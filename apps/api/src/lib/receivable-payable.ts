import {
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
 * Who owes whom — docs/MODULE_ACCOUNTS.md §3.6.
 *
 * Computed from the documents on every read, not kept in a second table: while
 * nothing but a debit invoice posts to a party, a posting table would be a copy
 * that can only drift from what it copies. When Journal and Expense arrive they
 * get a ledger table, and these documents post into it.
 *
 *   receivable (customer)          = issued invoices − receipts + opening
 *   payable (carrier/agent/vendor) = cost blocks of issued invoices + opening
 *
 * The USD columns carry what is denominated in US dollars; the Base columns
 * carry everything, converted (§3.6, §12 Q5).
 */

const ZERO = new Prisma.Decimal(0);

export interface Balance {
  receivableUsd: Prisma.Decimal;
  receivableBase: Prisma.Decimal;
  payableUsd: Prisma.Decimal;
  payableBase: Prisma.Decimal;
  rateMissing: boolean;
}

const empty = (): Balance => ({
  receivableUsd: ZERO,
  receivableBase: ZERO,
  payableUsd: ZERO,
  payableBase: ZERO,
  rateMissing: false,
});

export const partyKey = (type: LedgerPartyType, id: bigint | string): string => `${type}:${id.toString()}`;

/** One figure landing on one side of one party's balance. */
function post(
  into: Map<string, Balance>,
  key: string,
  side: 'RECEIVABLE' | 'PAYABLE',
  currencyCode: string,
  amount: Prisma.Decimal,
  base: Prisma.Decimal | null,
): void {
  const acc = into.get(key) ?? empty();
  const usd = currencyCode === 'USD' ? amount : ZERO;
  if (side === 'RECEIVABLE') {
    acc.receivableUsd = acc.receivableUsd.plus(usd);
    if (base === null) acc.rateMissing = true;
    else acc.receivableBase = acc.receivableBase.plus(base);
  } else {
    acc.payableUsd = acc.payableUsd.plus(usd);
    if (base === null) acc.rateMissing = true;
    else acc.payableBase = acc.payableBase.plus(base);
  }
  into.set(key, acc);
}

export function isOpen(b: Balance): boolean {
  return !(
    b.receivableUsd.isZero() &&
    b.receivableBase.isZero() &&
    b.payableUsd.isZero() &&
    b.payableBase.isZero()
  );
}

interface Opening {
  key: string;
  type: LedgerPartyType;
  id: bigint;
  /** Receivable when positive, payable when negative — the CRM fields' signs. */
  receivable: Prisma.Decimal;
  payable: Prisma.Decimal;
  currencyId: bigint;
  currencyCode: string;
  createdAt: Date;
}

/**
 * The CRM opening figures (20260819180000), each on the side its sign says:
 * customer and vendor opening_balance is signed, positive owed to us; the
 * agent keeps agent_owe (receivable) and we_owe (payable) apart. Carriers have
 * none.
 */
async function openings(db: TenantDb, filter?: { type: LedgerPartyType; id: bigint }): Promise<Opening[]> {
  const wants = (type: LedgerPartyType): boolean => filter === undefined || filter.type === type;
  const idFilter = (type: LedgerPartyType) => (filter !== undefined && filter.type === type ? { id: filter.id } : {});
  const currency = { select: { currency: true } } as const;

  const [customers, vendors, agents] = await Promise.all([
    wants('CUSTOMER')
      ? db.customer.findMany({
          where: { ...idFilter('CUSTOMER'), deletedAt: null, openingBalance: { not: null }, openingCurrencyId: { not: null } },
          select: { id: true, openingBalance: true, openingCurrencyId: true, openingCurrency: currency, createdAt: true },
        })
      : Promise.resolve([]),
    wants('VENDOR')
      ? db.vendor.findMany({
          where: { ...idFilter('VENDOR'), deletedAt: null, openingBalance: { not: null }, openingCurrencyId: { not: null } },
          select: { id: true, openingBalance: true, openingCurrencyId: true, openingCurrency: currency, createdAt: true },
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
          select: {
            id: true,
            weOwe: true,
            agentOwe: true,
            openingCurrencyId: true,
            openingCurrency: currency,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const out: Opening[] = [];
  const signed = (type: LedgerPartyType, row: (typeof customers)[number]): void => {
    const value = dec(row.openingBalance);
    if (value.isZero() || row.openingCurrencyId === null) return;
    out.push({
      key: partyKey(type, row.id),
      type,
      id: row.id,
      receivable: value.greaterThan(0) ? value : ZERO,
      payable: value.lessThan(0) ? value.negated() : ZERO,
      currencyId: row.openingCurrencyId,
      currencyCode: isoCurrency(row.openingCurrency?.currency ?? ''),
      createdAt: row.createdAt,
    });
  };
  customers.forEach((row) => signed('CUSTOMER', row));
  vendors.forEach((row) => signed('VENDOR', row));
  for (const row of agents) {
    const receivable = dec(row.agentOwe);
    const payable = dec(row.weOwe);
    if ((receivable.isZero() && payable.isZero()) || row.openingCurrencyId === null) continue;
    out.push({
      key: partyKey('AGENT', row.id),
      type: 'AGENT',
      id: row.id,
      receivable,
      payable,
      currencyId: row.openingCurrencyId,
      currencyCode: isoCurrency(row.openingCurrency?.currency ?? ''),
      createdAt: row.createdAt,
    });
  }
  return out;
}

/**
 * Every party's balance, keyed by partyKey.
 *
 * Openings are converted at today's rate, because nothing froze one; a
 * currency with no rate on file marks the party `rateMissing` rather than
 * being silently counted as zero.
 */
export async function partyBalances(
  db: TenantDb,
  tenantId: bigint,
  base: BaseCurrency | null,
): Promise<Map<string, Balance>> {
  const out = new Map<string, Balance>();

  const [invoices, receipts, costs, opening] = await Promise.all([
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
    openings(db),
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
  for (const row of costs) {
    const id = row.party_type === 'CARRIER' ? row.carrier_id : row.party_type === 'AGENT' ? row.agent_id : row.vendor_id;
    if (id === null) continue;
    post(
      out,
      partyKey(row.party_type, id),
      'PAYABLE',
      row.currency_code,
      dec(String(row.amount)),
      dec(String(row.amount_base)),
    );
  }

  const rates =
    base === null
      ? new Map<string, { rate: Prisma.Decimal }>()
      : await resolveRates(db, tenantId, [...new Set(opening.map((o) => o.currencyId))].map((id) => BigInt(id)));
  for (const o of opening) {
    const rate = rates.get(o.currencyId.toString())?.rate ?? null;
    if (!o.receivable.isZero()) {
      post(out, o.key, 'RECEIVABLE', o.currencyCode, o.receivable, rate === null ? null : toBase(o.receivable, rate));
    }
    if (!o.payable.isZero()) {
      post(out, o.key, 'PAYABLE', o.currencyCode, o.payable, rate === null ? null : toBase(o.payable, rate));
    }
  }

  return out;
}

export function totalsOf(balances: Balance[]): ReceivablePayableTotals {
  const sum = (pick: (b: Balance) => Prisma.Decimal): string =>
    money(balances.reduce((acc, b) => acc.plus(pick(b)), ZERO));
  return {
    receivableUsd: sum((b) => b.receivableUsd),
    receivableBase: sum((b) => b.receivableBase),
    payableUsd: sum((b) => b.payableUsd),
    payableBase: sum((b) => b.payableBase),
  };
}

/**
 * One party's ledger — the `Ledger.` sheet: every document that moved the
 * balance, in date order, each in its own currency with the rate it was
 * booked at, so the list's two money columns never have to be reconciled in
 * the reader's head.
 */
export async function ledgerEntries(
  db: TenantDb,
  tenantId: bigint,
  base: BaseCurrency | null,
  party: { type: LedgerPartyType; id: bigint },
): Promise<LedgerEntryDto[]> {
  const entries: (LedgerEntryDto & { sortKey: string })[] = [];
  const at = (d: Date): string => d.toISOString().slice(0, 10);

  // Openings, at today's rate — the one figure nothing froze.
  const opening = await openings(db, party);
  const rates =
    base === null
      ? new Map<string, { rate: Prisma.Decimal }>()
      : await resolveRates(db, tenantId, [...new Set(opening.map((o) => o.currencyId))]);
  for (const o of opening) {
    const rate = rates.get(o.currencyId.toString())?.rate ?? null;
    for (const [side, amount] of [
      ['RECEIVABLE', o.receivable],
      ['PAYABLE', o.payable],
    ] as const) {
      if (amount.isZero()) continue;
      entries.push({
        sortKey: `${at(o.createdAt)}:0`,
        date: at(o.createdAt),
        kind: 'OPENING',
        side,
        reference: 'Opening',
        description: 'Opening balance',
        currencyCode: o.currencyCode,
        amount: money(amount),
        conversionRate: rate?.toString() ?? null,
        amountBase: rate === null ? null : money(toBase(amount, rate)),
        paymentStatus: null,
        debitInvoiceId: null,
      });
    }
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
          select: { id: true, paymentDate: true, amount: true, amountBase: true },
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
        debitInvoiceId: inv.id.toString(),
      });
      for (const r of inv.receipts) {
        entries.push({
          sortKey: `${at(r.paymentDate)}:2:${r.id.toString().padStart(12, '0')}`,
          date: at(r.paymentDate),
          kind: 'RECEIPT',
          side: 'RECEIVABLE',
          reference: inv.code,
          description: `Received against ${inv.code}`,
          currencyCode: inv.currencyCode,
          amount: money(r.amount.negated()),
          conversionRate: inv.conversionRate.toString(),
          amountBase: money(r.amountBase.negated()),
          paymentStatus: null,
          debitInvoiceId: inv.id.toString(),
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
      },
    });
    for (const block of blocks) {
      const inv = block.debitInvoice;
      entries.push({
        sortKey: `${at(inv.invoiceDate)}:1:${block.id.toString().padStart(12, '0')}`,
        date: at(inv.invoiceDate),
        kind: 'SUPPLIER_INVOICE',
        side: 'PAYABLE',
        // The Ledger sheet's "Inv-CMA-001": the supplier's own number, or ours
        // until theirs arrives.
        reference: block.supplierInvoiceNo ?? inv.code,
        description: `${describeLines(block.lines)} — ${inv.shipment?.code ?? inv.code}`,
        currencyCode: block.currencyCode,
        amount: money(block.totalAmount),
        conversionRate: block.conversionRate.toString(),
        amountBase: money(block.totalAmountBase),
        // Nothing pays a supplier yet (§12 Q9).
        paymentStatus: 'UNPAID',
        debitInvoiceId: inv.id.toString(),
      });
    }
  }

  return entries
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ sortKey: _sortKey, ...entry }) => entry);
}

/** The ledger's own totals, from its entries — the same arithmetic as the list. */
export function ledgerTotals(entries: LedgerEntryDto[]): ReceivablePayableTotals {
  const one = new Map<string, Balance>();
  for (const e of entries) {
    post(one, 'party', e.side, e.currencyCode, dec(e.amount), e.amountBase === null ? null : dec(e.amountBase));
  }
  return totalsOf([one.get('party') ?? empty()]);
}
