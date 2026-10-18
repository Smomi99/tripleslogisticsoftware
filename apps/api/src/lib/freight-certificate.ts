import type {
  FreightCertificateDto,
  FreightCertificateFields,
  FreightCertificateFigureDto,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { amountInWords } from './amount-in-words';
import { resolveRate } from './currency-rate';
import { day, money } from './debit-invoice';
import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * Freight Certificate — the client's sample of 2026-10-18, made from an issued
 * freight debit invoice (packages/shared/src/freight-certificate.ts).
 *
 * The certificate keeps its own copy of every fact it prints, so what is read
 * here from the booking is only where a new one STARTS. The dollar figure is
 * the exception: it is never typed, and is worked out again from the invoice
 * each time the certificate is saved.
 */

export const CERTIFICATE_SELECT = {
  id: true,
  code: true,
  certificateDate: true,
  shipperText: true,
  packages: true,
  commodity: true,
  commercialInvoiceNo: true,
  commercialInvoiceDate: true,
  expNo: true,
  expDate: true,
  blNo: true,
  lcNo: true,
  portOfLoading: true,
  portOfDelivery: true,
  amount: true,
  conversionRate: true,
  updatedAt: true,
} satisfies Prisma.FreightCertificateSelect;

export type CertificateRow = Prisma.FreightCertificateGetPayload<{ select: typeof CERTIFICATE_SELECT }>;

/** The invoice as a certificate needs it: its total, and the booking it moved. */
export const CERTIFICATE_INVOICE_SELECT = {
  id: true,
  code: true,
  kind: true,
  status: true,
  currencyId: true,
  currencyCode: true,
  conversionRate: true,
  totalAmount: true,
  totalAmountBase: true,
  customer: { select: { name: true, address: true } },
  shipment: {
    select: {
      id: true,
      code: true,
      shipmentType: true,
      exporterName: true,
      exporterAddress: true,
      pol: { select: { name: true } },
      pod: { select: { name: true } },
      commodities: {
        where: { isActive: true },
        select: { commodityItem: { select: { name: true } } },
      },
      cargoLines: { where: { deletedAt: null }, select: { ctnQty: true } },
    },
  },
  freightCertificates: {
    where: { deletedAt: null },
    orderBy: { id: 'desc' as const },
    take: 1,
    select: CERTIFICATE_SELECT,
  },
} satisfies Prisma.DebitInvoiceSelect;

export type CertificateInvoiceRow = Prisma.DebitInvoiceGetPayload<{ select: typeof CERTIFICATE_INVOICE_SELECT }>;

export async function loadCertificateInvoice(db: TenantDb, debitInvoiceId: bigint): Promise<CertificateInvoiceRow> {
  const row = await db.debitInvoice.findFirst({
    where: { id: debitInvoiceId, deletedAt: null },
    select: CERTIFICATE_INVOICE_SELECT,
  });
  if (row === null) throw HttpError.notFound('Debit invoice not found.');
  return row;
}

/**
 * Why a certificate cannot be made or changed on this invoice now, or null.
 *
 * It certifies what a shipment's freight cost, so it needs a booking and an
 * invoice the customer was actually sent. A cancelled invoice certifies
 * nothing — its certificate can still be read, not changed or printed.
 */
export function lockedReason(invoice: Pick<CertificateInvoiceRow, 'code' | 'kind' | 'status' | 'shipment'>): string | null {
  if (invoice.kind !== 'FREIGHT' || invoice.shipment === null) {
    return `${invoice.code} was not made from a booking, so there is no shipment to certify.`;
  }
  if (invoice.status === 'CANCELLED') return `${invoice.code} was cancelled.`;
  if (invoice.status !== 'ISSUED') return `${invoice.code} is still a draft. Send it to the customer first.`;
  return null;
}

// ------------------------------------------------------------- the figure

export interface DollarFigure {
  currencyId: bigint;
  amount: Prisma.Decimal;
  /** Base units per dollar. */
  rate: Prisma.Decimal;
}

/**
 * An invoice not in dollars, stated in dollars: its base total at the dollar
 * rate. Two decimals, as the certificate prints it and as its words read.
 */
export function convertToDollars(totalAmountBase: Prisma.Decimal, usdId: bigint, rate: Prisma.Decimal): DollarFigure {
  return { currencyId: usdId, amount: totalAmountBase.dividedBy(rate).toDecimalPlaces(2), rate };
}

/**
 * "Figure USD" and "Conversion Rate" (decided 2026-10-18).
 *
 * A dollar invoice states its own total at its own frozen rate — the figure
 * the customer was billed. Any other invoice is converted from its base total
 * at the workspace's dollar rate in force on the certificate date.
 */
export async function dollarFigure(
  db: TenantDb,
  tenantId: bigint,
  invoice: Pick<CertificateInvoiceRow, 'currencyId' | 'currencyCode' | 'conversionRate' | 'totalAmount' | 'totalAmountBase'>,
  certificateDate: string,
): Promise<DollarFigure> {
  if (invoice.currencyCode === 'USD') {
    return { currencyId: invoice.currencyId, amount: invoice.totalAmount, rate: invoice.conversionRate };
  }

  const usd = await db.currency.findFirst({
    where: { deletedAt: null, currency: { startsWith: 'USD' } },
    select: { id: true },
  });
  if (usd === null) {
    throw new HttpError(
      409,
      'NO_USD',
      'There is no US Dollar on Settings → Currency, so the freight cannot be stated in dollars. Add it there first.',
    );
  }

  // The rate in force at the end of the certificate's day — or now, for today.
  const endOfDay = new Date(`${certificateDate}T23:59:59.999Z`);
  const at = endOfDay.getTime() < Date.now() ? endOfDay : new Date();
  const { rate } = await resolveRate(db, tenantId, usd.id, at);
  return convertToDollars(invoice.totalAmountBase, usd.id, rate);
}

export function figureDto(amount: Prisma.Decimal, rate: Prisma.Decimal, baseCurrencyCode: string): FreightCertificateFigureDto {
  return {
    amount: money(amount),
    amountInWords: amountInWords(amount.toFixed(2), 'USD'),
    conversionRate: rate.toString(),
    baseCurrencyCode,
  };
}

// ------------------------------------------------------------- the fields

/**
 * Where a new certificate starts: the booking's facts, as of now.
 *
 * Cartons are what went on the shipment advise when there is one — what was
 * actually shipped — and the booked quantity otherwise. The BL number is the
 * advise's, which is where the house bill takes its number from.
 */
export async function prefillFields(
  db: TenantDb,
  invoice: CertificateInvoiceRow,
  today: string,
): Promise<FreightCertificateFields> {
  const shipment = invoice.shipment;
  if (shipment === null) throw HttpError.badRequest('That invoice was not made from a booking.');

  const [adviseLines, adviseLink] = await Promise.all([
    db.shipmentAdviseLine.findMany({
      where: { shipmentId: shipment.id, deletedAt: null, advise: { deletedAt: null, status: { not: 'CANCELLED' } } },
      select: { ctnQty: true },
    }),
    db.shipmentAdviseBooking.findFirst({
      where: { shipmentId: shipment.id, deletedAt: null, advise: { deletedAt: null, status: { not: 'CANCELLED' } } },
      orderBy: { id: 'desc' },
      select: { advise: { select: { houseBlNo: true } } },
    }),
  ]);

  const shipped = adviseLines.reduce((n, l) => n + l.ctnQty, 0);
  const booked = shipment.cargoLines.reduce((n, l) => n + l.ctnQty, 0);
  const cartons = adviseLines.length > 0 ? shipped : booked;

  const name = shipment.exporterName ?? invoice.customer.name;
  const address = shipment.exporterName === null ? invoice.customer.address : shipment.exporterAddress;
  const commodity = shipment.commodities.map((c) => c.commodityItem.name).join(', ');

  return {
    certificateDate: today,
    shipperText: [name, address].filter((v): v is string => v !== null && v.trim() !== '').join('\n'),
    packages: cartons > 0 ? `${cartons.toLocaleString('en-US')} Cartons` : null,
    commodity: commodity === '' ? null : commodity,
    commercialInvoiceNo: null,
    commercialInvoiceDate: null,
    expNo: null,
    expDate: null,
    blNo: adviseLink?.advise.houseBlNo ?? null,
    lcNo: null,
    portOfLoading: shipment.pol.name,
    portOfDelivery: shipment.pod.name,
  };
}

export function fieldsOf(row: CertificateRow): FreightCertificateFields {
  return {
    certificateDate: day(row.certificateDate) ?? '',
    shipperText: row.shipperText,
    packages: row.packages,
    commodity: row.commodity,
    commercialInvoiceNo: row.commercialInvoiceNo,
    commercialInvoiceDate: day(row.commercialInvoiceDate),
    expNo: row.expNo,
    expDate: day(row.expDate),
    blNo: row.blNo,
    lcNo: row.lcNo,
    portOfLoading: row.portOfLoading,
    portOfDelivery: row.portOfDelivery,
  };
}

export function certificateDto(row: CertificateRow, baseCurrencyCode: string): FreightCertificateDto {
  return {
    id: row.id.toString(),
    code: row.code,
    fields: fieldsOf(row),
    ...figureDto(row.amount, row.conversionRate, baseCurrencyCode),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The columns a save writes, from what the operator sent. */
export function columnsOf(fields: FreightCertificateFields): Omit<
  Prisma.FreightCertificateUncheckedCreateInput,
  'tenantId' | 'code' | 'seriesYear' | 'debitInvoiceId' | 'currencyId' | 'amount' | 'conversionRate'
> {
  const date = (v: string | null): Date | null => (v === null ? null : new Date(`${v}T00:00:00.000Z`));
  return {
    certificateDate: new Date(`${fields.certificateDate}T00:00:00.000Z`),
    shipperText: fields.shipperText,
    packages: fields.packages,
    commodity: fields.commodity,
    commercialInvoiceNo: fields.commercialInvoiceNo,
    commercialInvoiceDate: date(fields.commercialInvoiceDate),
    expNo: fields.expNo,
    expDate: date(fields.expDate),
    blNo: fields.blNo,
    lcNo: fields.lcNo,
    portOfLoading: fields.portOfLoading,
    portOfDelivery: fields.portOfDelivery,
  };
}
