import {
  BANK_CHARGE_ACCOUNT_KEY,
  INCOME_STATEMENT_COLUMNS,
  INCOME_STATEMENT_LINES,
  INCOME_STATEMENT_SECTION_TITLE,
  type IncomeStatementBasis,
  type IncomeStatementBreakdownDto,
  type IncomeStatementColumn,
  type IncomeStatementDto,
  type IncomeStatementEntryDto,
  type IncomeStatementLineKey,
  type IncomeStatementRowDto,
  type IncomeStatementSection,
  type JournalEntryKind,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import type { TenantDb } from './tenant-client';

/**
 * The Income statement — docs/DESIGN-UPDATE-2026-10-04.md §9.3.
 *
 * Accrual, as the sheet asks (C9), from books that recognise service revenue
 * when the money arrives (MODULE_ACCOUNTS §14.13 Q2). Rather than restructure
 * those books, the statement reads each figure from where it is earned:
 *
 *   revenue        every ISSUED debit invoice, on its invoice date, by the
 *                  booking's service (FCL, LCL, Air; anything else is Other)
 *   job costs      the cost blocks of those invoices, on the same date — the
 *                  matching principle: a job's cost lands with its revenue.
 *                  Carrier and vendor blocks are freight by service; agent
 *                  blocks are Agent / Overseas Partner Cost
 *   everything     every POSTED voucher line on an income or expense account,
 *   else           on its entry date, mapped from the chart (ACCOUNT_LINE)
 *
 * …except the vouchers that settle something. A receipt against an invoice,
 * a payment against a supplier's cost and a payment against an opening
 * balance are cash for revenue or cost already counted (or counted before the
 * system existed), so their category lines are left out. What such a voucher
 * moved beyond the document's booked base is the exchange difference, and
 * that is real: it becomes Foreign Exchange Gain or Loss on the voucher date.
 * A bank charge on one (MODULE_ACCOUNTS §14.15) is neither: it is the bank's
 * fee, and counts as Bank Charges like any other.
 */

// ---------------------------------------------------------------- mapping

/**
 * The predefined chart (lib/ledger DEFAULT_CHART) onto the sheet's lines, by
 * system key. A workspace's own accounts follow their parent ledger
 * (LEDGER_LINE), and an account with neither falls to its type.
 */
const ACCOUNT_LINE: Readonly<Record<string, IncomeStatementLineKey>> = {
  'INCOME.SERVICE.SEA_FCL': 'REV_FCL',
  'INCOME.SERVICE.SEA_LCL': 'REV_LCL',
  'INCOME.SERVICE.SEA_DOOR': 'REV_DOOR',
  'INCOME.SERVICE.AIR': 'REV_AIR',
  'INCOME.SERVICE.PROJECT': 'REV_PROJECT',
  'INCOME.SERVICE.CUSTOMS': 'REV_CUSTOMS',
  'INCOME.SERVICE.WAREHOUSING': 'REV_WAREHOUSING',
  'INCOME.SERVICE.COMMISSION': 'REV_OTHER',
  'INCOME.FX_GAIN': 'FX_GAIN',
  'INCOME.OTHER.FIXED_DEPOSIT': 'NONOP_INTEREST',
  'INCOME.UNCATEGORIZED': 'NONOP_INC_OTHER',

  'EXPENSE.COST_OF_SERVICE.SEA_FCL': 'COST_FCL',
  'EXPENSE.COST_OF_SERVICE.SEA_LCL': 'COST_LCL',
  'EXPENSE.COST_OF_SERVICE.SEA_DOOR': 'COST_OTHER_JOB',
  'EXPENSE.COST_OF_SERVICE.AIR': 'COST_AIR',
  'EXPENSE.COST_OF_SERVICE.PROJECT': 'COST_OTHER_JOB',
  'EXPENSE.COST_OF_SERVICE.CUSTOMS': 'COST_CUSTOMS',
  'EXPENSE.COST_OF_SERVICE.WAREHOUSING': 'COST_WAREHOUSE',
  'EXPENSE.DISCOUNT': 'DISCOUNTS',
  'EXPENSE.FX_LOSS': 'FX_LOSS',

  'EXPENSE.OPERATING.AUDITOR_FEE': 'OPEX_PROFESSIONAL',
  'EXPENSE.OPERATING.ADVERTISEMENT': 'OPEX_MARKETING',
  'EXPENSE.OPERATING.BANK_CHARGE': 'OPEX_BANK',
  'EXPENSE.OPERATING.COMPUTER_HARDWARE': 'OPEX_IT',
  'EXPENSE.OPERATING.COMPUTER_SOFTWARE': 'OPEX_IT',
  'EXPENSE.OPERATING.HOSTING': 'OPEX_IT',
  'EXPENSE.OPERATING.INTERNET': 'OPEX_TELECOM',
  'EXPENSE.OPERATING.MOBILE': 'OPEX_TELECOM',
  'EXPENSE.OPERATING.TELEPHONE': 'OPEX_TELECOM',
  'EXPENSE.OPERATING.TA_DA': 'OPEX_TRAVEL',
  'EXPENSE.OPERATING.MEAL': 'OPEX_TRAVEL',
  'EXPENSE.OPERATING.SALES_INCENTIVE': 'OPEX_COMMISSION',
  'EXPENSE.OPERATING.INTEREST': 'NONOP_FINANCE',
  'EXPENSE.OPERATING.STATIONERY': 'OPEX_SUPPLIES',
  'EXPENSE.OPERATING.PROFESSIONAL_FEE': 'OPEX_PROFESSIONAL',
  'EXPENSE.OPERATING.RENT': 'OPEX_RENT',
  'EXPENSE.OPERATING.REPAIR': 'OPEX_REPAIRS',
  'EXPENSE.OPERATING.UTILITIES': 'OPEX_UTILITIES',
  'EXPENSE.OPERATING.VEHICLE_FUEL': 'OPEX_VEHICLE',
  'EXPENSE.OPERATING.VEHICLE_REPAIR': 'OPEX_VEHICLE',
  'EXPENSE.OPERATING.ADJUSTMENT': 'OPEX_OTHER_ADMIN',
  'EXPENSE.OPERATING.CASH_SHORT': 'OPEX_OTHER_ADMIN',
  'EXPENSE.OPERATING.MEDIA_BUYING': 'OPEX_MARKETING',
  'EXPENSE.OPERATING.INSURANCE': 'OPEX_INSURANCE',
  'EXPENSE.OPERATING.DEPRECIATION': 'OPEX_DEPRECIATION',
  'EXPENSE.OPERATING.BAD_DEBT': 'OPEX_BAD_DEBT',
  'EXPENSE.OPERATING.LEGAL': 'OPEX_LEGAL',
  'EXPENSE.OPERATING.BUSINESS_DEVELOPMENT': 'OPEX_BUSINESS_DEV',
  'EXPENSE.PAYROLL.BENEFITS': 'OPEX_BENEFITS',
  'EXPENSE.PAYROLL.SALARY': 'OPEX_SALARIES',
  'EXPENSE.UNCATEGORIZED.GENERAL': 'OPEX_OTHER_ADMIN',
  'EXPENSE.NON_OPERATING.ASSET_DISPOSAL': 'NONOP_ASSET_LOSS',
  'EXPENSE.NON_OPERATING.OTHER': 'NONOP_EXP_OTHER',
  'EXPENSE.TAX.INCOME_TAX': 'INCOME_TAX',
};

/** Where a workspace's own sub ledger lands, by the predefined ledger it sits under. */
const LEDGER_LINE: Readonly<Record<string, IncomeStatementLineKey>> = {
  'INCOME.SERVICE': 'REV_OTHER',
  'INCOME.OTHER': 'NONOP_INC_OTHER',
  'EXPENSE.COST_OF_SERVICE': 'COST_OTHER_JOB',
  'EXPENSE.OPERATING': 'OPEX_OTHER_ADMIN',
  'EXPENSE.PAYROLL': 'OPEX_SALARIES',
  'EXPENSE.UNCATEGORIZED': 'OPEX_OTHER_ADMIN',
  'EXPENSE.NON_OPERATING': 'NONOP_EXP_OTHER',
  'EXPENSE.TAX': 'INCOME_TAX',
};

export function lineOfAccount(account: {
  accountType: 'INCOME' | 'EXPENSE';
  systemKey: string | null;
  parentKey: string | null;
}): IncomeStatementLineKey {
  if (account.systemKey !== null) {
    const own = ACCOUNT_LINE[account.systemKey] ?? LEDGER_LINE[account.systemKey];
    if (own !== undefined) return own;
  }
  if (account.parentKey !== null) {
    const inherited = ACCOUNT_LINE[account.parentKey] ?? LEDGER_LINE[account.parentKey];
    if (inherited !== undefined) return inherited;
  }
  return account.accountType === 'INCOME' ? 'NONOP_INC_OTHER' : 'OPEX_OTHER_ADMIN';
}

const SECTION_OF = new Map<IncomeStatementLineKey, IncomeStatementSection | 'DISCOUNTS' | 'INCOME_TAX'>([
  ...INCOME_STATEMENT_LINES.map((l) => [l.key, l.section] as const),
  ['DISCOUNTS', 'DISCOUNTS'],
  ['INCOME_TAX', 'INCOME_TAX'],
]);

/** Income-natured lines read credit − debit; the rest debit − credit. */
function isIncomeNatured(key: IncomeStatementLineKey): boolean {
  const section = SECTION_OF.get(key);
  return section === 'REVENUE' || section === 'NONOP_INCOME';
}

// ---------------------------------------------------------------- periods

export interface Period {
  from: string;
  to: string;
}

const iso = (y: number, m: number, d: number): string =>
  new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The sheet's three columns for a month: the month itself, the financial year
 * to the end of it, and the same span a year earlier.
 */
export function periodsOf(month: string, yearStartMonth: number): [Period, Period, Period] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const startYear = m >= yearStartMonth ? y : y - 1;
  const current = { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
  const ytd = { from: iso(startYear, yearStartMonth, 1), to: current.to };
  const previousYtd = { from: iso(startYear - 1, yearStartMonth, 1), to: iso(y - 1, m, lastDay(y - 1, m)) };
  return [current, ytd, previousYtd];
}

/** The calendar month before `month`, whatever the financial year: December for a January. */
export function previousMonthOf(month: string): Period {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
  return { from: iso(py, pm, 1), to: iso(py, pm, lastDay(py, pm)) };
}

/**
 * The Income Statement's columns, in INCOME_STATEMENT_COLUMNS order: the
 * sheet's three, with Previous Month beside Current Month (client,
 * 2026-10-21). The Cash Flow Statement keeps the sheet's three (periodsOf).
 */
export function statementPeriodsOf(month: string, yearStartMonth: number): [Period, Period, Period, Period] {
  const [current, ytd, previousYtd] = periodsOf(month, yearStartMonth);
  return [current, previousMonthOf(month), ytd, previousYtd];
}

// ----------------------------------------------------------------- totals

/** One amount per column. */
type Amounts = Prisma.Decimal[];
const zero = (columns: number): Amounts => Array.from({ length: columns }, () => new Prisma.Decimal(0));
const dec = (v: Prisma.Decimal | string | number | null): Prisma.Decimal => new Prisma.Decimal(v ?? 0);

/** The statement's figures by line, one amount per column. */
export class Ledger {
  readonly lines = new Map<IncomeStatementLineKey, Amounts>();

  constructor(readonly columns: number) {}

  add(key: IncomeStatementLineKey, column: number, amount: Prisma.Decimal): void {
    const row = this.lines.get(key) ?? zero(this.columns);
    row[column] = row[column]!.plus(amount);
    this.lines.set(key, row);
  }

  addColumns(key: IncomeStatementLineKey, amounts: (Prisma.Decimal | string | number | null)[]): void {
    amounts.forEach((a, i) => this.add(key, i, dec(a)));
  }

  of(key: IncomeStatementLineKey): Amounts {
    return this.lines.get(key) ?? zero(this.columns);
  }
}

function service(shipmentType: string | null, loadingType: string | null): 'FCL' | 'LCL' | 'AIR' | null {
  if (shipmentType === 'AIR') return 'AIR';
  if (loadingType === 'FCL') return 'FCL';
  if (loadingType === 'LCL') return 'LCL';
  return null;
}

const REVENUE_BY_SERVICE = { FCL: 'REV_FCL', LCL: 'REV_LCL', AIR: 'REV_AIR' } as const;
const COST_BY_SERVICE = { FCL: 'COST_FCL', LCL: 'COST_LCL', AIR: 'COST_AIR' } as const;

/** The line an issued invoice's revenue lands on: by the booking's service, anything else Other. */
function revenueLineOf(shipmentType: string | null, loadingType: string | null): IncomeStatementLineKey {
  const svc = service(shipmentType, loadingType);
  return svc === null ? 'REV_OTHER' : REVENUE_BY_SERVICE[svc];
}

/** The line a cost block lands on: agents apart, carriers and vendors as freight by service. */
function costLineOf(partyType: string, shipmentType: string | null, loadingType: string | null): IncomeStatementLineKey {
  if (partyType === 'AGENT') return 'COST_AGENT';
  const svc = service(shipmentType, loadingType);
  return svc === null ? 'COST_OTHER_JOB' : COST_BY_SERVICE[svc];
}

/** Every line revenueLineOf and costLineOf can answer: the only lines an invoice reaches. */
const INVOICE_REVENUE_LINES = new Set<IncomeStatementLineKey>([...Object.values(REVENUE_BY_SERVICE), 'REV_OTHER']);
const INVOICE_COST_LINES = new Set<IncomeStatementLineKey>([...Object.values(COST_BY_SERVICE), 'COST_AGENT', 'COST_OTHER_JOB']);

/**
 * A voucher that settles something: a receipt against an invoice, a payment
 * against a supplier's cost, or a payment against an opening balance.
 */
const SETTLES = Prisma.sql`(
     EXISTS (SELECT 1 FROM debit_invoice_receipt r
              WHERE r.tenant_id = je.tenant_id AND r.journal_entry_id = je.id AND r.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM supplier_payment sp
              WHERE sp.tenant_id = je.tenant_id AND sp.journal_entry_id = je.id AND sp.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM opening_settlement os
              WHERE os.tenant_id = je.tenant_id AND os.journal_entry_id = je.id AND os.deleted_at IS NULL)
)`;

/** A line on the Bank Service Charge account. Needs la. */
const IS_BANK_CHARGE = Prisma.sql`COALESCE(la.system_key, '') = ${BANK_CHARGE_ACCOUNT_KEY}`;

/**
 * The lines accrual leaves out: a settling voucher's, but for its bank charge,
 * which is a cost of its own and not part of the exchange difference.
 */
const SETTLEMENT_LINE = Prisma.sql`(${SETTLES} AND NOT ${IS_BANK_CHARGE})`;

/** The voucher's party, whichever of the four it names. Needs je, and the four joins below. */
const PARTY_NAME = Prisma.sql`COALESCE(cu.name, ag.name, ca.name, ve.name)`;
const PARTY_JOINS = Prisma.sql`
  LEFT JOIN customer cu ON cu.tenant_id = je.tenant_id AND cu.id = je.customer_id
  LEFT JOIN agent ag    ON ag.tenant_id = je.tenant_id AND ag.id = je.agent_id
  LEFT JOIN carrier ca  ON ca.id = je.carrier_id
  LEFT JOIN vendor ve   ON ve.tenant_id = je.tenant_id AND ve.id = je.vendor_id`;

type SettlementRow = {
  id: bigint;
  code: string;
  kind: JournalEntryKind;
  entry_date: Date;
  party_name: string | null;
  /** The debit invoices it received against or paid a cost of, by number. */
  settled: string | null;
  pl: Prisma.Decimal;
  received: Prisma.Decimal;
  paid: Prisma.Decimal;
};

/** Every posted voucher that received against an invoice or paid a supplier's cost, dated within `when`. */
function settlementVouchers(db: TenantDb, tenantId: bigint, when: Prisma.Sql): Promise<SettlementRow[]> {
  return db.$queryRaw<SettlementRow[]>`
    SELECT je.id, je.code, je.kind::text AS kind, je.entry_date, ${PARTY_NAME} AS party_name,
           (SELECT string_agg(d.code, ', ' ORDER BY d.code)
              FROM debit_invoice d
             WHERE d.tenant_id = je.tenant_id
               AND (d.id IN (SELECT r.debit_invoice_id FROM debit_invoice_receipt r
                              WHERE r.tenant_id = je.tenant_id AND r.journal_entry_id = je.id AND r.deleted_at IS NULL)
                 OR d.id IN (SELECT c.debit_invoice_id FROM supplier_payment sp
                               JOIN debit_invoice_cost c ON c.tenant_id = sp.tenant_id AND c.id = sp.debit_invoice_cost_id
                              WHERE sp.tenant_id = je.tenant_id AND sp.journal_entry_id = je.id AND sp.deleted_at IS NULL))
           ) AS settled,
           (SELECT COALESCE(SUM(jl.credit - jl.debit), 0)
              FROM journal_line jl
              JOIN ledger_account la ON la.tenant_id = jl.tenant_id AND la.id = jl.ledger_account_id
             WHERE jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id AND jl.deleted_at IS NULL
               AND la.account_type IN ('INCOME', 'EXPENSE')
               AND NOT ${IS_BANK_CHARGE}) AS pl,
           (SELECT COALESCE(SUM(r.amount_base), 0) FROM debit_invoice_receipt r
             WHERE r.tenant_id = je.tenant_id AND r.journal_entry_id = je.id AND r.deleted_at IS NULL) AS received,
           (SELECT COALESCE(SUM(sp.amount_base), 0) FROM supplier_payment sp
             WHERE sp.tenant_id = je.tenant_id AND sp.journal_entry_id = je.id AND sp.deleted_at IS NULL) AS paid
      FROM journal_entry je
      ${PARTY_JOINS}
     WHERE je.tenant_id = ${tenantId}
       AND je.deleted_at IS NULL
       AND je.status = 'POSTED'
       AND ${when}
       AND (
             EXISTS (SELECT 1 FROM debit_invoice_receipt r
                      WHERE r.tenant_id = je.tenant_id AND r.journal_entry_id = je.id AND r.deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM supplier_payment sp
                      WHERE sp.tenant_id = je.tenant_id AND sp.journal_entry_id = je.id AND sp.deleted_at IS NULL)
       )
     ORDER BY je.entry_date, je.code
  `;
}

/*
 * The exchange difference a settlement realised. Income vouchers: cash in
 * (pl) less the invoice base it settled. Expense vouchers: pl is the cash
 * out, negative; adding the cost base it settled leaves what was saved.
 * Positive is a gain, negative a loss.
 */
const exchangeOf = (row: SettlementRow): Prisma.Decimal => dec(row.pl).plus(dec(row.paid)).minus(dec(row.received));

const day = (d: Date): string => d.toISOString().slice(0, 10);

/** One conditional sum per column over a date expression, named c0, c1, …. */
function columnSums(value: Prisma.Sql, date: Prisma.Sql, periods: readonly Period[]): Prisma.Sql {
  return Prisma.join(
    periods.map(
      (p, i) =>
        Prisma.sql`COALESCE(SUM(${value}) FILTER (WHERE ${date} BETWEEN ${p.from}::date AND ${p.to}::date), 0) AS ${Prisma.raw(`c${i}`)}`,
    ),
    ',\n',
  );
}

function inAnyPeriod(date: Prisma.Sql, periods: readonly Period[]): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(
    periods.map((p) => Prisma.sql`${date} BETWEEN ${p.from}::date AND ${p.to}::date`),
    ' OR ',
  )})`;
}

type ColumnRow = Record<`c${number}`, Prisma.Decimal>;
/** A row's columnSums, in column order. */
const columnsOf = (row: ColumnRow, periods: readonly Period[]): Prisma.Decimal[] =>
  periods.map((_, i) => dec(row[`c${i}`] ?? null));
type RevenueRow = ColumnRow & { shipment_type: string | null; loading_type: string | null };
type CostRow = RevenueRow & { party_type: string };

/**
 * Every figure the statement prints, by line, before the subtotals.
 *
 * ACCRUAL is described at the top of this file. CASH is the Transaction
 * screens alone: every posted voucher line on an income or expense account,
 * settlements included — so revenue is what Transaction → Income received —
 * and no invoice is read. An exchange difference then sits inside the cash,
 * as it does in the books, rather than on a line of its own.
 *
 * tenant_id is named on every table even though RLS filters them too: the
 * application is the first line (CLAUDE.md §7A rule 2).
 */
export async function statementLines(
  db: TenantDb,
  tenantId: bigint,
  periods: readonly Period[],
  basis: IncomeStatementBasis = 'ACCRUAL',
): Promise<Ledger> {
  const ledger = new Ledger(periods.length);
  const accrual = basis === 'ACCRUAL';
  const invoiceDate = Prisma.sql`i.invoice_date`;
  const entryDate = Prisma.sql`je.entry_date`;

  const [revenue, costs, posted, settlements] = await Promise.all([
    !accrual ? Promise.resolve<RevenueRow[]>([]) : db.$queryRaw<RevenueRow[]>`
      SELECT s.shipment_type::text AS shipment_type, s.loading_type::text AS loading_type,
             ${columnSums(Prisma.sql`i.total_amount_base`, invoiceDate, periods)}
        FROM debit_invoice i
        LEFT JOIN shipment s ON s.tenant_id = i.tenant_id AND s.id = i.shipment_id
       WHERE i.tenant_id = ${tenantId}
         AND i.deleted_at IS NULL
         AND i.status = 'ISSUED'
         AND ${inAnyPeriod(invoiceDate, periods)}
       GROUP BY s.shipment_type, s.loading_type
    `,
    !accrual ? Promise.resolve<CostRow[]>([]) : db.$queryRaw<CostRow[]>`
      SELECT c.party_type::text AS party_type, s.shipment_type::text AS shipment_type, s.loading_type::text AS loading_type,
             ${columnSums(Prisma.sql`c.total_amount_base`, invoiceDate, periods)}
        FROM debit_invoice_cost c
        JOIN debit_invoice i ON i.tenant_id = c.tenant_id AND i.id = c.debit_invoice_id
        LEFT JOIN shipment s ON s.tenant_id = i.tenant_id AND s.id = i.shipment_id
       WHERE c.tenant_id = ${tenantId}
         AND c.deleted_at IS NULL
         AND i.deleted_at IS NULL
         AND i.status = 'ISSUED'
         AND ${inAnyPeriod(invoiceDate, periods)}
       GROUP BY c.party_type, s.shipment_type, s.loading_type
    `,
    db.$queryRaw<(ColumnRow & { account_type: 'INCOME' | 'EXPENSE'; system_key: string | null; parent_key: string | null })[]>`
      SELECT la.account_type::text AS account_type, la.system_key, p.system_key AS parent_key,
             ${columnSums(Prisma.sql`(jl.credit - jl.debit)`, entryDate, periods)}
        FROM journal_line jl
        JOIN journal_entry je  ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
        JOIN ledger_account la ON la.tenant_id = jl.tenant_id AND la.id = jl.ledger_account_id
        LEFT JOIN ledger_account p ON p.tenant_id = la.tenant_id AND p.id = la.parent_id
       WHERE jl.tenant_id = ${tenantId}
         AND jl.deleted_at IS NULL
         AND je.deleted_at IS NULL
         AND je.status = 'POSTED'
         AND la.account_type IN ('INCOME', 'EXPENSE')
         AND ${inAnyPeriod(entryDate, periods)}
         ${accrual ? Prisma.sql`AND NOT ${SETTLEMENT_LINE}` : Prisma.empty}
       GROUP BY la.account_type, la.system_key, p.system_key
    `,
    !accrual ? Promise.resolve<SettlementRow[]>([]) : settlementVouchers(db, tenantId, inAnyPeriod(entryDate, periods)),
  ]);

  for (const row of revenue) {
    ledger.addColumns(revenueLineOf(row.shipment_type, row.loading_type), columnsOf(row, periods));
  }

  for (const row of costs) {
    ledger.addColumns(costLineOf(row.party_type, row.shipment_type, row.loading_type), columnsOf(row, periods));
  }

  for (const row of posted) {
    const key = lineOfAccount({ accountType: row.account_type, systemKey: row.system_key, parentKey: row.parent_key });
    // credit − debit is what an income line earns; an expense line is its negative.
    const sign = isIncomeNatured(key) ? 1 : -1;
    ledger.addColumns(key, columnsOf(row, periods).map((v) => dec(v).times(sign)));
  }

  for (const row of settlements) {
    const fx = exchangeOf(row);
    if (fx.isZero()) continue;
    const date = day(row.entry_date);
    periods.forEach((p, column) => {
      if (date < p.from || date > p.to) return;
      if (fx.greaterThan(0)) ledger.add('FX_GAIN', column, fx);
      else ledger.add('FX_LOSS', column, fx.negated());
    });
  }

  return ledger;
}

// ------------------------------------------------------------------- rows

const money = (v: Prisma.Decimal): string => v.toFixed(2);

const minus = (a: Amounts, b: Amounts): Amounts => a.map((v, i) => v.minus(b[i]!));
const plus = (a: Amounts, b: Amounts): Amounts => a.map((v, i) => v.plus(b[i]!));

function sum(ledger: Ledger, keys: IncomeStatementLineKey[]): Amounts {
  return keys.reduce<Amounts>((acc, key) => plus(acc, ledger.of(key)), zero(ledger.columns));
}

function percent(part: Amounts, whole: Amounts): IncomeStatementRowDto['amounts'] {
  return part.map((p, i) => (whole[i]!.isZero() ? null : p.div(whole[i]!).times(100).toFixed(1)));
}

const out = (a: Amounts): IncomeStatementRowDto['amounts'] => a.map(money);

/** Every line's printed label, the two outside the sections included. */
const LABEL_OF = new Map<IncomeStatementLineKey, string>([
  ...INCOME_STATEMENT_LINES.map((l) => [l.key, l.label] as const),
  ['DISCOUNTS', 'Less: Discounts / Credit Notes'],
  ['INCOME_TAX', 'Income Tax Expense'],
]);

/** The sheet's layout, top to bottom, with every subtotal it draws (C11–C91). */
export function statementRows(ledger: Ledger): IncomeStatementRowDto[] {
  const keysOf = (section: IncomeStatementSection) =>
    INCOME_STATEMENT_LINES.filter((l) => l.section === section).map((l) => l.key as IncomeStatementLineKey);
  const lineRows = (section: IncomeStatementSection): IncomeStatementRowDto[] =>
    INCOME_STATEMENT_LINES.filter((l) => l.section === section).map((l) => ({
      kind: 'LINE',
      key: l.key,
      label: l.label,
      amounts: out(ledger.of(l.key)),
    }));
  const section = (s: IncomeStatementSection): IncomeStatementRowDto => ({
    kind: 'SECTION',
    key: s,
    label: INCOME_STATEMENT_SECTION_TITLE[s],
    amounts: Array.from({ length: ledger.columns }, () => null),
  });

  const gross = sum(ledger, keysOf('REVENUE'));
  const discounts = ledger.of('DISCOUNTS');
  const netRevenue = minus(gross, discounts);
  const directCost = sum(ledger, keysOf('DIRECT_COST'));
  const grossProfit = minus(netRevenue, directCost);
  const opex = sum(ledger, keysOf('OPEX'));
  const operatingProfit = minus(grossProfit, opex);
  const nonOpIncome = sum(ledger, keysOf('NONOP_INCOME'));
  const nonOpExpense = sum(ledger, keysOf('NONOP_EXPENSE'));
  const beforeTax = minus(plus(operatingProfit, nonOpIncome), nonOpExpense);
  const tax = ledger.of('INCOME_TAX');
  const afterTax = minus(beforeTax, tax);

  return [
    section('REVENUE'),
    ...lineRows('REVENUE'),
    { kind: 'SUBTOTAL', key: 'GROSS_REVENUE', label: 'Gross Revenue', amounts: out(gross) },
    { kind: 'LINE', key: 'DISCOUNTS', label: LABEL_OF.get('DISCOUNTS')!, amounts: out(discounts), deduction: true },
    { kind: 'TOTAL', key: 'NET_REVENUE', label: 'Net Revenue', amounts: out(netRevenue) },
    section('DIRECT_COST'),
    ...lineRows('DIRECT_COST'),
    { kind: 'TOTAL', key: 'TOTAL_DIRECT_COST', label: 'Total Direct Cost', amounts: out(directCost) },
    { kind: 'TOTAL', key: 'GROSS_PROFIT', label: 'Gross Profit', amounts: out(grossProfit) },
    { kind: 'PERCENT', key: 'GROSS_PROFIT_PERCENT', label: 'Gross Profit %', amounts: percent(grossProfit, netRevenue) },
    section('OPEX'),
    ...lineRows('OPEX'),
    { kind: 'TOTAL', key: 'TOTAL_OPEX', label: 'Total Operating Expenses', amounts: out(opex) },
    { kind: 'TOTAL', key: 'OPERATING_PROFIT', label: 'Operating Profit', amounts: out(operatingProfit) },
    section('NONOP_INCOME'),
    ...lineRows('NONOP_INCOME'),
    { kind: 'SUBTOTAL', key: 'TOTAL_NONOP_INCOME', label: 'Total Non-Operating Income', amounts: out(nonOpIncome) },
    section('NONOP_EXPENSE'),
    ...lineRows('NONOP_EXPENSE'),
    { kind: 'SUBTOTAL', key: 'TOTAL_NONOP_EXPENSE', label: 'Total Non-Operating Expenses', amounts: out(nonOpExpense) },
    { kind: 'TOTAL', key: 'PROFIT_BEFORE_TAX', label: 'Profit Before Tax', amounts: out(beforeTax) },
    { kind: 'LINE', key: 'INCOME_TAX', label: LABEL_OF.get('INCOME_TAX')!, amounts: out(tax) },
    { kind: 'TOTAL', key: 'NET_PROFIT_AFTER_TAX', label: 'Net Profit After Tax', amounts: out(afterTax) },
    { kind: 'PERCENT', key: 'NET_PROFIT_MARGIN', label: 'Net Profit Margin %', amounts: percent(afterTax, netRevenue) },
  ];
}

export async function incomeStatement(
  db: TenantDb,
  tenantId: bigint,
  input: { month: string; yearStartMonth: number; basis: IncomeStatementBasis; currencyCode: string },
): Promise<IncomeStatementDto> {
  const periods = statementPeriodsOf(input.month, input.yearStartMonth);
  const ledger = await statementLines(db, tenantId, periods, input.basis);
  const [currentMonth, previousMonth, ytd, previousYtd] = periods;
  return {
    currencyCode: input.currencyCode,
    basis: input.basis,
    periods: { currentMonth, previousMonth, ytd, previousYtd },
    yearStartMonth: input.yearStartMonth,
    rows: statementRows(ledger),
  };
}

// -------------------------------------------------------------- breakdown

type InvoiceEntryRow = {
  id: bigint;
  code: string;
  invoice_date: Date;
  amount: Prisma.Decimal;
  shipment_type: string | null;
  loading_type: string | null;
  booking_code: string | null;
  party_name: string | null;
};
type CostEntryRow = InvoiceEntryRow & { party_type: string; supplier_invoice_no: string | null };
type VoucherEntryRow = {
  id: bigint;
  code: string;
  kind: JournalEntryKind;
  entry_date: Date;
  description: string | null;
  account_name: string;
  party_name: string | null;
  amount: Prisma.Decimal;
};

/**
 * One line's figure for one column, as the documents it was added up from
 * (client, 2026-10-20). The same sources, filters and mapping as
 * statementLines, read row by row instead of summed, so the entries add up to
 * the statement's figure; income-statement.test.ts checks that for every line.
 *
 * A voucher is one entry per account it touched on this line. Job costs need
 * ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE to be listed: without it they are
 * counted and summed into `withheld`, so the total still agrees with a
 * statement that already prints them as a line (MODULE_ACCOUNTS §3.9).
 */
export async function lineBreakdown(
  db: TenantDb,
  tenantId: bigint,
  input: {
    month: string;
    yearStartMonth: number;
    basis: IncomeStatementBasis;
    line: IncomeStatementLineKey;
    column: IncomeStatementColumn;
    currencyCode: string;
    viewBuyPrice: boolean;
  },
): Promise<IncomeStatementBreakdownDto> {
  const { line, basis } = input;
  const accrual = basis === 'ACCRUAL';
  const period = statementPeriodsOf(input.month, input.yearStartMonth)[INCOME_STATEMENT_COLUMNS.indexOf(input.column)]!;
  const within = (date: Prisma.Sql) => Prisma.sql`${date} BETWEEN ${period.from}::date AND ${period.to}::date`;
  const invoiceDate = Prisma.sql`i.invoice_date`;
  const entryDate = Prisma.sql`je.entry_date`;

  const accounts = await db.$queryRaw<{ id: bigint; account_type: 'INCOME' | 'EXPENSE'; system_key: string | null; parent_key: string | null }[]>`
    SELECT la.id, la.account_type::text AS account_type, la.system_key, p.system_key AS parent_key
      FROM ledger_account la
      LEFT JOIN ledger_account p ON p.tenant_id = la.tenant_id AND p.id = la.parent_id
     WHERE la.tenant_id = ${tenantId}
       AND la.account_type IN ('INCOME', 'EXPENSE')
  `;
  const accountIds = accounts
    .filter((a) => lineOfAccount({ accountType: a.account_type, systemKey: a.system_key, parentKey: a.parent_key }) === line)
    .map((a) => a.id);

  const [invoices, costs, vouchers, settlements] = await Promise.all([
    !accrual || !INVOICE_REVENUE_LINES.has(line) ? Promise.resolve<InvoiceEntryRow[]>([]) : db.$queryRaw<InvoiceEntryRow[]>`
      SELECT i.id, i.code, i.invoice_date, i.total_amount_base AS amount,
             s.shipment_type::text AS shipment_type, s.loading_type::text AS loading_type, s.code AS booking_code,
             cu.name AS party_name
        FROM debit_invoice i
        LEFT JOIN shipment s ON s.tenant_id = i.tenant_id AND s.id = i.shipment_id
        LEFT JOIN customer cu ON cu.tenant_id = i.tenant_id AND cu.id = i.customer_id
       WHERE i.tenant_id = ${tenantId}
         AND i.deleted_at IS NULL
         AND i.status = 'ISSUED'
         AND ${within(invoiceDate)}
    `,
    !accrual || !INVOICE_COST_LINES.has(line) ? Promise.resolve<CostEntryRow[]>([]) : db.$queryRaw<CostEntryRow[]>`
      SELECT i.id, i.code, i.invoice_date, c.total_amount_base AS amount, c.party_type::text AS party_type,
             c.supplier_invoice_no,
             s.shipment_type::text AS shipment_type, s.loading_type::text AS loading_type, s.code AS booking_code,
             COALESCE(ca.name, ag.name, ve.name) AS party_name
        FROM debit_invoice_cost c
        JOIN debit_invoice i ON i.tenant_id = c.tenant_id AND i.id = c.debit_invoice_id
        LEFT JOIN shipment s ON s.tenant_id = i.tenant_id AND s.id = i.shipment_id
        LEFT JOIN carrier ca ON ca.id = c.carrier_id
        LEFT JOIN agent ag   ON ag.tenant_id = c.tenant_id AND ag.id = c.agent_id
        LEFT JOIN vendor ve  ON ve.tenant_id = c.tenant_id AND ve.id = c.vendor_id
       WHERE c.tenant_id = ${tenantId}
         AND c.deleted_at IS NULL
         AND i.deleted_at IS NULL
         AND i.status = 'ISSUED'
         AND ${within(invoiceDate)}
       ORDER BY c.sort_order, c.id
    `,
    accountIds.length === 0 ? Promise.resolve<VoucherEntryRow[]>([]) : db.$queryRaw<VoucherEntryRow[]>`
      SELECT je.id, je.code, je.kind::text AS kind, je.entry_date, je.description,
             la.name AS account_name, ${PARTY_NAME} AS party_name,
             SUM(jl.credit - jl.debit) AS amount
        FROM journal_line jl
        JOIN journal_entry je  ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
        JOIN ledger_account la ON la.tenant_id = jl.tenant_id AND la.id = jl.ledger_account_id
        ${PARTY_JOINS}
       WHERE jl.tenant_id = ${tenantId}
         AND jl.deleted_at IS NULL
         AND je.deleted_at IS NULL
         AND je.status = 'POSTED'
         AND jl.ledger_account_id IN (${Prisma.join(accountIds)})
         AND ${within(entryDate)}
         ${accrual ? Prisma.sql`AND NOT ${SETTLEMENT_LINE}` : Prisma.empty}
       GROUP BY je.id, je.code, je.kind, je.entry_date, je.description, la.id, la.name, cu.name, ag.name, ca.name, ve.name
    `,
    !accrual || (line !== 'FX_GAIN' && line !== 'FX_LOSS')
      ? Promise.resolve<SettlementRow[]>([])
      : settlementVouchers(db, tenantId, within(entryDate)),
  ]);

  const entries: IncomeStatementEntryDto[] = [];
  const groups = new Map<string, { count: number; amount: Prisma.Decimal }>();
  const tally = (label: string, amount: Prisma.Decimal) => {
    const group = groups.get(label) ?? { count: 0, amount: new Prisma.Decimal(0) };
    groups.set(label, { count: group.count + 1, amount: group.amount.plus(amount) });
  };

  for (const row of invoices) {
    if (revenueLineOf(row.shipment_type, row.loading_type) !== line) continue;
    tally('Debit invoices', dec(row.amount));
    entries.push({
      source: 'DEBIT_INVOICE',
      date: day(row.invoice_date),
      documentId: row.id.toString(),
      documentCode: row.code,
      voucherKind: null,
      partyName: row.party_name,
      reference: row.booking_code,
      details: null,
      amount: money(dec(row.amount)),
    });
  }

  const withheld = { count: 0, amount: new Prisma.Decimal(0) };
  for (const row of costs) {
    if (costLineOf(row.party_type, row.shipment_type, row.loading_type) !== line) continue;
    if (!input.viewBuyPrice) {
      withheld.count += 1;
      withheld.amount = withheld.amount.plus(dec(row.amount));
      continue;
    }
    tally('Costs on debit invoices', dec(row.amount));
    entries.push({
      source: 'INVOICE_COST',
      date: day(row.invoice_date),
      documentId: row.id.toString(),
      documentCode: row.code,
      voucherKind: null,
      partyName: row.party_name,
      reference: row.booking_code,
      details: row.supplier_invoice_no,
      amount: money(dec(row.amount)),
    });
  }

  // credit − debit is what an income line earns; an expense line is its negative.
  const sign = isIncomeNatured(line) ? 1 : -1;
  for (const row of [...vouchers].sort((a, b) => a.account_name.localeCompare(b.account_name))) {
    const amount = dec(row.amount).times(sign);
    if (amount.isZero()) continue;
    tally(row.account_name, amount);
    entries.push({
      source: 'VOUCHER',
      date: day(row.entry_date),
      documentId: row.id.toString(),
      documentCode: row.code,
      voucherKind: row.kind,
      partyName: row.party_name,
      reference: row.account_name,
      details: row.description,
      amount: money(amount),
    });
  }

  for (const row of settlements) {
    const fx = exchangeOf(row);
    const amount = line === 'FX_GAIN' ? fx : fx.negated();
    if (!amount.greaterThan(0)) continue;
    tally('Exchange difference on settlements', amount);
    entries.push({
      source: 'EXCHANGE',
      date: day(row.entry_date),
      documentId: row.id.toString(),
      documentCode: row.code,
      voucherKind: row.kind,
      partyName: row.party_name,
      reference: null,
      details: row.settled === null ? null : `Against ${row.settled}`,
      amount: money(amount),
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.documentCode.localeCompare(b.documentCode));
  const total = [...groups.values()].reduce((acc, g) => acc.plus(g.amount), withheld.amount);

  return {
    line,
    label: LABEL_OF.get(line)!,
    basis,
    currencyCode: input.currencyCode,
    column: input.column,
    period,
    total: money(total),
    groups: [...groups].map(([label, g]) => ({ label, count: g.count, amount: money(g.amount) })),
    entries,
    withheld: withheld.count === 0 ? null : { count: withheld.count, amount: money(withheld.amount) },
  };
}
