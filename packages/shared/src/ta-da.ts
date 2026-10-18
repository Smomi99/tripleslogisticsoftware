import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * Accounts → TA/DA (Menu M17) — Travel Allowance / Daily Allowance claims.
 *
 * The menu names the screen and no sheet draws it (MODULE_ACCOUNTS §14.13 Q1).
 * Built 2026-10-18 on our recommendation: an employee's claim for field work,
 * line by line (date · from · to · mode · TA · DA), submitted, approved or
 * rejected, then paid from cash or bank by an Expense voucher on the chart's
 * TA/DA account — so the payment is in the books like every other.
 *
 * Permissions: the existing ACCOUNTS.TA_DA feature. CREATE/EDIT write and
 * submit a claim; APPROVE approves or rejects one; TOGGLE_STATUS cancels one;
 * EXPORT downloads the list. Paying needs ACCOUNTS.EXPENSE.CREATE as well,
 * because it writes an Expense voucher.
 */

export const TA_DA_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED'] as const;
export type TaDaStatus = (typeof TA_DA_STATUSES)[number];

export const TA_DA_STATUS_LABEL: Record<TaDaStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
};

/** Offered as suggestions on the Mode box; anything else may be typed. */
export const TA_DA_MODE_SUGGESTIONS = [
  'Rickshaw',
  'CNG',
  'Bus',
  'Train',
  'Launch',
  'Air',
  'Ride-share',
  'Office vehicle',
  'Own vehicle',
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');
const idString = (message: string) => z.string().trim().regex(/^\d+$/, message);
/** Money as a string, never a float (§4 rule 6); taka and poisha. */
const amount = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,2})?$/, 'Use digits, up to two decimal places.');
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v));

export const taDaLineInputSchema = z
  .object({
    travelDate: isoDate,
    fromPlace: z.string().trim().min(1, 'Say where the trip started.').max(200, 'Keep it under 200 characters.'),
    toPlace: z.string().trim().min(1, 'Say where the trip went.').max(200, 'Keep it under 200 characters.'),
    mode: optionalText(100, 'Keep the mode under 100 characters.'),
    description: optionalText(1000, 'Keep the note under 1,000 characters.'),
    /** Travel Allowance: the fare. */
    taAmount: amount.default('0'),
    /** Daily Allowance: food and the day's stay. */
    daAmount: amount.default('0'),
  })
  .refine((l) => Number(l.taAmount) + Number(l.daAmount) > 0, {
    message: 'Enter a TA or a DA amount.',
    path: ['taAmount'],
  });
export type TaDaLineInput = z.input<typeof taDaLineInputSchema>;

export const taDaClaimSaveSchema = z.object({
  employeeId: idString('Choose the employee.'),
  claimDate: isoDate,
  purpose: z.string().trim().min(1, 'Say what the travel was for.').max(2000, 'Keep it under 2,000 characters.'),
  lines: z.array(taDaLineInputSchema).min(1, 'Add at least one trip or day.').max(100, 'That is too many lines.'),
});
export type TaDaClaimSaveInput = z.input<typeof taDaClaimSaveSchema>;
export type TaDaClaimSaveData = z.output<typeof taDaClaimSaveSchema>;

export const taDaReasonSchema = z.object({
  reason: z.string().trim().min(1, 'Say why.').max(2000, 'Keep it under 2,000 characters.'),
});

export const taDaPaySchema = z.object({
  paymentDate: isoDate,
  moneyAccountId: idString('Choose the cash or bank account it is paid from.'),
});
export type TaDaPayInput = z.input<typeof taDaPaySchema>;

export const TA_DA_SORT_FIELDS = ['code', 'claimDate', 'amount'] as const;

export const taDaListQuerySchema = listQuerySchema.extend({
  status: z.enum(TA_DA_STATUSES).optional(),
  sortBy: z.enum(TA_DA_SORT_FIELDS).optional(),
});

// ------------------------------------------------------------------- DTOs

export interface TaDaClaimLineDto {
  id: string;
  travelDate: string;
  fromPlace: string;
  toPlace: string;
  mode: string | null;
  description: string | null;
  taAmount: string;
  daAmount: string;
  amount: string;
}

export interface TaDaClaimDto {
  id: string;
  code: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  department: string | null;
  designation: string | null;
  claimDate: string;
  purpose: string;
  status: TaDaStatus;
  currencyCode: string;
  totalTa: string;
  totalDa: string;
  totalAmount: string;
  lines: TaDaClaimLineDto[];
  submittedAt: string | null;
  submittedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  rejectReason: string | null;
  paidAt: string | null;
  paidByName: string | null;
  /** The Expense voucher that paid it. */
  voucher: { id: string; code: string } | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** DRAFT or REJECTED: still the claimant's to change. */
  editable: boolean;
}

export interface TaDaListRow {
  id: string;
  code: string;
  claimDate: string;
  employeeName: string;
  purpose: string;
  totalTa: string;
  totalDa: string;
  totalAmount: string;
  status: TaDaStatus;
  voucherCode: string | null;
}

export interface TaDaOptionsDto {
  employees: { id: string; label: string }[];
  /** The signed-in user's own employee record, the claim's default. */
  myEmployeeId: string | null;
  /** Cash and bank accounts a payment may come from, with their balances. */
  moneyAccounts: { id: string; label: string; balance: string | null }[];
  baseCurrencyCode: string | null;
}
