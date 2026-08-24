import { z } from 'zod';

import { listQuerySchema } from './api';
import type { RateLineDto } from './freight-rate';

/**
 * Sales — inquiry (docs/MODULE_PURCHASE_SALES.md §3.3, §5.4, §5.5).
 *
 * An inquiry is one customer's request on one lane. Its status drives the
 * numbers the business is measured on, which is why §9 Q10 puts WON and LOST
 * behind their own permission rather than plain EDIT.
 */

// ------------------------------------------------------------------ vocabulary

export const SHIPMENT_TYPES = ['SEA', 'AIR'] as const;
export type ShipmentType = (typeof SHIPMENT_TYPES)[number];

export const SHIPMENT_TYPE_LABEL: Record<ShipmentType, string> = {
  SEA: 'Sea',
  AIR: 'Air',
};

export const MOVEMENT_TYPES = ['INBOUND', 'OUTBOUND'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  INBOUND: 'Inbound',
  OUTBOUND: 'Outbound',
};

export const INQUIRY_STATUSES = [
  'OPEN',
  'QUOTED',
  'WON',
  'LOST',
  'EXPIRED',
  'CANCELLED',
] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const INQUIRY_STATUS_LABEL: Record<InquiryStatus, string> = {
  OPEN: 'Open',
  QUOTED: 'Quoted',
  WON: 'Won',
  LOST: 'Lost',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

/** §5.5: "OPEN steel · QUOTED signal · WON verified · LOST/EXPIRED alert". */
export const INQUIRY_STATUS_TONE: Record<
  InquiryStatus,
  'inactive' | 'pending' | 'active' | 'overdue'
> =
  {
    OPEN: 'inactive',
    QUOTED: 'pending',
    WON: 'active',
    LOST: 'overdue',
    EXPIRED: 'overdue',
    CANCELLED: 'overdue',
  };

/** Statuses a user may set directly. EXPIRED belongs to §4 rule 11's job. */
export const SETTABLE_STATUSES = ['OPEN', 'QUOTED', 'WON', 'LOST', 'CANCELLED'] as const;
/** §9 Q10: these two need SALES.INQUIRY.SET_OUTCOME, not plain EDIT. */
export const OUTCOME_STATUSES: readonly InquiryStatus[] = ['WON', 'LOST'];

export const VOLUME_KINDS = ['FCL', 'LCL', 'AIR'] as const;
export type VolumeKind = (typeof VOLUME_KINDS)[number];

export const CONTACT_MODES = ['CALL', 'EMAIL', 'VISIT', 'WHATSAPP'] as const;
export type ContactMode = (typeof CONTACT_MODES)[number];

export const CONTACT_MODE_LABEL: Record<ContactMode, string> = {
  CALL: 'Call',
  EMAIL: 'Email',
  VISIT: 'Visit',
  WHATSAPP: 'WhatsApp',
};

// ----------------------------------------------------------------- primitives

const idField = z.string().regex(/^\d+$/, 'Choose an option.');
const optionalIdField = z.union([idField, z.literal('')]).optional();

const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.');
const optionalDateField = z
  .union([dateField, z.literal('')])
  .optional();

/** Money is NUMERIC(18,4) — four decimal places, per CLAUDE.md §4 rule 6. */
const optionalMoney = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{1,14}(\.\d{1,4})?$/.test(v), message)
    .optional();

/** Volumes and weights are NUMERIC(18,3) — three, not four. */
const optionalQuantity = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{1,14}(\.\d{1,3})?$/.test(v), message)
    .optional();

const optionalInt = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{1,6}$/.test(v), 'Enter a whole number.')
  .optional();

// --------------------------------------------------------------------- volume

/**
 * §5.4: "Volume is a small grid, not six loose inputs — rows appear based on
 * Shipment Type."
 *
 * One row per container size for Sea FCL, a single CBM row for LCL, a single KG
 * row for Air. Empty rows are dropped before submit rather than stored as zeros.
 */
/** Sea only: FCL fills containers, LCL is consolidated. */
export const LOADING_TYPES = ['FCL', 'LCL'] as const;
export type LoadingType = (typeof LOADING_TYPES)[number];

export const inquiryVolumeInputSchema = z.object({
  volumeKind: z.enum(VOLUME_KINDS),
  containerSizeId: optionalIdField,
  quantity: optionalInt,
  cbm: optionalQuantity('Enter a CBM figure.'),
  weightKg: optionalQuantity('Enter a weight in KG.'),
  /** The client's wireframe puts Target Price inside the grid, per size. */
  targetPrice: optionalMoney('Enter a target price.'),
  /** The wireframe's "Container Size :" row. Free text, by the client's choice. */
  containerSizeNote: z.string().trim().max(200, 'That is too long.').optional(),
});

export type InquiryVolumeInput = z.input<typeof inquiryVolumeInputSchema>;

export interface InquiryVolumeDto {
  id: string;
  volumeKind: VolumeKind;
  containerSizeId: string | null;
  containerSizeCode: string | null;
  quantity: number | null;
  cbm: string | null;
  weightKg: string | null;
  targetPrice: string | null;
  containerSizeNote: string | null;
}

/**
 * Whether the workspace already has a buying rate for the chosen lane.
 *
 * MATCHED  — a published rate, right mode, valid today. Nothing to chase.
 * EXPIRED  — the lane has been rated before, but not currently. Chase it.
 * NONE     — never rated. Chase it.
 */
export interface LaneCheckDto {
  status: 'MATCHED' | 'EXPIRED' | 'NONE';
  count: number;
  /** The most recent expiry, when the status is EXPIRED. */
  latestValidTo: string | null;
}

/** A selectable party and the people at it, for the recipient block. */
export interface InquiryPartyOption {
  id: string;
  name: string;
  contacts: { id: string; name: string; email: string | null }[];
}

/** An agent (Inbound) or a customer (Outbound) this inquiry is sent to. */
export interface InquiryPartyDto {
  id: string;
  partyId: string;
  name: string;
}

/** One of their people, with the address that seeds the email list. */
export interface InquiryPartyContactDto {
  id: string;
  contactId: string;
  name: string;
  email: string | null;
  partyName: string;
}

// -------------------------------------------------------------------- inquiry

export const inquiryInputSchema = z
  .object({
    inquiryDate: dateField,
    sourceId: idField,
    shipmentType: z.enum(SHIPMENT_TYPES, { message: 'Choose sea or air.' }),
    customerId: idField,
    movementType: z.enum(MOVEMENT_TYPES, { message: 'Choose inbound or outbound.' }),
    polId: idField,
    podId: idField,
    placeOfReceipt: z.string().trim().max(500, 'That is too long.').optional(),
    commodityItemId: optionalIdField,
    hsCode: z.string().trim().max(50, 'HS code is too long.').optional(),
    tosId: optionalIdField,
    /**
     * Sea only. Chooses which columns the volume grid offers, and is left unset
     * on an Air inquiry where the question does not arise.
     */
    loadingType: z.enum(LOADING_TYPES).optional(),
    currencyId: optionalIdField,
    expectedShipmentDate: optionalDateField,
    validTo: optionalDateField,
    remarks: z.string().trim().max(2000, 'Remarks are too long.').optional(),
    salesmanId: optionalIdField,
    /** §9 Q12: the lead this inquiry was raised from, if any. */
    leadId: optionalIdField,
    volumes: z.array(inquiryVolumeInputSchema).default([]),
    /**
     * Who this inquiry goes to. Inbound picks agents, Outbound picks customers
     * — the same list, filled from whichever side the movement names.
     */
    partyIds: z.array(z.string().regex(/^\d+$/)).default([]),
    /** The people at those parties. */
    partyContactIds: z.array(z.string().regex(/^\d+$/)).default([]),
    /**
     * Prefilled from the selected contacts and then editable, by the client's
     * choice — a one-off recipient has to be possible. Stored as typed.
     */
    notifyEmails: z.string().trim().max(4000, 'That list is too long.').optional(),
  })
  .refine((v) => v.polId !== v.podId, {
    message: 'The destination must differ from the origin.',
    path: ['podId'],
  })
  .refine(
    // Target price lives per size now, so the currency is required as soon as
    // ANY column carries one.
    (v) =>
      !(v.volumes ?? []).some((row) => (row.targetPrice ?? '') !== '') ||
      (v.currencyId ?? '') !== '',
    { message: 'Choose the currency those target prices are in.', path: ['currencyId'] },
  )
  .refine(
    // A Sea inquiry has to say which; Air must not.
    (v) => v.shipmentType !== 'SEA' || v.loadingType !== undefined,
    { message: 'Choose FCL or LCL.', path: ['loadingType'] },
  )
  .refine(
    (v) =>
      v.validTo === undefined ||
      v.validTo === '' ||
      v.validTo >= v.inquiryDate,
    { message: 'The inquiry cannot expire before it was raised.', path: ['validTo'] },
  );

export type InquiryInput = z.input<typeof inquiryInputSchema>;

export interface InquiryDto {
  id: string;
  /** The client's Inquiry No, e.g. INQ-2026-000001. */
  code: string;
  seriesYear: number;
  inquiryDate: string;
  sourceId: string;
  sourceName: string;
  shipmentType: ShipmentType;
  customerId: string;
  customerName: string;
  movementType: MovementType;
  polId: string;
  polCode: string;
  polName: string;
  podId: string;
  podCode: string;
  podName: string;
  placeOfReceipt: string | null;
  commodityItemId: string | null;
  commodityName: string | null;
  hsCode: string | null;
  tosId: string | null;
  tosName: string | null;
  loadingType: LoadingType | null;
  currencyId: string | null;
  currencyCode: string | null;
  expectedShipmentDate: string | null;
  validTo: string | null;
  remarks: string | null;
  salesmanId: string | null;
  salesmanName: string | null;
  status: InquiryStatus;
  quotedPrice: string | null;
  leadId: string | null;
  isActive: boolean;
  volumes: InquiryVolumeDto[];
  parties: InquiryPartyDto[];
  partyContacts: InquiryPartyContactDto[];
  notifyEmails: string | null;
  /** §5.5's "Follow Up(n)" counter. */
  followupCount: number;
  /**
   * How many agents have priced this inquiry.
   *
   * Withdrawn quotes are not counted: the agent took the offer back, so there
   * is nothing on the row to read.
   */
  agentQuoteCount: number;
  /** True once §4 rule 11's window has passed but the status still says OPEN. */
  isLapsed: boolean;
}

// ----------------------------------------------------------------- status set

export const inquiryStatusInputSchema = z.object({
  status: z.enum(SETTABLE_STATUSES, { message: 'Choose a status.' }),
  reason: z.string().trim().max(500, 'Keep the reason under 500 characters.').optional(),
});

export type InquiryStatusInput = z.input<typeof inquiryStatusInputSchema>;

// ------------------------------------------------------------------ follow-up

export const inquiryFollowupInputSchema = z.object({
  followupDate: dateField,
  contactMode: z.enum(CONTACT_MODES, { message: 'Choose how you made contact.' }),
  contactPerson: z.string().trim().max(200, 'That name is too long.').optional(),
  notes: z.string().trim().max(2000, 'Notes are too long.').optional(),
  nextFollowupDate: optionalDateField,
});

export type InquiryFollowupInput = z.input<typeof inquiryFollowupInputSchema>;

export interface InquiryFollowupDto {
  id: string;
  followupDate: string;
  contactMode: ContactMode;
  contactPerson: string | null;
  notes: string | null;
  nextFollowupDate: string | null;
  createdBy: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- list query

export const inquiryListQuerySchema = listQuerySchema.extend({
  fromDate: optionalDateField,
  toDate: optionalDateField,
  shipmentType: z.enum(SHIPMENT_TYPES).optional(),
  polId: optionalIdField,
  podId: optionalIdField,
  salesmanId: optionalIdField,
  status: z.enum(INQUIRY_STATUSES).optional(),
  /**
   * §4 rule 10: a salesman sees their own inquiries by default. Asking for the
   * whole team requires SALES.INQUIRY.VIEW_ALL — the server decides, this only
   * expresses the request.
   */
  scope: z.enum(['OWN', 'ALL']).default('OWN'),
});

export type InquiryListQuery = z.infer<typeof inquiryListQuerySchema>;

export const INQUIRY_SORT_FIELDS = ['code', 'inquiryDate', 'status', 'validTo'] as const;
export type InquirySortField = (typeof INQUIRY_SORT_FIELDS)[number];

// ==========================================================================
// §5.5 row actions — Price
// ==========================================================================

/**
 * A rate the Price drawer can offer for this inquiry's lane.
 *
 * Lines carry RateLineDto, so §4 rule 5's buy-price stripping applies here
 * exactly as it does on the Price List. An inquiry is where sales quote a
 * customer, which makes it the last place the margin should leak.
 */
export interface InquiryRateMatchDto {
  rateId: string;
  rateCode: string;
  carrierName: string;
  validFrom: string;
  validTo: string;
  currencyCode: string;
  transitDays: number | null;
  freeDays: number | null;
  lines: RateLineDto[];
}

/** A rate line already attached to the inquiry. */
export interface InquiryRateDto {
  id: string;
  rateId: string;
  rateCode: string;
  rateLineId: string;
  tierLabel: string;
  carrierName: string;
  currencyCode: string;
  /**
   * Snapshotted when attached (§3.3). §4 rule 1 versions rates, so the live
   * line may belong to a superseded rate by the time anyone reads this back —
   * which is the whole reason the figure is stored rather than joined.
   */
  quotedPrice: string;
  /** The one whose price the inquiry quotes. */
  isSelected: boolean;
  /** The rate it came from is no longer the live one for this lane. */
  isStale: boolean;
}

export const inquiryRateAttachSchema = z.object({
  rateLineIds: z
    .array(z.string().regex(/^\d+$/))
    .min(1, 'Choose at least one rate to attach.')
    .max(20, 'Attach 20 rates at most.'),
});

export type InquiryRateAttachInput = z.input<typeof inquiryRateAttachSchema>;

export const inquiryRateSelectSchema = z.object({
  inquiryRateId: z.string().regex(/^\d+$/, 'Choose which rate the quote uses.'),
});

export type InquiryRateSelectInput = z.input<typeof inquiryRateSelectSchema>;

/**
 * Settings → Notifications. Who hears about an Outbound lane with no rate.
 *
 * Validated as a list rather than one address: people type them separated by
 * commas, semicolons or newlines, and rejecting the wrong separator would be
 * pedantry.
 */
export const notificationSettingSchema = z.object({
  priceTeamEmails: z
    .string()
    .trim()
    .max(2000, 'That list is too long.')
    .refine(
      (v) =>
        v === '' ||
        v
          .split(/[,;\n]/)
          .map((a) => a.trim())
          .filter((a) => a !== '')
          .every((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)),
      'One of those is not an email address.',
    )
    .default(''),
});

export interface NotificationSettingDto {
  priceTeamEmails: string;
}
