import {
  type AccountOptionDto,
  CODE_PREFIX,
  DEBIT_NORMAL,
  formatCode,
  INCOME_FROM_PARTY_TYPES,
  isoCurrency,
  JOURNAL_ENTRY_FEATURE,
  JOURNAL_ENTRY_PREFIX,
  type JournalEntryData,
  type JournalEntryDto,
  type JournalEntryKind,
  type LedgerAccountType,
  type LedgerPartyType,
  MONEY_LEDGER_KEYS,
  PAY_TO_PARTY_TYPES,
  type ServiceKey,
  type SupplierPartyType,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import type { BaseCurrency } from './currency-rate';
import { day, dec, money, paymentOf, toBase } from './debit-invoice';
import { HttpError } from './http-error';
import { formatDocumentNo } from './inquiry-no';
import type { TenantDb } from './tenant-client';

/**
 * The books — docs/MODULE_ACCOUNTS.md §14.
 *
 * Everything the voucher, chart and bank routes share: the predefined chart and
 * how a workspace gets it, account balances, how each of the four screens turns
 * into debits and credits, and what a voucher settles on a party's ledger. The
 * routes only decide who may call what.
 */

const ZERO = new Prisma.Decimal(0);

// ------------------------------------------------------ the predefined chart

interface ChartSeed {
  key: string;
  type: LedgerAccountType;
  name: string;
  subs?: readonly (readonly [key: string, name: string])[];
}

/**
 * Sheet `Chart of accounts`, rows 9–58, with B64 "Expense Ledger - Predefined".
 *
 * Every ledger (a row with "+ ADD new" beside it) and every sub ledger under
 * one, in the sheet's order, head by head. Spelling is corrected where the
 * sheet slipped ("Customs Clearence", "Gain on Foreight Exchange", "Vehical");
 * the full list of what changed is in §14.1. A workspace renames any of these
 * freely — the key is what the product holds on to.
 *
 * Not seeded: the sheet's three sample bank sub ledgers (Z11–Z13, "Bank Asia
 * Ltd-878"). Those are made by Account setup, one per real account (§14.3).
 */
export const DEFAULT_CHART: readonly ChartSeed[] = [
  // -- Expense (column B)
  {
    key: 'EXPENSE.COST_OF_SERVICE',
    type: 'EXPENSE',
    name: 'Cost of Service',
    subs: [
      ['EXPENSE.COST_OF_SERVICE.SEA_FCL', 'Sea Freight-FCL'],
      ['EXPENSE.COST_OF_SERVICE.SEA_LCL', 'Sea Freight-LCL'],
      ['EXPENSE.COST_OF_SERVICE.SEA_DOOR', 'Sea Freight-Door-Door'],
      ['EXPENSE.COST_OF_SERVICE.AIR', 'Air-Freight'],
      ['EXPENSE.COST_OF_SERVICE.PROJECT', 'Project Logistics'],
      ['EXPENSE.COST_OF_SERVICE.CUSTOMS', 'Customs Clearance'],
      ['EXPENSE.COST_OF_SERVICE.WAREHOUSING', 'Warehousing'],
    ],
  },
  { key: 'EXPENSE.DISCOUNT', type: 'EXPENSE', name: 'Discount' },
  { key: 'EXPENSE.FX_LOSS', type: 'EXPENSE', name: 'Loss on Foreign Exchange' },
  {
    key: 'EXPENSE.OPERATING',
    type: 'EXPENSE',
    name: 'Operating Expense',
    subs: [
      ['EXPENSE.OPERATING.AUDITOR_FEE', 'Auditor fee'],
      ['EXPENSE.OPERATING.ADVERTISEMENT', 'Advertisement & Promotion'],
      ['EXPENSE.OPERATING.BANK_CHARGE', 'Bank Service Charge'],
      ['EXPENSE.OPERATING.COMPUTER_HARDWARE', 'Computer Hardware'],
      ['EXPENSE.OPERATING.COMPUTER_SOFTWARE', 'Computer Software'],
      ['EXPENSE.OPERATING.HOSTING', 'Web Site Hosting'],
      ['EXPENSE.OPERATING.INTERNET', 'Internet Bill'],
      ['EXPENSE.OPERATING.MOBILE', 'Mobile Bill'],
      ['EXPENSE.OPERATING.TA_DA', 'TA-DA'],
      ['EXPENSE.OPERATING.SALES_INCENTIVE', 'Sales Incentive'],
      ['EXPENSE.OPERATING.MEAL', 'Meal & Entertainment'],
      ['EXPENSE.OPERATING.INTEREST', 'Interest Expense'],
      ['EXPENSE.OPERATING.STATIONERY', 'Office Stationery'],
      ['EXPENSE.OPERATING.PROFESSIONAL_FEE', 'Professional fee'],
      ['EXPENSE.OPERATING.RENT', 'Office Rent'],
      ['EXPENSE.OPERATING.REPAIR', 'Repair and Maintenance'],
      ['EXPENSE.OPERATING.TELEPHONE', 'Telephone - Land line'],
      ['EXPENSE.OPERATING.UTILITIES', 'Utilities'],
      ['EXPENSE.OPERATING.VEHICLE_FUEL', 'Vehicle - Fuel'],
      ['EXPENSE.OPERATING.VEHICLE_REPAIR', 'Vehicle - Repair & Maintenance'],
      ['EXPENSE.OPERATING.ADJUSTMENT', 'Adjustment'],
      ['EXPENSE.OPERATING.CASH_SHORT', 'Cash short or less'],
      ['EXPENSE.OPERATING.MEDIA_BUYING', 'Media Buying'],
      // DESIGN-UPDATE-2026-10-04 §9 (Q25): the Income statement sheet's
      // operating lines that had no account to post to.
      ['EXPENSE.OPERATING.INSURANCE', 'Insurance'],
      ['EXPENSE.OPERATING.DEPRECIATION', 'Depreciation'],
      ['EXPENSE.OPERATING.BAD_DEBT', 'Bad Debt / Provision for Doubtful Debt'],
      ['EXPENSE.OPERATING.LEGAL', 'Legal & Compliance'],
      ['EXPENSE.OPERATING.BUSINESS_DEVELOPMENT', 'Business Development'],
    ],
  },
  {
    key: 'EXPENSE.PAYROLL',
    type: 'EXPENSE',
    name: 'Payroll Expense',
    subs: [
      ['EXPENSE.PAYROLL.BENEFITS', 'Payroll - Employee Benefits'],
      ['EXPENSE.PAYROLL.SALARY', 'Payroll - Employee salary'],
    ],
  },
  {
    key: 'EXPENSE.UNCATEGORIZED',
    type: 'EXPENSE',
    name: 'Uncategorized Expense',
    subs: [['EXPENSE.UNCATEGORIZED.GENERAL', 'Uncategorized Expense']],
  },
  // DESIGN-UPDATE-2026-10-04 §9 (Q25): the sheet's sections E and the line
  // below profit before tax, which the chart had nowhere to put.
  {
    key: 'EXPENSE.NON_OPERATING',
    type: 'EXPENSE',
    name: 'Non-Operating Expense',
    subs: [
      ['EXPENSE.NON_OPERATING.ASSET_DISPOSAL', 'Loss on Asset Disposal'],
      ['EXPENSE.NON_OPERATING.OTHER', 'Other Non-Operating Expense'],
    ],
  },
  {
    key: 'EXPENSE.TAX',
    type: 'EXPENSE',
    name: 'Income Tax',
    subs: [['EXPENSE.TAX.INCOME_TAX', 'Income Tax Expense']],
  },

  // -- Income (column H)
  {
    key: 'INCOME.SERVICE',
    type: 'INCOME',
    name: 'Income on Service',
    subs: [
      ['INCOME.SERVICE.SEA_FCL', 'Sea Freight-FCL'],
      ['INCOME.SERVICE.SEA_LCL', 'Sea Freight-LCL'],
      ['INCOME.SERVICE.SEA_DOOR', 'Sea Freight-Door-Door'],
      ['INCOME.SERVICE.AIR', 'Air-Freight'],
      ['INCOME.SERVICE.PROJECT', 'Project Logistics'],
      ['INCOME.SERVICE.CUSTOMS', 'Customs Clearance'],
      ['INCOME.SERVICE.WAREHOUSING', 'Warehousing'],
      ['INCOME.SERVICE.COMMISSION', 'Commission - Profit sharing from Agent'],
    ],
  },
  { key: 'INCOME.FX_GAIN', type: 'INCOME', name: 'Gain on Foreign Exchange' },
  {
    key: 'INCOME.OTHER',
    type: 'INCOME',
    name: 'Other Income',
    subs: [['INCOME.OTHER.FIXED_DEPOSIT', 'Fixed Deposit']],
  },
  { key: 'INCOME.UNCATEGORIZED', type: 'INCOME', name: 'Uncategorized Income' },

  // -- Owners Equity (column N)
  {
    key: 'EQUITY.OWNER',
    type: 'EQUITY',
    name: 'Business Owner Contribution and Drawing',
    subs: [
      ['EQUITY.OWNER.INVESTMENT', 'Owner Investment'],
      ['EQUITY.OWNER.OPENING_BALANCE', 'Opening Balance Equity'],
    ],
  },
  {
    key: 'EQUITY.RETAINED',
    type: 'EQUITY',
    name: 'Retained Earnings',
    subs: [['EQUITY.RETAINED.OWNERS_EQUITY', "Owner's Equity"]],
  },

  // -- Liabilities (column T)
  {
    key: 'LIABILITY.CUSTOMER_PREPAYMENT',
    type: 'LIABILITY',
    name: 'Customer Prepayments and Customer Credits',
    subs: [['LIABILITY.CUSTOMER_PREPAYMENT.ADVANCE', 'Advanced Payments from customer']],
  },
  {
    key: 'LIABILITY.PAYABLE',
    type: 'LIABILITY',
    name: 'Expected Payments to Vendors - Agent - Carrier',
    subs: [
      ['LIABILITY.PAYABLE.VENDOR', 'Accounts Payable - Vendor'],
      ['LIABILITY.PAYABLE.CARRIER', 'Accounts Payable - Carrier'],
      ['LIABILITY.PAYABLE.AGENT', 'Accounts Payable - Agent'],
    ],
  },
  {
    key: 'LIABILITY.PAYROLL',
    type: 'LIABILITY',
    name: 'Due For Payroll',
    subs: [['LIABILITY.PAYROLL.LIABILITIES', 'Payroll Liabilities']],
  },
  { key: 'LIABILITY.LOAN', type: 'LIABILITY', name: 'Loan and Line of Credit' },
  { key: 'LIABILITY.OTHER_LONG_TERM', type: 'LIABILITY', name: 'Other Long-Term Liability' },
  { key: 'LIABILITY.OTHER_SHORT_TERM', type: 'LIABILITY', name: 'Other Short-Term Liability' },
  {
    key: 'LIABILITY.SALES_TAX',
    type: 'LIABILITY',
    name: 'Sales Taxes',
    subs: [['LIABILITY.SALES_TAX.PAYABLE', 'Sales Tax Payable']],
  },

  // -- Asset (column Z)
  { key: 'ASSET.BANK', type: 'ASSET', name: 'Bank' },
  {
    key: 'ASSET.CASH',
    type: 'ASSET',
    name: 'Cash',
    subs: [['ASSET.CASH.ON_HAND', 'Cash on Hand']],
  },
  {
    key: 'ASSET.RECEIVABLE',
    type: 'ASSET',
    name: 'Expected Payments from Customers',
    subs: [
      ['ASSET.RECEIVABLE.SEA_FCL', 'Sea Freight-FCL'],
      ['ASSET.RECEIVABLE.SEA_LCL', 'Sea Freight-LCL'],
      ['ASSET.RECEIVABLE.SEA_DOOR', 'Sea Freight-Door-Door'],
      ['ASSET.RECEIVABLE.AIR', 'Air-Freight'],
      ['ASSET.RECEIVABLE.PROJECT', 'Project Logistics'],
      ['ASSET.RECEIVABLE.CUSTOMS', 'Customs Clearance'],
      ['ASSET.RECEIVABLE.WAREHOUSING', 'Warehousing'],
      ['ASSET.RECEIVABLE.COMMISSION', 'Commission - Profit sharing from Agent'],
    ],
  },
  {
    key: 'ASSET.INVENTORY',
    type: 'ASSET',
    name: 'Inventory',
    subs: [['ASSET.INVENTORY.REVENUE_STAMP', 'Revenue Stamp']],
  },
  {
    key: 'ASSET.CURRENT',
    type: 'ASSET',
    name: 'Current Asset',
    subs: [['ASSET.CURRENT.SALES_TAX_RECEIVABLE', 'Sales Tax Receivable']],
  },
  {
    key: 'ASSET.OTHER_LONG_TERM',
    type: 'ASSET',
    name: 'Other Long-Term Asset',
    subs: [
      ['ASSET.OTHER_LONG_TERM.LAND', 'Land Purchase'],
      ['ASSET.OTHER_LONG_TERM.BUILDING', 'Building Purchase'],
    ],
  },
  { key: 'ASSET.SHORT_TERM_LOAN', type: 'ASSET', name: 'Short term loan to other' },
];

const SEEDED_KEY_COUNT = DEFAULT_CHART.reduce((n, l) => n + 1 + (l.subs?.length ?? 0), 0);

/** Ledgers the voucher screens stand on: they can be renamed, never retired. */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set(MONEY_LEDGER_KEYS);

/**
 * Gives the workspace its chart, the first time anything asks (§14.1).
 *
 * Lazy rather than a data migration or a step of tenant creation, so a
 * workspace made yesterday, one made by the test suite and one made next year
 * all arrive at the same chart without anyone remembering to run anything —
 * §7A rule 6's zero-touch onboarding.
 *
 * Idempotent and race-safe: every predefined row carries a system key unique
 * per workspace, and the inserts skip what exists. Two first requests at once
 * both try; one set of rows lands. A predefined account added to DEFAULT_CHART
 * later reaches every workspace the same way.
 */
export async function ensureChart(db: TenantDb, tenantId: bigint, userId: bigint | null): Promise<void> {
  const seeded = await db.ledgerAccount.count({ where: { systemKey: { not: null } } });
  if (seeded >= SEEDED_KEY_COUNT) return;

  const existing = await db.ledgerAccount.findMany({
    where: { systemKey: { not: null } },
    select: { systemKey: true },
  });
  const have = new Set(existing.map((r) => r.systemKey));

  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX(
             CASE WHEN code ~ ${`^${CODE_PREFIX.ledgerAccount}-[0-9]+$`}
                  THEN (regexp_replace(code, '^.*-', ''))::int
             END
           ) AS max_seq
      FROM ledger_account
     WHERE tenant_id = ${tenantId}
  `;
  let sequence = rows[0]?.max_seq ?? 0;
  const nextCode = (): string => formatCode(CODE_PREFIX.ledgerAccount, (sequence += 1));
  const audit = { createdBy: userId, updatedBy: userId };

  const ledgers = DEFAULT_CHART.filter((l) => !have.has(l.key));
  if (ledgers.length > 0) {
    await db.ledgerAccount.createMany({
      data: ledgers.map((l) => ({
        tenantId,
        code: nextCode(),
        accountType: l.type,
        name: l.name,
        systemKey: l.key,
        ...audit,
      })),
      skipDuplicates: true,
    });
  }

  const parents = await db.ledgerAccount.findMany({
    where: { systemKey: { in: DEFAULT_CHART.map((l) => l.key) }, parentId: null },
    select: { id: true, systemKey: true },
  });
  const parentId = new Map(parents.map((p) => [p.systemKey, p.id]));

  const subs = DEFAULT_CHART.flatMap((l) =>
    (l.subs ?? [])
      .filter(([key]) => !have.has(key) && parentId.has(l.key))
      .map(([key, name]) => ({ key, name, type: l.type, parentId: parentId.get(l.key)! })),
  );
  if (subs.length > 0) {
    await db.ledgerAccount.createMany({
      data: subs.map((s) => ({
        tenantId,
        code: nextCode(),
        accountType: s.type,
        parentId: s.parentId,
        name: s.name,
        systemKey: s.key,
        ...audit,
      })),
      skipDuplicates: true,
    });
  }
}

// --------------------------------------------------------------- accounts

export const ACCOUNT_SELECT = {
  id: true,
  code: true,
  accountType: true,
  parentId: true,
  name: true,
  systemKey: true,
  isActive: true,
  parent: { select: { name: true, isActive: true, systemKey: true } },
  bankAccount: { select: { id: true, deletedAt: true } },
  _count: { select: { children: { where: { deletedAt: null } } } },
} satisfies Prisma.LedgerAccountSelect;

export type AccountRow = Prisma.LedgerAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

export async function loadAccounts(db: TenantDb): Promise<AccountRow[]> {
  return db.ledgerAccount.findMany({
    where: { deletedAt: null },
    select: ACCOUNT_SELECT,
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  });
}

/** A voucher may post here: a sub ledger, or a ledger with none under it. */
export function isPostable(a: AccountRow): boolean {
  return a.parentId !== null || a._count.children === 0;
}

/** Usable on a new voucher: switched on, and so is its ledger. */
export function isUsable(a: AccountRow): boolean {
  return a.isActive && (a.parent === null || a.parent.isActive) && isPostable(a);
}

/** Sheet F17: "Asset like Bank, Cash" — a sub ledger of Bank or of Cash. */
export function isMoney(a: AccountRow): boolean {
  return a.parent !== null && (MONEY_LEDGER_KEYS as readonly (string | null)[]).includes(a.parent.systemKey);
}

/** "Cost of Service › Sea Freight-FCL"; a ledger on its own is just its name. */
export function labelOf(a: { name: string; parent: { name: string } | null }): string {
  return a.parent === null ? a.name : `${a.parent.name} › ${a.name}`;
}

/** Every posted voucher's debits and credits, per account. */
export async function accountTotals(
  db: TenantDb,
  tenantId: bigint,
): Promise<Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>> {
  const rows = await db.$queryRaw<{ ledger_account_id: bigint; debit: unknown; credit: unknown }[]>`
    SELECT l.ledger_account_id, SUM(l.debit) AS debit, SUM(l.credit) AS credit
      FROM journal_line l
      JOIN journal_entry e ON e.id = l.journal_entry_id
     WHERE l.deleted_at IS NULL
       AND e.deleted_at IS NULL
       AND e.status = 'POSTED'
       AND e.tenant_id = ${tenantId}
     GROUP BY l.ledger_account_id
  `;
  return new Map(
    rows.map((r) => [r.ledger_account_id.toString(), { debit: dec(String(r.debit)), credit: dec(String(r.credit)) }]),
  );
}

/** Positive when the balance runs the way the head normally does (§14.1). */
export function balanceOf(
  type: LedgerAccountType,
  totals: { debit: Prisma.Decimal; credit: Prisma.Decimal } | undefined,
): Prisma.Decimal {
  if (totals === undefined) return ZERO;
  return DEBIT_NORMAL[type] ? totals.debit.minus(totals.credit) : totals.credit.minus(totals.debit);
}

export function accountOption(
  a: AccountRow,
  totals: Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>,
): AccountOptionDto {
  const money_ = isMoney(a);
  return {
    id: a.id.toString(),
    code: a.code,
    label: labelOf(a),
    accountType: a.accountType,
    systemKey: a.systemKey,
    isMoney: money_,
    balance: money_ ? money(balanceOf(a.accountType, totals.get(a.id.toString()))) : null,
  };
}

/**
 * A bank account's sub ledger name: the sheet's "Bank Asia Ltd-878" — the bank
 * and the account number's last three digits. The full number when another
 * account of the same bank already ends the same way, so two never collide.
 */
export async function bankLedgerName(
  db: TenantDb,
  bankName: string,
  accountNo: string,
  bankLedgerId: bigint,
  selfId: bigint | null,
): Promise<string> {
  const digits = accountNo.replace(/\D/g, '');
  const short = `${bankName}-${(digits.length > 0 ? digits : accountNo).slice(-3)}`;
  const clash = await db.ledgerAccount.findFirst({
    where: {
      parentId: bankLedgerId,
      deletedAt: null,
      name: { equals: short, mode: 'insensitive' },
      ...(selfId === null ? {} : { id: { not: selfId } }),
    },
    select: { id: true },
  });
  return (clash === null ? short : `${bankName}-${accountNo}`).slice(0, 200);
}

export async function systemAccount(db: TenantDb, key: string): Promise<{ id: bigint }> {
  const row = await db.ledgerAccount.findFirst({ where: { systemKey: key, deletedAt: null }, select: { id: true } });
  if (row === null) throw new HttpError(500, 'CHART_MISSING', `The chart has no ${key} account.`);
  return row;
}

// --------------------------------------------------------------- vouchers

/** JV-2026-000001: per workspace, per kind, per year of the voucher date. */
export async function nextVoucherNo(
  db: TenantDb,
  tenantId: bigint,
  kind: JournalEntryKind,
  year: number,
): Promise<string> {
  const prefix = JOURNAL_ENTRY_PREFIX[kind];
  const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
    SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
      FROM journal_entry
     WHERE tenant_id = ${tenantId}
       AND series_year = ${year}
       AND code LIKE ${`${prefix}-${year}-%`}
  `;
  return formatDocumentNo(prefix, year, (rows[0]?.max_seq ?? 0) + 1);
}

export interface BuiltLine {
  ledgerAccountId: bigint;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

/**
 * The four sheets, turned into debits and credits (§14.4):
 *
 *   Expense    Dr each Expense Category row     Cr "Payment from"
 *   Income     Dr "Deposit to"                  Cr each Income Category row
 *   Transfer   Dr each "Transfer To" account    Cr "Transfer From"
 *   Journal    the rows as written
 *
 * Refused with the sheet's own words when Debit Amount and Credit Amount would
 * not match — the Difference row has to read nil.
 */
export function buildLines(input: JournalEntryData, accounts: Map<string, AccountRow>): BuiltLine[] {
  const account = (id: string, what: string): AccountRow => {
    const row = accounts.get(id);
    if (row === undefined) throw HttpError.badRequest(`${what} is not an account on this chart.`);
    if (!isUsable(row)) {
      throw HttpError.badRequest(
        `${labelOf(row)} is ${row.isActive ? 'a ledger with sub ledgers — choose one of them' : 'switched off'}.`,
      );
    }
    return row;
  };

  if (input.kind === 'JOURNAL') {
    const lines = input.lines.map((l) => {
      account(l.ledgerAccountId, 'One of the accounts');
      return { ledgerAccountId: BigInt(l.ledgerAccountId), debit: dec(l.debit), credit: dec(l.credit) };
    });
    const debit = lines.reduce((s, l) => s.plus(l.debit), ZERO);
    const credit = lines.reduce((s, l) => s.plus(l.credit), ZERO);
    if (!debit.equals(credit)) {
      throw HttpError.badRequest(
        `Total Debit (${money(debit)}) and Total Credit (${money(credit)}) must be equal before this can be saved.`,
      );
    }
    if (!lines.some((l) => l.debit.greaterThan(0)) || !lines.some((l) => l.credit.greaterThan(0))) {
      throw HttpError.badRequest('A journal needs at least one debit and one credit.');
    }
    return lines;
  }

  const moneyAccount = account(input.moneyAccountId, 'That bank or cash account');
  if (!isMoney(moneyAccount)) {
    throw HttpError.badRequest(`${labelOf(moneyAccount)} is not a bank or cash account.`);
  }
  const amount = dec(input.amount);
  const rows = input.lines.map((l) => ({ row: account(l.ledgerAccountId, 'One of the accounts'), amount: dec(l.amount) }));

  for (const { row } of rows) {
    if (input.kind === 'EXPENSE' && row.accountType !== 'EXPENSE') {
      throw HttpError.badRequest(`${labelOf(row)} is not an expense category.`);
    }
    if (input.kind === 'INCOME' && row.accountType !== 'INCOME') {
      throw HttpError.badRequest(`${labelOf(row)} is not an income category.`);
    }
    if (input.kind === 'TRANSFER') {
      if (!isMoney(row)) throw HttpError.badRequest(`${labelOf(row)} is not a bank or cash account.`);
      if (row.id === moneyAccount.id) {
        throw HttpError.badRequest('Money cannot be transferred into the account it came from.');
      }
    }
  }

  const spread = rows.reduce((s, r) => s.plus(r.amount), ZERO);
  if (!spread.equals(amount)) {
    throw HttpError.badRequest(
      `The rows come to ${money(spread)} but the amount is ${money(amount)}. The difference must be nil before this can be saved.`,
    );
  }

  // Money leaves the account on an expense or a transfer, and arrives on income.
  const moneyIsDebit = input.kind === 'INCOME';
  return [
    ...(moneyIsDebit
      ? [{ ledgerAccountId: moneyAccount.id, debit: amount, credit: ZERO }]
      : []),
    ...rows.map((r) =>
      moneyIsDebit
        ? { ledgerAccountId: r.row.id, debit: ZERO, credit: r.amount }
        : { ledgerAccountId: r.row.id, debit: r.amount, credit: ZERO },
    ),
    ...(moneyIsDebit ? [] : [{ ledgerAccountId: moneyAccount.id, debit: ZERO, credit: amount }]),
  ];
}

// ----------------------------------------------------------- settlements

interface OpeningPosition {
  currencyId: bigint;
  currencyCode: string;
  receivable: Prisma.Decimal;
  payable: Prisma.Decimal;
}

/**
 * A party's CRM opening: what they owe us (receivable) and what we owe them
 * (payable), each its own column — the agent's pair, and since §14.14 the
 * customer's and vendor's too.
 */
export async function openingOf(
  db: TenantDb,
  type: LedgerPartyType,
  id: bigint,
): Promise<OpeningPosition | null> {
  const currency = { select: { currency: true } } as const;
  const where = { id, deletedAt: null };
  if (type === 'CUSTOMER') {
    const row = await db.customer.findFirst({
      where,
      select: { customerOwe: true, weOwe: true, openingCurrencyId: true, openingCurrency: currency },
    });
    if (row === null || row.openingCurrencyId === null) return null;
    return {
      currencyId: row.openingCurrencyId,
      currencyCode: isoCurrency(row.openingCurrency?.currency ?? ''),
      receivable: dec(row.customerOwe),
      payable: dec(row.weOwe),
    };
  }
  if (type === 'VENDOR') {
    const row = await db.vendor.findFirst({
      where,
      select: { vendorOwe: true, weOwe: true, openingCurrencyId: true, openingCurrency: currency },
    });
    if (row === null || row.openingCurrencyId === null) return null;
    return {
      currencyId: row.openingCurrencyId,
      currencyCode: isoCurrency(row.openingCurrency?.currency ?? ''),
      receivable: dec(row.vendorOwe),
      payable: dec(row.weOwe),
    };
  }
  if (type === 'AGENT') {
    const row = await db.agent.findFirst({
      where: { id, deletedAt: null },
      select: { agentOwe: true, weOwe: true, openingCurrencyId: true, openingCurrency: currency },
    });
    if (row === null || row.openingCurrencyId === null) return null;
    return {
      currencyId: row.openingCurrencyId,
      currencyCode: isoCurrency(row.openingCurrency?.currency ?? ''),
      receivable: dec(row.agentOwe),
      payable: dec(row.weOwe),
    };
  }
  return null;
}

/** What is still open on a party's opening, on one side, in its currency. */
export async function openingOutstanding(
  db: TenantDb,
  type: LedgerPartyType,
  id: bigint,
  side: 'RECEIVABLE' | 'PAYABLE',
): Promise<{ position: OpeningPosition; outstanding: Prisma.Decimal } | null> {
  const position = await openingOf(db, type, id);
  if (position === null) return null;
  const opening = side === 'RECEIVABLE' ? position.receivable : position.payable;
  if (opening.isZero()) return null;
  const settled = await db.openingSettlement.aggregate({
    where: {
      deletedAt: null,
      side,
      partyType: type,
      ...openingColumns(type, id),
      currencyId: position.currencyId,
    },
    _sum: { amount: true },
  });
  const outstanding = Prisma.Decimal.max(opening.minus(dec(settled._sum.amount)), ZERO);
  return { position, outstanding };
}

/** opening_settlement has no carrier column: carriers hold no opening. */
function openingColumns(
  type: LedgerPartyType,
  id: bigint,
): { customerId: bigint } | { agentId: bigint } | { vendorId: bigint } {
  if (type === 'CUSTOMER') return { customerId: id };
  if (type === 'AGENT') return { agentId: id };
  return { vendorId: id };
}

/** debit_invoice_cost names a carrier, an agent or a vendor. */
export function supplierColumns(
  type: LedgerPartyType,
  id: bigint,
): { carrierId: bigint } | { agentId: bigint } | { vendorId: bigint } {
  if (type === 'CARRIER') return { carrierId: id };
  if (type === 'AGENT') return { agentId: id };
  return { vendorId: id };
}

export function partyColumns(
  type: LedgerPartyType,
  id: bigint,
): { customerId?: bigint; agentId?: bigint; carrierId?: bigint; vendorId?: bigint } {
  if (type === 'CUSTOMER') return { customerId: id };
  if (type === 'AGENT') return { agentId: id };
  if (type === 'CARRIER') return { carrierId: id };
  return { vendorId: id };
}

export async function partyName(db: TenantDb, type: LedgerPartyType, id: bigint): Promise<string | null> {
  const where = { id, deletedAt: null };
  const select = { name: true } as const;
  const row =
    type === 'CUSTOMER'
      ? await db.customer.findFirst({ where, select })
      : type === 'AGENT'
        ? await db.agent.findFirst({ where, select })
        : type === 'CARRIER'
          ? await db.carrier.findFirst({ where, select })
          : await db.vendor.findFirst({ where, select });
  return row?.name ?? null;
}

/** §14.5: which Cost of Service / Income on Service row a booking belongs to. */
export function serviceKeyOf(
  shipment: { shipmentType: string; loadingType: string | null } | null,
): ServiceKey | null {
  if (shipment === null) return null;
  if (shipment.shipmentType === 'AIR') return 'AIR';
  if (shipment.loadingType === 'LCL') return 'SEA_LCL';
  if (shipment.loadingType === 'FCL') return 'SEA_FCL';
  return null;
}

/**
 * The half of a save that touches a party's ledger (§14.6): pay a credit
 * invoice, bank a debit invoice, or close part of an opening balance.
 *
 * `baseAmount` is what the voucher moved through the bank, in the base. When
 * the document is itself in the base the two figures are one figure, and must
 * agree; in any other currency their ratio is simply the rate the bank gave.
 */
export async function settle(
  db: TenantDb,
  args: {
    tenantId: bigint;
    userId: bigint;
    entryId: bigint;
    entryDate: Date;
    kind: 'EXPENSE' | 'INCOME';
    settlement: NonNullable<Extract<JournalEntryData, { kind: 'EXPENSE' | 'INCOME' }>['settlement']>;
    baseAmount: Prisma.Decimal;
    base: BaseCurrency;
  },
): Promise<void> {
  const { tenantId, userId, entryId, entryDate, kind, settlement, baseAmount, base } = args;
  const partyType = settlement.partyType;
  const partyId = BigInt(settlement.partyId);
  const amount = dec(settlement.amount);

  const allowed: readonly LedgerPartyType[] = kind === 'EXPENSE' ? PAY_TO_PARTY_TYPES : INCOME_FROM_PARTY_TYPES;
  if (!allowed.includes(partyType)) {
    throw HttpError.badRequest(
      kind === 'EXPENSE'
        ? 'An expense is paid to a vendor, a carrier or an agent.'
        : 'Income against an invoice is received from a customer.',
    );
  }
  if ((await partyName(db, partyType, partyId)) === null) {
    throw HttpError.badRequest('That party is not available.');
  }

  const sameFigure = (currencyId: bigint, code: string): void => {
    if (currencyId === base.id && !amount.equals(baseAmount)) {
      throw HttpError.badRequest(
        `The invoice is in ${code}, so the amount settled (${money(amount)}) and the amount ` +
          `${kind === 'EXPENSE' ? 'paid' : 'deposited'} (${money(baseAmount)}) must be the same.`,
      );
    }
  };
  const tooMuch = (outstanding: Prisma.Decimal, code: string, what: string): HttpError =>
    new HttpError(
      409,
      kind === 'EXPENSE' ? 'OVER_PAID' : 'OVER_RECEIVED',
      `That is more than the ${code} ${outstanding.toFixed(2)} still outstanding on ${what}.`,
    );
  const audit = { createdBy: userId, updatedBy: userId };

  await db.journalEntry.update({
    where: { id: entryId },
    data: { partyType, ...partyColumns(partyType, partyId) },
  });

  if (settlement.against === 'OPENING') {
    const side = kind === 'EXPENSE' ? 'PAYABLE' : 'RECEIVABLE';
    const open = await openingOutstanding(db, partyType, partyId, side);
    if (open === null || open.outstanding.isZero()) {
      throw new HttpError(409, 'NO_OPENING', 'There is no opening balance left to settle for them.');
    }
    if (amount.greaterThan(open.outstanding)) throw tooMuch(open.outstanding, open.position.currencyCode, 'the opening balance');
    sameFigure(open.position.currencyId, open.position.currencyCode);
    await db.openingSettlement.create({
      data: {
        tenantId,
        journalEntryId: entryId,
        side,
        partyType,
        ...openingColumns(partyType, partyId),
        settlementDate: entryDate,
        currencyId: open.position.currencyId,
        currencyCode: open.position.currencyCode,
        amount,
        ...audit,
      },
    });
    return;
  }

  const documentId = BigInt(settlement.documentId!);

  if (kind === 'INCOME') {
    const invoice = await db.debitInvoice.findFirst({
      where: { id: documentId, customerId: partyId, deletedAt: null },
      select: {
        id: true,
        code: true,
        status: true,
        currencyId: true,
        currencyCode: true,
        conversionRate: true,
        totalAmount: true,
        totalAmountBase: true,
        receipts: { where: { deletedAt: null }, select: { amount: true, amountBase: true } },
      },
    });
    if (invoice === null) throw HttpError.badRequest('That debit invoice is not one of theirs.');
    if (invoice.status !== 'ISSUED') {
      throw new HttpError(
        409,
        'NOT_ISSUED',
        invoice.status === 'DRAFT'
          ? `${invoice.code} is still a draft. Send it before recording money against it.`
          : `${invoice.code} was cancelled.`,
      );
    }
    const payment = paymentOf(invoice.totalAmount, invoice.receipts);
    if (amount.greaterThan(payment.outstanding)) throw tooMuch(payment.outstanding, invoice.currencyCode, invoice.code);
    sameFigure(invoice.currencyId, invoice.currencyCode);
    // The receipt that closes the invoice takes whatever base is left, so a
    // fully received invoice nets to exactly zero in both columns (§3.4).
    const receivedBase = invoice.receipts.reduce((s, r) => s.plus(r.amountBase), ZERO);
    await db.debitInvoiceReceipt.create({
      data: {
        tenantId,
        debitInvoiceId: invoice.id,
        journalEntryId: entryId,
        paymentDate: entryDate,
        amount,
        amountBase: amount.equals(payment.outstanding)
          ? invoice.totalAmountBase.minus(receivedBase)
          : toBase(amount, invoice.conversionRate),
        ...audit,
      },
    });
    return;
  }

  // Checked against PAY_TO_PARTY_TYPES above: a carrier, an agent or a vendor.
  const supplierType = partyType as SupplierPartyType;
  const cost = await db.debitInvoiceCost.findFirst({
    where: { id: documentId, partyType: supplierType, ...supplierColumns(supplierType, partyId), deletedAt: null },
    select: {
      id: true,
      supplierInvoiceNo: true,
      currencyId: true,
      currencyCode: true,
      conversionRate: true,
      totalAmount: true,
      totalAmountBase: true,
      debitInvoice: { select: { code: true, status: true, deletedAt: true } },
      payments: { where: { deletedAt: null }, select: { amount: true, amountBase: true } },
    },
  });
  if (cost === null || cost.debitInvoice.deletedAt !== null) {
    throw HttpError.badRequest('That credit invoice is not one of theirs.');
  }
  const what = cost.supplierInvoiceNo ?? `the cost on ${cost.debitInvoice.code}`;
  if (cost.debitInvoice.status !== 'ISSUED') {
    throw new HttpError(
      409,
      'NOT_ISSUED',
      cost.debitInvoice.status === 'DRAFT'
        ? `${what} is on ${cost.debitInvoice.code}, which is still a draft. Send it first.`
        : `${cost.debitInvoice.code} was cancelled.`,
    );
  }
  const paid = paymentOf(cost.totalAmount, cost.payments);
  if (amount.greaterThan(paid.outstanding)) throw tooMuch(paid.outstanding, cost.currencyCode, what);
  sameFigure(cost.currencyId, cost.currencyCode);
  const paidBase = cost.payments.reduce((s, p) => s.plus(p.amountBase), ZERO);
  await db.supplierPayment.create({
    data: {
      tenantId,
      journalEntryId: entryId,
      debitInvoiceCostId: cost.id,
      paymentDate: entryDate,
      amount,
      amountBase: amount.equals(paid.outstanding)
        ? cost.totalAmountBase.minus(paidBase)
        : toBase(amount, cost.conversionRate),
      ...audit,
    },
  });
}

/** Cancelling a voucher takes back what it settled (§14.4). */
export async function unsettle(db: TenantDb, entryId: bigint, userId: bigint): Promise<void> {
  const gone = { deletedAt: new Date(), isActive: false, updatedBy: userId };
  await db.debitInvoiceReceipt.updateMany({ where: { journalEntryId: entryId, deletedAt: null }, data: gone });
  await db.supplierPayment.updateMany({ where: { journalEntryId: entryId, deletedAt: null }, data: gone });
  await db.openingSettlement.updateMany({ where: { journalEntryId: entryId, deletedAt: null }, data: gone });
}

// ------------------------------------------------------------ the reads

export const ENTRY_SELECT = {
  id: true,
  code: true,
  kind: true,
  status: true,
  entryDate: true,
  description: true,
  attachmentFile: true,
  partyType: true,
  customerId: true,
  agentId: true,
  carrierId: true,
  vendorId: true,
  totalAmount: true,
  postedAt: true,
  cancelledAt: true,
  cancelReason: true,
  customer: { select: { name: true } },
  agent: { select: { name: true } },
  carrier: { select: { name: true } },
  vendor: { select: { name: true } },
  lines: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      ledgerAccountId: true,
      debit: true,
      credit: true,
      ledgerAccount: { select: { code: true, name: true, parent: { select: { name: true } } } },
    },
  },
  receipts: {
    where: { deletedAt: null },
    select: { amount: true, debitInvoice: { select: { id: true, code: true, currencyCode: true } } },
  },
  supplierPayments: {
    where: { deletedAt: null },
    select: {
      amount: true,
      cost: {
        select: {
          supplierInvoiceNo: true,
          currencyCode: true,
          debitInvoice: { select: { id: true, code: true } },
        },
      },
    },
  },
  openingSettlements: {
    where: { deletedAt: null },
    select: { amount: true, currencyCode: true },
  },
} satisfies Prisma.JournalEntrySelect;

export type EntryRow = Prisma.JournalEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

export async function loadEntry(db: TenantDb, id: bigint, kind: JournalEntryKind): Promise<EntryRow> {
  const row = await db.journalEntry.findFirst({ where: { id, kind, deletedAt: null }, select: ENTRY_SELECT });
  if (row === null) throw HttpError.notFound('Voucher not found.');
  return row;
}

export function entryParty(row: EntryRow): JournalEntryDto['party'] {
  if (row.partyType === null) return null;
  const pick = {
    CUSTOMER: [row.customerId, row.customer?.name],
    AGENT: [row.agentId, row.agent?.name],
    CARRIER: [row.carrierId, row.carrier?.name],
    VENDOR: [row.vendorId, row.vendor?.name],
  } as const;
  const [id, name] = pick[row.partyType];
  return id === null ? null : { type: row.partyType, id: id.toString(), name: name ?? '—' };
}

export function entrySettlement(row: EntryRow): JournalEntryDto['settlement'] {
  const receipt = row.receipts[0];
  if (receipt !== undefined) {
    return {
      against: 'INVOICE',
      reference: receipt.debitInvoice.code,
      currencyCode: receipt.debitInvoice.currencyCode,
      amount: money(receipt.amount),
      debitInvoiceId: receipt.debitInvoice.id.toString(),
    };
  }
  const payment = row.supplierPayments[0];
  if (payment !== undefined) {
    return {
      against: 'INVOICE',
      reference: payment.cost.supplierInvoiceNo ?? payment.cost.debitInvoice.code,
      currencyCode: payment.cost.currencyCode,
      amount: money(payment.amount),
      debitInvoiceId: payment.cost.debitInvoice.id.toString(),
    };
  }
  const opening = row.openingSettlements[0];
  if (opening !== undefined) {
    return {
      against: 'OPENING',
      reference: 'Opening balance',
      currencyCode: opening.currencyCode,
      amount: money(opening.amount),
      debitInvoiceId: null,
    };
  }
  return null;
}

export function entryDto(
  row: EntryRow,
  ctx: { baseCurrencyCode: string | null; displayName: (key: string) => string },
): JournalEntryDto {
  return {
    id: row.id.toString(),
    code: row.code,
    kind: row.kind,
    status: row.status,
    entryDate: day(row.entryDate) ?? '',
    description: row.description,
    attachmentFileName: row.attachmentFile === null ? null : ctx.displayName(row.attachmentFile),
    party: entryParty(row),
    settlement: entrySettlement(row),
    lines: row.lines.map((l) => ({
      id: l.id.toString(),
      ledgerAccountId: l.ledgerAccountId.toString(),
      accountCode: l.ledgerAccount.code,
      accountLabel: labelOf(l.ledgerAccount),
      debit: money(l.debit),
      credit: money(l.credit),
    })),
    totalAmount: money(row.totalAmount),
    baseCurrencyCode: ctx.baseCurrencyCode,
    postedAt: row.postedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    editable: row.kind === 'JOURNAL' && row.status === 'DRAFT',
    cancellable: row.status !== 'CANCELLED',
  };
}

/** "Bank Asia Plc-878 → Office Rent, Internet Bill" — a voucher in one line. */
export function accountsSummary(row: {
  lines: { debit: Prisma.Decimal; credit: Prisma.Decimal; ledgerAccount: { name: string } }[];
}): string {
  const from = [...new Set(row.lines.filter((l) => l.credit.greaterThan(0)).map((l) => l.ledgerAccount.name))];
  const to = [...new Set(row.lines.filter((l) => l.debit.greaterThan(0)).map((l) => l.ledgerAccount.name))];
  return `${from.join(', ')} → ${to.join(', ')}`;
}

export const featureOf = (kind: JournalEntryKind): string => JOURNAL_ENTRY_FEATURE[kind];
