import { z } from 'zod';

import { LEDGER_PARTY_TYPES, type LedgerPartyType } from './accounts';
import { listQuerySchema } from './api';

/**
 * Accounts — the books (docs/MODULE_ACCOUNTS.md §14).
 *
 * Transcribed from the client's `Design.xlsx` sheets `Chart of accounts`,
 * `Journal`, `Expense-regular`, `Expense-Vendor`, `Income`, `Income-Other`,
 * `Internal Transfer`, `bank setup` and `Account setup`. What no sheet answers
 * is an open question in §14.13, with the default used here named there.
 */

// ------------------------------------------------------------------- enums

/** The chart's five heads, in the sheet's own order (row 6). */
export const LEDGER_ACCOUNT_TYPES = ['EXPENSE', 'INCOME', 'EQUITY', 'LIABILITY', 'ASSET'] as const;
export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export const LEDGER_ACCOUNT_TYPE_LABEL: Record<LedgerAccountType, string> = {
  EXPENSE: 'Expense',
  INCOME: 'Income',
  EQUITY: 'Owners Equity',
  LIABILITY: 'Liabilities',
  ASSET: 'Asset',
};

/**
 * Which way an account's balance normally runs. An asset or an expense grows
 * with a debit; everything else grows with a credit — so the chart shows each
 * balance the way an accountant reads it, positive when normal.
 */
export const DEBIT_NORMAL: Record<LedgerAccountType, boolean> = {
  EXPENSE: true,
  ASSET: true,
  INCOME: false,
  EQUITY: false,
  LIABILITY: false,
};

/**
 * The predefined ledgers every voucher screen depends on. A sub ledger under
 * either is a money account: what "Payment from", "Deposit to" and "Transfer
 * From" list (sheet F17: "Asset like Bank, Cash").
 */
export const MONEY_LEDGER_KEYS = ['ASSET.BANK', 'ASSET.CASH'] as const;

/** The four Transaction screens (Menu M9–M12). */
export const JOURNAL_ENTRY_KINDS = ['JOURNAL', 'EXPENSE', 'INCOME', 'TRANSFER'] as const;
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

export const JOURNAL_ENTRY_KIND_LABEL: Record<JournalEntryKind, string> = {
  JOURNAL: 'Journal',
  EXPENSE: 'Expense',
  INCOME: 'Income',
  TRANSFER: 'Internal Transfer',
};

/**
 * Voucher number prefixes (§14.13 Q6 — CLAUDE.md §11 item 4 leaves every
 * prefix but PL-001 unspecified). The Bangladeshi voucher names: journal,
 * payment, receipt and transfer.
 */
export const JOURNAL_ENTRY_PREFIX: Record<JournalEntryKind, string> = {
  JOURNAL: 'JV',
  EXPENSE: 'PV',
  INCOME: 'RV',
  TRANSFER: 'TV',
};

/** Each screen's feature key (packages/shared/src/permissions.ts). */
export const JOURNAL_ENTRY_FEATURE: Record<JournalEntryKind, string> = {
  JOURNAL: 'ACCOUNTS.JOURNAL',
  EXPENSE: 'ACCOUNTS.EXPENSE',
  INCOME: 'ACCOUNTS.INCOME',
  TRANSFER: 'ACCOUNTS.INTERNAL_TRANSFER',
};

/** §14.4: DRAFT is the Journal sheet's `Save`, POSTED its `Save & agreed`. */
export const JOURNAL_ENTRY_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type JournalEntryStatus = (typeof JOURNAL_ENTRY_STATUSES)[number];

export const JOURNAL_ENTRY_STATUS_LABEL: Record<JournalEntryStatus, string> = {
  DRAFT: 'Draft',
  POSTED: 'Posted',
  CANCELLED: 'Cancelled',
};

/**
 * What a voucher settles, when it pays or banks against a party (§14.6):
 * one of the party's invoices, or the opening balance CRM holds for them.
 */
export const SETTLEMENT_AGAINST = ['INVOICE', 'OPENING'] as const;
export type SettlementAgainst = (typeof SETTLEMENT_AGAINST)[number];

/** "Pay to : ( Vendor / Carrier / Agent )" — sheet `Expense-Vendor` F9. */
export const PAY_TO_PARTY_TYPES = ['VENDOR', 'CARRIER', 'AGENT'] as const satisfies readonly LedgerPartyType[];
/** "Income From : ( Customer )" — sheet `Income` F9. */
export const INCOME_FROM_PARTY_TYPES = ['CUSTOMER'] as const satisfies readonly LedgerPartyType[];

/** Credit invoice payment status, in the payer's words ("Partial Paid | Full Paid"). */
export const SUPPLIER_PAYMENT_STATUS_LABEL = {
  UNPAID: 'Unpaid',
  PARTIAL: 'Partially paid',
  PAID: 'Paid',
} as const;

// ------------------------------------------------------------------ fields

const idString = (message: string) => z.string().trim().regex(/^\d+$/, message);
const optionalId = z
  .string()
  .trim()
  .regex(/^\d*$/, 'Choose one from the list.')
  .nullish()
  .transform((v) => (v === '' || v === undefined ? null : v));

/** §4 rule 6: money travels as a string, never a float. */
const money = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use digits, up to four decimal places.');
const positiveMoney = money.refine((v) => Number(v) > 0, 'Enter an amount greater than zero.');
/** A Journal cell left blank is zero. */
const moneyOrBlank = z
  .string()
  .trim()
  .regex(/^(\d{1,14}(\.\d{1,4})?)?$/, 'Use digits, up to four decimal places.')
  .transform((v) => (v === '' ? '0' : v));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');
const description = z
  .string()
  .trim()
  .max(2000, 'That description is too long.')
  .nullish()
  .transform((v) => (v === undefined || v === null || v === '' ? null : v));
const name = (what: string) =>
  z.string().trim().min(1, `Enter the ${what}.`).max(200, `That ${what} is too long.`);
const optionalText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `That ${what} is too long.`)
    .nullish()
    .transform((v) => (v === undefined || v === null || v === '' ? null : v));

// ------------------------------------------------------ Chart of accounts

/**
 * "+ ADD new" (sheet F10, L10, …): a Sub Ledger under a Ledger. With no
 * parent it is a new Ledger under a head — the sheet's "++" (C9).
 */
export const ledgerAccountCreateSchema = z.object({
  accountType: z.enum(LEDGER_ACCOUNT_TYPES),
  parentId: optionalId,
  name: name('account name'),
});
export type LedgerAccountCreateInput = z.input<typeof ledgerAccountCreateSchema>;

export const ledgerAccountRenameSchema = z.object({ name: name('account name') });
export type LedgerAccountRenameInput = z.input<typeof ledgerAccountRenameSchema>;

// ---------------------------------------------------- Bank / Account set up

/** Sheet `bank setup` C5–C10. */
export const bankInputSchema = z.object({
  bankName: name('bank name'),
  branch: name('branch'),
  bankAddress: optionalText(1000, 'address'),
  swiftNo: optionalText(20, 'SWIFT number'),
  routingNo: optionalText(20, 'routing number'),
  ibanNo: optionalText(40, 'IBAN'),
});
export type BankInput = z.input<typeof bankInputSchema>;

/**
 * Sheet `Account setup` C5–C8. Bank Address, Swift No, Routing number and IBAN
 * No (C9–C12) are the chosen branch's, shown from it, not typed again.
 */
export const bankAccountInputSchema = z.object({
  accountName: name('account name'),
  accountNo: z
    .string()
    .trim()
    .min(1, 'Enter the account number.')
    .max(50, 'That account number is too long.'),
  bankId: idString('Choose the bank and branch.'),
});
export type BankAccountInput = z.input<typeof bankAccountInputSchema>;

export const BANK_SORT_FIELDS = ['bankName', 'code'] as const;
export const bankListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(BANK_SORT_FIELDS).default('bankName'),
});

export const BANK_ACCOUNT_SORT_FIELDS = ['accountName', 'code'] as const;
export const bankAccountListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(BANK_ACCOUNT_SORT_FIELDS).default('accountName'),
});

// ------------------------------------------------------------- vouchers

/** One row of an Expense / Income category grid, or a Transfer To row. */
export const voucherLineSchema = z.object({
  ledgerAccountId: idString('Choose an account.'),
  amount: positiveMoney,
});

/** One row of the Journal sheet's Account / Debit / Credit grid (row 19). */
export const journalLineSchema = z
  .object({
    ledgerAccountId: idString('Choose an account.'),
    debit: moneyOrBlank,
    credit: moneyOrBlank,
  })
  .superRefine((line, ctx) => {
    const d = Number(line.debit);
    const c = Number(line.credit);
    if ((d > 0) === (c > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['debit'],
        message: 'Put the amount in Debit or in Credit — one of the two.',
      });
    }
  });

/**
 * What a voucher pays or banks against (§14.6): "Select Invoice No" on the
 * Expense-Vendor and Income sheets, or the party's CRM opening balance.
 *
 * `amount` is in the document's own currency — what comes off the invoice.
 * The voucher's own figures are in the base: what left or reached the bank.
 */
export const settlementSchema = z
  .object({
    partyType: z.enum(LEDGER_PARTY_TYPES),
    partyId: idString('Choose who this is.'),
    against: z.enum(SETTLEMENT_AGAINST),
    /** The debit invoice (Income) or credit invoice (Expense). */
    documentId: optionalId,
    amount: positiveMoney,
  })
  .superRefine((s, ctx) => {
    if (s.against === 'INVOICE' && s.documentId === null) {
      ctx.addIssue({ code: 'custom', path: ['documentId'], message: 'Choose the invoice.' });
    }
  });
export type SettlementInput = z.input<typeof settlementSchema>;

const voucherBase = {
  entryDate: isoDate,
  description,
};

/**
 * Save on each of the four screens. The shapes differ because the sheets do:
 *
 *   JOURNAL   free Account / Debit / Credit rows; `post` is "Save & agreed"
 *   EXPENSE   Payment from (credit) and Expense Category rows (debit)
 *   INCOME    Deposit to (debit) and Income Category rows (credit)
 *   TRANSFER  Transfer From (credit) and the accounts it went to (debit)
 *
 * `amount` is the one figure the money account moves, in the base. The sheets'
 * Debit Amount / Credit Amount / Difference is the check that the rows add up
 * to it — refused unless the difference is nil.
 */
export const journalEntryInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('JOURNAL'),
    ...voucherBase,
    post: z.boolean().default(false),
    lines: z
      .array(journalLineSchema)
      .min(2, 'A journal needs at least one debit and one credit.')
      .max(100, 'That is too many lines for one journal.'),
  }),
  z.object({
    kind: z.literal('EXPENSE'),
    ...voucherBase,
    moneyAccountId: idString('Choose the bank or cash account it was paid from.'),
    amount: positiveMoney,
    lines: z
      .array(voucherLineSchema)
      .min(1, 'Add at least one expense category.')
      .max(100, 'That is too many lines.'),
    settlement: settlementSchema.nullish(),
  }),
  z.object({
    kind: z.literal('INCOME'),
    ...voucherBase,
    moneyAccountId: idString('Choose the bank or cash account it was deposited to.'),
    amount: positiveMoney,
    lines: z
      .array(voucherLineSchema)
      .min(1, 'Add at least one income category.')
      .max(100, 'That is too many lines.'),
    settlement: settlementSchema.nullish(),
  }),
  z.object({
    kind: z.literal('TRANSFER'),
    ...voucherBase,
    moneyAccountId: idString('Choose the account it was transferred from.'),
    amount: positiveMoney,
    lines: z
      .array(voucherLineSchema)
      .min(1, 'Choose the account it was transferred to.')
      .max(20, 'That is too many lines.'),
  }),
]);
export type JournalEntryInput = z.input<typeof journalEntryInputSchema>;
export type JournalEntryData = z.output<typeof journalEntryInputSchema>;

export const journalEntryCancelSchema = z.object({
  reason: z.string().trim().min(1, 'Say why this voucher is being cancelled.').max(2000, 'That reason is too long.'),
});

export const JOURNAL_ENTRY_SORT_FIELDS = ['code', 'entryDate', 'amount'] as const;
export const journalEntryListQuerySchema = listQuerySchema.extend({
  kind: z.enum(JOURNAL_ENTRY_KINDS),
  status: z.enum(JOURNAL_ENTRY_STATUSES).optional(),
  sortBy: z.enum(JOURNAL_ENTRY_SORT_FIELDS).optional(),
});

/** "Select Invoice No": what a party still owes, or is owed. */
export const openDocumentsQuerySchema = z.object({
  partyType: z.enum(LEDGER_PARTY_TYPES),
  partyId: idString('Choose who this is.'),
});

// ------------------------------------------------------ Credit Invoice list

export const CREDIT_INVOICE_PAYMENT_FILTERS = ['UNPAID', 'PARTIAL', 'PAID'] as const;
export const creditInvoiceListQuerySchema = listQuerySchema.extend({
  partyType: z.enum(PAY_TO_PARTY_TYPES).optional(),
  payment: z.enum(CREDIT_INVOICE_PAYMENT_FILTERS).optional(),
  sortBy: z.enum(['date', 'amount']).optional(),
});

// ------------------------------------------------------------------- DTOs

export interface LedgerAccountDto {
  id: string;
  code: string;
  accountType: LedgerAccountType;
  parentId: string | null;
  name: string;
  systemKey: string | null;
  isActive: boolean;
  /**
   * The Sub Ledger an Account setup row posts through. Named and switched
   * off from there, never from the chart, so the two cannot disagree.
   */
  bankAccountId: string | null;
  /** Posted vouchers only, in the base, positive when the balance is normal. */
  balance: string;
  /** A voucher may post here: a sub ledger, or a ledger with none under it. */
  postable: boolean;
}

export interface ChartLedgerDto extends LedgerAccountDto {
  subLedgers: LedgerAccountDto[];
}

export interface ChartDto {
  baseCurrencyCode: string | null;
  heads: { accountType: LedgerAccountType; label: string; ledgers: ChartLedgerDto[] }[];
}

export interface BankDto {
  id: string;
  code: string;
  bankName: string;
  branch: string;
  bankAddress: string | null;
  swiftNo: string | null;
  routingNo: string | null;
  ibanNo: string | null;
  isActive: boolean;
}

export interface BankAccountDto {
  id: string;
  code: string;
  accountName: string;
  accountNo: string;
  bankId: string;
  bankName: string;
  branch: string;
  bankAddress: string | null;
  swiftNo: string | null;
  routingNo: string | null;
  ibanNo: string | null;
  ledgerAccountId: string;
  /** "Bank Asia Plc-878" — its Sub Ledger's name on the chart. */
  ledgerName: string;
  balance: string;
  isActive: boolean;
}

/** An account as a picker offers it: "Cost of Service › Sea Freight-FCL". */
export interface AccountOptionDto {
  id: string;
  code: string;
  label: string;
  accountType: LedgerAccountType;
  systemKey: string | null;
  isMoney: boolean;
  /** Money accounts only: what it holds now, so nobody pays from an empty bank. */
  balance: string | null;
}

export interface PartyOptionDto {
  id: string;
  label: string;
}

export interface JournalEntryOptionsDto {
  baseCurrencyCode: string | null;
  moneyAccounts: AccountOptionDto[];
  /** Every active account a voucher may post to. */
  accounts: AccountOptionDto[];
  customers: PartyOptionDto[];
  vendors: PartyOptionDto[];
  carriers: PartyOptionDto[];
  agents: PartyOptionDto[];
}

/** The service a document was for, to pre-select its category (§14.5). */
export const SERVICE_KEYS = ['SEA_FCL', 'SEA_LCL', 'AIR'] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

/** One entry of the "Select Invoice No" list. */
export interface OpenDocumentDto {
  against: SettlementAgainst;
  /** The debit invoice or credit invoice; null for the opening balance. */
  documentId: string | null;
  reference: string;
  date: string;
  description: string;
  currencyCode: string;
  total: string;
  outstanding: string;
  /**
   * The document's own rate (base per unit), to suggest what the bank moved;
   * the voucher records the bank's actual figure. Null when no rate is on file.
   */
  conversionRate: string | null;
  /** In the workspace base: then the settled and banked figures are one. */
  isBaseCurrency: boolean;
  /** For "( View invoice )". */
  debitInvoiceId: string | null;
  serviceKey: ServiceKey | null;
}

/** Whose invoice a `Receive` or `Make Payment` link names. */
export interface DocumentPartyDto {
  partyType: LedgerPartyType;
  partyId: string;
  partyName: string;
}

export const documentPartyQuerySchema = z
  .object({ debitInvoice: optionalId, creditInvoice: optionalId })
  .refine((q) => (q.debitInvoice === null) !== (q.creditInvoice === null), 'Name one invoice.');

export interface JournalLineDto {
  id: string;
  ledgerAccountId: string;
  accountCode: string;
  accountLabel: string;
  debit: string;
  credit: string;
}

export interface JournalSettlementDto {
  against: SettlementAgainst;
  reference: string;
  currencyCode: string;
  amount: string;
  debitInvoiceId: string | null;
}

export interface JournalEntryDto {
  id: string;
  code: string;
  kind: JournalEntryKind;
  status: JournalEntryStatus;
  entryDate: string;
  description: string | null;
  attachmentFileName: string | null;
  party: { type: LedgerPartyType; id: string; name: string } | null;
  settlement: JournalSettlementDto | null;
  lines: JournalLineDto[];
  totalAmount: string;
  baseCurrencyCode: string | null;
  postedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** Decided by the server, so the screen cannot drift from the rule. */
  editable: boolean;
  cancellable: boolean;
}

export interface JournalEntryListRow {
  id: string;
  code: string;
  kind: JournalEntryKind;
  status: JournalEntryStatus;
  entryDate: string;
  description: string | null;
  partyName: string | null;
  /** "Bank Asia Plc-878 → Office Rent, Internet Bill". */
  accounts: string;
  settledReference: string | null;
  totalAmount: string;
}

/** One row of the Credit Invoice list (sheet `Credit Invoice` row 7). */
export interface CreditInvoiceRow {
  /** The cost block's id — what Make Payment settles. */
  id: string;
  debitInvoiceId: string;
  debitInvoiceCode: string;
  bookingCode: string | null;
  date: string;
  /** "Vendor/Agent/Carrier Inv No"; ours until theirs is entered. */
  supplierInvoiceNo: string | null;
  partyType: (typeof PAY_TO_PARTY_TYPES)[number];
  partyId: string;
  partyName: string;
  description: string;
  currencyCode: string;
  amount: string;
  conversionRate: string;
  amountBase: string;
  paidAmount: string;
  outstandingAmount: string;
  paymentStatus: keyof typeof SUPPLIER_PAYMENT_STATUS_LABEL;
  /** Removable: nothing has been paid against it. */
  deletable: boolean;
}
