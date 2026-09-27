import {
  INVOICEABLE_SHIPMENT_STATUSES,
  isoCurrency,
  type LedgerEntryDto,
  type LedgerPartyType,
  type ReceivablePayableTotals,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import type { BaseCurrency } from './currency-rate';
import { resolveRates } from './currency-rate';
import { dec, describeLines, money, paymentOf, toBase } from './debit-invoice';
import type { TenantDb } from './tenant-client';

/**
 * Who owes whom — docs/MODULE_ACCOUNTS.md §3.6, §14.6, §14.7.
 *
 * Computed from the documents on every read, not kept in a second table. The
 * books (§14) did not change that: a voucher that pays or banks against a
 * party leaves a settlement row beside it, and those rows are documents too.
 *
 *   receivable (customer)          = issued invoices − receipts + opening
 *   payable (carrier/agent/vendor) = cost blocks of issued invoices − payments + opening
 *   opening                        = the CRM figure − what vouchers settled against it
 *   unbilled                       = money on jobs whose debit invoice is not issued yet
 *
 * The USD columns carry what is denominated in US dollars; the Base columns
 * carry everything, converted (§3.6, §12 Q5).
 */

const ZERO = new Prisma.Decimal(0);

export interface Balance {
  receivableUsd: Prisma.Decimal;
  receivableBase: Prisma.Decimal;
  unbilledUsd: Prisma.Decimal;
  unbilledBase: Prisma.Decimal;
  payableUsd: Prisma.Decimal;
  payableBase: Prisma.Decimal;
  rateMissing: boolean;
}

type Side = 'RECEIVABLE' | 'PAYABLE' | 'UNBILLED';

export const emptyBalance = (): Balance => ({
  receivableUsd: ZERO,
  receivableBase: ZERO,
  unbilledUsd: ZERO,
  unbilledBase: ZERO,
  payableUsd: ZERO,
  payableBase: ZERO,
  rateMissing: false,
});

export const partyKey = (type: LedgerPartyType, id: bigint | string): string => `${type}:${id.toString()}`;

/** One figure landing on one column pair of one party's row. */
function post(
  into: Map<string, Balance>,
  key: string,
  side: Side,
  currencyCode: string,
  amount: Prisma.Decimal,
  base: Prisma.Decimal | null,
): void {
  const acc = into.get(key) ?? emptyBalance();
  const usd = currencyCode === 'USD' ? amount : ZERO;
  if (base === null) acc.rateMissing = true;
  const baseValue = base ?? ZERO;
  if (side === 'RECEIVABLE') {
    acc.receivableUsd = acc.receivableUsd.plus(usd);
    acc.receivableBase = acc.receivableBase.plus(baseValue);
  } else if (side === 'PAYABLE') {
    acc.payableUsd = acc.payableUsd.plus(usd);
    acc.payableBase = acc.payableBase.plus(baseValue);
  } else {
    acc.unbilledUsd = acc.unbilledUsd.plus(usd);
    acc.unbilledBase = acc.unbilledBase.plus(baseValue);
  }
  into.set(key, acc);
}

export function isOpen(b: Balance): boolean {
  return !(
    b.receivableUsd.isZero() &&
    b.receivableBase.isZero() &&
    b.unbilledUsd.isZero() &&
    b.unbilledBase.isZero() &&
    b.payableUsd.isZero() &&
    b.payableBase.isZero()
  );
}

interface PartyFilter {
  type: LedgerPartyType;
  id: bigint;
}

/**
 * One movement of an opening balance: the CRM figure itself (positive), or a
 * voucher that settled part of it (negative). Both are converted at today's
 * rate, because nothing froze one — so a fully settled opening nets to zero.
 */
interface OpeningMovement {
  key: string;
  side: 'RECEIVABLE' | 'PAYABLE';
  amount: Prisma.Decimal;
  currencyId: bigint;
  currencyCode: string;
  date: Date;
  settlement: { journalEntryId: bigint; journalEntryCode: string } | null;
}

/**
 * The CRM opening figures, each party's two columns on their own sides: what
 * they owe us (agent_owe, customer_owe, vendor_owe) is receivable, what we owe
 * them (we_owe) is payable — the agent's pair since 20260819180000, the
 * customer's and vendor's since §14.14. Carriers have none. Less what vouchers
 * have settled against them (§14.6).
 */
async function openingMovements(db: TenantDb, filter?: PartyFilter): Promise<OpeningMovement[]> {
  const wants = (type: LedgerPartyType): boolean => filter === undefined || filter.type === type;
  const idFilter = (type: LedgerPartyType) => (filter !== undefined && filter.type === type ? { id: filter.id } : {});
  const currency = { select: { currency: true } } as const;

  const [customers, vendors, agents, settlements] = await Promise.all([
    wants('CUSTOMER')
      ? db.customer.findMany({
          where: {
            ...idFilter('CUSTOMER'),
            deletedAt: null,
            openingCurrencyId: { not: null },
            OR: [{ weOwe: { not: null } }, { customerOwe: { not: null } }],
          },
          select: { id: true, weOwe: true, customerOwe: true, openingCurrencyId: true, openingCurrency: currency, createdAt: true },
        })
      : Promise.resolve([]),
    wants('VENDOR')
      ? db.vendor.findMany({
          where: {
            ...idFilter('VENDOR'),
            deletedAt: null,
            openingCurrencyId: { not: null },
            OR: [{ weOwe: { not: null } }, { vendorOwe: { not: null } }],
          },
          select: { id: true, weOwe: true, vendorOwe: true, openingCurrencyId: true, openingCurrency: currency, createdAt: true },
        })
      : Promise.resolve([]),
    wants('AGENT')
      ? db.agent.findMany({
          where: {
            ...idFilter('AGENT'),
            deletedAt: null,
            openingCurrencyId: { not: null },
            OR: [{ weOwe: { not: null } }, { agentOwe: { not: null } }],
          },
          select: { id: true, weOwe: true, agentOwe: true, openingCurrencyId: true, openingCurrency: currency, createdAt: true },
        })
      : Promise.resolve([]),
    db.openingSettlement.findMany({
      where: {
        deletedAt: null,
        ...(filter === undefined
          ? {}
          : {
              partyType: filter.type,
              ...(filter.type === 'CUSTOMER'
                ? { customerId: filter.id }
                : filter.type === 'AGENT'
                  ? { agentId: filter.id }
                  : filter.type === 'VENDOR'
                    ? { vendorId: filter.id }
                    : { id: -1n }),
            }),
      },
      select: {
        side: true,
        partyType: true,
        customerId: true,
        agentId: true,
        vendorId: true,
        currencyId: true,
        currencyCode: true,
        amount: true,
        settlementDate: true,
        journalEntry: { select: { id: true, code: true } },
      },
    }),
  ]);

  const out: OpeningMovement[] = [];
  const add = (
    type: LedgerPartyType,
    id: bigint,
    side: 'RECEIVABLE' | 'PAYABLE',
    amount: Prisma.Decimal,
    currencyId: bigint,
    code: string,
    date: Date,
  ): void => {
    if (amount.isZero()) return;
    out.push({ key: partyKey(type, id), side, amount, currencyId, currencyCode: code, date, settlement: null });
  };

  // Every party the same way: what they owe us, and what we owe them.
  const pairs = [
    ...customers.map((r) => ({ type: 'CUSTOMER' as const, row: r, theyOwe: r.customerOwe })),
    ...vendors.map((r) => ({ type: 'VENDOR' as const, row: r, theyOwe: r.vendorOwe })),
    ...agents.map((r) => ({ type: 'AGENT' as const, row: r, theyOwe: r.agentOwe })),
  ];
  for (const { type, row, theyOwe } of pairs) {
    if (row.openingCurrencyId === null) continue;
    const code = isoCurrency(row.openingCurrency?.currency ?? '');
    add(type, row.id, 'RECEIVABLE', dec(theyOwe), row.openingCurrencyId, code, row.createdAt);
    add(type, row.id, 'PAYABLE', dec(row.weOwe), row.openingCurrencyId, code, row.createdAt);
  }
  for (const s of settlements) {
    const id = s.customerId ?? s.agentId ?? s.vendorId;
    if (id === null) continue;
    out.push({
      key: partyKey(s.partyType, id),
      side: s.side,
      amount: s.amount.negated(),
      currencyId: s.currencyId,
      currencyCode: s.currencyCode,
      date: s.settlementDate,
      settlement: { journalEntryId: s.journalEntry.id, journalEntryCode: s.journalEntry.code },
    });
  }
  return out;
}

/**
 * §14.7 — the sheet's new "Unbilled Amount" column (Design.xlsx 2026-09-27).
 *
 * Money on a job whose debit invoice has not gone out yet, on both sides of it:
 *
 *   customer   a draft debit invoice's total; or, for a confirmed booking on
 *              Awaiting Freight Inv with no invoice started, its quoted amount
 *   supplier   the cost blocks of a draft debit invoice
 *
 * Draft totals carry their own frozen rate. A quoted amount has none that
 * belongs to an invoice, so it is converted at today's — the openings' rule.
 */
export async function unbilledBalances(
  db: TenantDb,
  tenantId: bigint,
  base: BaseCurrency | null,
  filter?: PartyFilter,
): Promise<Map<string, Balance>> {
  const out = new Map<string, Balance>();
  const wantsCustomer = filter === undefined || filter.type === 'CUSTOMER';
  const customerWhere = filter?.type === 'CUSTOMER' ? { customerId: filter.id } : {};

  const [drafts, awaiting, costs] = await Promise.all([
    wantsCustomer
      ? db.debitInvoice.groupBy({
          by: ['customerId', 'currencyCode'],
          where: { status: 'DRAFT', deletedAt: null, ...customerWhere },
          _sum: { totalAmount: true, totalAmountBase: true },
        })
      : Promise.resolve([]),
    wantsCustomer
      ? db.shipment.findMany({
          where: {
            deletedAt: null,
            status: { in: [...INVOICEABLE_SHIPMENT_STATUSES] },
            debitInvoices: { none: { kind: 'FREIGHT', deletedAt: null, status: { not: 'CANCELLED' } } },
            ...customerWhere,
          },
          select: {
            customerId: true,
            quotation: {
              select: {
                lines: {
                  where: { deletedAt: null, isActive: true },
                  select: { currencyId: true, currencyCode: true, totalAmount: true },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    filter !== undefined && filter.type === 'CUSTOMER'
      ? Promise.resolve([])
      : db.$queryRaw<{
          party_type: 'CARRIER' | 'AGENT' | 'VENDOR';
          carrier_id: bigint | null;
          agent_id: bigint | null;
          vendor_id: bigint | null;
          currency_code: string;
          amount: unknown;
          amount_base: unknown;
        }[]>`
          SELECT c.party_type, c.carrier_id, c.agent_id, c.vendor_id, c.currency_code,
                 SUM(c.total_amount) AS amount, SUM(c.total_amount_base) AS amount_base
            FROM debit_invoice_cost c
            JOIN debit_invoice i ON i.id = c.debit_invoice_id
           WHERE c.deleted_at IS NULL
             AND i.deleted_at IS NULL
             AND i.status = 'DRAFT'
             AND i.tenant_id = ${tenantId}
             ${
               filter === undefined
                 ? Prisma.empty
                 : filter.type === 'CARRIER'
                   ? Prisma.sql`AND c.carrier_id = ${filter.id}`
                   : filter.type === 'AGENT'
                     ? Prisma.sql`AND c.agent_id = ${filter.id}`
                     : Prisma.sql`AND c.vendor_id = ${filter.id}`
             }
           GROUP BY c.party_type, c.carrier_id, c.agent_id, c.vendor_id, c.currency_code
        `,
  ]);

  for (const row of drafts) {
    post(
      out,
      partyKey('CUSTOMER', row.customerId),
      'UNBILLED',
      row.currencyCode,
      dec(row._sum.totalAmount),
      dec(row._sum.totalAmountBase),
    );
  }

  const quoted = awaiting.flatMap((s) =>
    s.quotation.lines.map((l) => ({ customerId: s.customerId, ...l })),
  );
  const rates =
    base === null || quoted.length === 0
      ? new Map<string, { rate: Prisma.Decimal }>()
      : await resolveRates(db, tenantId, [...new Set(quoted.map((l) => l.currencyId.toString()))].map((id) => BigInt(id)));
  for (const line of quoted) {
    const amount = dec(line.totalAmount);
    if (amount.isZero()) continue;
    const rate = base !== null && line.currencyId === base.id ? new Prisma.Decimal(1) : (rates.get(line.currencyId.toString())?.rate ?? null);
    post(
      out,
      partyKey('CUSTOMER', line.customerId),
      'UNBILLED',
      line.currencyCode,
      amount,
      rate === null ? null : toBase(amount, rate),
    );
  }

  for (const row of costs) {
    const id = row.party_type === 'CARRIER' ? row.carrier_id : row.party_type === 'AGENT' ? row.agent_id : row.vendor_id;
    if (id === null) continue;
    post(out, partyKey(row.party_type, id), 'UNBILLED', row.currency_code, dec(String(row.amount)), dec(String(row.amount_base)));
  }
  return out;
}

/**
 * Every party's balance, keyed by partyKey.
 *
 * A currency with no rate on file marks the party `rateMissing` rather than
 * being silently counted as zero.
 */
export async function partyBalances(
  db: TenantDb,
  tenantId: bigint,
  base: BaseCurrency | null,
): Promise<Map<string, Balance>> {
  const out = await unbilledBalances(db, tenantId, base);

  const [invoices, receipts, costs, payments, opening] = await Promise.all([
    db.debitInvoice.groupBy({
      by: ['customerId', 'currencyCode'],
      where: { status: 'ISSUED', deletedAt: null },
      _sum: { totalAmount: true, totalAmountBase: true },
    }),
    db.$queryRaw<{ customer_id: bigint; currency_code: string; amount: unknown; amount_base: unknown }[]>`
      SELECT i.customer_id, i.currency_code,
             SUM(r.amount) AS amount, SUM(r.amount_base) AS amount_base
        FROM debit_invoice_receipt r
        JOIN debit_invoice i ON i.id = r.debit_invoice_id
       WHERE r.deleted_at IS NULL
         AND i.deleted_at IS NULL
         AND i.status = 'ISSUED'
         AND i.tenant_id = ${tenantId}
       GROUP BY i.customer_id, i.currency_code
    `,
    db.$queryRaw<{
      party_type: 'CARRIER' | 'AGENT' | 'VENDOR';
      carrier_id: bigint | null;
      agent_id: bigint | null;
      vendor_id: bigint | null;
      currency_code: string;
      amount: unknown;
      amount_base: unknown;
    }[]>`
      SELECT c.party_type, c.carrier_id, c.agent_id, c.vendor_id, c.currency_code,
             SUM(c.total_amount) AS amount, SUM(c.total_amount_base) AS amount_base
        FROM debit_invoice_cost c
        JOIN debit_invoice i ON i.id = c.debit_invoice_id
       WHERE c.deleted_at IS NULL
         AND i.deleted_at IS NULL
         AND i.status = 'ISSUED'
         AND i.tenant_id = ${tenantId}
       GROUP BY c.party_type, c.carrier_id, c.agent_id, c.vendor_id, c.currency_code
    `,
    // §14.6: what Expense vouchers paid against those credit invoices.
    db.$queryRaw<{
      party_type: 'CARRIER' | 'AGENT' | 'VENDOR';
      carrier_id: bigint | null;
      agent_id: bigint | null;
      vendor_id: bigint | null;
      currency_code: string;
      amount: unknown;
      amount_base: unknown;
    }[]>`
      SELECT c.party_type, c.carrier_id, c.agent_id, c.vendor_id, c.currency_code,
             SUM(p.amount) AS amount, SUM(p.amount_base) AS amount_base
        FROM supplier_payment p
        JOIN debit_invoice_cost c ON c.id = p.debit_invoice_cost_id
       WHERE p.deleted_at IS NULL
         AND p.tenant_id = ${tenantId}
       GROUP BY c.party_type, c.carrier_id, c.agent_id, c.vendor_id, c.currency_code
    `,
    openingMovements(db),
  ]);

  for (const row of invoices) {
    post(
      out,
      partyKey('CUSTOMER', row.customerId),
      'RECEIVABLE',
      row.currencyCode,
      dec(row._sum.totalAmount),
      dec(row._sum.totalAmountBase),
    );
  }
  for (const row of receipts) {
    post(
      out,
      partyKey('CUSTOMER', row.customer_id),
      'RECEIVABLE',
      row.currency_code,
      dec(String(row.amount)).negated(),
      dec(String(row.amount_base)).negated(),
    );
  }
  for (const [rows, sign] of [
    [costs, 1],
    [payments, -1],
  ] as const) {
    for (const row of rows) {
      const id = row.party_type === 'CARRIER' ? row.carrier_id : row.party_type === 'AGENT' ? row.agent_id : row.vendor_id;
      if (id === null) continue;
      const amount = dec(String(row.amount));
      const amountBase = dec(String(row.amount_base));
      post(
        out,
        partyKey(row.party_type, id),
        'PAYABLE',
        row.currency_code,
        sign === 1 ? amount : amount.negated(),
        sign === 1 ? amountBase : amountBase.negated(),
      );
    }
  }

  const rates =
    base === null
      ? new Map<string, { rate: Prisma.Decimal }>()
      : await resolveRates(db, tenantId, [...new Set(opening.map((o) => o.currencyId.toString()))].map((id) => BigInt(id)));
  for (const o of opening) {
    const rate = base !== null && o.currencyId === base.id ? new Prisma.Decimal(1) : (rates.get(o.currencyId.toString())?.rate ?? null);
    post(out, o.key, o.side, o.currencyCode, o.amount, rate === null ? null : toBase(o.amount, rate));
  }

  return out;
}

export function totalsOf(balances: Balance[]): ReceivablePayableTotals {
  const sum = (pick: (b: Balance) => Prisma.Decimal): string =>
    money(balances.reduce((acc, b) => acc.plus(pick(b)), ZERO));
  return {
    receivableUsd: sum((b) => b.receivableUsd),
    receivableBase: sum((b) => b.receivableBase),
    unbilledUsd: sum((b) => b.unbilledUsd),
    unbilledBase: sum((b) => b.unbilledBase),
    payableUsd: sum((b) => b.payableUsd),
    payableBase: sum((b) => b.payableBase),
  };
}

/**
 * One party's ledger — the `Ledger.` sheet: every document that moved the
 * balance, in date order, each in its own currency with the rate it was
 * booked at, so the list's two money columns never have to be reconciled in
 * the reader's head. Receipts, payments and opening settlements name the
 * voucher that moved the money (§14.6).
 */
export async function ledgerEntries(
  db: TenantDb,
  tenantId: bigint,
  base: BaseCurrency | null,
  party: PartyFilter,
): Promise<LedgerEntryDto[]> {
  const entries: (LedgerEntryDto & { sortKey: string })[] = [];
  const at = (d: Date): string => d.toISOString().slice(0, 10);
  const blank = { debitInvoiceId: null, creditInvoiceId: null, journalEntryId: null, journalEntryCode: null };

  // Openings and their settlements, at today's rate — the one figure nothing froze.
  const opening = await openingMovements(db, party);
  const rates =
    base === null
      ? new Map<string, { rate: Prisma.Decimal }>()
      : await resolveRates(db, tenantId, [...new Set(opening.map((o) => o.currencyId.toString()))].map((id) => BigInt(id)));
  for (const o of opening) {
    const rate = base !== null && o.currencyId === base.id ? new Prisma.Decimal(1) : (rates.get(o.currencyId.toString())?.rate ?? null);
    entries.push({
      sortKey: `${at(o.date)}:${o.settlement === null ? 0 : 3}:${o.settlement?.journalEntryId.toString().padStart(12, '0') ?? ''}`,
      date: at(o.date),
      kind: o.settlement === null ? 'OPENING' : 'OPENING_SETTLEMENT',
      side: o.side,
      reference: o.settlement === null ? 'Opening' : o.settlement.journalEntryCode,
      description:
        o.settlement === null
          ? 'Opening balance'
          : `${o.side === 'PAYABLE' ? 'Paid' : 'Received'} against the opening balance`,
      currencyCode: o.currencyCode,
      amount: money(o.amount),
      conversionRate: rate?.toString() ?? null,
      amountBase: rate === null ? null : money(toBase(o.amount, rate)),
      paymentStatus: null,
      ...blank,
      journalEntryId: o.settlement?.journalEntryId.toString() ?? null,
      journalEntryCode: o.settlement?.journalEntryCode ?? null,
    });
  }

  if (party.type === 'CUSTOMER') {
    const invoices = await db.debitInvoice.findMany({
      where: { customerId: party.id, status: 'ISSUED', deletedAt: null },
      orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        code: true,
        kind: true,
        invoiceDate: true,
        currencyCode: true,
        conversionRate: true,
        totalAmount: true,
        totalAmountBase: true,
        shipment: {
          select: { code: true, pol: { select: { name: true } }, pod: { select: { name: true } } },
        },
        receipts: {
          where: { deletedAt: null },
          orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            paymentDate: true,
            amount: true,
            amountBase: true,
            journalEntry: { select: { id: true, code: true } },
          },
        },
      },
    });
    for (const inv of invoices) {
      const lane =
        inv.shipment === null ? '' : ` — ${inv.shipment.code}, ${inv.shipment.pol.name} → ${inv.shipment.pod.name}`;
      entries.push({
        sortKey: `${at(inv.invoiceDate)}:1:${inv.id.toString().padStart(12, '0')}`,
        date: at(inv.invoiceDate),
        kind: 'DEBIT_INVOICE',
        side: 'RECEIVABLE',
        reference: inv.code,
        description: `${inv.kind === 'FREIGHT' ? 'Freight debit invoice' : 'Debit invoice'}${lane}`,
        currencyCode: inv.currencyCode,
        amount: money(inv.totalAmount),
        conversionRate: inv.conversionRate.toString(),
        amountBase: money(inv.totalAmountBase),
        paymentStatus: paymentOf(inv.totalAmount, inv.receipts).status,
        ...blank,
        debitInvoiceId: inv.id.toString(),
      });
      for (const r of inv.receipts) {
        entries.push({
          sortKey: `${at(r.paymentDate)}:2:${r.id.toString().padStart(12, '0')}`,
          date: at(r.paymentDate),
          kind: 'RECEIPT',
          side: 'RECEIVABLE',
          reference: r.journalEntry?.code ?? inv.code,
          description: `Received against ${inv.code}`,
          currencyCode: inv.currencyCode,
          amount: money(r.amount.negated()),
          conversionRate: inv.conversionRate.toString(),
          amountBase: money(r.amountBase.negated()),
          paymentStatus: null,
          ...blank,
          debitInvoiceId: inv.id.toString(),
          journalEntryId: r.journalEntry?.id.toString() ?? null,
          journalEntryCode: r.journalEntry?.code ?? null,
        });
      }
    }
  } else {
    const partyFilter =
      party.type === 'CARRIER'
        ? { carrierId: party.id }
        : party.type === 'AGENT'
          ? { agentId: party.id }
          : { vendorId: party.id };
    const blocks = await db.debitInvoiceCost.findMany({
      where: {
        ...partyFilter,
        partyType: party.type,
        deletedAt: null,
        debitInvoice: { status: 'ISSUED', deletedAt: null },
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        supplierInvoiceNo: true,
        currencyCode: true,
        conversionRate: true,
        totalAmount: true,
        totalAmountBase: true,
        lines: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          select: { costHeadName: true, quantity: true, containerSizeName: true },
        },
        debitInvoice: {
          select: { id: true, code: true, invoiceDate: true, shipment: { select: { code: true } } },
        },
        payments: {
          where: { deletedAt: null },
          orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            paymentDate: true,
            amount: true,
            amountBase: true,
            journalEntry: { select: { id: true, code: true } },
          },
        },
      },
    });
    for (const block of blocks) {
      const inv = block.debitInvoice;
      // The Ledger sheet's "Inv-CMA-001": the supplier's own number, or ours
      // until theirs arrives.
      const reference = block.supplierInvoiceNo ?? inv.code;
      entries.push({
        sortKey: `${at(inv.invoiceDate)}:1:${block.id.toString().padStart(12, '0')}`,
        date: at(inv.invoiceDate),
        kind: 'SUPPLIER_INVOICE',
        side: 'PAYABLE',
        reference,
        description: `${describeLines(block.lines)} — ${inv.shipment?.code ?? inv.code}`,
        currencyCode: block.currencyCode,
        amount: money(block.totalAmount),
        conversionRate: block.conversionRate.toString(),
        amountBase: money(block.totalAmountBase),
        paymentStatus: paymentOf(block.totalAmount, block.payments).status,
        ...blank,
        debitInvoiceId: inv.id.toString(),
        creditInvoiceId: block.id.toString(),
      });
      for (const p of block.payments) {
        entries.push({
          sortKey: `${at(p.paymentDate)}:2:${p.id.toString().padStart(12, '0')}`,
          date: at(p.paymentDate),
          kind: 'PAYMENT',
          side: 'PAYABLE',
          reference: p.journalEntry.code,
          description: `Paid against ${reference}`,
          currencyCode: block.currencyCode,
          amount: money(p.amount.negated()),
          conversionRate: block.conversionRate.toString(),
          amountBase: money(p.amountBase.negated()),
          paymentStatus: null,
          ...blank,
          debitInvoiceId: inv.id.toString(),
          creditInvoiceId: block.id.toString(),
          journalEntryId: p.journalEntry.id.toString(),
          journalEntryCode: p.journalEntry.code,
        });
      }
    }
  }

  return entries
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ sortKey: _sortKey, ...entry }) => entry);
}

/**
 * The ledger's own totals, from its entries — the same arithmetic as the list
 * — plus what is unbilled for the party, which no entry carries.
 */
export function ledgerTotals(entries: LedgerEntryDto[], unbilled: Balance | undefined): ReceivablePayableTotals {
  const one = new Map<string, Balance>();
  for (const e of entries) {
    post(one, 'party', e.side, e.currencyCode, dec(e.amount), e.amountBase === null ? null : dec(e.amountBase));
  }
  const balance = one.get('party') ?? emptyBalance();
  if (unbilled !== undefined) {
    balance.unbilledUsd = unbilled.unbilledUsd;
    balance.unbilledBase = unbilled.unbilledBase;
  }
  return totalsOf([balance]);
}
