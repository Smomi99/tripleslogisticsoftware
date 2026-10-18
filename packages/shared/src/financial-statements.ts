import { z } from 'zod';

import { INCOME_STATEMENT_BASES, type IncomeStatementBasis } from './income-statement';

/**
 * Accounts → Balance Sheet and Cash Flow Statement (Menu M15, M16).
 *
 * The client's menu names both and draws neither (MODULE_ACCOUNTS §14.13 Q1),
 * and DESIGN-UPDATE-2026-10-04 §9 held them back on Q21, accrual or cash. The
 * Income Statement answered Q21 as "accrual, built as a report over the books,
 * with a Cash switch" (client, 2026-10-04: "both, with a switch"); these two
 * follow that answer, so the three statements tell one story. Built on our own
 * recommendation, 2026-10-18 ("do all with your recommendation").
 */

/** One printed row. Amounts are base-currency strings, one per column. */
export interface StatementRowDto {
  kind: 'SECTION' | 'GROUP' | 'LINE' | 'SUBTOTAL' | 'TOTAL' | 'CHECK';
  key: string;
  label: string;
  /** One per column; null where a row has no figure (a heading). */
  amounts: (string | null)[];
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month.');
const yearStartMonth = z.coerce.number().int().min(1).max(12).default(1);

// ===========================================================================
// Balance Sheet
// ===========================================================================

export const BALANCE_SHEET_GROUPS = [
  'CURRENT_ASSETS',
  'NON_CURRENT_ASSETS',
  'CURRENT_LIABILITIES',
  'LONG_TERM_LIABILITIES',
  'EQUITY',
] as const;
export type BalanceSheetGroup = (typeof BALANCE_SHEET_GROUPS)[number];

export const BALANCE_SHEET_LINES = [
  { key: 'CASH', group: 'CURRENT_ASSETS', label: 'Cash in Hand' },
  { key: 'BANK', group: 'CURRENT_ASSETS', label: 'Cash at Bank' },
  { key: 'RECEIVABLE', group: 'CURRENT_ASSETS', label: 'Accounts Receivable – Customers' },
  { key: 'INVENTORY', group: 'CURRENT_ASSETS', label: 'Inventory' },
  { key: 'LOANS_GIVEN', group: 'CURRENT_ASSETS', label: 'Short-Term Loans to Others' },
  { key: 'OTHER_CURRENT_ASSETS', group: 'CURRENT_ASSETS', label: 'Other Current Assets' },
  { key: 'LONG_TERM_ASSETS', group: 'NON_CURRENT_ASSETS', label: 'Land, Buildings and Other Long-Term Assets' },

  { key: 'PAYABLE', group: 'CURRENT_LIABILITIES', label: 'Accounts Payable – Carriers, Agents, Vendors' },
  { key: 'CUSTOMER_ADVANCES', group: 'CURRENT_LIABILITIES', label: 'Customer Advances and Credits' },
  { key: 'PAYROLL', group: 'CURRENT_LIABILITIES', label: 'Payroll Liabilities' },
  { key: 'TAXES', group: 'CURRENT_LIABILITIES', label: 'Taxes Payable' },
  { key: 'OTHER_CURRENT_LIABILITIES', group: 'CURRENT_LIABILITIES', label: 'Other Short-Term Liabilities' },
  { key: 'LOANS', group: 'LONG_TERM_LIABILITIES', label: 'Loans and Lines of Credit' },
  { key: 'OTHER_LONG_TERM_LIABILITIES', group: 'LONG_TERM_LIABILITIES', label: 'Other Long-Term Liabilities' },

  { key: 'OWNER', group: 'EQUITY', label: 'Owner Investment and Drawings' },
  { key: 'OPENING_EQUITY', group: 'EQUITY', label: 'Opening Balance Equity' },
  { key: 'RETAINED', group: 'EQUITY', label: 'Retained Earnings Brought Forward' },
  { key: 'PROFIT', group: 'EQUITY', label: 'Profit for the Year' },
] as const satisfies readonly { key: string; group: BalanceSheetGroup; label: string }[];

export type BalanceSheetLineKey = (typeof BALANCE_SHEET_LINES)[number]['key'];

export const balanceSheetQuerySchema = z.object({
  /** "As at": the day the position is taken, inclusive. */
  asOf: isoDate,
  /** For Profit for the Year: the month the financial year starts in. */
  yearStartMonth,
  basis: z.enum(INCOME_STATEMENT_BASES).default('ACCRUAL'),
});
export type BalanceSheetQuery = z.input<typeof balanceSheetQuerySchema>;

export interface BalanceSheetDto {
  currencyCode: string;
  basis: IncomeStatementBasis;
  yearStartMonth: number;
  /** The date asked for, and the same day a year before. */
  columns: { label: string; asOf: string }[];
  rows: StatementRowDto[];
  /** Assets equal liabilities and equity in every column. */
  balanced: boolean;
}

// ===========================================================================
// Cash Flow Statement
// ===========================================================================

export const CASH_FLOW_SECTIONS = ['OPERATING', 'INVESTING', 'FINANCING'] as const;
export type CashFlowSection = (typeof CASH_FLOW_SECTIONS)[number];

export const CASH_FLOW_SECTION_TITLE: Record<CashFlowSection, string> = {
  OPERATING: 'A. Cash Flows from Operating Activities',
  INVESTING: 'B. Cash Flows from Investing Activities',
  FINANCING: 'C. Cash Flows from Financing Activities',
};

export const CASH_FLOW_LINES = [
  { key: 'OP_CUSTOMERS', section: 'OPERATING', label: 'Cash received from customers' },
  { key: 'OP_SUPPLIERS', section: 'OPERATING', label: 'Cash paid to carriers, agents and vendors' },
  { key: 'OP_EMPLOYEES', section: 'OPERATING', label: 'Cash paid to and for employees' },
  { key: 'OP_EXPENSES', section: 'OPERATING', label: 'Cash paid for operating expenses' },
  { key: 'OP_TAX', section: 'OPERATING', label: 'Taxes paid' },
  { key: 'OP_OTHER', section: 'OPERATING', label: 'Other operating receipts and payments' },
  { key: 'INV_ASSETS', section: 'INVESTING', label: 'Purchase and sale of long-term assets' },
  { key: 'INV_LOANS', section: 'INVESTING', label: 'Loans given to others, and repayments' },
  { key: 'INV_INTEREST', section: 'INVESTING', label: 'Interest and deposit income received' },
  { key: 'FIN_OWNER', section: 'FINANCING', label: 'Owner investment and drawings' },
  { key: 'FIN_LOANS', section: 'FINANCING', label: 'Loans received and repaid' },
  { key: 'FIN_INTEREST', section: 'FINANCING', label: 'Interest paid' },
] as const satisfies readonly { key: string; section: CashFlowSection; label: string }[];

export type CashFlowLineKey = (typeof CASH_FLOW_LINES)[number]['key'];

export const cashFlowQuerySchema = z.object({
  month,
  yearStartMonth,
});
export type CashFlowQuery = z.input<typeof cashFlowQuerySchema>;

export interface CashFlowDto {
  currencyCode: string;
  yearStartMonth: number;
  /** ISO dates, inclusive: the Income Statement's three columns. */
  periods: {
    currentMonth: { from: string; to: string };
    ytd: { from: string; to: string };
    previousYtd: { from: string; to: string };
  };
  rows: StatementRowDto[];
}
