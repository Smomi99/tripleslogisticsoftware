import { Router } from 'express';

import {
  type ApiSuccess,
  type AwaitingFreightInvRow,
  awaitingFreightInvQuerySchema,
  buildMeta,
  type DebitInvoiceDto,
  type DebitInvoiceListRow,
  type DebitInvoiceOptionsDto,
  type DebitInvoicePrefillDto,
  debitInvoiceCancelSchema,
  debitInvoiceCostsSaveSchema,
  debitInvoiceDisplayStatus,
  debitInvoiceListQuerySchema,
  debitInvoiceReceiptSchema,
  debitInvoiceSaveSchema,
  debitInvoiceSendSchema,
  INVOICEABLE_SHIPMENT_STATUSES,
  isoCurrency,
  LEDGER_PARTY_TYPES,
  type LedgerDto,
  type LedgerPartyType,
  READY_TO_INVOICE_STATUSES,
  type ReceivablePayableRow,
  receivablePayableQuerySchema,
  type ShipmentStatus,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { amountInWords } from '../lib/amount-in-words';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { type BaseCurrency, baseCurrency, resolveRates } from '../lib/currency-rate';
import {
  assertInvoiceable,
  BOOKING_SELECT,
  cancellable,
  costEditable,
  currencyOf,
  dec,
  type InvoiceRow,
  invoiceDto,
  isoOf,
  loadInvoice,
  money,
  paymentOf,
  prefillFor,
  quotedAmount,
  rateFor,
  retotalInvoice,
  saveCostSide,
  saveSellSide,
  sellEditable,
  toBase,
  day,
} from '../lib/debit-invoice';
import { renderDebitInvoicePdf } from '../lib/debit-invoice-pdf';
import { queueMail } from '../lib/email-queue';
import { HttpError } from '../lib/http-error';
import { nextDebitInvoiceNo, seriesYearOf } from '../lib/inquiry-no';
import { letterheadOf } from '../lib/letterhead';
import { logger } from '../lib/logger';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import {
  isOpen,
  ledgerEntries,
  ledgerTotals,
  partyBalances,
  partyKey,
  totalsOf,
} from '../lib/receivable-payable';
import { renderRequiredContainer } from '../lib/render-volumes';
import { parseId } from '../lib/request';
import { displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { type AuthContext, authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * Accounts — docs/MODULE_ACCOUNTS.md §7.
 *
 *   Awaiting Freight Inv      the queue of confirmed bookings not yet invoiced
 *   Debit Invoice             the invoice itself, from a booking or `Create New`
 *   Receivable-Payable list   who owes whom, and each party's ledger
 *
 * Every write re-reads the invoice inside its transaction and applies §3.7
 * there — never trusting the state the browser last saw.
 */
export const accountsRouter: Router = Router();
accountsRouter.use(authenticate);

const AWAITING = 'ACCOUNTS.AWAITING_FREIGHT_INV';
const INVOICE = 'ACCOUNTS.DEBIT_INVOICE';
const LEDGER = 'ACCOUNTS.RECEIVABLE_PAYABLE';

type Auth = AuthContext;

/** §3.9: cost blocks, cost totals and margin are this grant's, and only this grant's. */
function canViewBuyPrice(auth: Auth): boolean {
  return auth.isSuperadmin || auth.permissions.has(`${INVOICE}.VIEW_BUY_PRICE`);
}

async function requireBase(db: TenantDb, tenantId: bigint): Promise<BaseCurrency> {
  const base = await baseCurrency(db, tenantId);
  if (base === null) {
    throw new HttpError(
      409,
      'NO_BASE_CURRENCY',
      'This workspace has no base currency. Set one on Settings → Currency before invoicing.',
    );
  }
  return base;
}

async function dtoFor(db: TenantDb, auth: Auth, id: bigint): Promise<DebitInvoiceDto> {
  const [row, base] = await Promise.all([loadInvoice(db, id), baseCurrency(db, auth.tenantId)]);
  return invoiceDto(
    row,
    { canViewBuyPrice: canViewBuyPrice(auth), baseCurrencyCode: base === null ? '' : isoOf(base) },
    displayNameFromKey,
  );
}

/**
 * Allocates DN-<year>-<n> and inserts the header, retrying a lost race on the
 * number (UNIQUE(tenant_id, code) is the real guarantee, as with every
 * document number here). A clash on the one-live-freight-invoice index is not
 * a race to retry: somebody invoiced the booking first.
 */
async function createHeader(
  db: TenantDb,
  data: Omit<Prisma.DebitInvoiceUncheckedCreateInput, 'code' | 'seriesYear'>,
  invoiceDate: Date,
  shipmentCode: string | null,
): Promise<bigint> {
  const year = seriesYearOf(invoiceDate);
  for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
    const code = await nextDebitInvoiceNo(db, BigInt(data.tenantId), year);
    try {
      const made = await db.debitInvoice.create({
        data: { ...data, code, seriesYear: year },
        select: { id: true },
      });
      return made.id;
    } catch (error) {
      if (isUniqueViolation(error, 'code')) continue;
      if (isUniqueViolation(error)) {
        throw new HttpError(
          409,
          'ALREADY_INVOICED',
          `${shipmentCode ?? 'That booking'} has just been invoiced by somebody else. Open it from the list.`,
        );
      }
      throw error;
    }
  }
  throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a debit invoice number.');
}

// ===========================================================================
// Awaiting Freight Inv (sheet `Awaiting Debit Note`, §2.1)
// ===========================================================================

accountsRouter.get('/awaiting-freight-inv', requirePermission(`${AWAITING}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = awaitingFreightInvQuerySchema.parse(req.query);

  const ready = new Set<string>(READY_TO_INVOICE_STATUSES);
  const statuses: ShipmentStatus[] =
    query.stage === 'READY'
      ? [...READY_TO_INVOICE_STATUSES]
      : query.stage === 'EARLIER'
        ? INVOICEABLE_SHIPMENT_STATUSES.filter((s) => !ready.has(s))
        : [...INVOICEABLE_SHIPMENT_STATUSES];

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const where: Prisma.ShipmentWhereInput = {
      deletedAt: null,
      status: { in: statuses },
      // §3.1: awaiting until an ISSUED freight invoice exists. A draft keeps
      // the booking here, marked Draft, so it is carried on rather than lost.
      debitInvoices: { none: { kind: 'FREIGHT', status: 'ISSUED', deletedAt: null } },
      ...(query.shipmentType === undefined ? {} : { shipmentType: query.shipmentType }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { quotation: { code: { contains: query.search, mode: 'insensitive' } } },
              { quotation: { inquiry: { code: { contains: query.search, mode: 'insensitive' } } } },
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }),
    };

    const sortable: Record<string, Prisma.ShipmentOrderByWithRelationInput> = {
      code: { code: query.sortOrder },
      customer: { customer: { name: query.sortOrder } },
      quotationDate: { quotation: { quotationDate: query.sortOrder } },
    };

    const [found, counted] = await Promise.all([
      db.shipment.findMany({
        where,
        // A queue: the booking waiting longest first, as every worklist here.
        orderBy: sortable[query.sortBy ?? ''] ?? { id: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          ...BOOKING_SELECT,
          customer: { select: { name: true } },
          debitInvoices: {
            where: { kind: 'FREIGHT', status: 'DRAFT', deletedAt: null },
            select: { id: true, code: true },
            take: 1,
          },
        },
      }),
      db.shipment.count({ where }),
    ]);
    return { rows: found, total: counted };
  });

  const data: AwaitingFreightInvRow[] = rows.map((row) => {
    const draft = row.debitInvoices[0] ?? null;
    return {
      shipmentId: row.id.toString(),
      bookingCode: row.code,
      bookingStatus: row.status,
      inquiryCode: row.quotation.inquiry.code,
      quotationId: row.quotation.id.toString(),
      quotationCode: row.quotation.code,
      quotationDate: day(row.quotation.quotationDate) ?? '',
      customerName: row.customer.name,
      commodity: row.commodities.map((c) => c.commodityItem.name).join(', ') || '—',
      shipmentType: row.shipmentType,
      polName: row.pol.name,
      polCode: row.pol.portCode,
      podName: row.pod.name,
      podCode: row.pod.portCode,
      requiredContainer: renderRequiredContainer(row.quotation.lines, row.quotation.inquiry.volumes),
      quotedAmount: quotedAmount(row.quotation.lines),
      invoiceId: draft?.id.toString() ?? null,
      invoiceCode: draft?.code ?? null,
      invoiceState: draft === null ? 'AWAITING' : 'DRAFT',
    };
  });

  const payload: ApiSuccess<AwaitingFreightInvRow[]> = {
    success: true,
    data,
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});

/** What `Make invoice` opens on (§3.5). Nothing is saved by reading it. */
accountsRouter.get(
  '/shipments/:id/debit-invoice/prefill',
  requirePermission(`${AWAITING}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const data = await withTenant(auth.tenantId, async (db) =>
      prefillFor(db, {
        tenantId: auth.tenantId,
        shipmentId,
        base: await requireBase(db, auth.tenantId),
        canViewBuyPrice: canViewBuyPrice(auth),
        today: new Date(),
      }),
    );
    const payload: ApiSuccess<DebitInvoicePrefillDto> = { success: true, data };
    res.json(payload);
  },
);

/** `Drat` on a booking's first save (sheet B64): the freight invoice is born. */
accountsRouter.post(
  '/shipments/:id/debit-invoice',
  requirePermission(`${AWAITING}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = debitInvoiceSaveSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const base = await requireBase(db, auth.tenantId);
      const shipment = await db.shipment.findFirst({
        where: { id: shipmentId, deletedAt: null },
        select: { id: true, code: true, status: true, customerId: true, quotationId: true },
      });
      if (shipment === null) throw HttpError.notFound('Booking not found.');
      await assertInvoiceable(db, shipment);

      const invoiceDate = new Date(`${input.invoiceDate}T00:00:00.000Z`);
      const currencyId = BigInt(input.currencyId);
      const id = await createHeader(
        db,
        {
          tenantId: auth.tenantId,
          kind: 'FREIGHT',
          shipmentId: shipment.id,
          quotationId: shipment.quotationId,
          customerId: shipment.customerId,
          invoiceDate,
          currencyId,
          currencyCode: await currencyOf(db, currencyId),
          conversionRate: rateFor(currencyId, input.conversionRate, base),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        invoiceDate,
        shipment.code,
      );

      await saveSellSide(db, { tenantId: auth.tenantId, userId: auth.userId, invoiceId: id, kind: 'FREIGHT', input, base });
      if (input.costs !== undefined && canViewBuyPrice(auth)) {
        await saveCostSide(db, { tenantId: auth.tenantId, userId: auth.userId, invoiceId: id, costs: input.costs, base });
      }
      await retotalInvoice(db, id);
      return dtoFor(db, auth, id);
    });

    const payload: ApiSuccess<DebitInvoiceDto> = { success: true, data };
    res.status(201).json(payload);
  },
);

// ===========================================================================
// Debit Invoice (sheet `Debit note (Other)`, §2.3)
// ===========================================================================

/** The form's lookup lists. Shared by Make invoice and Edit, hence either key. */
accountsRouter.get(
  '/debit-invoices/options',
  requireAnyPermission(`${AWAITING}.CREATE`, `${INVOICE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const data = await withTenant(auth.tenantId, async (db): Promise<DebitInvoiceOptionsDto> => {
      const [base, inactive] = await Promise.all([baseCurrency(db, auth.tenantId), inactiveMasters(db)]);
      const live = { deletedAt: null, isActive: true };
      const [currencies, costHeads, sizes, units, carriers, agents, vendors, customers] = await Promise.all([
        db.currency.findMany({
          where: { ...live, ...excludeInactive(inactive, 'currency') },
          select: { id: true, currency: true },
          orderBy: { currency: 'asc' },
        }),
        db.costHead.findMany({
          where: live,
          select: { id: true, name: true, unitId: true, unit: { select: { name: true } } },
          orderBy: { name: 'asc' },
        }),
        db.containerSize.findMany({
          where: { ...live, ...excludeInactive(inactive, 'container_size') },
          select: { id: true, name: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        db.costUnit.findMany({
          where: { ...live, ...excludeInactive(inactive, 'cost_unit') },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.carrier.findMany({
          where: { ...live, ...excludeInactive(inactive, 'carrier') },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.agent.findMany({ where: live, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        db.vendor.findMany({ where: live, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        db.customer.findMany({ where: live, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      ]);
      const rates = await resolveRates(
        db,
        auth.tenantId,
        currencies.map((c) => c.id),
      );
      const option = (r: { id: bigint; name: string }) => ({ id: r.id.toString(), label: r.name });
      return {
        baseCurrencyId: base?.id.toString() ?? null,
        baseCurrencyCode: base === null ? null : isoOf(base),
        currencies: currencies.map((c) => ({
          id: c.id.toString(),
          label: c.currency,
          code: isoCurrency(c.currency),
          rate: rates.get(c.id.toString())?.rate.toString() ?? null,
        })),
        costHeads: costHeads.map((h) => ({
          id: h.id.toString(),
          label: h.name,
          unitId: h.unitId.toString(),
          unitName: h.unit.name,
        })),
        containerSizes: sizes.map(option),
        costUnits: units.map(option),
        carriers: carriers.map(option),
        agents: agents.map(option),
        vendors: vendors.map(option),
        customers: customers.map(option),
        canViewBuyPrice: canViewBuyPrice(auth),
      };
    });
    const payload: ApiSuccess<DebitInvoiceOptionsDto> = { success: true, data };
    res.json(payload);
  },
);

/**
 * PAID and PARTIAL are derived from the receipts (§3.7), so filtering on them
 * needs the sums — asked of the database here rather than by loading every
 * issued invoice to add up in memory.
 */
async function idsByPayment(db: TenantDb, tenantId: bigint, want: 'PAID' | 'PARTIAL'): Promise<bigint[]> {
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    SELECT i.id
      FROM debit_invoice i
      LEFT JOIN (
        SELECT debit_invoice_id, SUM(amount) AS received
          FROM debit_invoice_receipt
         WHERE deleted_at IS NULL
         GROUP BY debit_invoice_id
      ) r ON r.debit_invoice_id = i.id
     WHERE i.tenant_id = ${tenantId}
       AND i.deleted_at IS NULL
       AND i.status = 'ISSUED'
       AND ${
         want === 'PAID'
           ? Prisma.sql`COALESCE(r.received, 0) >= i.total_amount`
           : Prisma.sql`COALESCE(r.received, 0) > 0 AND COALESCE(r.received, 0) < i.total_amount`
       }
  `;
  return rows.map((r) => r.id);
}

accountsRouter.get('/debit-invoices', requirePermission(`${INVOICE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = debitInvoiceListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    let statusWhere: Prisma.DebitInvoiceWhereInput = {};
    if (query.status === 'DRAFT' || query.status === 'CANCELLED') statusWhere = { status: query.status };
    else if (query.status === 'UNPAID') {
      statusWhere = { status: 'ISSUED', receipts: { none: { deletedAt: null } } };
    } else if (query.status === 'PAID' || query.status === 'PARTIAL') {
      statusWhere = { id: { in: await idsByPayment(db, auth.tenantId, query.status) } };
    }

    const where: Prisma.DebitInvoiceWhereInput = {
      deletedAt: null,
      ...statusWhere,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
              { shipment: { code: { contains: query.search, mode: 'insensitive' } } },
              { quotation: { code: { contains: query.search, mode: 'insensitive' } } },
              { quotation: { inquiry: { code: { contains: query.search, mode: 'insensitive' } } } },
            ],
          }),
    };

    const sortable: Record<string, Prisma.DebitInvoiceOrderByWithRelationInput> = {
      code: { code: query.sortOrder },
      customer: { customer: { name: query.sortOrder } },
      invoiceDate: { invoiceDate: query.sortOrder },
      amount: { totalAmount: query.sortOrder },
    };

    const [found, counted] = await Promise.all([
      db.debitInvoice.findMany({
        where,
        // A register of documents, newest first — unlike the queue above.
        orderBy: sortable[query.sortBy ?? ''] ?? { id: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          code: true,
          kind: true,
          status: true,
          invoiceDate: true,
          currencyCode: true,
          totalAmount: true,
          customer: { select: { name: true } },
          shipment: {
            select: {
              code: true,
              shipmentType: true,
              pol: { select: { name: true, portCode: true } },
              pod: { select: { name: true, portCode: true } },
            },
          },
          quotation: {
            select: { id: true, code: true, quotationDate: true, inquiry: { select: { code: true } } },
          },
          receipts: { where: { deletedAt: null }, select: { amount: true } },
        },
      }),
      db.debitInvoice.count({ where }),
    ]);
    return { rows: found, total: counted };
  });

  const data: DebitInvoiceListRow[] = rows.map((row) => {
    const payment = paymentOf(row.totalAmount, row.receipts);
    return {
      id: row.id.toString(),
      code: row.code,
      kind: row.kind,
      inquiryCode: row.quotation?.inquiry.code ?? null,
      quotationId: row.quotation?.id.toString() ?? null,
      quotationCode: row.quotation?.code ?? null,
      quotationDate: day(row.quotation?.quotationDate ?? null),
      bookingCode: row.shipment?.code ?? null,
      customerName: row.customer.name,
      shipmentType: row.shipment?.shipmentType ?? null,
      polName: row.shipment?.pol.name ?? null,
      polCode: row.shipment?.pol.portCode ?? null,
      podName: row.shipment?.pod.name ?? null,
      podCode: row.shipment?.pod.portCode ?? null,
      invoiceDate: day(row.invoiceDate) ?? '',
      totalAmount: money(row.totalAmount),
      currencyCode: row.currencyCode,
      receivedAmount: money(payment.received),
      outstandingAmount: money(payment.outstanding),
      status: row.status,
      displayStatus: debitInvoiceDisplayStatus(row.status, payment.status),
      cancellable: cancellable(row, row.receipts.length),
    };
  });

  const payload: ApiSuccess<DebitInvoiceListRow[]> = {
    success: true,
    data,
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});

/** `Create New` (sheet O5): an OTHER invoice, raised by hand (§3.2). */
accountsRouter.post('/debit-invoices', requirePermission(`${INVOICE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = debitInvoiceSaveSchema.parse(req.body);
  if (input.customerId === null) throw HttpError.badRequest('Choose the customer to bill.');

  const data = await withTenant(auth.tenantId, async (db) => {
    const base = await requireBase(db, auth.tenantId);
    const customer = await db.customer.findFirst({
      where: { id: BigInt(input.customerId!), deletedAt: null },
      select: { id: true },
    });
    if (customer === null) throw HttpError.badRequest('That customer is not available.');

    const invoiceDate = new Date(`${input.invoiceDate}T00:00:00.000Z`);
    const currencyId = BigInt(input.currencyId);
    const id = await createHeader(
      db,
      {
        tenantId: auth.tenantId,
        kind: 'OTHER',
        customerId: customer.id,
        invoiceDate,
        currencyId,
        currencyCode: await currencyOf(db, currencyId),
        conversionRate: rateFor(currencyId, input.conversionRate, base),
        createdBy: auth.userId,
        updatedBy: auth.userId,
      },
      invoiceDate,
      null,
    );

    await saveSellSide(db, { tenantId: auth.tenantId, userId: auth.userId, invoiceId: id, kind: 'OTHER', input, base });
    if (input.costs !== undefined && canViewBuyPrice(auth)) {
      await saveCostSide(db, { tenantId: auth.tenantId, userId: auth.userId, invoiceId: id, costs: input.costs, base });
    }
    await retotalInvoice(db, id);
    return dtoFor(db, auth, id);
  });

  const payload: ApiSuccess<DebitInvoiceDto> = { success: true, data };
  res.status(201).json(payload);
});

accountsRouter.get('/debit-invoices/:id', requirePermission(`${INVOICE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');
  const data = await withTenant(auth.tenantId, (db) => dtoFor(db, auth, id));
  const payload: ApiSuccess<DebitInvoiceDto> = { success: true, data };
  res.json(payload);
});

/** `Drat` again, or Edit from the list (§3.7). */
accountsRouter.patch('/debit-invoices/:id', requirePermission(`${INVOICE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');
  const input = debitInvoiceSaveSchema.parse(req.body);

  if (input.costs !== undefined && !canViewBuyPrice(auth)) {
    throw HttpError.forbidden('You do not have permission to change what the suppliers charged.');
  }

  const data = await withTenant(auth.tenantId, async (db) => {
    const base = await requireBase(db, auth.tenantId);
    const row = await loadInvoice(db, id);
    if (row.status === 'CANCELLED') {
      throw new HttpError(409, 'INVOICE_CANCELLED', `${row.code} was cancelled and cannot be changed.`);
    }
    if (!sellEditable(row, row.receipts.length)) {
      throw new HttpError(
        409,
        'SELL_SIDE_LOCKED',
        `Money has been received against ${row.code}, so what the customer was billed can no ` +
          'longer change. The cost side can still be updated; to correct the bill, the receipt ' +
          'has to be reversed first.',
      );
    }

    await saveSellSide(db, { tenantId: auth.tenantId, userId: auth.userId, invoiceId: id, kind: row.kind, input, base });
    if (input.costs !== undefined) {
      await saveCostSide(db, { tenantId: auth.tenantId, userId: auth.userId, invoiceId: id, costs: input.costs, base });
    }
    await retotalInvoice(db, id);
    return dtoFor(db, auth, id);
  });

  const payload: ApiSuccess<DebitInvoiceDto> = { success: true, data };
  res.json(payload);
});

/** The cost side alone — what stays editable after money is received (§3.7). */
accountsRouter.put(
  '/debit-invoices/:id/costs',
  requirePermission(`${INVOICE}.EDIT`),
  requirePermission(`${INVOICE}.VIEW_BUY_PRICE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'debit invoice');
    const input = debitInvoiceCostsSaveSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const base = await requireBase(db, auth.tenantId);
      const row = await loadInvoice(db, id);
      if (!costEditable(row)) {
        throw new HttpError(409, 'INVOICE_CANCELLED', `${row.code} was cancelled and cannot be changed.`);
      }
      await saveCostSide(db, { tenantId: auth.tenantId, userId: auth.userId, invoiceId: id, costs: input.costs, base });
      await retotalInvoice(db, id);
      return dtoFor(db, auth, id);
    });

    const payload: ApiSuccess<DebitInvoiceDto> = { success: true, data };
    res.json(payload);
  },
);

// ------------------------------------------------------ Print, Send

/** The document, rendered from what is stored (§9). */
async function invoiceDocument(
  db: TenantDb,
  tenantId: bigint,
  row: InvoiceRow,
): Promise<{ pdf: Buffer; filename: string }> {
  const [letterhead, tenant, base] = await Promise.all([
    letterheadOf(db, tenantId),
    db.tenant.findFirst({ where: { id: tenantId }, select: { logoFile: true } }),
    baseCurrency(db, tenantId),
  ]);

  let logo: Buffer | null = null;
  if (tenant?.logoFile != null && tenant.logoFile !== '') {
    try {
      const file = await openFile(tenantId, tenant.logoFile);
      const parts: Buffer[] = [];
      for await (const chunk of file.stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      logo = Buffer.concat(parts);
    } catch {
      logo = null;
    }
  }

  const b = row.shipment;
  const isBase = base !== null && row.currencyId === base.id;
  const pdf = await renderDebitInvoicePdf({
    companyName: letterhead.companyName,
    companyAddress: letterhead.companyAddress,
    logo,
    invoiceNo: row.code,
    invoiceDate: day(row.invoiceDate) ?? '',
    status: row.status,
    customerName: row.customer.name,
    customerAddress: row.customer.address,
    booking:
      b === null
        ? null
        : {
            bookingNo: b.code,
            quotationNo: b.quotation.code,
            inquiryNo: b.quotation.inquiry.code,
            shipmentType: b.shipmentType === 'AIR' ? 'Air' : 'Sea',
            isAir: b.shipmentType === 'AIR',
            polName: b.pol.name,
            podName: b.pod.name,
            carrierName: b.carrier.name,
            commodity: b.commodities.map((c) => c.commodityItem.name).join(', ') || '—',
            requiredContainer: renderRequiredContainer(b.quotation.lines, b.quotation.inquiry.volumes),
          },
    currencyCode: row.currencyCode,
    lines: row.lines.map((line) => ({
      description: line.costHeadName,
      containerSize: line.containerSizeName,
      unit: line.unitName,
      quantity: line.quantity.toString(),
      unitPrice: line.unitPrice.toFixed(2),
      amount: dec(line.amount).toFixed(2),
    })),
    total: row.totalAmount.toFixed(2),
    amountInWords: amountInWords(row.totalAmount.toFixed(2), row.currencyCode),
    baseEquivalent:
      isBase || base === null
        ? null
        : {
            baseCurrencyCode: isoOf(base),
            rate: row.conversionRate.toString(),
            totalBase: row.totalAmountBase.toFixed(2),
          },
  });
  return { pdf, filename: `${row.code}.pdf` };
}

accountsRouter.get('/debit-invoices/:id/pdf', requirePermission(`${INVOICE}.EXPORT_PDF`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');
  const { pdf, filename } = await withTenant(auth.tenantId, async (db) =>
    invoiceDocument(db, auth.tenantId, await loadInvoice(db, id)),
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.send(pdf);
});

/**
 * `Save & Send` (sheet C64): issues a draft, or sends an issued invoice again.
 *
 * The PDF is rendered, stored and attached — the advise's pattern — so what
 * the customer receives is the page that was printed. A render that fails
 * logs and sends the letter without it rather than failing an issue that has
 * already happened (§5 rule 6).
 */
accountsRouter.post('/debit-invoices/:id/send', requirePermission(`${INVOICE}.SEND`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');
  const input = debitInvoiceSendSchema.parse(req.body);

  const sent = await withTenant(auth.tenantId, async (db) => {
    const row = await loadInvoice(db, id);
    if (row.status === 'CANCELLED') {
      throw new HttpError(409, 'INVOICE_CANCELLED', `${row.code} was cancelled and cannot be sent.`);
    }
    if (row.lines.length === 0) {
      throw new HttpError(409, 'NO_LINES', 'Add at least one selling line before sending the invoice.');
    }
    const now = new Date();
    await db.debitInvoice.update({
      where: { id },
      data: {
        ...(row.status === 'DRAFT' ? { status: 'ISSUED' as const, issuedAt: now, issuedBy: auth.userId } : {}),
        sentAt: now,
        sentBy: auth.userId,
        recipientEmails: [...new Set(input.to)],
        updatedBy: auth.userId,
      },
    });
    return loadInvoice(db, id);
  });

  const attachments = await withTenant(auth.tenantId, async (db) => {
    try {
      const doc = await invoiceDocument(db, auth.tenantId, sent);
      const stored = await putFile(auth.tenantId, 'debit-invoice', {
        buffer: doc.pdf,
        originalname: doc.filename,
        mimetype: 'application/pdf',
        size: doc.pdf.length,
      });
      await db.debitInvoice.update({ where: { id }, data: { pdfFile: stored.key, updatedBy: auth.userId } });
      return [{ filename: doc.filename, contentType: 'application/pdf', storageKey: stored.key }];
    } catch (error) {
      logger.error({ err: error, debitInvoiceId: id.toString() }, 'debit invoice PDF not attached');
      return [];
    }
  });

  await queueMail({
    attachments,
    tenantId: auth.tenantId,
    templateKey: 'DEBIT_INVOICE_SENT',
    to: input.to,
    variables: {
      invoiceNo: sent.code,
      invoiceDate: day(sent.invoiceDate) ?? '',
      customerName: sent.customer.name,
      bookingNo: sent.shipment?.code ?? '—',
      total: `${sent.currencyCode} ${sent.totalAmount.toFixed(2)}`,
    },
    relatedType: 'debit_invoice',
    relatedId: id,
    actorId: auth.userId,
    fallback: {
      subject:
        sent.shipment === null
          ? `Debit Note ${sent.code}`
          : `Debit Note ${sent.code} — Booking no : ${sent.shipment.code}`,
      bodyText:
        `Dear ${sent.customer.name},\n\nPlease find attached debit note ${sent.code} dated ` +
        `${day(sent.invoiceDate) ?? ''} for ${sent.currencyCode} ${sent.totalAmount.toFixed(2)}` +
        `${sent.shipment === null ? '' : `, against booking ${sent.shipment.code}`}.`,
    },
  });

  const data = await withTenant(auth.tenantId, (db) => dtoFor(db, auth, id));
  const payload: ApiSuccess<DebitInvoiceDto> = { success: true, data };
  res.json(payload);
});

/** `Cancel invoice` (E64) and the list's `Cancel` (P8). Reason mandatory. */
accountsRouter.post('/debit-invoices/:id/cancel', requirePermission(`${INVOICE}.CANCEL`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');
  const input = debitInvoiceCancelSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadInvoice(db, id);
    if (row.status === 'CANCELLED') {
      throw new HttpError(409, 'INVOICE_CANCELLED', `${row.code} was already cancelled.`);
    }
    if (!cancellable(row, row.receipts.length)) {
      throw new HttpError(
        409,
        'MONEY_RECEIVED',
        `Money has been received against ${row.code}, so it cannot be cancelled while that ` +
          'receipt stands.',
      );
    }
    await db.debitInvoice.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: auth.userId,
        cancelReason: input.reason,
        updatedBy: auth.userId,
      },
    });
    return dtoFor(db, auth, id);
  });

  const payload: ApiSuccess<DebitInvoiceDto> = { success: true, data };
  res.json(payload);
});

/** `Receive` (sheet N8, rows 15–20). */
accountsRouter.post('/debit-invoices/:id/receipts', requirePermission(`${INVOICE}.RECEIVE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'debit invoice');
  const input = debitInvoiceReceiptSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadInvoice(db, id);
    if (row.status !== 'ISSUED') {
      throw new HttpError(
        409,
        'NOT_ISSUED',
        row.status === 'DRAFT'
          ? `${row.code} is still a draft. Send it before recording money against it.`
          : `${row.code} was cancelled.`,
      );
    }
    const payment = paymentOf(row.totalAmount, row.receipts);
    const amount = new Prisma.Decimal(input.amount);
    if (amount.greaterThan(payment.outstanding)) {
      throw new HttpError(
        409,
        'OVER_RECEIVED',
        `That is more than the ${row.currencyCode} ${payment.outstanding.toFixed(2)} still outstanding on ${row.code}.`,
      );
    }
    /*
     * At the invoice's frozen rate (§3.4). The receipt that closes the invoice
     * takes whatever base is left rather than its own rounded product, so a
     * fully received invoice comes to exactly zero in both columns of the
     * Receivable-Payable list, not a stray 0.0001.
     */
    const receivedBase = row.receipts.reduce((sum, r) => sum.plus(r.amountBase), new Prisma.Decimal(0));
    const amountBase = amount.equals(payment.outstanding)
      ? row.totalAmountBase.minus(receivedBase)
      : toBase(amount, row.conversionRate);

    await db.debitInvoiceReceipt.create({
      data: {
        tenantId: auth.tenantId,
        debitInvoiceId: id,
        paymentDate: new Date(`${input.paymentDate}T00:00:00.000Z`),
        amount,
        amountBase,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      },
    });
    return dtoFor(db, auth, id);
  });

  const payload: ApiSuccess<DebitInvoiceDto> = { success: true, data };
  res.status(201).json(payload);
});

// ------------------------------------------ the supplier's invoice file

/** "Upload Invoice" (sheet E27, E36, E44). Only the key is stored (§2). */
accountsRouter.post(
  '/debit-invoices/:id/costs/:costId/file',
  requirePermission(`${INVOICE}.EDIT`),
  requirePermission(`${INVOICE}.VIEW_BUY_PRICE`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'debit invoice');
    const costId = parseId(req.params.costId, 'cost block');
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose a file to upload.');

    const stored = await withTenant(auth.tenantId, async (db) => {
      const row = await loadInvoice(db, id);
      if (!costEditable(row)) {
        throw new HttpError(409, 'INVOICE_CANCELLED', `${row.code} was cancelled and cannot be changed.`);
      }
      const cost = await db.debitInvoiceCost.findFirst({
        where: { id: costId, debitInvoiceId: id, deletedAt: null },
        select: { id: true, supplierInvoiceFile: true },
      });
      if (cost === null) throw HttpError.notFound('That cost block is not on this invoice. Save it first.');

      const put = await putFile(auth.tenantId, 'supplier-invoice', file);
      await db.debitInvoiceCost.update({
        where: { id: costId },
        data: { supplierInvoiceFile: put.key, updatedBy: auth.userId },
      });
      // Removed after the row points at the new one, so a failure here never
      // leaves the record naming a file that is gone.
      if (cost.supplierInvoiceFile !== null) await removeFile(auth.tenantId, cost.supplierInvoiceFile);
      return put;
    });

    const payload: ApiSuccess<{ fileName: string }> = {
      success: true,
      data: { fileName: displayNameFromKey(stored.key) },
    };
    res.status(201).json(payload);
  },
);

accountsRouter.get(
  '/debit-invoices/:id/costs/:costId/file',
  requirePermission(`${INVOICE}.VIEW_BUY_PRICE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'debit invoice');
    const costId = parseId(req.params.costId, 'cost block');

    const key = await withTenant(auth.tenantId, async (db) => {
      const cost = await db.debitInvoiceCost.findFirst({
        where: { id: costId, debitInvoiceId: id, deletedAt: null, debitInvoice: { deletedAt: null } },
        select: { supplierInvoiceFile: true },
      });
      if (cost === null || cost.supplierInvoiceFile === null) {
        throw HttpError.notFound('No supplier invoice has been uploaded for this block.');
      }
      return cost.supplierInvoiceFile;
    });

    const { stream, sizeBytes } = await openFile(auth.tenantId, key);
    res.setHeader('Content-Length', sizeBytes);
    res.setHeader('Content-Disposition', `attachment; filename="${displayNameFromKey(key).replace(/"/g, '')}"`);
    stream.pipe(res);
  },
);

// ===========================================================================
// Receivable-Payable list (sheet `Receiveable-Payable list`, §2.4)
// ===========================================================================

interface PartyName {
  code: string;
  name: string;
}

/** Names and codes for the parties a page needs, one query per type. */
async function partyNames(
  db: TenantDb,
  ids: Map<LedgerPartyType, bigint[]> | 'ALL',
): Promise<Map<string, PartyName & { type: LedgerPartyType; id: bigint }>> {
  const out = new Map<string, PartyName & { type: LedgerPartyType; id: bigint }>();
  const pick = (type: LedgerPartyType) =>
    ids === 'ALL' ? { deletedAt: null } : { deletedAt: null, id: { in: ids.get(type) ?? [] } };
  const skip = (type: LedgerPartyType) => ids !== 'ALL' && (ids.get(type) ?? []).length === 0;
  const select = { id: true, code: true, name: true } as const;

  const [customers, agents, carriers, vendors] = await Promise.all([
    skip('CUSTOMER') ? Promise.resolve([]) : db.customer.findMany({ where: pick('CUSTOMER'), select }),
    skip('AGENT') ? Promise.resolve([]) : db.agent.findMany({ where: pick('AGENT'), select }),
    skip('CARRIER') ? Promise.resolve([]) : db.carrier.findMany({ where: pick('CARRIER'), select }),
    skip('VENDOR') ? Promise.resolve([]) : db.vendor.findMany({ where: pick('VENDOR'), select }),
  ]);
  for (const [type, rows] of [
    ['CUSTOMER', customers],
    ['AGENT', agents],
    ['CARRIER', carriers],
    ['VENDOR', vendors],
  ] as const) {
    for (const r of rows) out.set(partyKey(type, r.id), { type, id: r.id, code: r.code, name: r.name });
  }
  return out;
}

accountsRouter.get('/receivable-payable', requirePermission(`${LEDGER}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = receivablePayableQuerySchema.parse(req.query);

  const { rows, total, totals } = await withTenant(auth.tenantId, async (db) => {
    const base = await baseCurrency(db, auth.tenantId);
    const balances = await partyBalances(db, auth.tenantId, base);

    let names: Awaited<ReturnType<typeof partyNames>>;
    if (query.openOnly) {
      const wanted = new Map<LedgerPartyType, bigint[]>();
      for (const [key, balance] of balances) {
        if (!isOpen(balance) && !balance.rateMissing) continue;
        const [type, id] = key.split(':') as [LedgerPartyType, string];
        wanted.set(type, [...(wanted.get(type) ?? []), BigInt(id)]);
      }
      names = await partyNames(db, wanted);
    } else {
      names = await partyNames(db, 'ALL');
    }

    const needle = query.search?.toLowerCase();
    const listed = [...names.values()]
      .filter((p) => query.partyType === undefined || p.type === query.partyType)
      .filter((p) => needle === undefined || p.name.toLowerCase().includes(needle) || p.code.toLowerCase().includes(needle))
      .sort((a, b) => (query.sortOrder === 'desc' ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));

    const zero = {
      receivableUsd: new Prisma.Decimal(0),
      receivableBase: new Prisma.Decimal(0),
      payableUsd: new Prisma.Decimal(0),
      payableBase: new Prisma.Decimal(0),
      rateMissing: false,
    };
    const withBalance = listed.map((p) => ({ party: p, balance: balances.get(partyKey(p.type, p.id)) ?? zero }));
    const page = withBalance.slice((query.page - 1) * query.limit, query.page * query.limit);

    return {
      rows: page.map<ReceivablePayableRow>(({ party, balance }) => ({
        partyType: party.type,
        partyId: party.id.toString(),
        partyCode: party.code,
        partyName: party.name,
        receivableUsd: money(balance.receivableUsd),
        receivableBase: money(balance.receivableBase),
        payableUsd: money(balance.payableUsd),
        payableBase: money(balance.payableBase),
        rateMissing: balance.rateMissing,
      })),
      total: withBalance.length,
      // The sheet's "Total =" row (C19), over every page, not just this one.
      totals: totalsOf(withBalance.map((w) => w.balance)),
    };
  });

  const payload: ApiSuccess<ReceivablePayableRow[]> = {
    success: true,
    data: rows,
    meta: { ...buildMeta(query.page, query.limit, total), totals: { ...totals } },
  };
  res.json(payload);
});

/** One party's ledger — the `Ledger.` sheet, read-only until payments exist (§12 Q9). */
accountsRouter.get(
  '/receivable-payable/:partyType/:partyId',
  requirePermission(`${LEDGER}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const rawType = String(req.params.partyType ?? '').toUpperCase();
    if (!(LEDGER_PARTY_TYPES as readonly string[]).includes(rawType)) {
      throw HttpError.badRequest('That is not a kind of party this list keeps.');
    }
    const partyType = rawType as LedgerPartyType;
    const partyId = parseId(req.params.partyId, 'party');

    const data = await withTenant(auth.tenantId, async (db): Promise<LedgerDto> => {
      const names = await partyNames(db, new Map([[partyType, [partyId]]]));
      const party = names.get(partyKey(partyType, partyId));
      if (party === undefined) throw HttpError.notFound('That party was not found.');

      const base = await baseCurrency(db, auth.tenantId);
      const entries = await ledgerEntries(db, auth.tenantId, base, { type: partyType, id: partyId });
      return {
        partyType,
        partyId: partyId.toString(),
        partyCode: party.code,
        partyName: party.name,
        baseCurrencyCode: base === null ? null : isoOf(base),
        entries,
        totals: ledgerTotals(entries),
      };
    });

    const payload: ApiSuccess<LedgerDto> = { success: true, data };
    res.json(payload);
  },
);
