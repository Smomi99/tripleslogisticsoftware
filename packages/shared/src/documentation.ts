import { z } from 'zod';

import { TRANSIT_TYPES } from './quotation';

/**
 * Documentation — Shipment Advise and BL Draft (docs/MODULE_DOCUMENTATION.md).
 *
 * Transcribed from the client's `Design (6).xlsx` sheets `Shipment Advise.-Sea`,
 * `Shipment Advise-Air`, `BL Draft-outbound` and `BL Draft-outbound-Customer`.
 * Every field here is a cell on one of those sheets; anything that was not is
 * an open question in §12 of the spec, not a column.
 */

// ------------------------------------------------------------ shipment advise

export const ADVISE_STATUSES = ['DRAFT', 'SENT', 'CANCELLED'] as const;
export type AdviseStatus = (typeof ADVISE_STATUSES)[number];

export const ADVISE_STATUS_LABEL: Record<AdviseStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  CANCELLED: 'Cancelled',
};

/** Direct / Indirect (B13 on both sheets) — the quotation's list, reused. */
export type TransitTypeValue = (typeof TRANSIT_TYPES)[number];

/**
 * One row of the PO grid (row 17 of both sheets).
 *
 * A snapshot: these values were copied from the CLP and the cargo receipts when
 * the advise was built, not joined at read time (§3.2).
 */
export interface ShipmentAdviseLineDto {
  id: string;
  poNo: string;
  itemCode: string;
  sku: string | null;
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: string | null;
  grossWeightKg: string | null;
  cartonLengthCm: string | null;
  cartonWidthCm: string | null;
  cartonHeightCm: string | null;
  volumeCbm: string | null;
  /** Air only — the M17 column the air sheet adds. */
  chargeableWtKg: string | null;
  cargoReceiptDate: string | null;
  stuffingDate: string | null;
  efrNo: string | null;
  /** Which container these cartons went into. Null on air (§3.7). */
  clpCode: string | null;
  containerNo: string | null;
}

/** Row 21 of the sheet — the totals line. */
export interface ShipmentAdviseTotalsDto {
  poCount: number;
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: string | null;
  grossWeightKg: string | null;
  volumeCbm: string | null;
  chargeableWtKg: string | null;
}

export interface ShipmentAdviseDto {
  id: string;
  code: string;
  status: AdviseStatus;
  shipmentId: string;
  bookingNo: string;
  shipmentType: 'SEA' | 'AIR';
  customerName: string;
  exporterName: string | null;
  /** Sea: the carrier. Air: the airline. One field, two words (§4). */
  carrierId: string;
  carrierName: string;
  transitType: TransitTypeValue;
  firstVesselId: string | null;
  firstVesselName: string | null;
  voyageNo: string | null;
  firstFlightNo: string | null;
  polId: string;
  polName: string;
  podId: string;
  podName: string;
  etd: string | null;
  eta: string | null;
  /** Air only (§3.7). */
  stuffingDate: string | null;
  houseBlNo: string;
  mblNo: string | null;
  sentAt: string | null;
  sentByName: string | null;
  cancelReason: string | null;
  lines: ShipmentAdviseLineDto[];
  totals: ShipmentAdviseTotalsDto;
  /** The customer's contacts, prefilled into the send form (sheet B24). */
  recipients: { name: string | null; email: string }[];
}

/**
 * What the screen offers before an advise exists — the pulled document, not yet
 * saved. Same shape as the real thing so the form is written once.
 */
export interface ShipmentAdvisePrefillDto
  extends Omit<ShipmentAdviseDto, 'id' | 'code' | 'status' | 'houseBlNo' | 'sentAt' | 'sentByName' | 'cancelReason'> {
  /** Why it cannot be created yet, when it cannot. */
  blockedReason: string | null;
}

const optionalText = (max: number, message = 'That is too long.') =>
  z.string().trim().max(max, message).nullish();

const idString = z.string().regex(/^\d+$/, 'Pick one from the list.');

/**
 * The header a user may change (B12–B14), and nothing else.
 *
 * The PO grid is never submitted: it is pulled from the CLP by the build step,
 * and letting a client post it would make the document say whatever the browser
 * decided it said.
 */
export const shipmentAdviseHeaderSchema = z.object({
  carrierId: idString,
  transitType: z.enum(TRANSIT_TYPES),
  firstVesselId: idString.nullish(),
  voyageNo: optionalText(200),
  firstFlightNo: optionalText(200),
  polId: idString,
  podId: idString,
  /** ISO datetimes. The sea screen shows the date half, air shows both (§2.2). */
  etd: z.string().datetime({ offset: true }).nullish(),
  eta: z.string().datetime({ offset: true }).nullish(),
  stuffingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date.')
    .nullish(),
  mblNo: optionalText(64),
});

export type ShipmentAdviseHeaderInput = z.infer<typeof shipmentAdviseHeaderSchema>;

const emailList = z
  .array(
    z.object({
      email: z.string().trim().toLowerCase().email('Check this email address.'),
      name: optionalText(200),
    }),
  )
  .min(1, 'Add at least one recipient.')
  .max(50, 'That is too many recipients.');

/** B26's `Save & Send`. The subject is B29's, filled in by the API. */
export const shipmentAdviseSendSchema = z.object({
  to: emailList,
  cc: z
    .array(
      z.object({
        email: z.string().trim().toLowerCase().email('Check this email address.'),
        name: optionalText(200),
      }),
    )
    .max(50, 'That is too many recipients.')
    .optional(),
  note: optionalText(4000),
});

export type ShipmentAdviseSendInput = z.infer<typeof shipmentAdviseSendSchema>;

export const shipmentAdviseCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why this advise is being cancelled. The customer has already seen it.')
    .max(2000, 'That reason is too long.'),
});

export type ShipmentAdviseCancelInput = z.infer<typeof shipmentAdviseCancelSchema>;

// ------------------------------------------------------------------ BL draft

export const BL_DRAFT_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'SENT', 'CANCELLED'] as const;
export type BlDraftStatus = (typeof BL_DRAFT_STATUSES)[number];

export const BL_DRAFT_STATUS_LABEL: Record<BlDraftStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted by customer',
  APPROVED: 'Approved',
  SENT: 'Sent',
  CANCELLED: 'Cancelled',
};

export const BL_DRAFT_ORIGINS = ['STAFF', 'CUSTOMER'] as const;
export type BlDraftOrigin = (typeof BL_DRAFT_ORIGINS)[number];

/** The B40 block — one row per container, pulled from the booking's CLPs. */
export interface BlDraftContainerDto {
  id: string;
  containerNo: string | null;
  containerSize: string | null;
  sealNo: string | null;
  ctnQty: number | null;
  grossWeightKg: string | null;
  measurementCbm: string | null;
}

export interface BlDraftDto {
  id: string;
  code: string;
  status: BlDraftStatus;
  origin: BlDraftOrigin;
  shipmentId: string;
  bookingNo: string;
  customerName: string;
  blNo: string;
  mblNo: string | null;
  manifestNo: string | null;

  shipperText: string;
  consigneeText: string;
  notifyText: string;
  alsoNotifyText: string | null;

  exportReferences: string | null;
  forwardingAgentReferences: string | null;
  pointCountryOfOrigin: string | null;

  preCarriageByModeId: string;
  preCarriageByModeName: string;
  placeOfReceipt: string;

  deliveryAgentId: string | null;
  deliveryAgentName: string | null;
  deliveryAgentText: string | null;

  oceanVesselVoyage: string | null;
  polId: string;
  polName: string;
  podId: string;
  podName: string;
  placeOfDelivery: string | null;

  packagesDescription: string | null;
  marksAndNumbers: string | null;
  grossWeightKg: string | null;
  measurementCbm: string | null;

  freightPayableAt: string | null;
  originalBlCount: number | null;
  ladenOnBoardDate: string | null;

  submittedAt: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  /** §13: set by BL Print. Kept on a cancelled draft — a voided issue is history. */
  issuedAt: string | null;
  cancelReason: string | null;

  containers: BlDraftContainerDto[];
  recipients: { name: string | null; email: string }[];
}

export interface BlDraftPrefillDto
  extends Omit<
    BlDraftDto,
    | 'id'
    | 'code'
    | 'status'
    | 'origin'
    | 'submittedAt'
    | 'approvedAt'
    | 'sentAt'
    | 'issuedAt'
    | 'cancelReason'
  > {
  blockedReason: string | null;
}

/**
 * The BL form (§2.3).
 *
 * The party blocks are required and free text: a bill of lading without a
 * shipper, a consignee and a notify party is not a bill of lading. B34 and F34
 * are starred on the client's sheet, so `preCarriageByModeId` and
 * `placeOfReceipt` are required too.
 *
 * `blNo` is absent on purpose — it comes from the advise (§3.3) and is not the
 * form's to set.
 */
export const blDraftInputSchema = z.object({
  manifestNo: optionalText(64),

  shipperText: z.string().trim().min(1, 'The shipper block is required.').max(2000, 'That is too long.'),
  consigneeText: z.string().trim().min(1, 'The consignee block is required.').max(2000, 'That is too long.'),
  notifyText: z.string().trim().min(1, 'The notify party block is required.').max(2000, 'That is too long.'),
  alsoNotifyText: optionalText(2000),

  exportReferences: optionalText(2000),
  forwardingAgentReferences: optionalText(2000),
  pointCountryOfOrigin: optionalText(500),

  preCarriageByModeId: idString,
  placeOfReceipt: z.string().trim().min(1, 'Place of receipt is required.').max(500, 'That is too long.'),

  deliveryAgentId: idString.nullish(),
  deliveryAgentText: optionalText(2000),

  oceanVesselVoyage: optionalText(500),
  polId: idString,
  podId: idString,
  placeOfDelivery: optionalText(500),

  packagesDescription: optionalText(8000),
  marksAndNumbers: optionalText(8000),
  grossWeightKg: z.number().nonnegative('Weight cannot be negative.').nullish(),
  measurementCbm: z.number().nonnegative('Measurement cannot be negative.').nullish(),

  freightPayableAt: optionalText(500),
  originalBlCount: z.number().int().min(0, 'That cannot be negative.').max(99, 'That is too many.').nullish(),
  ladenOnBoardDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date.')
    .nullish(),
});

export type BlDraftInput = z.infer<typeof blDraftInputSchema>;

export const blDraftSendSchema = shipmentAdviseSendSchema;
export type BlDraftSendInput = ShipmentAdviseSendInput;

export const blDraftCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why this draft is being cancelled.')
    .max(2000, 'That reason is too long.'),
});

export type BlDraftCancelInput = z.infer<typeof blDraftCancelSchema>;

// ------------------------------------------------------------------ BL print

/**
 * BL Print (Menu K7) — docs/MODULE_DOCUMENTATION.md §13.
 *
 * ORIGINAL prints one page per original (D56's "No. of Original BL"), each
 * marked with its number; COPY prints one page marked non-negotiable. Only an
 * issued bill prints originals (§13.3 rule 4).
 */
export const BL_PRINT_KINDS = ['ORIGINAL', 'COPY'] as const;
export type BlPrintKind = (typeof BL_PRINT_KINDS)[number];

export const blPrintQuerySchema = z.object({
  kind: z.enum(BL_PRINT_KINDS).default('ORIGINAL'),
});

/**
 * `Issue BL`.
 *
 * The number of originals is the approved draft's. It is asked for here only
 * when the draft left D56 empty: the approved draft is frozen, and a bill has
 * to say how many originals were issued. It cannot be changed here when the
 * draft already has one — that is a correction to the bill, which is cancel
 * and redraft (§5 rule 3).
 */
export const blIssueSchema = z.object({
  originalBlCount: z
    .number()
    .int('Use a whole number.')
    .min(0, 'That cannot be negative.')
    .max(99, 'That is too many.')
    .nullish(),
});

export type BlIssueInput = z.infer<typeof blIssueSchema>;

/** What BL Print shows about a booking's bill, and what `Issue BL` confirms. */
export interface BlPrintDto {
  shipmentId: string;
  bookingNo: string;
  customerName: string;
  draftId: string;
  draftCode: string;
  draftStatus: BlDraftStatus;
  blNo: string;
  mblNo: string | null;
  polName: string;
  podName: string;
  originalBlCount: number | null;
  ladenOnBoardDate: string | null;
  approvedAt: string | null;
  issuedAt: string | null;
  issuedByName: string | null;
}

// ----------------------------------------------------------------- templates

export interface BlTemplateDto {
  id: string;
  code: string;
  name: string;
  customerId: string | null;
  customerName: string | null;
  shipperText: string | null;
  consigneeText: string | null;
  notifyText: string | null;
  alsoNotifyText: string | null;
  freightPayableAt: string | null;
  originalBlCount: number | null;
  deliveryAgentId: string | null;
  deliveryAgentName: string | null;
  isActive: boolean;
}

/** `Make Templet` (§3.5) — saved from whatever is on the form. */
export const blTemplateInputSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name.').max(200, 'That name is too long.'),
  /** Null keeps it available on every customer's draft. */
  customerId: idString.nullish(),
  shipperText: optionalText(2000),
  consigneeText: optionalText(2000),
  notifyText: optionalText(2000),
  alsoNotifyText: optionalText(2000),
  freightPayableAt: optionalText(500),
  originalBlCount: z.number().int().min(0).max(99).nullish(),
  deliveryAgentId: idString.nullish(),
});

export type BlTemplateInput = z.infer<typeof blTemplateInputSchema>;
