import {
  type DebitInvoiceBookingDto,
  type DebitInvoiceCostDto,
  type DebitInvoiceDto,
  type DebitInvoiceLineDto,
  type DebitInvoicePrefillDto,
  debitInvoiceDisplayStatus,
  type DebitInvoiceSaveData,
  INVOICEABLE_SHIPMENT_STATUSES,
  type InvoiceCostData,
  type InvoiceLineData,
  isoCurrency,
  type PaymentStatus,
  type ShipmentStatus,
  SUPPLIER_PARTY_LABEL,
  type SupplierPartyType,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { type BaseCurrency, resolveRate, resolveRates } from './currency-rate';
import { HttpError } from './http-error';
import { renderRequiredContainer } from './render-volumes';
import type { TenantDb } from './tenant-client';

/**
 * The debit invoice — docs/MODULE_ACCOUNTS.md §3, §4, §5.
 *
 * Everything the routes share: how an invoice is read, what may change and
 * when (§3.7), how a grid is written, how the totals are kept, and what `Make
 * invoice` opens on (§3.5). The routes only decide who may call what.
 */

// ------------------------------------------------------------------ money

/** §4 rule 6: NUMERIC(18,4). Money is never a float, and never rounded twice. */
const MONEY_DP = 4;
const ZERO = new Prisma.Decimal(0);

export const dec = (v: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal =>
  v === null || v === undefined || v === '' ? ZERO : new Prisma.Decimal(v);

/** Base amount of a figure at a rate, rounded the way the column stores it. */
export function toBase(amount: Prisma.Decimal, rate: Prisma.Decimal): Prisma.Decimal {
  return amount.times(rate).toDecimalPlaces(MONEY_DP);
}

export const money = (v: Prisma.Decimal | null | undefined): string => dec(v).toFixed(MONEY_DP);

/**
 * The base currency's ISO code — "BDT", not its business code "CUR-001". The
 * business code identifies the row; a person reading an amount wants the money.
 */
export const isoOf = (base: { currency: string }): string => isoCurrency(base.currency);
export const day = (d: Date | null | undefined): string | null =>
  d === null || d === undefined ? null : d.toISOString().slice(0, 10);

/** "1.000" -> "1", "2.500" -> "2.5" — quantities in a sentence, not a column. */
function qty(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(3).toString();
}

// -------------------------------------------------------------- the reads

const LINE_SELECT = {
  id: true,
  source: true,
  costHeadId: true,
  costHeadName: true,
  containerSizeId: true,
  containerSizeName: true,
  costUnitId: true,
  unitName: true,
  quantity: true,
  unitPrice: true,
  amount: true,
} satisfies Prisma.DebitInvoiceLineSelect;

/**
 * The booking as an invoice shows it — the awaiting list's columns (§2.1) and
 * the header the form is filled in against.
 */
export const BOOKING_SELECT = {
  id: true,
  code: true,
  status: true,
  shipmentType: true,
  customerId: true,
  carrierId: true,
  pol: { select: { name: true, portCode: true } },
  pod: { select: { name: true, portCode: true } },
  carrier: { select: { name: true } },
  commodities: {
    where: { isActive: true },
    select: { commodityItem: { select: { name: true } } },
  },
  quotation: {
    select: {
      id: true,
      code: true,
      quotationDate: true,
      inquiry: {
        select: {
          code: true,
          volumes: {
            where: { deletedAt: null },
            select: {
              quantity: true,
              cbm: true,
              weightKg: true,
              containerSizeNote: true,
              containerSize: { select: { name: true } },
            },
          },
        },
      },
      lines: {
        where: { deletedAt: null, isActive: true },
        orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
        select: { containerSizeName: true, quantity: true, totalAmount: true, currencyCode: true },
      },
    },
  },
} satisfies Prisma.ShipmentSelect;

export type BookingRow = Prisma.ShipmentGetPayload<{ select: typeof BOOKING_SELECT }>;

export const INVOICE_SELECT = {
  id: true,
  code: true,
  kind: true,
  status: true,
  shipmentId: true,
  quotationId: true,
  customerId: true,
  invoiceDate: true,
  currencyId: true,
  currencyCode: true,
  conversionRate: true,
  totalAmount: true,
  totalAmountBase: true,
  costTotalBase: true,
  recipientEmails: true,
  issuedAt: true,
  sentAt: true,
  cancelledAt: true,
  cancelReason: true,
  pdfFile: true,
  customer: { select: { name: true, address: true } },
  shipment: { select: BOOKING_SELECT },
  quotation: {
    select: { id: true, code: true, quotationDate: true, inquiry: { select: { code: true } } },
  },
  lines: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    select: LINE_SELECT,
  },
  costs: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      partyType: true,
      carrierId: true,
      agentId: true,
      vendorId: true,
      supplierInvoiceNo: true,
      supplierInvoiceFile: true,
      currencyId: true,
      currencyCode: true,
      conversionRate: true,
      totalAmount: true,
      totalAmountBase: true,
      carrier: { select: { name: true } },
      agent: { select: { name: true } },
      vendor: { select: { name: true } },
      lines: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
        select: LINE_SELECT,
      },
    },
  },
  receipts: {
    where: { deletedAt: null },
    orderBy: [{ paymentDate: 'asc' as const }, { id: 'asc' as const }],
    select: { id: true, paymentDate: true, amount: true, amountBase: true, createdAt: true },
  },
} satisfies Prisma.DebitInvoiceSelect;

export type InvoiceRow = Prisma.DebitInvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

export async function loadInvoice(db: TenantDb, id: bigint): Promise<InvoiceRow> {
  const row = await db.debitInvoice.findFirst({
    where: { id, deletedAt: null },
    select: INVOICE_SELECT,
  });
  if (row === null) throw HttpError.notFound('Debit invoice not found.');
  return row;
}

// ---------------------------------------------------------- the booking

/** The quotation's total, per currency it was priced in (L5's Quoted Amount). */
export function quotedAmount(
  lines: { totalAmount: Prisma.Decimal | null; currencyCode: string }[],
): { currencyCode: string; amount: string }[] {
  const byCode = new Map<string, Prisma.Decimal>();
  for (const line of lines) {
    if (line.currencyCode === '') continue;
    byCode.set(line.currencyCode, (byCode.get(line.currencyCode) ?? ZERO).plus(dec(line.totalAmount)));
  }
  return [...byCode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, amount]) => ({ currencyCode, amount: money(amount) }));
}

export function bookingDto(row: BookingRow): DebitInvoiceBookingDto {
  return {
    shipmentId: row.id.toString(),
    bookingCode: row.code,
    bookingStatus: row.status,
    shipmentType: row.shipmentType,
    inquiryCode: row.quotation.inquiry.code,
    quotationId: row.quotation.id.toString(),
    quotationCode: row.quotation.code,
    quotationDate: day(row.quotation.quotationDate),
    polName: row.pol.name,
    polCode: row.pol.portCode,
    podName: row.pod.name,
    podCode: row.pod.portCode,
    carrierName: row.carrier.name,
    commodity: row.commodities.map((c) => c.commodityItem.name).join(', ') || '—',
    requiredContainer: renderRequiredContainer(row.quotation.lines, row.quotation.inquiry.volumes),
  };
}

// ----------------------------------------------------------- the rules

export interface Money3 {
  received: Prisma.Decimal;
  outstanding: Prisma.Decimal;
  status: PaymentStatus;
}

/** §5 rule 4, derived — never stored, so it can never disagree with receipts. */
export function paymentOf(total: Prisma.Decimal, receipts: { amount: Prisma.Decimal }[]): Money3 {
  const received = receipts.reduce((sum, r) => sum.plus(r.amount), ZERO);
  const outstanding = Prisma.Decimal.max(total.minus(received), ZERO);
  const status: PaymentStatus = received.isZero()
    ? 'UNPAID'
    : outstanding.isZero()
      ? 'PAID'
      : 'PARTIAL';
  return { received, outstanding, status };
}

/**
 * §3.7. The sell side is what the customer was sent: editable while a draft,
 * and after issue only until money has been received against it.
 */
export function sellEditable(row: { status: string }, receiptCount: number): boolean {
  return row.status === 'DRAFT' || (row.status === 'ISSUED' && receiptCount === 0);
}

/** §3.7. A carrier's invoice arrives when it arrives; the customer never sees it. */
export function costEditable(row: { status: string }): boolean {
  return row.status !== 'CANCELLED';
}

/** §3.7 and §12 Q7: nothing reverses a receipt yet, so one blocks cancelling. */
export function cancellable(row: { status: string }, receiptCount: number): boolean {
  return row.status !== 'CANCELLED' && receiptCount === 0;
}

// ------------------------------------------------------------- the DTO

function lineDto(
  line: InvoiceRow['lines'][number],
  rate: Prisma.Decimal,
): DebitInvoiceLineDto {
  const amount = dec(line.amount);
  return {
    id: line.id.toString(),
    source: line.source,
    costHeadId: line.costHeadId.toString(),
    costHeadName: line.costHeadName,
    containerSizeId: line.containerSizeId?.toString() ?? null,
    containerSizeName: line.containerSizeName,
    costUnitId: line.costUnitId?.toString() ?? null,
    unitName: line.unitName,
    quantity: line.quantity.toString(),
    unitPrice: line.unitPrice.toString(),
    amount: money(amount),
    amountBase: money(toBase(amount, rate)),
  };
}

function partyOf(cost: InvoiceRow['costs'][number]): { id: bigint | null; name: string } {
  if (cost.partyType === 'CARRIER') return { id: cost.carrierId, name: cost.carrier?.name ?? '—' };
  if (cost.partyType === 'AGENT') return { id: cost.agentId, name: cost.agent?.name ?? '—' };
  return { id: cost.vendorId, name: cost.vendor?.name ?? '—' };
}

export function invoiceDto(
  row: InvoiceRow,
  ctx: { canViewBuyPrice: boolean; baseCurrencyCode: string },
  displayName: (key: string) => string,
): DebitInvoiceDto {
  const rate = row.conversionRate;
  const payment = paymentOf(row.totalAmount, row.receipts);

  const costs: DebitInvoiceCostDto[] | null = ctx.canViewBuyPrice
    ? row.costs.map((cost) => {
        const party = partyOf(cost);
        return {
          id: cost.id.toString(),
          partyType: cost.partyType,
          partyId: party.id?.toString() ?? '',
          partyName: party.name,
          supplierInvoiceNo: cost.supplierInvoiceNo,
          supplierInvoiceFileName:
            cost.supplierInvoiceFile === null ? null : displayName(cost.supplierInvoiceFile),
          currencyId: cost.currencyId.toString(),
          currencyCode: cost.currencyCode,
          conversionRate: cost.conversionRate.toString(),
          totalAmount: money(cost.totalAmount),
          totalAmountBase: money(cost.totalAmountBase),
          lines: cost.lines.map((l) => lineDto(l, cost.conversionRate)),
        };
      })
    : null;

  // §3.4: derived from the stored totals, never stored itself.
  const grossProfit = row.totalAmountBase.minus(row.costTotalBase);
  const grossProfitPercent = row.totalAmountBase.greaterThan(0)
    ? grossProfit.dividedBy(row.totalAmountBase).times(100).toDecimalPlaces(2).toFixed(2)
    : null;

  const booking = row.shipment === null ? null : bookingDto(row.shipment);
  return {
    id: row.id.toString(),
    code: row.code,
    kind: row.kind,
    status: row.status,
    paymentStatus: payment.status,
    displayStatus: debitInvoiceDisplayStatus(row.status, payment.status),
    booking,
    customerId: row.customerId.toString(),
    customerName: row.customer.name,
    invoiceDate: day(row.invoiceDate) ?? '',
    currencyId: row.currencyId.toString(),
    currencyCode: row.currencyCode,
    conversionRate: rate.toString(),
    baseCurrencyCode: ctx.baseCurrencyCode,
    lines: row.lines.map((l) => lineDto(l, rate)),
    totalAmount: money(row.totalAmount),
    totalAmountBase: money(row.totalAmountBase),
    receivedAmount: money(payment.received),
    outstandingAmount: money(payment.outstanding),
    costs,
    costTotalBase: ctx.canViewBuyPrice ? money(row.costTotalBase) : null,
    grossProfitBase: ctx.canViewBuyPrice ? money(grossProfit) : null,
    grossProfitPercent: ctx.canViewBuyPrice ? grossProfitPercent : null,
    recipientEmails: row.recipientEmails,
    receipts: row.receipts.map((r) => ({
      id: r.id.toString(),
      paymentDate: day(r.paymentDate) ?? '',
      amount: money(r.amount),
      amountBase: money(r.amountBase),
      recordedAt: r.createdAt.toISOString(),
    })),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    sellEditable: sellEditable(row, row.receipts.length),
    costEditable: costEditable(row),
    cancellable: cancellable(row, row.receipts.length),
  };
}

// ------------------------------------------------------------- the writes

/** A currency this workspace can see, with the ISO code the document keeps. */
export async function currencyOf(db: TenantDb, id: bigint): Promise<string> {
  const row = await db.currency.findFirst({
    where: { id, deletedAt: null },
    select: { currency: true },
  });
  if (row === null) throw HttpError.badRequest('That currency is not available.');
  return isoCurrency(row.currency);
}

/**
 * §3.4: the base currency converts to itself at exactly 1 — a document cannot
 * say otherwise, whatever the form sent.
 */
export function rateFor(currencyId: bigint, rate: string, base: BaseCurrency): Prisma.Decimal {
  return currencyId === base.id ? new Prisma.Decimal(1) : new Prisma.Decimal(rate);
}

interface ResolvedLine {
  costHeadId: bigint;
  costHeadName: string;
  containerSizeId: bigint | null;
  containerSizeName: string | null;
  costUnitId: bigint | null;
  unitName: string | null;
  quantity: string;
  unitPrice: string;
  source: InvoiceLineData['source'];
}

/**
 * Names snapshotted from the masters, so the document keeps saying what it said
 * when a cost head is renamed later. A reference this workspace cannot see is
 * refused by name rather than failing on a foreign key.
 */
async function resolveLines(db: TenantDb, lines: InvoiceLineData[]): Promise<ResolvedLine[]> {
  if (lines.length === 0) return [];
  const headIds = [...new Set(lines.map((l) => BigInt(l.costHeadId)))];
  const sizeIds = [...new Set(lines.flatMap((l) => (l.containerSizeId === null ? [] : [BigInt(l.containerSizeId)])))];
  const unitIds = [...new Set(lines.flatMap((l) => (l.costUnitId === null ? [] : [BigInt(l.costUnitId)])))];

  const [heads, sizes, units] = await Promise.all([
    db.costHead.findMany({
      where: { id: { in: headIds }, deletedAt: null },
      select: { id: true, name: true, unitId: true, unit: { select: { name: true } } },
    }),
    sizeIds.length === 0
      ? Promise.resolve([])
      : db.containerSize.findMany({
          where: { id: { in: sizeIds }, deletedAt: null },
          select: { id: true, name: true },
        }),
    unitIds.length === 0
      ? Promise.resolve([])
      : db.costUnit.findMany({
          where: { id: { in: unitIds }, deletedAt: null },
          select: { id: true, name: true },
        }),
  ]);

  const headById = new Map(heads.map((h) => [h.id.toString(), h]));
  const sizeById = new Map(sizes.map((s) => [s.id.toString(), s]));
  const unitById = new Map(units.map((u) => [u.id.toString(), u]));

  return lines.map((line) => {
    const head = headById.get(line.costHeadId);
    if (head === undefined) throw HttpError.badRequest('One of the cost heads is not available.');
    const size = line.containerSizeId === null ? null : sizeById.get(line.containerSizeId);
    if (size === undefined) throw HttpError.badRequest('One of the container sizes is not available.');

    // A line with no unit takes its cost head's, the way the quotation did.
    let costUnitId: bigint | null = head.unitId;
    let unitName: string | null = head.unit.name;
    if (line.costUnitId !== null) {
      const unit = unitById.get(line.costUnitId);
      if (unit === undefined) throw HttpError.badRequest('One of the units is not available.');
      costUnitId = unit.id;
      unitName = unit.name;
    }

    return {
      costHeadId: head.id,
      costHeadName: head.name,
      containerSizeId: size?.id ?? null,
      containerSizeName: size?.name ?? null,
      costUnitId,
      unitName,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      source: line.source,
    };
  });
}

/**
 * Replace the Selling Price grid. The old lines are soft-deleted, not removed —
 * what an issued invoice once said stays on the record (§4 rule 3), and the
 * audit trigger has every version of every line.
 */
async function writeSellLines(
  db: TenantDb,
  tenantId: bigint,
  userId: bigint,
  invoiceId: bigint,
  lines: ResolvedLine[],
): Promise<void> {
  await db.debitInvoiceLine.updateMany({
    where: { debitInvoiceId: invoiceId, deletedAt: null },
    data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
  });
  if (lines.length === 0) return;
  await db.debitInvoiceLine.createMany({
    data: lines.map((line, index) => ({
      tenantId,
      debitInvoiceId: invoiceId,
      sortOrder: index,
      ...line,
      createdBy: userId,
      updatedBy: userId,
    })),
  });
}

async function partyIsVisible(db: TenantDb, type: SupplierPartyType, id: bigint): Promise<boolean> {
  const where = { id, deletedAt: null };
  if (type === 'CARRIER') return (await db.carrier.findFirst({ where, select: { id: true } })) !== null;
  if (type === 'AGENT') return (await db.agent.findFirst({ where, select: { id: true } })) !== null;
  return (await db.vendor.findFirst({ where, select: { id: true } })) !== null;
}

/**
 * Replace the cost side (§3.5, §5 rule 3).
 *
 * A block the caller sent with an id is updated in place, so its uploaded
 * supplier invoice stays attached; one it did not send is soft-deleted; an
 * empty block that names nobody is simply not written.
 */
async function writeCosts(
  db: TenantDb,
  tenantId: bigint,
  userId: bigint,
  invoiceId: bigint,
  costs: InvoiceCostData[],
  base: BaseCurrency,
): Promise<void> {
  const existing = await db.debitInvoiceCost.findMany({
    where: { debitInvoiceId: invoiceId, deletedAt: null },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((c) => c.id.toString()));
  const kept = new Set<string>();

  for (const [index, block] of costs.entries()) {
    const isEmpty =
      block.partyId === null &&
      block.lines.length === 0 &&
      (block.supplierInvoiceNo ?? '').trim() === '';
    if (block.id === null && isEmpty) continue;
    if (block.partyId === null) {
      throw HttpError.badRequest(
        `Choose the ${SUPPLIER_PARTY_LABEL[block.partyType].toLowerCase()} this cost is owed to.`,
      );
    }

    const partyId = BigInt(block.partyId);
    if (!(await partyIsVisible(db, block.partyType, partyId))) {
      throw HttpError.badRequest(
        `That ${SUPPLIER_PARTY_LABEL[block.partyType].toLowerCase()} is not available.`,
      );
    }

    const currencyId = BigInt(block.currencyId);
    const currencyCode = await currencyOf(db, currencyId);
    const rate = rateFor(currencyId, block.conversionRate, base);
    const lines = await resolveLines(db, block.lines);

    const data = {
      sortOrder: index,
      partyType: block.partyType,
      carrierId: block.partyType === 'CARRIER' ? partyId : null,
      agentId: block.partyType === 'AGENT' ? partyId : null,
      vendorId: block.partyType === 'VENDOR' ? partyId : null,
      supplierInvoiceNo: (block.supplierInvoiceNo ?? '').trim() || null,
      currencyId,
      currencyCode,
      conversionRate: rate,
      updatedBy: userId,
    };

    let costId: bigint;
    if (block.id !== null) {
      if (!existingIds.has(block.id)) {
        throw HttpError.badRequest('One of the cost blocks does not belong to this invoice.');
      }
      costId = BigInt(block.id);
      await db.debitInvoiceCost.update({ where: { id: costId }, data });
    } else {
      const made = await db.debitInvoiceCost.create({
        data: { tenantId, debitInvoiceId: invoiceId, ...data, createdBy: userId },
        select: { id: true },
      });
      costId = made.id;
    }
    kept.add(costId.toString());

    await db.debitInvoiceCostLine.updateMany({
      where: { debitInvoiceCostId: costId, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
    });
    if (lines.length > 0) {
      await db.debitInvoiceCostLine.createMany({
        data: lines.map((line, lineIndex) => ({
          tenantId,
          debitInvoiceCostId: costId,
          sortOrder: lineIndex,
          ...line,
          createdBy: userId,
          updatedBy: userId,
        })),
      });
    }
    await retotalCost(db, costId, rate);
  }

  const dropped = [...existingIds].filter((id) => !kept.has(id)).map((id) => BigInt(id));
  if (dropped.length > 0) {
    await db.debitInvoiceCostLine.updateMany({
      where: { debitInvoiceCostId: { in: dropped }, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
    });
    await db.debitInvoiceCost.updateMany({
      where: { id: { in: dropped } },
      data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
    });
  }
}

/**
 * A block's "Total Cost =", read back from the database: the line amounts are
 * GENERATED, so Postgres is the only thing that has done that arithmetic.
 * The base total is the sum of the rows' base amounts, so the sheet's Total
 * Amount (BDT) column adds up to exactly what the block says.
 */
async function retotalCost(db: TenantDb, costId: bigint, rate: Prisma.Decimal): Promise<void> {
  const lines = await db.debitInvoiceCostLine.findMany({
    where: { debitInvoiceCostId: costId, deletedAt: null },
    select: { amount: true },
  });
  const total = lines.reduce((sum, l) => sum.plus(dec(l.amount)), ZERO);
  const totalBase = lines.reduce((sum, l) => sum.plus(toBase(dec(l.amount), rate)), ZERO);
  await db.debitInvoiceCost.update({
    where: { id: costId },
    data: { totalAmount: total, totalAmountBase: totalBase },
  });
}

/** The header's three sums (§3.4), recomputed from what the database holds. */
export async function retotalInvoice(db: TenantDb, invoiceId: bigint): Promise<void> {
  const invoice = await db.debitInvoice.findFirst({
    where: { id: invoiceId },
    select: { conversionRate: true },
  });
  if (invoice === null) throw HttpError.notFound('Debit invoice not found.');

  const [lines, costs] = await Promise.all([
    db.debitInvoiceLine.findMany({
      where: { debitInvoiceId: invoiceId, deletedAt: null },
      select: { amount: true },
    }),
    db.debitInvoiceCost.findMany({
      where: { debitInvoiceId: invoiceId, deletedAt: null },
      select: { totalAmountBase: true },
    }),
  ]);

  const total = lines.reduce((sum, l) => sum.plus(dec(l.amount)), ZERO);
  const totalBase = lines.reduce(
    (sum, l) => sum.plus(toBase(dec(l.amount), invoice.conversionRate)),
    ZERO,
  );
  const costTotalBase = costs.reduce((sum, c) => sum.plus(c.totalAmountBase), ZERO);

  await db.debitInvoice.update({
    where: { id: invoiceId },
    data: { totalAmount: total, totalAmountBase: totalBase, costTotalBase },
  });
}

/**
 * The sell side of a save: header fields and the Selling Price grid.
 *
 * `customerId` only moves on an OTHER invoice — a freight invoice bills the
 * booking's customer, and a form cannot redirect it.
 */
export async function saveSellSide(
  db: TenantDb,
  args: {
    tenantId: bigint;
    userId: bigint;
    invoiceId: bigint;
    kind: 'FREIGHT' | 'OTHER';
    input: DebitInvoiceSaveData;
    base: BaseCurrency;
  },
): Promise<void> {
  const { tenantId, userId, invoiceId, kind, input, base } = args;
  const currencyId = BigInt(input.currencyId);
  const currencyCode = await currencyOf(db, currencyId);
  const rate = rateFor(currencyId, input.conversionRate, base);

  const header: Prisma.DebitInvoiceUncheckedUpdateInput = {
    invoiceDate: new Date(`${input.invoiceDate}T00:00:00.000Z`),
    currencyId,
    currencyCode,
    conversionRate: rate,
    recipientEmails: [...new Set(input.recipientEmails)],
    updatedBy: userId,
  };

  if (kind === 'OTHER') {
    if (input.customerId === null) throw HttpError.badRequest('Choose the customer to bill.');
    const customer = await db.customer.findFirst({
      where: { id: BigInt(input.customerId), deletedAt: null },
      select: { id: true },
    });
    if (customer === null) throw HttpError.badRequest('That customer is not available.');
    header.customerId = customer.id;

    // §3.2: an OTHER invoice may name a booking, for reference only.
    if (input.shipmentId === null) {
      header.shipmentId = null;
      header.quotationId = null;
    } else {
      const shipment = await db.shipment.findFirst({
        where: { id: BigInt(input.shipmentId), deletedAt: null },
        select: { id: true, quotationId: true },
      });
      if (shipment === null) throw HttpError.badRequest('That booking is not available.');
      header.shipmentId = shipment.id;
      header.quotationId = shipment.quotationId;
    }
  }

  await db.debitInvoice.update({ where: { id: invoiceId }, data: header });
  await writeSellLines(db, tenantId, userId, invoiceId, await resolveLines(db, input.lines));
}

export async function saveCostSide(
  db: TenantDb,
  args: {
    tenantId: bigint;
    userId: bigint;
    invoiceId: bigint;
    costs: InvoiceCostData[];
    base: BaseCurrency;
  },
): Promise<void> {
  await writeCosts(db, args.tenantId, args.userId, args.invoiceId, args.costs, args.base);
}

// ---------------------------------------------------------------- prefill

/**
 * What `Make invoice` opens on (§3.5). Nothing here is saved — the advise's
 * prefill-then-create shape — so opening the form and walking away leaves no
 * half-made invoice on the books.
 */
export async function prefillFor(
  db: TenantDb,
  args: { tenantId: bigint; shipmentId: bigint; base: BaseCurrency; canViewBuyPrice: boolean; today: Date },
): Promise<DebitInvoicePrefillDto> {
  const { tenantId, shipmentId, base, canViewBuyPrice, today } = args;

  const shipment = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: {
      ...BOOKING_SELECT,
      customer: {
        select: {
          id: true,
          name: true,
          pics: {
            where: { deletedAt: null, isActive: true, email: { not: null } },
            select: { email: true },
          },
        },
      },
      quotation: {
        select: {
          ...BOOKING_SELECT.quotation.select,
          sourceAgentQuote: { select: { agentId: true, agent: { select: { name: true } } } },
          inquiry: {
            select: {
              ...BOOKING_SELECT.quotation.select.inquiry.select,
              wonAgentId: true,
              wonAgent: { select: { name: true } },
            },
          },
          lines: {
            where: { deletedAt: null, isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            select: {
              costHeadId: true,
              costHeadName: true,
              containerSizeId: true,
              containerSizeName: true,
              costUnitId: true,
              unitName: true,
              quantity: true,
              sellingPrice: true,
              currencyId: true,
              currencyCode: true,
              totalAmount: true,
              lineGroup: true,
            },
          },
        },
      },
    },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');
  await assertInvoiceable(db, shipment);

  const notes: string[] = [];

  /** Today's rate, or '' with a note when the workspace has none on file. */
  async function rateOf(currencyId: bigint, code: string): Promise<string> {
    if (currencyId === base.id) return '1';
    try {
      return (await resolveRate(db, tenantId, currencyId, today)).rate.toString();
    } catch {
      notes.push(`No ${code} rate is on file for today. Enter the rate before saving.`);
      return '';
    }
  }

  /*
   * The quotation's one currency (§3.3), or the base if it has no lines.
   *
   * A quotation raised before the one-currency rule (2026-09-11) can still hold
   * charges in two — "BDT 19,500 + USD 3,200". Relabelling every line in the
   * first line's currency would bill 19,500 dollars for a taka charge, so a
   * mixed quotation is invoiced in the base currency instead, each charge
   * converted at today's rate. Converting INTO the base loses nothing: it is
   * price x rate, exactly what the base column of the sheet computes.
   */
  const firstLine = shipment.quotation.lines[0];
  const lineCurrencies = new Set(shipment.quotation.lines.map((l) => l.currencyId.toString()));
  const mixed = lineCurrencies.size > 1;
  const sellCurrencyId = mixed ? base.id : (firstLine?.currencyId ?? base.id);
  const sellCurrencyCode = mixed ? isoOf(base) : (firstLine?.currencyCode ?? isoOf(base));

  const lineRates = mixed
    ? await resolveRates(db, tenantId, [...lineCurrencies].map((id) => BigInt(id)), today)
    : new Map<string, { rate: Prisma.Decimal }>();
  if (mixed) {
    const codes = [...new Set(shipment.quotation.lines.map((l) => l.currencyCode))].sort().join(' and ');
    notes.push(
      `The quotation prices its charges in ${codes}, so this invoice is in ${sellCurrencyCode} ` +
        'and each charge was converted at today’s rate. Check them against the quotation.',
    );
  }

  const lines = shipment.quotation.lines.map((line) => {
    let unitPrice = line.sellingPrice;
    if (mixed && line.currencyId !== base.id) {
      const rate = lineRates.get(line.currencyId.toString())?.rate;
      if (rate === undefined) {
        notes.push(
          `No ${line.currencyCode} rate is on file, so ${line.costHeadName} could not be converted ` +
            `and was left at ${line.sellingPrice.toFixed(2)}. Enter it in ${sellCurrencyCode}.`,
        );
      } else {
        unitPrice = line.sellingPrice.times(rate).toDecimalPlaces(MONEY_DP);
      }
    }
    return {
      costHeadId: line.costHeadId.toString(),
      costHeadName: line.costHeadName,
      containerSizeId: line.containerSizeId?.toString() ?? null,
      containerSizeName: line.containerSizeName,
      costUnitId: line.costUnitId?.toString() ?? null,
      unitName: line.unitName,
      quantity: line.quantity.toString(),
      unitPrice: unitPrice.toString(),
      source: 'QUOTATION' as const,
    };
  });

  let costs: DebitInvoicePrefillDto['costs'] = null;
  if (canViewBuyPrice) {
    const usd = await db.currency.findFirst({
      where: { deletedAt: null, currency: { startsWith: 'USD' } },
      select: { id: true },
    });
    const foreignId = usd?.id ?? base.id;
    const foreignCode = usd === null ? isoOf(base) : 'USD';

    /*
     * The carrier block: the booking's carrier, and what CR-002 §9 allocated
     * to this booking on every finalised load plan. That figure is the
     * operator-entered actual container cost, split — the cost this invoice's
     * carrier block exists to record — and it was captured precisely so
     * Accounts would not have to reconstruct it.
     */
    const shares = await db.clpBooking.findMany({
      where: {
        shipmentId,
        deletedAt: null,
        allocatedCostAmount: { not: null },
        clp: { deletedAt: null, status: 'FINAL' },
      },
      orderBy: { id: 'asc' },
      select: {
        allocatedCostAmount: true,
        clp: {
          select: {
            code: true,
            costCurrencyId: true,
            costCurrency: { select: { currency: true } },
            containerSizeId: true,
            containerSize: { select: { name: true } },
          },
        },
      },
    });
    const shareCurrencies = new Set(
      shares.flatMap((s) => (s.clp.costCurrencyId === null ? [] : [s.clp.costCurrencyId.toString()])),
    );
    const carrierCurrencyId =
      shareCurrencies.size === 1 ? BigInt([...shareCurrencies][0]!) : foreignId;
    const carrierCurrencyCode =
      shareCurrencies.size === 1
        ? isoCurrency(shares.find((s) => s.clp.costCurrency !== null)?.clp.costCurrency?.currency ?? foreignCode)
        : foreignCode;

    const carrierLines: NonNullable<DebitInvoicePrefillDto['costs']>[number]['lines'] = [];
    if (shareCurrencies.size > 1) {
      notes.push(
        'The load plans hold this booking’s carrier cost in more than one currency, so none ' +
          'was pulled in. Enter it from the carrier’s invoice.',
      );
    } else {
      for (const share of shares) {
        // The cost head the quotation used for this box, so the carrier's line
        // reads like the customer's. Without one, the figure is named in a note
        // rather than pinned on a guessed head.
        const match = shipment.quotation.lines.find(
          (l) => l.lineGroup === 'STANDARD' && l.containerSizeId === share.clp.containerSizeId,
        );
        if (match === undefined) {
          notes.push(
            `Load plan ${share.clp.code} holds a carrier cost of ${carrierCurrencyCode} ` +
              `${money(share.allocatedCostAmount)} for ${share.clp.containerSize.name}. ` +
              'The quotation has no charge for that size to name it after, so add it by hand.',
          );
          continue;
        }
        carrierLines.push({
          costHeadId: match.costHeadId.toString(),
          costHeadName: match.costHeadName,
          containerSizeId: share.clp.containerSizeId.toString(),
          containerSizeName: share.clp.containerSize.name,
          costUnitId: match.costUnitId?.toString() ?? null,
          unitName: match.unitName,
          quantity: '1',
          unitPrice: dec(share.allocatedCostAmount).toString(),
          source: 'LOAD_PLAN',
        });
      }
    }

    // The agent the price came from, or the one who won the inquiry (§3.5).
    const agentId =
      shipment.quotation.sourceAgentQuote?.agentId ?? shipment.quotation.inquiry.wonAgentId ?? null;
    const agentName =
      shipment.quotation.sourceAgentQuote?.agent.name ?? shipment.quotation.inquiry.wonAgent?.name ?? null;

    costs = [
      {
        id: null,
        partyType: 'CARRIER',
        partyId: shipment.carrierId.toString(),
        partyName: shipment.carrier.name,
        supplierInvoiceNo: null,
        currencyId: carrierCurrencyId.toString(),
        conversionRate: await rateOf(carrierCurrencyId, carrierCurrencyCode),
        lines: carrierLines,
      },
      {
        id: null,
        partyType: 'AGENT',
        partyId: agentId?.toString() ?? null,
        partyName: agentName,
        supplierInvoiceNo: null,
        currencyId: foreignId.toString(),
        conversionRate: await rateOf(foreignId, foreignCode),
        lines: [],
      },
      {
        id: null,
        partyType: 'VENDOR',
        partyId: null,
        partyName: null,
        supplierInvoiceNo: null,
        currencyId: base.id.toString(),
        conversionRate: '1',
        lines: [],
      },
    ];
  }

  return {
    booking: bookingDto(shipment),
    customerId: shipment.customer.id.toString(),
    customerName: shipment.customer.name,
    invoiceDate: day(today) ?? '',
    currencyId: sellCurrencyId.toString(),
    conversionRate: await rateOf(sellCurrencyId, sellCurrencyCode),
    lines,
    costs,
    recipientEmails: [
      ...new Set(shipment.customer.pics.flatMap((p) => (p.email === null ? [] : [p.email.trim().toLowerCase()]))),
    ].filter((e) => e !== ''),
    notes,
  };
}

/**
 * §5 rule 1: a confirmed booking with no live freight invoice. Said in words —
 * the operator needs to know which of the two it is.
 */
export async function assertInvoiceable(
  db: TenantDb,
  shipment: { id: bigint; code: string; status: ShipmentStatus },
): Promise<void> {
  if (!(INVOICEABLE_SHIPMENT_STATUSES as readonly string[]).includes(shipment.status)) {
    throw new HttpError(
      409,
      'BOOKING_NOT_INVOICEABLE',
      shipment.status === 'CANCELLED' || shipment.status === 'REJECTED'
        ? `${shipment.code} is ${shipment.status.toLowerCase()} and is not invoiced.`
        : `${shipment.code} has not been approved for shipment yet, so there is nothing to invoice.`,
    );
  }
  const live = await db.debitInvoice.findFirst({
    where: { shipmentId: shipment.id, kind: 'FREIGHT', deletedAt: null, status: { not: 'CANCELLED' } },
    select: { code: true, status: true },
  });
  if (live !== null) {
    throw new HttpError(
      409,
      'ALREADY_INVOICED',
      live.status === 'DRAFT'
        ? `${shipment.code} already has a draft invoice, ${live.code}. Open it from the list to carry on.`
        : `${shipment.code} has already been invoiced on ${live.code}.`,
    );
  }
}

/** One cost block's lines as a phrase, for a ledger row: "Ocean Freight 1x40HC". */
export function describeLines(
  lines: { costHeadName: string; quantity: Prisma.Decimal; containerSizeName: string | null }[],
): string {
  if (lines.length === 0) return 'No lines entered';
  return lines
    .map((l) =>
      l.containerSizeName === null
        ? `${l.costHeadName} x${qty(l.quantity)}`
        : `${l.costHeadName} ${qty(l.quantity)}x${l.containerSizeName}`,
    )
    .join(', ');
}
