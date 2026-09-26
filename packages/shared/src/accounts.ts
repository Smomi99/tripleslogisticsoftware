import { z } from 'zod';

import { listQuerySchema } from './api';
import { SHIPMENT_TYPES, type ShipmentType } from './inquiry';
import type { ShipmentStatus } from './shipment';

/**
 * Accounts — Awaiting Freight Inv, Debit Invoice, Receivable-Payable list
 * (docs/MODULE_ACCOUNTS.md).
 *
 * Transcribed from the client's `Design.xlsx` sheets `Awaiting Debit Note`,
 * `Debit note (Other)`, `Receiveable-Payable list` and `Ledger.`. Every field
 * is a cell on one of them; what no sheet answers is an open question in §12
 * of the spec, with the default used here named there.
 */

// ------------------------------------------------------------------- enums

/** §3.2: FREIGHT is made from a booking; OTHER is `Create New`. */
export const DEBIT_INVOICE_KINDS = ['FREIGHT', 'OTHER'] as const;
export type DebitInvoiceKind = (typeof DEBIT_INVOICE_KINDS)[number];

export const DEBIT_INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'CANCELLED'] as const;
export type DebitInvoiceStatus = (typeof DEBIT_INVOICE_STATUSES)[number];

/** Derived from the receipts, never stored (§3.7). */
export const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  UNPAID: 'Unpaid',
  // The Ledger sheet's "Partial Paid", in the product's voice.
  PARTIAL: 'Partially received',
  PAID: 'Received',
};

/**
 * What the Debit Invoice list's Status column says (sheet M7): the document's
 * state and its money folded into one word, because a reader scanning for who
 * still owes wants one column, not two.
 */
export const DEBIT_INVOICE_DISPLAY_STATUSES = [
  'DRAFT',
  'UNPAID',
  'PARTIAL',
  'PAID',
  'CANCELLED',
] as const;
export type DebitInvoiceDisplayStatus = (typeof DEBIT_INVOICE_DISPLAY_STATUSES)[number];

export const DEBIT_INVOICE_DISPLAY_STATUS_LABEL: Record<DebitInvoiceDisplayStatus, string> = {
  DRAFT: 'Draft',
  UNPAID: 'Unpaid',
  PARTIAL: 'Partially received',
  PAID: 'Received',
  CANCELLED: 'Cancelled',
};

export function debitInvoiceDisplayStatus(
  status: DebitInvoiceStatus,
  payment: PaymentStatus,
): DebitInvoiceDisplayStatus {
  if (status === 'DRAFT') return 'DRAFT';
  if (status === 'CANCELLED') return 'CANCELLED';
  return payment;
}

/** Which supplier a "Buying from …" block is owed to (sheet B21, B30, B38). */
export const SUPPLIER_PARTY_TYPES = ['CARRIER', 'AGENT', 'VENDOR'] as const;
export type SupplierPartyType = (typeof SUPPLIER_PARTY_TYPES)[number];

export const SUPPLIER_PARTY_LABEL: Record<SupplierPartyType, string> = {
  CARRIER: 'Carrier',
  AGENT: 'Agent',
  VENDOR: 'Vendor',
};

export const INVOICE_LINE_SOURCES = ['QUOTATION', 'LOAD_PLAN', 'MANUAL'] as const;
export type InvoiceLineSource = (typeof INVOICE_LINE_SOURCES)[number];

/**
 * Everyone the Receivable-Payable list can name. The sheet heads the column
 * "Agent / Carrier / Vendor name"; customers are listed too, because the
 * invoice creates their receivable (sheet K17) — §12 Q3.
 */
export const LEDGER_PARTY_TYPES = ['CUSTOMER', 'AGENT', 'CARRIER', 'VENDOR'] as const;
export type LedgerPartyType = (typeof LEDGER_PARTY_TYPES)[number];

export const LEDGER_PARTY_LABEL: Record<LedgerPartyType, string> = {
  CUSTOMER: 'Customer',
  AGENT: 'Agent',
  CARRIER: 'Carrier',
  VENDOR: 'Vendor',
};

// ------------------------------------------------ the awaiting list's scope

/**
 * §3.1: a booking waits for its debit note from the moment it is confirmed.
 * Not yet confirmed, rejected and cancelled bookings never do.
 */
export const INVOICEABLE_SHIPMENT_STATUSES = [
  'APPROVED_FOR_SHIPMENT',
  'SO_ISSUED',
  'SO_SKIPPED',
  'PART_RECEIVED',
  'CARGO_RECEIVED',
  'ADVISED',
  'BL_DRAFTED',
  'BL_ISSUED',
  'SHORT_CLOSED',
] as const satisfies readonly ShipmentStatus[];

/**
 * The stages at which the chain in Menu F22 has reached its end: the advise
 * has gone to the customer, the BL has been drafted, or it has been issued —
 * F22's own last step before the Debit Note. A filter, not a gate — an
 * accountant may bill a prepaid job earlier (§12 Q1).
 */
export const READY_TO_INVOICE_STATUSES = [
  'ADVISED',
  'BL_DRAFTED',
  'BL_ISSUED',
] as const satisfies readonly ShipmentStatus[];

export const AWAITING_STAGES = ['READY', 'EARLIER'] as const;
export type AwaitingStage = (typeof AWAITING_STAGES)[number];

export const AWAITING_STAGE_LABEL: Record<AwaitingStage, string> = {
  READY: 'Advised, BL drafted or issued',
  EARLIER: 'Earlier stages',
};

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

const quantity = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,3})?$/, 'Use digits, up to three decimal places.');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');

/**
 * A conversion rate: base units per 1 unit (lib/currency-rate). NUMERIC(18,10),
 * so eight integer digits and ten decimals — the same limits Settings →
 * Currency enforces.
 */
const rate = z
  .string()
  .trim()
  .regex(/^\d{1,8}(\.\d{1,10})?$/, 'Enter a rate with up to 8 digits and 10 decimal places.')
  .refine((value) => Number(value) > 0, 'The rate must be greater than zero.');

const email = z.string().trim().toLowerCase().email('Check this email address.');

// ------------------------------------------------------------- the inputs

/** One row of a Selling Price or Buying grid (sheet rows 23, 32, 40, 52). */
export const invoiceLineInputSchema = z.object({
  costHeadId: idString('Choose a cost head.'),
  containerSizeId: optionalId,
  costUnitId: optionalId,
  quantity,
  /** Selling price on the Selling Price grid, buying price on a cost block. */
  unitPrice: money,
  source: z.enum(INVOICE_LINE_SOURCES).default('MANUAL'),
});
export type InvoiceLineInput = z.input<typeof invoiceLineInputSchema>;

/**
 * One "Buying from Carrier / Agent / Vendor" block.
 *
 * `id` names a block that already exists, so its uploaded invoice file is kept
 * rather than orphaned when the grid is saved again.
 */
export const invoiceCostInputSchema = z
  .object({
    id: optionalId,
    partyType: z.enum(SUPPLIER_PARTY_TYPES),
    /** '' until somebody chooses one from the block's combo box. */
    partyId: optionalId,
    supplierInvoiceNo: z.string().trim().max(100, 'That invoice number is too long.').nullish(),
    currencyId: idString('Choose the currency this supplier billed in.'),
    conversionRate: rate,
    lines: z.array(invoiceLineInputSchema).max(200, 'That is too many lines for one block.'),
  })
  .superRefine((block, ctx) => {
    // §5 rule 3: a cost owed to nobody cannot be posted to a ledger.
    const used =
      block.lines.length > 0 || (block.supplierInvoiceNo ?? '').trim() !== '' || block.id !== null;
    if (used && block.partyId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['partyId'],
        message: `Choose the ${SUPPLIER_PARTY_LABEL[block.partyType].toLowerCase()} this cost is owed to.`,
      });
    }
  });
export type InvoiceCostInput = z.input<typeof invoiceCostInputSchema>;

/**
 * Everything `Draft` and `Save & Send` save.
 *
 * `costs` absent means "leave the cost side as it is" — what a caller without
 * VIEW_BUY_PRICE sends, and must never be read as "delete every cost" (§3.9).
 */
export const debitInvoiceSaveSchema = z.object({
  invoiceDate: isoDate,
  /** Required for an OTHER invoice; a FREIGHT invoice takes the booking's. */
  customerId: optionalId,
  /** An OTHER invoice may name a booking for reference (§3.2). */
  shipmentId: optionalId,
  currencyId: idString('Choose the currency this invoice is in.'),
  conversionRate: rate,
  lines: z.array(invoiceLineInputSchema).max(200, 'That is too many lines for one invoice.'),
  costs: z.array(invoiceCostInputSchema).max(20, 'That is too many cost blocks.').optional(),
  recipientEmails: z.array(email).max(20, 'That is too many addresses.').default([]),
});
export type DebitInvoiceSaveInput = z.input<typeof debitInvoiceSaveSchema>;

/**
 * The cost side alone — §3.7: once money is received the sell side is fixed,
 * but a carrier's invoice that arrives later still has to be recorded.
 */
export const debitInvoiceCostsSaveSchema = z.object({
  costs: z.array(invoiceCostInputSchema).max(20, 'That is too many cost blocks.'),
});

/** `Save & Send` (sheet C64). Needs somebody to send it to (§5 rule 2). */
export const debitInvoiceSendSchema = z.object({
  to: z.array(email).min(1, 'Add at least one address to send it to.').max(20, 'That is too many addresses.'),
});
export type DebitInvoiceSendInput = z.input<typeof debitInvoiceSendSchema>;

/** `Cancel invoice` (sheet E64) and the list's `Cancel` (P8). */
export const debitInvoiceCancelSchema = z.object({
  reason: z.string().trim().min(1, 'Say why this invoice is being cancelled.').max(2000, 'That reason is too long.'),
});

/** `Receive` (sheet N8, rows 15–20). */
export const debitInvoiceReceiptSchema = z.object({
  paymentDate: isoDate,
  amount: money.refine((v) => Number(v) > 0, 'Enter the amount received.'),
});
export type DebitInvoiceReceiptInput = z.input<typeof debitInvoiceReceiptSchema>;

/** What the server works with once a body has been parsed. */
export type InvoiceLineData = z.output<typeof invoiceLineInputSchema>;
export type InvoiceCostData = z.output<typeof invoiceCostInputSchema>;
export type DebitInvoiceSaveData = z.output<typeof debitInvoiceSaveSchema>;

// ------------------------------------------------------------ list queries

export const AWAITING_SORT_FIELDS = ['code', 'customer', 'quotationDate'] as const;

export const awaitingFreightInvQuerySchema = listQuerySchema.extend({
  shipmentType: z.enum(SHIPMENT_TYPES).optional(),
  stage: z.enum(AWAITING_STAGES).optional(),
  sortBy: z.enum(AWAITING_SORT_FIELDS).optional(),
});

export const DEBIT_INVOICE_SORT_FIELDS = ['code', 'customer', 'invoiceDate', 'amount'] as const;

export const debitInvoiceListQuerySchema = listQuerySchema.extend({
  status: z.enum(DEBIT_INVOICE_DISPLAY_STATUSES).optional(),
  kind: z.enum(DEBIT_INVOICE_KINDS).optional(),
  sortBy: z.enum(DEBIT_INVOICE_SORT_FIELDS).optional(),
});

export const receivablePayableQuerySchema = listQuerySchema.extend({
  partyType: z.enum(LEDGER_PARTY_TYPES).optional(),
  /** Hide parties whose every column is zero. On unless asked otherwise. */
  openOnly: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(true),
});

// ------------------------------------------------------------------- DTOs

/** A subtotal in one currency, e.g. the quotation's "USD 2,121.00". */
export interface CurrencyAmountDto {
  currencyCode: string;
  amount: string;
}

/** One row of Awaiting Freight Inv (sheet row 7). */
export interface AwaitingFreightInvRow {
  shipmentId: string;
  bookingCode: string;
  bookingStatus: ShipmentStatus;
  inquiryCode: string;
  quotationId: string;
  quotationCode: string;
  quotationDate: string;
  customerName: string;
  commodity: string;
  shipmentType: ShipmentType;
  polName: string;
  polCode: string;
  podName: string;
  podCode: string;
  requiredContainer: string;
  /** L5: "Quote can see by click on the amount". One entry per currency. */
  quotedAmount: CurrencyAmountDto[];
  /** Null until somebody has saved a draft. */
  invoiceId: string | null;
  invoiceCode: string | null;
  invoiceState: 'AWAITING' | 'DRAFT';
}

export interface DebitInvoiceLineDto {
  id: string;
  source: InvoiceLineSource;
  costHeadId: string;
  costHeadName: string;
  containerSizeId: string | null;
  containerSizeName: string | null;
  costUnitId: string | null;
  unitName: string | null;
  quantity: string;
  unitPrice: string;
  /** Quantity x price, in the grid's own currency. */
  amount: string;
  /** Sheet "Total Amount (BDT)": amount x the grid's rate. */
  amountBase: string;
}

export interface DebitInvoiceCostDto {
  id: string;
  partyType: SupplierPartyType;
  partyId: string;
  partyName: string;
  supplierInvoiceNo: string | null;
  /** The uploaded file's display name, or null when nothing is uploaded. */
  supplierInvoiceFileName: string | null;
  currencyId: string;
  currencyCode: string;
  conversionRate: string;
  totalAmount: string;
  totalAmountBase: string;
  lines: DebitInvoiceLineDto[];
}

export interface DebitInvoiceReceiptDto {
  id: string;
  paymentDate: string;
  amount: string;
  amountBase: string;
  recordedAt: string;
}

/** The booking an invoice was raised against, as the invoice shows it. */
export interface DebitInvoiceBookingDto {
  shipmentId: string;
  bookingCode: string;
  bookingStatus: ShipmentStatus;
  shipmentType: ShipmentType;
  inquiryCode: string | null;
  quotationId: string | null;
  quotationCode: string | null;
  quotationDate: string | null;
  polName: string;
  polCode: string;
  podName: string;
  podCode: string;
  carrierName: string;
  commodity: string;
  requiredContainer: string;
}

export interface DebitInvoiceDto {
  id: string;
  code: string;
  kind: DebitInvoiceKind;
  status: DebitInvoiceStatus;
  paymentStatus: PaymentStatus;
  displayStatus: DebitInvoiceDisplayStatus;

  booking: DebitInvoiceBookingDto | null;
  customerId: string;
  customerName: string;

  invoiceDate: string;
  currencyId: string;
  currencyCode: string;
  conversionRate: string;
  baseCurrencyCode: string;

  lines: DebitInvoiceLineDto[];
  totalAmount: string;
  totalAmountBase: string;
  receivedAmount: string;
  outstandingAmount: string;

  /**
   * §3.9: null when the caller lacks VIEW_BUY_PRICE. Null, not an empty list,
   * so a screen cannot mistake "not shown to you" for "no costs".
   */
  costs: DebitInvoiceCostDto[] | null;
  costTotalBase: string | null;
  grossProfitBase: string | null;
  /** Null as well when there is no selling total to divide by. */
  grossProfitPercent: string | null;

  recipientEmails: string[];
  receipts: DebitInvoiceReceiptDto[];

  issuedAt: string | null;
  sentAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;

  /** §3.7, decided by the server so the screen cannot drift from the rule. */
  sellEditable: boolean;
  costEditable: boolean;
  cancellable: boolean;
}

/** One row of the Debit Invoice list (sheet `Debit note (Other)` row 7). */
export interface DebitInvoiceListRow {
  id: string;
  code: string;
  kind: DebitInvoiceKind;
  inquiryCode: string | null;
  quotationId: string | null;
  quotationCode: string | null;
  quotationDate: string | null;
  bookingCode: string | null;
  customerName: string;
  shipmentType: ShipmentType | null;
  polName: string | null;
  polCode: string | null;
  podName: string | null;
  podCode: string | null;
  invoiceDate: string;
  totalAmount: string;
  currencyCode: string;
  receivedAmount: string;
  outstandingAmount: string;
  status: DebitInvoiceStatus;
  displayStatus: DebitInvoiceDisplayStatus;
  cancellable: boolean;
}

/**
 * What `Make invoice` opens on, before anything is saved (§3.5). The same
 * shape the form saves, plus the booking's facts to read while filling it in.
 */
export interface DebitInvoicePrefillDto {
  booking: DebitInvoiceBookingDto;
  customerId: string;
  customerName: string;
  invoiceDate: string;
  currencyId: string;
  conversionRate: string;
  lines: (InvoiceLineInput & { costHeadName: string; containerSizeName: string | null; unitName: string | null })[];
  costs:
    | (Omit<InvoiceCostInput, 'lines'> & {
        partyName: string | null;
        lines: (InvoiceLineInput & {
          costHeadName: string;
          containerSizeName: string | null;
          unitName: string | null;
        })[];
      })[]
    | null;
  recipientEmails: string[];
  /** Anything the prefill could not do, said in words (e.g. mixed currencies). */
  notes: string[];
}

export interface InvoiceOptionDto {
  id: string;
  label: string;
}

export interface DebitInvoiceOptionsDto {
  baseCurrencyId: string | null;
  baseCurrencyCode: string | null;
  /** `rate` is today's workspace rate, or null where none can be resolved. */
  currencies: (InvoiceOptionDto & { code: string; rate: string | null })[];
  costHeads: (InvoiceOptionDto & { unitId: string | null; unitName: string | null })[];
  containerSizes: InvoiceOptionDto[];
  costUnits: InvoiceOptionDto[];
  carriers: InvoiceOptionDto[];
  agents: InvoiceOptionDto[];
  vendors: InvoiceOptionDto[];
  customers: InvoiceOptionDto[];
  canViewBuyPrice: boolean;
}

/** One row of the Receivable-Payable list (sheet row 8). */
export interface ReceivablePayableRow {
  partyType: LedgerPartyType;
  partyId: string;
  partyCode: string;
  partyName: string;
  /** §3.6: the US-dollar-denominated part. */
  receivableUsd: string;
  /** §3.6: everything, converted to the workspace base. */
  receivableBase: string;
  payableUsd: string;
  payableBase: string;
  /** True when an opening balance is in a currency with no rate to convert it. */
  rateMissing: boolean;
}

export interface ReceivablePayableTotals {
  receivableUsd: string;
  receivableBase: string;
  payableUsd: string;
  payableBase: string;
}

export const LEDGER_ENTRY_KINDS = ['OPENING', 'DEBIT_INVOICE', 'RECEIPT', 'SUPPLIER_INVOICE'] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

/** One row of a party's Ledger (sheet `Ledger.` row 7). */
export interface LedgerEntryDto {
  date: string;
  kind: LedgerEntryKind;
  side: 'RECEIVABLE' | 'PAYABLE';
  /** "Invoice No" — ours for a debit invoice, the supplier's for a cost. */
  reference: string;
  description: string;
  currencyCode: string;
  /** Positive raises the balance on its side; a receipt is negative. */
  amount: string;
  conversionRate: string | null;
  amountBase: string | null;
  paymentStatus: PaymentStatus | null;
  debitInvoiceId: string | null;
}

export interface LedgerDto {
  partyType: LedgerPartyType;
  partyId: string;
  partyCode: string;
  partyName: string;
  baseCurrencyCode: string | null;
  entries: LedgerEntryDto[];
  totals: ReceivablePayableTotals;
}
