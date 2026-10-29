import {
  BALANCE_SHEET_COLUMNS,
  BALANCE_SHEET_LINES,
  type BalanceSheetColumn,
  type BalanceSheetDto,
  type BalanceSheetGroup,
  type BalanceSheetLineKey,
  INCOME_STATEMENT_BASIS_LABEL,
  INCOME_STATEMENT_LINES,
  type IncomeStatementBasis,
  type IncomeStatementLineKey,
  type IncomeStatementSection,
  LEDGER_PARTY_LABEL,
  type LedgerPartyType,
  type StatementBreakdownDto,
  type StatementRowDto,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { type BaseCurrency, resolveRates } from './currency-rate';
import { toBase } from './debit-invoice';
import { type Ledger, statementLines, statementRows } from './income-statement';
import { openingMovements } from './receivable-payable';
import { Breakdown, chartAccounts, shown, voucherRows } from './statement-breakdown';
import type { TenantDb } from './tenant-client';

/**
 * The Balance Sheet — the position on a day, and the same day a year before.
 *
 * The books are the source: every POSTED voucher line up to the day, on each
 * asset, liability and equity account, mapped from the chart (ACCOUNT_LINE).
 * Income and expense lines do not appear as themselves; what they add up to is
 * the profit the equity section carries.
 *
 * ACCRUAL, the Income Statement's default (its §9.3 answer to Q21), adds what
 * the books do not hold, because a debit invoice does not post (MODULE_
 * ACCOUNTS §14.13 Q2):
 *
 *   Accounts Receivable  + what customers owe on issued invoices up to the day,
 *                          less what was received by then; and what is left
 *                          of the CRM openings they owed before the system
 *   Accounts Payable     + the same for carriers, agents and vendors
 *   Opening Balance      + the CRM openings: owed to us, less owed by us
 *   Equity
 *   Retained earnings    + revenue and job cost as the invoices earned them,
 *                          in place of the cash the settling vouchers booked
 *
 * Each of those is one side of an entry the books would have made, so the
 * statement balances by construction — and Profit for the Year is the Income
 * Statement's own figure for the financial year to the day. CASH is the books
 * as they stand.
 *
 * The openings carry no frozen rate (receivable-payable.ts), so they are taken
 * at today's, as the Receivable-Payable list takes them.
 */

const ZERO = new Prisma.Decimal(0);
const dec = (v: unknown): Prisma.Decimal => new Prisma.Decimal(v === null || v === undefined ? 0 : String(v));

// ---------------------------------------------------------------- mapping

/** The predefined chart onto the statement's lines, by system key. */
const ACCOUNT_LINE: Readonly<Record<string, BalanceSheetLineKey>> = {
  'ASSET.CASH': 'CASH',
  'ASSET.BANK': 'BANK',
  'ASSET.RECEIVABLE': 'RECEIVABLE',
  'ASSET.INVENTORY': 'INVENTORY',
  'ASSET.CURRENT': 'OTHER_CURRENT_ASSETS',
  'ASSET.SHORT_TERM_LOAN': 'LOANS_GIVEN',
  'ASSET.OTHER_LONG_TERM': 'LONG_TERM_ASSETS',

  'LIABILITY.PAYABLE': 'PAYABLE',
  'LIABILITY.CUSTOMER_PREPAYMENT': 'CUSTOMER_ADVANCES',
  'LIABILITY.PAYROLL': 'PAYROLL',
  'LIABILITY.SALES_TAX': 'TAXES',
  'LIABILITY.OTHER_SHORT_TERM': 'OTHER_CURRENT_LIABILITIES',
  'LIABILITY.LOAN': 'LOANS',
  'LIABILITY.OTHER_LONG_TERM': 'OTHER_LONG_TERM_LIABILITIES',

  'EQUITY.OWNER.OPENING_BALANCE': 'OPENING_EQUITY',
  'EQUITY.OWNER': 'OWNER',
  'EQUITY.RETAINED': 'RETAINED',
};

/** Where an account lands: its own key, else its ledger's, else its head's catch-all. */
export function balanceLineOf(account: {
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY';
  systemKey: string | null;
  parentKey: string | null;
}): BalanceSheetLineKey {
  const own = account.systemKey === null ? undefined : ACCOUNT_LINE[account.systemKey];
  if (own !== undefined) return own;
  const inherited = account.parentKey === null ? undefined : ACCOUNT_LINE[account.parentKey];
  if (inherited !== undefined) return inherited;
  if (account.accountType === 'ASSET') return 'OTHER_CURRENT_ASSETS';
  if (account.accountType === 'LIABILITY') return 'OTHER_CURRENT_LIABILITIES';
  return 'OWNER';
}

// ---------------------------------------------------------------- dates

/** The same calendar day a year earlier; 29 February falls back to the 28th. */
export function yearBefore(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
  return new Date(Date.UTC(y - 1, m - 1, Math.min(d, last))).toISOString().slice(0, 10);
}

/** The first day of the financial year the day falls in. */
export function yearStartOf(isoDay: string, yearStartMonth: number): string {
  const [y, m] = isoDay.split('-').map(Number) as [number, number];
  const year = m >= yearStartMonth ? y : y - 1;
  return new Date(Date.UTC(year, yearStartMonth - 1, 1)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- figures

type Figures = Map<BalanceSheetLineKey, Prisma.Decimal>;
type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

/** An issued invoice to the day, and what was received against it by then. */
interface InvoiceOwing {
  id: bigint;
  code: string;
  invoiceDate: Date;
  customerName: string | null;
  bookingCode: string | null;
  billed: Prisma.Decimal;
  received: Prisma.Decimal;
}

/** A supplier's cost on an issued invoice to the day, and what was paid on it by then. */
interface CostOwing {
  invoiceId: bigint;
  invoiceCode: string;
  invoiceDate: Date;
  partyName: string | null;
  bookingCode: string | null;
  supplierInvoiceNo: string | null;
  costed: Prisma.Decimal;
  paid: Prisma.Decimal;
}

/** A party's CRM opening on one side, in base, and what vouchers settled of it by the day. */
interface OpeningOwing {
  partyType: LedgerPartyType;
  partyId: bigint;
  side: 'RECEIVABLE' | 'PAYABLE';
  date: Date;
  owed: Prisma.Decimal;
  settled: Prisma.Decimal;
}

/** Everything one day's figures are added up from — itemised, so a breakdown reads the same rows. */
interface Position {
  asOf: string;
  accounts: { id: bigint; accountType: AccountType; systemKey: string | null; parentKey: string | null; debit: Prisma.Decimal; credit: Prisma.Decimal }[];
  /** What the income and expense lines add up to: the books' profit to date. */
  bookProfit: Prisma.Decimal;
  /** What the books do not hold — null on the cash basis. */
  accrual: { invoices: InvoiceOwing[]; costs: CostOwing[]; openings: OpeningOwing[] } | null;
  /** The financial year to the day, and the Income Statement's figures for it. */
  year: { from: string; to: string };
  ledger: Ledger;
  profitForYear: Prisma.Decimal;
}

async function positionParts(
  db: TenantDb,
  tenantId: bigint,
  asOf: string,
  input: { basis: IncomeStatementBasis; yearStartMonth: number; base: BaseCurrency | null },
): Promise<Position> {
  // ------------------------------------------------------------ the books
  const books = await db.$queryRaw<
    { id: bigint; account_type: AccountType; system_key: string | null; parent_key: string | null; debit: unknown; credit: unknown }[]
  >`
    SELECT la.id, la.account_type::text AS account_type, la.system_key, p.system_key AS parent_key,
           COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
      FROM journal_line jl
      JOIN journal_entry je  ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
      JOIN ledger_account la ON la.tenant_id = jl.tenant_id AND la.id = jl.ledger_account_id
      LEFT JOIN ledger_account p ON p.tenant_id = la.tenant_id AND p.id = la.parent_id
     WHERE jl.tenant_id = ${tenantId}
       AND jl.deleted_at IS NULL
       AND je.deleted_at IS NULL
       AND je.status = 'POSTED'
       AND je.entry_date <= ${asOf}::date
     GROUP BY la.id, la.account_type, la.system_key, p.system_key
  `;
  const accounts = books.map((r) => ({
    id: r.id,
    accountType: r.account_type,
    systemKey: r.system_key,
    parentKey: r.parent_key,
    debit: dec(r.debit),
    credit: dec(r.credit),
  }));
  const bookProfit = accounts
    .filter((a) => a.accountType === 'INCOME' || a.accountType === 'EXPENSE')
    .reduce((sum, a) => sum.plus(a.credit.minus(a.debit)), ZERO);

  // ------------------------------------------------- what the books do not hold
  let accrual: Position['accrual'] = null;
  if (input.basis === 'ACCRUAL') {
    const [invoices, costs] = await Promise.all([
      db.$queryRaw<{ id: bigint; code: string; invoice_date: Date; customer_name: string | null; booking_code: string | null; billed: unknown; received: unknown }[]>`
        SELECT i.id, i.code, i.invoice_date, cu.name AS customer_name, s.code AS booking_code,
               i.total_amount_base AS billed,
               (SELECT COALESCE(SUM(r.amount_base), 0) FROM debit_invoice_receipt r
                 WHERE r.tenant_id = i.tenant_id AND r.debit_invoice_id = i.id AND r.deleted_at IS NULL
                   AND r.payment_date <= ${asOf}::date) AS received
          FROM debit_invoice i
          LEFT JOIN customer cu ON cu.tenant_id = i.tenant_id AND cu.id = i.customer_id
          LEFT JOIN shipment s  ON s.tenant_id = i.tenant_id AND s.id = i.shipment_id
         WHERE i.tenant_id = ${tenantId} AND i.deleted_at IS NULL AND i.status = 'ISSUED'
           AND i.invoice_date <= ${asOf}::date
      `,
      db.$queryRaw<{ invoice_id: bigint; invoice_code: string; invoice_date: Date; party_name: string | null; booking_code: string | null; supplier_invoice_no: string | null; costed: unknown; paid: unknown }[]>`
        SELECT i.id AS invoice_id, i.code AS invoice_code, i.invoice_date,
               COALESCE(ca.name, ag.name, ve.name) AS party_name, s.code AS booking_code, c.supplier_invoice_no,
               c.total_amount_base AS costed,
               (SELECT COALESCE(SUM(sp.amount_base), 0) FROM supplier_payment sp
                 WHERE sp.tenant_id = c.tenant_id AND sp.debit_invoice_cost_id = c.id AND sp.deleted_at IS NULL
                   AND sp.payment_date <= ${asOf}::date) AS paid
          FROM debit_invoice_cost c
          JOIN debit_invoice i ON i.tenant_id = c.tenant_id AND i.id = c.debit_invoice_id
          LEFT JOIN shipment s ON s.tenant_id = i.tenant_id AND s.id = i.shipment_id
          LEFT JOIN carrier ca ON ca.id = c.carrier_id
          LEFT JOIN agent ag   ON ag.tenant_id = c.tenant_id AND ag.id = c.agent_id
          LEFT JOIN vendor ve  ON ve.tenant_id = c.tenant_id AND ve.id = c.vendor_id
         WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL AND i.deleted_at IS NULL AND i.status = 'ISSUED'
           AND i.invoice_date <= ${asOf}::date
         ORDER BY i.invoice_date, i.code, c.sort_order, c.id
      `,
    ]);

    // The CRM openings, and what vouchers settled against them by the day.
    const movements = await openingMovements(db);
    const rates =
      input.base === null
        ? new Map<string, { rate: Prisma.Decimal }>()
        : await resolveRates(db, tenantId, [...new Set(movements.map((m) => m.currencyId.toString()))].map(BigInt));
    const openings = new Map<string, OpeningOwing>();
    for (const m of movements) {
      const rate =
        input.base !== null && m.currencyId === input.base.id
          ? new Prisma.Decimal(1)
          : rates.get(m.currencyId.toString())?.rate;
      // A currency with no rate on file cannot be stated in base; the list says so, and here it is left out.
      if (rate === undefined) continue;
      const base = toBase(m.amount, rate);
      const at = `${m.key}:${m.side}`;
      const [partyType, partyId] = m.key.split(':') as [LedgerPartyType, string];
      const row = openings.get(at) ?? { partyType, partyId: BigInt(partyId), side: m.side, date: m.date, owed: ZERO, settled: ZERO };
      if (m.settlement === null) {
        row.owed = row.owed.plus(base);
        row.date = m.date;
      } else if (m.date.toISOString().slice(0, 10) <= asOf) {
        // A settlement movement is negative; what it settled is its negation.
        row.settled = row.settled.minus(base);
      }
      openings.set(at, row);
    }

    accrual = {
      invoices: invoices.map((r) => ({
        id: r.id,
        code: r.code,
        invoiceDate: r.invoice_date,
        customerName: r.customer_name,
        bookingCode: r.booking_code,
        billed: dec(r.billed),
        received: dec(r.received),
      })),
      costs: costs.map((r) => ({
        invoiceId: r.invoice_id,
        invoiceCode: r.invoice_code,
        invoiceDate: r.invoice_date,
        partyName: r.party_name,
        bookingCode: r.booking_code,
        supplierInvoiceNo: r.supplier_invoice_no,
        costed: dec(r.costed),
        paid: dec(r.paid),
      })),
      openings: [...openings.values()],
    };
  }

  // ---------------------------------------------- the year's profit, and before
  const from = yearStartOf(asOf, input.yearStartMonth);
  const year = { from, to: asOf };
  const ledger = await statementLines(db, tenantId, [year, year, year], input.basis);
  const net = statementRows(ledger).find((r) => r.key === 'NET_PROFIT_AFTER_TAX')?.amounts[0] ?? '0';
  return { asOf, accounts, bookProfit, accrual, year, ledger, profitForYear: new Prisma.Decimal(net ?? '0') };
}

/** The accrual figures, summed: invoices and openings, each side. */
function accrualSums(accrual: NonNullable<Position['accrual']>) {
  const sum = <T>(rows: T[], f: (r: T) => Prisma.Decimal) => rows.reduce((acc, r) => acc.plus(f(r)), ZERO);
  const side = (s: 'RECEIVABLE' | 'PAYABLE') => accrual.openings.filter((o) => o.side === s);
  return {
    receivable: sum(accrual.invoices, (i) => i.billed.minus(i.received)),
    payable: sum(accrual.costs, (c) => c.costed.minus(c.paid)),
    owedToUs: sum(side('RECEIVABLE'), (o) => o.owed),
    owedByUs: sum(side('PAYABLE'), (o) => o.owed),
    settledToUs: sum(side('RECEIVABLE'), (o) => o.settled),
    settledByUs: sum(side('PAYABLE'), (o) => o.settled),
  };
}

function figuresOf(position: Position): Figures {
  const figures: Figures = new Map();
  const add = (key: BalanceSheetLineKey, amount: Prisma.Decimal) =>
    figures.set(key, (figures.get(key) ?? ZERO).plus(amount));

  for (const a of position.accounts) {
    if (a.accountType === 'INCOME' || a.accountType === 'EXPENSE') continue;
    const line = balanceLineOf({ accountType: a.accountType, systemKey: a.systemKey, parentKey: a.parentKey });
    // An asset reads debit − credit; a liability or equity account credit − debit.
    add(line, a.accountType === 'ASSET' ? a.debit.minus(a.credit) : a.credit.minus(a.debit));
  }

  let earned = position.bookProfit;
  if (position.accrual !== null) {
    const s = accrualSums(position.accrual);
    add('RECEIVABLE', s.receivable.plus(s.owedToUs).minus(s.settledToUs));
    add('PAYABLE', s.payable.plus(s.owedByUs).minus(s.settledByUs));
    add('OPENING_EQUITY', s.owedToUs.minus(s.owedByUs));
    // Revenue and cost as the invoices earned them, not as the cash arrived;
    // and an opening settled is a debt collected, not income.
    earned = position.bookProfit.plus(s.receivable).minus(s.payable).minus(s.settledToUs).plus(s.settledByUs);
  }

  add('PROFIT', position.profitForYear);
  add('RETAINED', earned.minus(position.profitForYear));
  return figures;
}

/** Every line's figure on one day, before the subtotals. */
export async function positionOn(
  db: TenantDb,
  tenantId: bigint,
  asOf: string,
  input: { basis: IncomeStatementBasis; yearStartMonth: number; base: BaseCurrency | null },
): Promise<Figures> {
  return figuresOf(await positionParts(db, tenantId, asOf, input));
}

// ------------------------------------------------------------------- rows

const GROUP_TITLE: Record<BalanceSheetGroup, string> = {
  CURRENT_ASSETS: 'Current Assets',
  NON_CURRENT_ASSETS: 'Non-Current Assets',
  CURRENT_LIABILITIES: 'Current Liabilities',
  LONG_TERM_LIABILITIES: 'Long-Term Liabilities',
  EQUITY: "Owner's Equity",
};

const GROUP_TOTAL: Record<BalanceSheetGroup, string> = {
  CURRENT_ASSETS: 'Total Current Assets',
  NON_CURRENT_ASSETS: 'Total Non-Current Assets',
  CURRENT_LIABILITIES: 'Total Current Liabilities',
  LONG_TERM_LIABILITIES: 'Total Long-Term Liabilities',
  EQUITY: "Total Owner's Equity",
};

export function balanceSheetRows(columns: Figures[]): { rows: StatementRowDto[]; balanced: boolean } {
  const amount = (key: BalanceSheetLineKey) => columns.map((c) => c.get(key) ?? ZERO);
  const groupSum = (group: BalanceSheetGroup) =>
    columns.map((c) =>
      BALANCE_SHEET_LINES.filter((l) => l.group === group).reduce((s, l) => s.plus(c.get(l.key) ?? ZERO), ZERO),
    );
  const add = (a: Prisma.Decimal[], b: Prisma.Decimal[]) => a.map((v, i) => v.plus(b[i]!));
  const out = (v: Prisma.Decimal[]) => v.map((d) => d.toFixed(2));

  const rows: StatementRowDto[] = [];
  const group = (g: BalanceSheetGroup) => {
    rows.push({ kind: 'GROUP', key: g, label: GROUP_TITLE[g], amounts: columns.map(() => null) });
    for (const l of BALANCE_SHEET_LINES.filter((x) => x.group === g)) {
      rows.push({ kind: 'LINE', key: l.key, label: l.label, amounts: out(amount(l.key)) });
    }
    const total = groupSum(g);
    rows.push({ kind: 'SUBTOTAL', key: `TOTAL_${g}`, label: GROUP_TOTAL[g], amounts: out(total) });
    return total;
  };

  rows.push({ kind: 'SECTION', key: 'ASSETS', label: 'A. Assets', amounts: columns.map(() => null) });
  const assets = add(group('CURRENT_ASSETS'), group('NON_CURRENT_ASSETS'));
  rows.push({ kind: 'TOTAL', key: 'TOTAL_ASSETS', label: 'Total Assets', amounts: out(assets) });

  rows.push({ kind: 'SECTION', key: 'LIABILITIES', label: 'B. Liabilities', amounts: columns.map(() => null) });
  const liabilities = add(group('CURRENT_LIABILITIES'), group('LONG_TERM_LIABILITIES'));
  rows.push({ kind: 'TOTAL', key: 'TOTAL_LIABILITIES', label: 'Total Liabilities', amounts: out(liabilities) });

  rows.push({ kind: 'SECTION', key: 'EQUITY_SECTION', label: "C. Owner's Equity", amounts: columns.map(() => null) });
  const equity = group('EQUITY');

  const both = add(liabilities, equity);
  rows.push({ kind: 'TOTAL', key: 'TOTAL_LIABILITIES_AND_EQUITY', label: "Total Liabilities and Owner's Equity", amounts: out(both) });

  // Assets = Liabilities + Owner's Equity (the identity the chart's H6 means).
  const difference = assets.map((a, i) => a.minus(both[i]!).toDecimalPlaces(2));
  const balanced = difference.every((d) => d.isZero());
  if (!balanced) {
    rows.push({ kind: 'CHECK', key: 'DIFFERENCE', label: 'Difference', amounts: out(difference) });
  }
  return { rows, balanced };
}

export async function balanceSheet(
  db: TenantDb,
  tenantId: bigint,
  input: { asOf: string; yearStartMonth: number; basis: IncomeStatementBasis; currencyCode: string; base: BaseCurrency | null },
): Promise<BalanceSheetDto> {
  const days = [input.asOf, yearBefore(input.asOf)];
  const columns = [];
  for (const day of days) {
    columns.push(await positionOn(db, tenantId, day, input));
  }
  const { rows, balanced } = balanceSheetRows(columns);
  return {
    currencyCode: input.currencyCode,
    basis: input.basis,
    yearStartMonth: input.yearStartMonth,
    columns: days.map((asOf, i) => ({ label: i === 0 ? 'As at' : 'A year earlier', asOf })),
    rows,
    balanced,
  };
}

// -------------------------------------------------------------- breakdown

/** "2026-10-31" → "31-Oct-2026", the statements' date style. */
function sheetDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}-${y}`;
}

/** The parties the openings belong to, for their names and codes. */
async function openingParties(db: TenantDb, openings: OpeningOwing[]): Promise<Map<string, { code: string; name: string }>> {
  const ids = (type: LedgerPartyType) => [...new Set(openings.filter((o) => o.partyType === type).map((o) => o.partyId))];
  const select = { id: true, code: true, name: true } as const;
  const [customers, agents, vendors] = await Promise.all([
    ids('CUSTOMER').length === 0 ? [] : db.customer.findMany({ where: { id: { in: ids('CUSTOMER') } }, select }),
    ids('AGENT').length === 0 ? [] : db.agent.findMany({ where: { id: { in: ids('AGENT') } }, select }),
    ids('VENDOR').length === 0 ? [] : db.vendor.findMany({ where: { id: { in: ids('VENDOR') } }, select }),
  ]);
  return new Map([
    ...customers.map((c) => [`CUSTOMER:${c.id}`, c] as const),
    ...agents.map((a) => [`AGENT:${a.id}`, a] as const),
    ...vendors.map((v) => [`VENDOR:${v.id}`, v] as const),
  ]);
}

/**
 * One line's figure in one column, as what it is made of (client, 2026-10-28).
 *
 * Read from the same itemised rows the statement adds up (positionParts), so
 * the total is the statement's figure and the rows add up to it:
 *
 *   every line           the posted vouchers on the accounts it maps, since the
 *                        books began — the oldest summed once there are many
 *   Receivable, Payable  + each issued invoice, or supplier's cost on one, that
 *                        is not settled by the day; and each opening not yet
 *                        settled (accrual)
 *   Opening Equity       + each opening as CRM holds it (accrual)
 *   Profit for the Year  the Income Statement for the year to the day, section
 *                        by section
 *   Retained Earnings    how it is worked out: all profit to the day, less the
 *                        year's
 *
 * Suppliers' costs need ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE to be listed,
 * as on the Income Statement's breakdown (MODULE_ACCOUNTS §3.9).
 */
export async function balanceSheetBreakdown(
  db: TenantDb,
  tenantId: bigint,
  input: {
    asOf: string;
    yearStartMonth: number;
    basis: IncomeStatementBasis;
    line: BalanceSheetLineKey;
    column: BalanceSheetColumn;
    currencyCode: string;
    base: BaseCurrency | null;
    viewBuyPrice: boolean;
  },
): Promise<StatementBreakdownDto> {
  const { line } = input;
  const asOf = BALANCE_SHEET_COLUMNS.indexOf(input.column) === 0 ? input.asOf : yearBefore(input.asOf);
  const [position, chart] = await Promise.all([positionParts(db, tenantId, asOf, input), chartAccounts(db, tenantId)]);
  const out = new Breakdown();
  const notes: string[] = [];

  // ------------------------------------------------------------ the books
  const mapped = chart.filter(
    (a) => a.accountType !== 'INCOME' && a.accountType !== 'EXPENSE' && balanceLineOf({ ...a, accountType: a.accountType }) === line,
  );
  const vouchers = await voucherRows(db, tenantId, { accountIds: mapped.map((a) => a.id), from: null, to: asOf, movedCash: false });
  out.addVouchers(vouchers, new Map(mapped.map((a) => [a.id.toString(), a])), (a) => a.accountType === 'ASSET');

  // ------------------------------------------------- what the books do not hold
  const accrual = position.accrual;
  if (accrual !== null && (line === 'RECEIVABLE' || line === 'PAYABLE' || line === 'OPENING_EQUITY')) {
    const parties = await openingParties(db, accrual.openings);
    const opening = (o: OpeningOwing, group: string, amount: Prisma.Decimal, details: string) => {
      const party = parties.get(`${o.partyType}:${o.partyId}`);
      out.add(group, {
        source: 'OPENING',
        date: o.date.toISOString().slice(0, 10),
        documentCode: party?.code ?? null,
        partyType: o.partyType,
        partyId: o.partyId.toString(),
        partyName: party?.name ?? null,
        reference: `${LEDGER_PARTY_LABEL[o.partyType]} opening balance`,
        details,
        amount,
      });
    };
    const settledNote = (o: OpeningOwing) =>
      o.settled.isZero() ? 'Opening balance from CRM' : `Opening ${shown(o.owed)}, settled ${shown(o.settled)}`;

    if (line === 'RECEIVABLE') {
      for (const i of accrual.invoices) {
        out.add('Issued debit invoices, not yet received', {
          source: 'DEBIT_INVOICE',
          date: i.invoiceDate.toISOString().slice(0, 10),
          documentId: i.id.toString(),
          documentCode: i.code,
          partyName: i.customerName,
          reference: i.bookingCode,
          details: i.received.isZero() ? null : `Billed ${shown(i.billed)}, received ${shown(i.received)}`,
          amount: i.billed.minus(i.received),
        });
      }
      for (const o of accrual.openings.filter((x) => x.side === 'RECEIVABLE')) {
        opening(o, 'Opening balances still owed to us', o.owed.minus(o.settled), settledNote(o));
      }
    }

    if (line === 'PAYABLE') {
      for (const c of accrual.costs) {
        const amount = c.costed.minus(c.paid);
        if (!input.viewBuyPrice) {
          out.withhold(amount);
          continue;
        }
        out.add("Suppliers' costs on issued invoices, not yet paid", {
          source: 'INVOICE_COST',
          date: c.invoiceDate.toISOString().slice(0, 10),
          documentId: c.invoiceId.toString(),
          documentCode: c.invoiceCode,
          partyName: c.partyName,
          reference: c.bookingCode,
          details: [c.supplierInvoiceNo, c.paid.isZero() ? null : `Cost ${shown(c.costed)}, paid ${shown(c.paid)}`]
            .filter((x) => x !== null)
            .join(' · ') || null,
          amount,
        });
      }
      for (const o of accrual.openings.filter((x) => x.side === 'PAYABLE')) {
        opening(o, 'Opening balances we still owe', o.owed.minus(o.settled), settledNote(o));
      }
    }

    if (line === 'OPENING_EQUITY') {
      // The other side of every opening, as CRM holds it: what was owed when the books began.
      for (const o of accrual.openings) {
        if (o.side === 'RECEIVABLE') opening(o, 'Opening balances owed to us', o.owed, 'Owed to us when the books began');
        else opening(o, 'Opening balances we owed', o.owed.negated(), 'Owed by us when the books began');
      }
    }
  }

  // ---------------------------------------------- the year's profit, and before
  const span = `${sheetDay(position.year.from)} to ${sheetDay(position.year.to)}`;
  const basisLabel = INCOME_STATEMENT_BASIS_LABEL[input.basis].toLowerCase();

  if (line === 'PROFIT') {
    for (const part of profitSections(position.ledger)) {
      out.add('Income Statement', { source: 'FIGURE', reference: part.label, details: span, amount: part.amount });
    }
    notes.push(
      `The Income Statement's ${basisLabel} net profit after tax, ${span}. Open the Income Statement to see each line's documents.`,
    );
  }

  if (line === 'RETAINED') {
    const earned = 'Profit earned to the day';
    out.add(earned, {
      source: 'FIGURE',
      reference: 'Income less expenses on posted vouchers',
      details: `Every voucher to ${sheetDay(asOf)}`,
      amount: position.bookProfit,
    });
    if (accrual !== null) {
      const s = accrualSums(accrual);
      out.add(earned, { source: 'FIGURE', reference: 'Add: still owed by customers on issued invoices', details: 'Revenue earned, not yet received', amount: s.receivable });
      out.add(earned, { source: 'FIGURE', reference: 'Less: still owed to suppliers on issued invoices', details: 'Costs incurred, not yet paid', amount: s.payable.negated() });
      out.add(earned, { source: 'FIGURE', reference: 'Less: opening balances collected', details: 'A debt collected, not income', amount: s.settledToUs.negated() });
      out.add(earned, { source: 'FIGURE', reference: 'Add: opening balances paid', details: 'A debt paid, not an expense', amount: s.settledByUs });
    }
    out.add('Less: Profit for the Year', {
      source: 'FIGURE',
      reference: 'Less: Profit for the Year',
      details: `${span}, shown on its own line`,
      amount: position.profitForYear.negated(),
    });
    notes.push(`Everything earned before ${sheetDay(position.year.from)}: all profit to the day, less this financial year's.`);
  }

  if (input.basis === 'ACCRUAL' && accrual !== null && accrual.openings.length > 0 && (line === 'RECEIVABLE' || line === 'PAYABLE' || line === 'OPENING_EQUITY')) {
    notes.push("Opening balances carry no fixed rate, so a foreign-currency one is converted at today's rate.");
  }

  const label = BALANCE_SHEET_LINES.find((l) => l.key === line)!.label;
  return out.dto({
    line,
    label,
    currencyCode: input.currencyCode,
    basis: input.basis,
    column: input.column,
    period: { from: null, to: asOf },
    total: figuresOf(position).get(line) ?? ZERO,
    notes,
  });
}

/** Net profit after tax as the Income Statement builds it, section by section, unrounded. */
function profitSections(ledger: Ledger): { label: string; amount: Prisma.Decimal }[] {
  const section = (s: IncomeStatementSection) =>
    INCOME_STATEMENT_LINES.filter((l) => l.section === s).reduce(
      (sum, l) => sum.plus(ledger.of(l.key as IncomeStatementLineKey)[0]!),
      ZERO,
    );
  return [
    { label: 'Net Revenue', amount: section('REVENUE').minus(ledger.of('DISCOUNTS')[0]!) },
    { label: 'Less: Total Direct Cost', amount: section('DIRECT_COST').negated() },
    { label: 'Less: Total Operating Expenses', amount: section('OPEX').negated() },
    { label: 'Add: Total Non-Operating Income', amount: section('NONOP_INCOME') },
    { label: 'Less: Total Non-Operating Expenses', amount: section('NONOP_EXPENSE').negated() },
    { label: 'Less: Income Tax Expense', amount: ledger.of('INCOME_TAX')[0]!.negated() },
  ];
}
