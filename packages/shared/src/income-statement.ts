import { z } from 'zod';

/**
 * Accounts → Income Statement (docs/DESIGN-UPDATE-2026-10-04.md §9).
 *
 * The client's `Income statement` sheet: sections A–E, their lines in the
 * sheet's order, and three columns — Current Month, YTD, Previous Year YTD.
 * How each line is filled is §9.3 of the spec; the short of it is that on
 * accrual, revenue and job costs come from issued debit invoices on their
 * invoice date and everything else from posted vouchers, and on cash,
 * everything comes from posted vouchers.
 */

export const INCOME_STATEMENT_SECTIONS = ['REVENUE', 'DIRECT_COST', 'OPEX', 'NONOP_INCOME', 'NONOP_EXPENSE'] as const;
export type IncomeStatementSection = (typeof INCOME_STATEMENT_SECTIONS)[number];

export const INCOME_STATEMENT_SECTION_TITLE: Record<IncomeStatementSection, string> = {
  REVENUE: 'A. Revenue',
  DIRECT_COST: 'B. Direct Cost of Services',
  OPEX: 'C. Operating Expenses',
  NONOP_INCOME: 'D. Non-Operating Income',
  NONOP_EXPENSE: 'E. Non-Operating Expenses',
};

/** Every line the sheet draws, in its order (C13–C89), with the section it sits in. */
export const INCOME_STATEMENT_LINES = [
  { key: 'REV_FCL', section: 'REVENUE', label: 'Ocean Freight Revenue – FCL' },
  { key: 'REV_LCL', section: 'REVENUE', label: 'Ocean Freight Revenue – LCL' },
  { key: 'REV_AIR', section: 'REVENUE', label: 'Air Freight Revenue' },
  { key: 'REV_CUSTOMS', section: 'REVENUE', label: 'Customs Clearance Revenue' },
  { key: 'REV_TRUCKING', section: 'REVENUE', label: 'Trucking / Transportation Revenue' },
  { key: 'REV_WAREHOUSING', section: 'REVENUE', label: 'Warehousing Revenue' },
  { key: 'REV_DOCUMENTATION', section: 'REVENUE', label: 'Documentation / BL Charges' },
  { key: 'REV_HANDLING', section: 'REVENUE', label: 'Handling / CFS Charges' },
  { key: 'REV_PACKING', section: 'REVENUE', label: 'Packing / Stuffing Revenue' },
  { key: 'REV_DOOR', section: 'REVENUE', label: 'Door-to-Door Revenue' },
  { key: 'REV_CROSS_TRADE', section: 'REVENUE', label: 'Cross-Trade / Third Country Revenue' },
  { key: 'REV_PROJECT', section: 'REVENUE', label: 'Project Cargo Revenue' },
  { key: 'REV_OTHER', section: 'REVENUE', label: 'Other Logistics Service Revenue' },

  { key: 'COST_FCL', section: 'DIRECT_COST', label: 'Ocean Freight Cost – FCL' },
  { key: 'COST_LCL', section: 'DIRECT_COST', label: 'Ocean Freight Cost – LCL' },
  { key: 'COST_AIR', section: 'DIRECT_COST', label: 'Air Freight Cost' },
  { key: 'COST_CARRIER', section: 'DIRECT_COST', label: 'Shipping Line / Carrier Charges' },
  { key: 'COST_PORT', section: 'DIRECT_COST', label: 'Port / Terminal Charges' },
  { key: 'COST_CFS', section: 'DIRECT_COST', label: 'CFS Charges' },
  { key: 'COST_CUSTOMS', section: 'DIRECT_COST', label: 'Customs / Clearing Cost' },
  { key: 'COST_TRUCKING', section: 'DIRECT_COST', label: 'Trucking / Transport Cost' },
  { key: 'COST_WAREHOUSE', section: 'DIRECT_COST', label: 'Warehouse Cost – Job Related' },
  { key: 'COST_LOADING', section: 'DIRECT_COST', label: 'Loading / Unloading Cost' },
  { key: 'COST_DOCUMENTATION', section: 'DIRECT_COST', label: 'Documentation / BL Cost' },
  { key: 'COST_AGENT', section: 'DIRECT_COST', label: 'Agent / Overseas Partner Cost' },
  { key: 'COST_HANDLING', section: 'DIRECT_COST', label: 'Handling Charges' },
  { key: 'COST_OTHER_JOB', section: 'DIRECT_COST', label: 'Other Job-Related Costs' },

  { key: 'OPEX_SALARIES', section: 'OPEX', label: 'Salaries & Wages' },
  { key: 'OPEX_BENEFITS', section: 'OPEX', label: 'Employee Benefits' },
  { key: 'OPEX_RENT', section: 'OPEX', label: 'Office Rent' },
  { key: 'OPEX_UTILITIES', section: 'OPEX', label: 'Utilities' },
  { key: 'OPEX_TELECOM', section: 'OPEX', label: 'Internet & Telephone' },
  { key: 'OPEX_IT', section: 'OPEX', label: 'Software / ERP / IT Expenses' },
  { key: 'OPEX_MARKETING', section: 'OPEX', label: 'Marketing & Advertising' },
  { key: 'OPEX_COMMISSION', section: 'OPEX', label: 'Sales Commission' },
  { key: 'OPEX_BUSINESS_DEV', section: 'OPEX', label: 'Business Development Expenses' },
  { key: 'OPEX_TRAVEL', section: 'OPEX', label: 'Travel & Entertainment' },
  { key: 'OPEX_VEHICLE', section: 'OPEX', label: 'Vehicle / Transportation Expenses' },
  { key: 'OPEX_SUPPLIES', section: 'OPEX', label: 'Office Supplies & Stationery' },
  { key: 'OPEX_REPAIRS', section: 'OPEX', label: 'Repairs & Maintenance' },
  { key: 'OPEX_INSURANCE', section: 'OPEX', label: 'Insurance' },
  { key: 'OPEX_PROFESSIONAL', section: 'OPEX', label: 'Professional / Consultancy Fees' },
  { key: 'OPEX_LEGAL', section: 'OPEX', label: 'Legal & Compliance Expenses' },
  { key: 'OPEX_BANK', section: 'OPEX', label: 'Bank Charges' },
  { key: 'OPEX_BAD_DEBT', section: 'OPEX', label: 'Bad Debt / Provision for Doubtful Debt' },
  { key: 'OPEX_DEPRECIATION', section: 'OPEX', label: 'Depreciation' },
  { key: 'OPEX_OTHER_ADMIN', section: 'OPEX', label: 'Other Administrative Expenses' },

  { key: 'NONOP_INTEREST', section: 'NONOP_INCOME', label: 'Interest Income' },
  { key: 'FX_GAIN', section: 'NONOP_INCOME', label: 'Foreign Exchange Gain' },
  { key: 'NONOP_INC_OTHER', section: 'NONOP_INCOME', label: 'Other Income' },

  { key: 'NONOP_FINANCE', section: 'NONOP_EXPENSE', label: 'Interest / Finance Cost' },
  { key: 'FX_LOSS', section: 'NONOP_EXPENSE', label: 'Foreign Exchange Loss' },
  { key: 'NONOP_ASSET_LOSS', section: 'NONOP_EXPENSE', label: 'Loss on Asset Disposal' },
  { key: 'NONOP_EXP_OTHER', section: 'NONOP_EXPENSE', label: 'Other Non-Operating Expenses' },
] as const satisfies readonly { key: string; section: IncomeStatementSection; label: string }[];

/** The two lines outside the sections: C27 "Less: Discounts / Credit Notes" and C89 "Income Tax Expense". */
export const INCOME_STATEMENT_EXTRA_LINES = ['DISCOUNTS', 'INCOME_TAX'] as const;

export type IncomeStatementLineKey =
  | (typeof INCOME_STATEMENT_LINES)[number]['key']
  | (typeof INCOME_STATEMENT_EXTRA_LINES)[number];

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month.');

/**
 * ACCRUAL is the sheet's own basis (C9): revenue and job cost when the debit
 * invoice is issued. CASH reads the Transaction screens alone — Income,
 * Expense and Journal vouchers as posted — so revenue is what Transaction →
 * Income received (client, 2026-10-04: "both, with a switch").
 */
export const INCOME_STATEMENT_BASES = ['ACCRUAL', 'CASH'] as const;
export type IncomeStatementBasis = (typeof INCOME_STATEMENT_BASES)[number];

export const INCOME_STATEMENT_BASIS_LABEL: Record<IncomeStatementBasis, string> = {
  ACCRUAL: 'Accrual',
  CASH: 'Cash',
};

export const incomeStatementQuerySchema = z.object({
  /** The sheet's "Current Month": the month the statement is for. */
  month,
  /**
   * The month the financial year starts in, 1–12, for YTD. January by
   * default; July for a Bangladesh tax year (§11 Q29).
   */
  yearStartMonth: z.coerce.number().int().min(1).max(12).default(1),
  basis: z.enum(INCOME_STATEMENT_BASES).default('ACCRUAL'),
});
export type IncomeStatementQuery = z.input<typeof incomeStatementQuerySchema>;

/** One printed row. Amounts are base-currency strings, one per column; a percentage row holds percentages. */
export interface IncomeStatementRowDto {
  kind: 'SECTION' | 'LINE' | 'SUBTOTAL' | 'TOTAL' | 'PERCENT';
  key: string;
  label: string;
  /** Current Month, YTD, Previous Year YTD. Null where there is nothing to divide by. */
  amounts: [string | null, string | null, string | null];
  /** A line deducted from the one above it, drawn in brackets (Discounts). */
  deduction?: boolean;
}

export interface IncomeStatementDto {
  currencyCode: string;
  basis: IncomeStatementBasis;
  /** ISO dates, inclusive. */
  periods: {
    currentMonth: { from: string; to: string };
    ytd: { from: string; to: string };
    previousYtd: { from: string; to: string };
  };
  yearStartMonth: number;
  rows: IncomeStatementRowDto[];
}
