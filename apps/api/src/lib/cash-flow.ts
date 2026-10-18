import {
  CASH_FLOW_LINES,
  CASH_FLOW_SECTION_TITLE,
  CASH_FLOW_SECTIONS,
  type CashFlowDto,
  type CashFlowLineKey,
  type CashFlowSection,
  MONEY_LEDGER_KEYS,
  type StatementRowDto,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { type Period, periodsOf } from './income-statement';
import type { TenantDb } from './tenant-client';

/**
 * The Cash Flow Statement — the direct method, read straight from the books.
 *
 * Cash is every sub ledger of Cash and of Bank (MONEY_LEDGER_KEYS, the
 * accounts a voucher may pay from). For every POSTED voucher that moved one,
 * each of its other lines is where that money went or came from: a line's
 * credit − debit is the cash it brought in. A voucher balances, so those sum
 * to exactly what the cash accounts moved — and a transfer between two cash
 * accounts, having no other line, moves nothing.
 *
 * Each line is classified by its account (ACCOUNT_LINE), the way the Income
 * Statement maps the chart. Cash basis by nature: a cash flow statement has
 * no accrual view, so there is no switch.
 *
 * The three columns are the Income Statement's: the month, the financial year
 * to its end, and the same span a year earlier.
 */

const ZERO = new Prisma.Decimal(0);
const dec = (v: unknown): Prisma.Decimal => new Prisma.Decimal(v === null || v === undefined ? 0 : String(v));

// ---------------------------------------------------------------- mapping

const ACCOUNT_LINE: Readonly<Record<string, CashFlowLineKey>> = {
  'INCOME.SERVICE': 'OP_CUSTOMERS',
  'ASSET.RECEIVABLE': 'OP_CUSTOMERS',
  'LIABILITY.CUSTOMER_PREPAYMENT': 'OP_CUSTOMERS',
  'EXPENSE.DISCOUNT': 'OP_CUSTOMERS',

  'EXPENSE.COST_OF_SERVICE': 'OP_SUPPLIERS',
  'LIABILITY.PAYABLE': 'OP_SUPPLIERS',

  'EXPENSE.PAYROLL': 'OP_EMPLOYEES',
  'LIABILITY.PAYROLL': 'OP_EMPLOYEES',

  'EXPENSE.OPERATING': 'OP_EXPENSES',
  'EXPENSE.UNCATEGORIZED': 'OP_EXPENSES',
  'ASSET.INVENTORY': 'OP_EXPENSES',
  'ASSET.CURRENT': 'OP_EXPENSES',

  'EXPENSE.TAX': 'OP_TAX',
  'LIABILITY.SALES_TAX': 'OP_TAX',
  'ASSET.CURRENT.SALES_TAX_RECEIVABLE': 'OP_TAX',

  'INCOME.FX_GAIN': 'OP_OTHER',
  'EXPENSE.FX_LOSS': 'OP_OTHER',
  'INCOME.OTHER': 'OP_OTHER',
  'INCOME.UNCATEGORIZED': 'OP_OTHER',
  'EXPENSE.NON_OPERATING': 'OP_OTHER',
  'LIABILITY.OTHER_SHORT_TERM': 'OP_OTHER',

  'ASSET.OTHER_LONG_TERM': 'INV_ASSETS',
  'EXPENSE.NON_OPERATING.ASSET_DISPOSAL': 'INV_ASSETS',
  'ASSET.SHORT_TERM_LOAN': 'INV_LOANS',
  'INCOME.OTHER.FIXED_DEPOSIT': 'INV_INTEREST',

  'EQUITY.OWNER': 'FIN_OWNER',
  'EQUITY.RETAINED': 'FIN_OWNER',
  'LIABILITY.LOAN': 'FIN_LOANS',
  'LIABILITY.OTHER_LONG_TERM': 'FIN_LOANS',
  'EXPENSE.OPERATING.INTEREST': 'FIN_INTEREST',
};

const DEFAULT_BY_TYPE: Record<string, CashFlowLineKey> = {
  INCOME: 'OP_OTHER',
  EXPENSE: 'OP_EXPENSES',
  ASSET: 'OP_OTHER',
  LIABILITY: 'OP_OTHER',
  EQUITY: 'FIN_OWNER',
};

/** Its own key, else its ledger's, else its head's default. */
export function cashFlowLineOf(account: { accountType: string; systemKey: string | null; parentKey: string | null }): CashFlowLineKey {
  const own = account.systemKey === null ? undefined : ACCOUNT_LINE[account.systemKey];
  if (own !== undefined) return own;
  const inherited = account.parentKey === null ? undefined : ACCOUNT_LINE[account.parentKey];
  return inherited ?? DEFAULT_BY_TYPE[account.accountType] ?? 'OP_OTHER';
}

// ---------------------------------------------------------------- figures

const MONEY = Prisma.join(MONEY_LEDGER_KEYS.map((k) => Prisma.sql`${k}`));

/**
 * A line on a Cash or Bank sub ledger (or on the ledger itself). COALESCEd: a
 * workspace's own account has no system key and a ledger has no parent, and
 * `NULL IN (…)` is NULL — which NOT would leave NULL, and drop the line.
 */
const isCash = (account: Prisma.Sql, parent: Prisma.Sql) =>
  Prisma.sql`(COALESCE(${account}.system_key, '') IN (${MONEY}) OR COALESCE(${parent}.system_key, '') IN (${MONEY}))`;

/** Cash and bank together, at the end of a day (null: before anything). */
async function cashOn(db: TenantDb, tenantId: bigint, endOfDay: string): Promise<Prisma.Decimal> {
  const [row] = await db.$queryRaw<{ balance: unknown }[]>`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
      FROM journal_line jl
      JOIN journal_entry je  ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
      JOIN ledger_account la ON la.tenant_id = jl.tenant_id AND la.id = jl.ledger_account_id
      LEFT JOIN ledger_account p ON p.tenant_id = la.tenant_id AND p.id = la.parent_id
     WHERE jl.tenant_id = ${tenantId}
       AND jl.deleted_at IS NULL
       AND je.deleted_at IS NULL
       AND je.status = 'POSTED'
       AND je.entry_date <= ${endOfDay}::date
       AND ${isCash(Prisma.sql`la`, Prisma.sql`p`)}
  `;
  return dec(row?.balance);
}

const dayBefore = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export async function cashFlowLines(
  db: TenantDb,
  tenantId: bigint,
  periods: [Period, Period, Period],
): Promise<Map<CashFlowLineKey, Prisma.Decimal[]>> {
  const [c, y, p] = periods;
  const sum = (period: Period, n: number) =>
    Prisma.sql`COALESCE(SUM(jl.credit - jl.debit) FILTER (WHERE je.entry_date BETWEEN ${period.from}::date AND ${period.to}::date), 0) AS ${Prisma.raw(`c${n}`)}`;

  const rows = await db.$queryRaw<
    { account_type: string; system_key: string | null; parent_key: string | null; c0: unknown; c1: unknown; c2: unknown }[]
  >`
    SELECT la.account_type::text AS account_type, la.system_key, p.system_key AS parent_key,
           ${sum(c, 0)}, ${sum(y, 1)}, ${sum(p, 2)}
      FROM journal_line jl
      JOIN journal_entry je  ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
      JOIN ledger_account la ON la.tenant_id = jl.tenant_id AND la.id = jl.ledger_account_id
      LEFT JOIN ledger_account p ON p.tenant_id = la.tenant_id AND p.id = la.parent_id
     WHERE jl.tenant_id = ${tenantId}
       AND jl.deleted_at IS NULL
       AND je.deleted_at IS NULL
       AND je.status = 'POSTED'
       AND (je.entry_date BETWEEN ${y.from}::date AND ${y.to}::date
            OR je.entry_date BETWEEN ${p.from}::date AND ${p.to}::date)
       AND NOT ${isCash(Prisma.sql`la`, Prisma.sql`p`)}
       AND EXISTS (
             SELECT 1
               FROM journal_line cl
               JOIN ledger_account ca ON ca.tenant_id = cl.tenant_id AND ca.id = cl.ledger_account_id
               LEFT JOIN ledger_account cp ON cp.tenant_id = ca.tenant_id AND cp.id = ca.parent_id
              WHERE cl.tenant_id = je.tenant_id
                AND cl.journal_entry_id = je.id
                AND cl.deleted_at IS NULL
                AND ${isCash(Prisma.sql`ca`, Prisma.sql`cp`)}
           )
     GROUP BY la.account_type, la.system_key, p.system_key
  `;

  const lines = new Map<CashFlowLineKey, Prisma.Decimal[]>();
  for (const row of rows) {
    const key = cashFlowLineOf({ accountType: row.account_type, systemKey: row.system_key, parentKey: row.parent_key });
    const acc = lines.get(key) ?? [ZERO, ZERO, ZERO];
    lines.set(key, [acc[0]!.plus(dec(row.c0)), acc[1]!.plus(dec(row.c1)), acc[2]!.plus(dec(row.c2))]);
  }
  return lines;
}

// ------------------------------------------------------------------- rows

export async function cashFlowStatement(
  db: TenantDb,
  tenantId: bigint,
  input: { month: string; yearStartMonth: number; currencyCode: string },
): Promise<CashFlowDto> {
  const periods = periodsOf(input.month, input.yearStartMonth);
  const [lines, opening, closing] = await Promise.all([
    cashFlowLines(db, tenantId, periods),
    Promise.all(periods.map((p) => cashOn(db, tenantId, dayBefore(p.from)))),
    Promise.all(periods.map((p) => cashOn(db, tenantId, p.to))),
  ]);

  const out = (v: Prisma.Decimal[]) => v.map((d) => d.toFixed(2));
  const empty = () => [null, null, null];
  const rows: StatementRowDto[] = [];
  let net = [ZERO, ZERO, ZERO];

  const sectionKeys: Record<CashFlowSection, string> = {
    OPERATING: 'NET_OPERATING',
    INVESTING: 'NET_INVESTING',
    FINANCING: 'NET_FINANCING',
  };
  const sectionTotal: Record<CashFlowSection, string> = {
    OPERATING: 'Net Cash from Operating Activities',
    INVESTING: 'Net Cash from Investing Activities',
    FINANCING: 'Net Cash from Financing Activities',
  };

  for (const section of CASH_FLOW_SECTIONS) {
    rows.push({ kind: 'SECTION', key: section, label: CASH_FLOW_SECTION_TITLE[section], amounts: empty() });
    let total = [ZERO, ZERO, ZERO];
    for (const line of CASH_FLOW_LINES.filter((l) => l.section === section)) {
      const amounts = lines.get(line.key) ?? [ZERO, ZERO, ZERO];
      total = total.map((t, i) => t.plus(amounts[i]!));
      rows.push({ kind: 'LINE', key: line.key, label: line.label, amounts: out(amounts) });
    }
    rows.push({ kind: 'TOTAL', key: sectionKeys[section], label: sectionTotal[section], amounts: out(total) });
    net = net.map((n, i) => n.plus(total[i]!));
  }

  rows.push({ kind: 'TOTAL', key: 'NET_CHANGE', label: 'Net Increase / (Decrease) in Cash', amounts: out(net) });
  rows.push({ kind: 'LINE', key: 'OPENING_CASH', label: 'Cash and Bank at the Beginning of the Period', amounts: out(opening) });
  rows.push({ kind: 'TOTAL', key: 'CLOSING_CASH', label: 'Cash and Bank at the End of the Period', amounts: out(closing) });

  // Opening + net change = closing, by construction; a gap means a voucher the classification missed.
  const gap = closing.map((c, i) => c.minus(opening[i]!).minus(net[i]!));
  if (gap.some((g) => !g.isZero())) {
    rows.push({ kind: 'CHECK', key: 'DIFFERENCE', label: 'Difference', amounts: out(gap) });
  }

  return {
    currencyCode: input.currencyCode,
    yearStartMonth: input.yearStartMonth,
    periods: { currentMonth: periods[0], ytd: periods[1], previousYtd: periods[2] },
    rows,
  };
}
