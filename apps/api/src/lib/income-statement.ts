import {
  INCOME_STATEMENT_LINES,
  INCOME_STATEMENT_SECTION_TITLE,
  type IncomeStatementBasis,
  type IncomeStatementDto,
  type IncomeStatementLineKey,
  type IncomeStatementRowDto,
  type IncomeStatementSection,
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

// ----------------------------------------------------------------- totals

type Amounts = [Prisma.Decimal, Prisma.Decimal, Prisma.Decimal];
const zero = (): Amounts => [new Prisma.Decimal(0), new Prisma.Decimal(0), new Prisma.Decimal(0)];
const dec = (v: Prisma.Decimal | string | number | null): Prisma.Decimal => new Prisma.Decimal(v ?? 0);

/** The statement's figures by line, one amount per column. */
export class Ledger {
  readonly lines = new Map<IncomeStatementLineKey, Amounts>();

  add(key: IncomeStatementLineKey, column: number, amount: Prisma.Decimal): void {
    const row = this.lines.get(key) ?? zero();
    row[column] = row[column]!.plus(amount);
    this.lines.set(key, row);
  }

  addColumns(key: IncomeStatementLineKey, amounts: (Prisma.Decimal | string | number | null)[]): void {
    amounts.forEach((a, i) => this.add(key, i, dec(a)));
  }

  of(key: IncomeStatementLineKey): Amounts {
    return this.lines.get(key) ?? zero();
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

/** Three conditional sums, one per column, over a date expression. */
function columnSums(value: Prisma.Sql, date: Prisma.Sql, periods: [Period, Period, Period]): Prisma.Sql {
  const [c, y, p] = periods;
  return Prisma.sql`
    COALESCE(SUM(${value}) FILTER (WHERE ${date} BETWEEN ${c.from}::date AND ${c.to}::date), 0) AS c0,
    COALESCE(SUM(${value}) FILTER (WHERE ${date} BETWEEN ${y.from}::date AND ${y.to}::date), 0) AS c1,
    COALESCE(SUM(${value}) FILTER (WHERE ${date} BETWEEN ${p.from}::date AND ${p.to}::date), 0) AS c2`;
}

function inAnyPeriod(date: Prisma.Sql, periods: [Period, Period, Period]): Prisma.Sql {
  const [, y, p] = periods;
  return Prisma.sql`(${date} BETWEEN ${y.from}::date AND ${y.to}::date OR ${date} BETWEEN ${p.from}::date AND ${p.to}::date)`;
}

type ColumnRow = { c0: Prisma.Decimal; c1: Prisma.Decimal; c2: Prisma.Decimal };
type RevenueRow = ColumnRow & { shipment_type: string | null; loading_type: string | null };
type CostRow = RevenueRow & { party_type: string };
type SettlementRow = { entry_date: Date; pl: Prisma.Decimal; received: Prisma.Decimal; paid: Prisma.Decimal };

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
  periods: [Period, Period, Period],
  basis: IncomeStatementBasis = 'ACCRUAL',
): Promise<Ledger> {
  const ledger = new Ledger();
  const accrual = basis === 'ACCRUAL';
  const invoiceDate = Prisma.sql`i.invoice_date`;
  const entryDate = Prisma.sql`je.entry_date`;

  const settles = Prisma.sql`(
       EXISTS (SELECT 1 FROM debit_invoice_receipt r
                WHERE r.tenant_id = je.tenant_id AND r.journal_entry_id = je.id AND r.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM supplier_payment sp
                WHERE sp.tenant_id = je.tenant_id AND sp.journal_entry_id = je.id AND sp.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM opening_settlement os
                WHERE os.tenant_id = je.tenant_id AND os.journal_entry_id = je.id AND os.deleted_at IS NULL)
  )`;

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
         ${accrual ? Prisma.sql`AND NOT ${settles}` : Prisma.empty}
       GROUP BY la.account_type, la.system_key, p.system_key
    `,
    !accrual ? Promise.resolve<SettlementRow[]>([]) : db.$queryRaw<SettlementRow[]>`
      SELECT je.entry_date,
             (SELECT COALESCE(SUM(jl.credit - jl.debit), 0)
                FROM journal_line jl
                JOIN ledger_account la ON la.tenant_id = jl.tenant_id AND la.id = jl.ledger_account_id
               WHERE jl.tenant_id = je.tenant_id AND jl.journal_entry_id = je.id AND jl.deleted_at IS NULL
                 AND la.account_type IN ('INCOME', 'EXPENSE')) AS pl,
             (SELECT COALESCE(SUM(r.amount_base), 0) FROM debit_invoice_receipt r
               WHERE r.tenant_id = je.tenant_id AND r.journal_entry_id = je.id AND r.deleted_at IS NULL) AS received,
             (SELECT COALESCE(SUM(sp.amount_base), 0) FROM supplier_payment sp
               WHERE sp.tenant_id = je.tenant_id AND sp.journal_entry_id = je.id AND sp.deleted_at IS NULL) AS paid
        FROM journal_entry je
       WHERE je.tenant_id = ${tenantId}
         AND je.deleted_at IS NULL
         AND je.status = 'POSTED'
         AND ${inAnyPeriod(entryDate, periods)}
         AND (
               EXISTS (SELECT 1 FROM debit_invoice_receipt r
                        WHERE r.tenant_id = je.tenant_id AND r.journal_entry_id = je.id AND r.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM supplier_payment sp
                        WHERE sp.tenant_id = je.tenant_id AND sp.journal_entry_id = je.id AND sp.deleted_at IS NULL)
         )
    `,
  ]);

  for (const row of revenue) {
    const svc = service(row.shipment_type, row.loading_type);
    ledger.addColumns(svc === null ? 'REV_OTHER' : REVENUE_BY_SERVICE[svc], [row.c0, row.c1, row.c2]);
  }

  for (const row of costs) {
    const svc = service(row.shipment_type, row.loading_type);
    const key: IncomeStatementLineKey =
      row.party_type === 'AGENT' ? 'COST_AGENT' : svc === null ? 'COST_OTHER_JOB' : COST_BY_SERVICE[svc];
    ledger.addColumns(key, [row.c0, row.c1, row.c2]);
  }

  for (const row of posted) {
    const key = lineOfAccount({ accountType: row.account_type, systemKey: row.system_key, parentKey: row.parent_key });
    // credit − debit is what an income line earns; an expense line is its negative.
    const sign = isIncomeNatured(key) ? 1 : -1;
    ledger.addColumns(key, [row.c0, row.c1, row.c2].map((v) => dec(v).times(sign)));
  }

  /*
   * The exchange difference a settlement realised. Income vouchers: cash in
   * (pl) less the invoice base it settled. Expense vouchers: pl is the cash
   * out, negative; adding the cost base it settled leaves what was saved.
   */
  const day = (d: Date) => d.toISOString().slice(0, 10);
  for (const row of settlements) {
    const fx = dec(row.pl).plus(dec(row.paid)).minus(dec(row.received));
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

function sum(ledger: Ledger, keys: IncomeStatementLineKey[]): Amounts {
  return keys.reduce<Amounts>((acc, key) => {
    const row = ledger.of(key);
    return [acc[0].plus(row[0]), acc[1].plus(row[1]), acc[2].plus(row[2])];
  }, zero());
}

const minus = (a: Amounts, b: Amounts): Amounts => [a[0].minus(b[0]), a[1].minus(b[1]), a[2].minus(b[2])];
const plus = (a: Amounts, b: Amounts): Amounts => [a[0].plus(b[0]), a[1].plus(b[1]), a[2].plus(b[2])];

function percent(part: Amounts, whole: Amounts): IncomeStatementRowDto['amounts'] {
  return part.map((p, i) => (whole[i]!.isZero() ? null : p.div(whole[i]!).times(100).toFixed(1))) as IncomeStatementRowDto['amounts'];
}

const out = (a: Amounts): IncomeStatementRowDto['amounts'] => [money(a[0]), money(a[1]), money(a[2])];

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
    amounts: [null, null, null],
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
    { kind: 'LINE', key: 'DISCOUNTS', label: 'Less: Discounts / Credit Notes', amounts: out(discounts), deduction: true },
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
    { kind: 'LINE', key: 'INCOME_TAX', label: 'Income Tax Expense', amounts: out(tax) },
    { kind: 'TOTAL', key: 'NET_PROFIT_AFTER_TAX', label: 'Net Profit After Tax', amounts: out(afterTax) },
    { kind: 'PERCENT', key: 'NET_PROFIT_MARGIN', label: 'Net Profit Margin %', amounts: percent(afterTax, netRevenue) },
  ];
}

export async function incomeStatement(
  db: TenantDb,
  tenantId: bigint,
  input: { month: string; yearStartMonth: number; basis: IncomeStatementBasis; currencyCode: string },
): Promise<IncomeStatementDto> {
  const periods = periodsOf(input.month, input.yearStartMonth);
  const ledger = await statementLines(db, tenantId, periods, input.basis);
  return {
    currencyCode: input.currencyCode,
    basis: input.basis,
    periods: { currentMonth: periods[0], ytd: periods[1], previousYtd: periods[2] },
    yearStartMonth: input.yearStartMonth,
    rows: statementRows(ledger),
  };
}
