import {
  BALANCE_SHEET_LINES,
  type BalanceSheetDto,
  type BalanceSheetGroup,
  type BalanceSheetLineKey,
  type IncomeStatementBasis,
  type StatementRowDto,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { type BaseCurrency, resolveRates } from './currency-rate';
import { toBase } from './debit-invoice';
import { statementLines, statementRows } from './income-statement';
import { openingMovements } from './receivable-payable';
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

/** Every line's figure on one day, before the subtotals. */
export async function positionOn(
  db: TenantDb,
  tenantId: bigint,
  asOf: string,
  input: { basis: IncomeStatementBasis; yearStartMonth: number; base: BaseCurrency | null },
): Promise<Figures> {
  const figures: Figures = new Map();
  const add = (key: BalanceSheetLineKey, amount: Prisma.Decimal) =>
    figures.set(key, (figures.get(key) ?? ZERO).plus(amount));

  // ------------------------------------------------------------ the books
  const accounts = await db.$queryRaw<
    { account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE'; system_key: string | null; parent_key: string | null; debit: unknown; credit: unknown }[]
  >`
    SELECT la.account_type::text AS account_type, la.system_key, p.system_key AS parent_key,
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
     GROUP BY la.account_type, la.system_key, p.system_key
  `;

  // What the income and expense lines add up to: the books' profit to date.
  let bookProfit = ZERO;
  for (const row of accounts) {
    const debit = dec(row.debit);
    const credit = dec(row.credit);
    if (row.account_type === 'INCOME' || row.account_type === 'EXPENSE') {
      bookProfit = bookProfit.plus(credit.minus(debit));
      continue;
    }
    const line = balanceLineOf({ accountType: row.account_type, systemKey: row.system_key, parentKey: row.parent_key });
    // An asset reads debit − credit; a liability or equity account credit − debit.
    add(line, row.account_type === 'ASSET' ? debit.minus(credit) : credit.minus(debit));
  }

  // ------------------------------------------------- what the books do not hold
  let earned = bookProfit;
  if (input.basis === 'ACCRUAL') {
    const [sums] = await db.$queryRaw<{ billed: unknown; received: unknown; costed: unknown; paid: unknown }[]>`
      SELECT
        (SELECT COALESCE(SUM(i.total_amount_base), 0) FROM debit_invoice i
          WHERE i.tenant_id = ${tenantId} AND i.deleted_at IS NULL AND i.status = 'ISSUED'
            AND i.invoice_date <= ${asOf}::date) AS billed,
        (SELECT COALESCE(SUM(r.amount_base), 0) FROM debit_invoice_receipt r
           JOIN debit_invoice i ON i.tenant_id = r.tenant_id AND i.id = r.debit_invoice_id
          WHERE r.tenant_id = ${tenantId} AND r.deleted_at IS NULL AND i.deleted_at IS NULL AND i.status = 'ISSUED'
            AND i.invoice_date <= ${asOf}::date AND r.payment_date <= ${asOf}::date) AS received,
        (SELECT COALESCE(SUM(c.total_amount_base), 0) FROM debit_invoice_cost c
           JOIN debit_invoice i ON i.tenant_id = c.tenant_id AND i.id = c.debit_invoice_id
          WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL AND i.deleted_at IS NULL AND i.status = 'ISSUED'
            AND i.invoice_date <= ${asOf}::date) AS costed,
        (SELECT COALESCE(SUM(sp.amount_base), 0) FROM supplier_payment sp
           JOIN debit_invoice_cost c ON c.tenant_id = sp.tenant_id AND c.id = sp.debit_invoice_cost_id
           JOIN debit_invoice i ON i.tenant_id = c.tenant_id AND i.id = c.debit_invoice_id
          WHERE sp.tenant_id = ${tenantId} AND sp.deleted_at IS NULL AND c.deleted_at IS NULL AND i.deleted_at IS NULL
            AND i.status = 'ISSUED' AND i.invoice_date <= ${asOf}::date AND sp.payment_date <= ${asOf}::date) AS paid
    `;
    const receivable = dec(sums?.billed).minus(dec(sums?.received));
    const payable = dec(sums?.costed).minus(dec(sums?.paid));

    // The CRM openings, and what vouchers settled against them by the day.
    const movements = await openingMovements(db);
    const rates =
      input.base === null
        ? new Map<string, { rate: Prisma.Decimal }>()
        : await resolveRates(db, tenantId, [...new Set(movements.map((m) => m.currencyId.toString()))].map(BigInt));
    let owedToUs = ZERO;
    let owedByUs = ZERO;
    let settledToUs = ZERO;
    let settledByUs = ZERO;
    for (const m of movements) {
      const rate =
        input.base !== null && m.currencyId === input.base.id
          ? new Prisma.Decimal(1)
          : rates.get(m.currencyId.toString())?.rate;
      // A currency with no rate on file cannot be stated in base; the list says so, and here it is left out.
      if (rate === undefined) continue;
      const base = toBase(m.amount, rate);
      if (m.settlement === null) {
        if (m.side === 'RECEIVABLE') owedToUs = owedToUs.plus(base);
        else owedByUs = owedByUs.plus(base);
      } else if (m.date.toISOString().slice(0, 10) <= asOf) {
        // A settlement movement is negative; what it settled is its negation.
        if (m.side === 'RECEIVABLE') settledToUs = settledToUs.minus(base);
        else settledByUs = settledByUs.minus(base);
      }
    }

    add('RECEIVABLE', receivable.plus(owedToUs).minus(settledToUs));
    add('PAYABLE', payable.plus(owedByUs).minus(settledByUs));
    add('OPENING_EQUITY', owedToUs.minus(owedByUs));
    // Revenue and cost as the invoices earned them, not as the cash arrived;
    // and an opening settled is a debt collected, not income.
    earned = bookProfit.plus(receivable).minus(payable).minus(settledToUs).plus(settledByUs);
  }

  // ---------------------------------------------- the year's profit, and before
  const from = yearStartOf(asOf, input.yearStartMonth);
  const year = { from, to: asOf };
  const ledger = await statementLines(db, tenantId, [year, year, year], input.basis);
  const net = statementRows(ledger).find((r) => r.key === 'NET_PROFIT_AFTER_TAX')?.amounts[0] ?? '0';
  const profitForYear = new Prisma.Decimal(net ?? '0');
  add('PROFIT', profitForYear);
  add('RETAINED', earned.minus(profitForYear));

  return figures;
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
