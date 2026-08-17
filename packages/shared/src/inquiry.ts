import { z } from 'zod';

import { listQuerySchema } from './api';

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
export const INQUIRY_STATUS_TONE: Record<InquiryStatus, 'inactive' | 'pending' | 'active' | 'alert'> =
  {
    OPEN: 'inactive',
    QUOTED: 'pending',
    WON: 'active',
    LOST: 'alert',
    EXPIRED: 'alert',
    CANCELLED: 'alert',
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
 * One row per container type for Sea FCL, a single CBM row for LCL, a single KG
 * row for Air. Empty rows are dropped before submit rather than stored as zeros.
 */
export const inquiryVolumeInputSchema = z.object({
  volumeKind: z.enum(VOLUME_KINDS),
  containerTypeId: optionalIdField,
  quantity: optionalInt,
  cbm: optionalQuantity('Enter a CBM figure.'),
  weightKg: optionalQuantity('Enter a weight in KG.'),
});

export type InquiryVolumeInput = z.input<typeof inquiryVolumeInputSchema>;

export interface InquiryVolumeDto {
  id: string;
  volumeKind: VolumeKind;
  containerTypeId: string | null;
  containerTypeCode: string | null;
  quantity: number | null;
  cbm: string | null;
  weightKg: string | null;
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
    targetPrice: optionalMoney('Enter a target price.'),
    currencyId: optionalIdField,
    expectedShipmentDate: optionalDateField,
    validTo: optionalDateField,
    weightKg: optionalQuantity('Enter a weight in KG.'),
    remarks: z.string().trim().max(2000, 'Remarks are too long.').optional(),
    salesmanId: optionalIdField,
    /** §9 Q12: the lead this inquiry was raised from, if any. */
    leadId: optionalIdField,
    volumes: z.array(inquiryVolumeInputSchema).default([]),
  })
  .refine((v) => v.polId !== v.podId, {
    message: 'The destination must differ from the origin.',
    path: ['podId'],
  })
  .refine(
    (v) => v.targetPrice === undefined || v.targetPrice === '' || (v.currencyId ?? '') !== '',
    { message: 'Choose the currency this target price is in.', path: ['currencyId'] },
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
  targetPrice: string | null;
  currencyId: string | null;
  currencyCode: string | null;
  expectedShipmentDate: string | null;
  validTo: string | null;
  weightKg: string | null;
  remarks: string | null;
  salesmanId: string | null;
  salesmanName: string | null;
  status: InquiryStatus;
  quotedPrice: string | null;
  leadId: string | null;
  isActive: boolean;
  volumes: InquiryVolumeDto[];
  /** §5.5's "Follow Up(n)" counter. */
  followupCount: number;
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
