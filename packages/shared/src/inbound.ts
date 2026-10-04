import { z } from 'zod';

import { listQuerySchema } from './api';
import { SHIPMENT_TYPES } from './inquiry';
import { MILESTONE_SORT_FIELDS, type MilestoneContainerDto, type MilestoneRow } from './milestone';

/**
 * Operation → IGM Submission and DO Issue, inbound bookings only
 * (docs/DESIGN-UPDATE-2026-10-04.md §4). The list columns are the Arrival
 * sheet's — the same booking row Depart-Arrive draws — with the stage's own
 * state beside them.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');

// ------------------------------------------------------------------ IGM

/** The sheet's Action values (O7 "/Awaiting/ Updated"), plus All. */
export const IGM_VIEWS = ['AWAITING', 'UPDATED', 'ALL'] as const;
export type IgmView = (typeof IGM_VIEWS)[number];

export const IGM_VIEW_LABEL: Record<IgmView, string> = {
  AWAITING: 'Awaiting',
  UPDATED: 'Updated',
  ALL: 'All',
};

export const igmListQuerySchema = listQuerySchema.extend({
  shipmentType: z.enum(SHIPMENT_TYPES),
  view: z.enum(IGM_VIEWS).default('AWAITING'),
  sortBy: z.enum(MILESTONE_SORT_FIELDS).optional(),
});

/** L14 "HBL NO" — sent alone, or as a field beside the uploaded file. */
export const igmSaveSchema = z.object({
  hblNo: z.string().trim().min(1, 'Type the HBL No.').max(64, 'An HBL No is at most 64 characters.'),
});

export interface IgmDto {
  hblNo: string | null;
  /** The uploaded file's own name, when there is one. */
  fileName: string | null;
  /** The sheet's "Updated": the IGM file is in. */
  updated: boolean;
  updatedAt: string;
  updatedByName: string | null;
}

export interface IgmRow extends MilestoneRow {
  igm: IgmDto | null;
}

// ------------------------------------------------------------------- DO

export const DELIVERY_ORDER_VIEWS = ['AWAITING', 'ISSUED', 'ALL'] as const;
export type DeliveryOrderView = (typeof DELIVERY_ORDER_VIEWS)[number];

export const DELIVERY_ORDER_VIEW_LABEL: Record<DeliveryOrderView, string> = {
  AWAITING: 'Awaiting',
  ISSUED: 'Issued',
  ALL: 'All',
};

export const DELIVERY_ORDER_STATUSES = ['ISSUED', 'CANCELLED'] as const;
export type DeliveryOrderStatus = (typeof DELIVERY_ORDER_STATUSES)[number];

/**
 * The sheet's addressee (B16–B18), offered for a sea order and edited when the
 * cargo lands elsewhere (§11 Q12). An air order starts blank.
 */
export const DELIVERY_ORDER_SEA_ADDRESSEE = 'TERMINAL MANAGER\nCHITTAGONG PORT AUTHORITY\nCHITTAGONG';

export const deliveryOrderListQuerySchema = listQuerySchema.extend({
  shipmentType: z.enum(SHIPMENT_TYPES),
  view: z.enum(DELIVERY_ORDER_VIEWS).default('AWAITING'),
  sortBy: z.enum(MILESTONE_SORT_FIELDS).optional(),
});

/** `ISSUE DO`: the letter as the operator wrote it. */
export const deliveryOrderIssueSchema = z.object({
  shipmentId: z.string().regex(/^\d+$/, 'Choose the booking.'),
  issueDate: isoDate,
  addressee: z.string().trim().min(1, 'Say who the order is addressed to.').max(1000),
  subject: z.string().trim().min(1, 'Write the subject.').max(500),
  body: z
    .string()
    .trim()
    .max(5000, 'Keep the letter under 5,000 characters.')
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});
export type DeliveryOrderIssueInput = z.input<typeof deliveryOrderIssueSchema>;

export const deliveryOrderCancelSchema = z.object({
  reason: z.string().trim().min(1, 'Say why the order is cancelled.').max(1000),
});

export interface DeliveryOrderDto {
  id: string;
  code: string;
  issueDate: string;
  addressee: string;
  subject: string;
  body: string | null;
  status: DeliveryOrderStatus;
  issuedAt: string;
  issuedByName: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  hasPdf: boolean;
}

export interface DeliveryOrderRow extends MilestoneRow {
  hblNo: string | null;
  /** The IGM file is in — what a DO waits on (§11 Q13). */
  igmUpdated: boolean;
  /** The issued order, or the latest cancelled one when none is issued. */
  deliveryOrder: DeliveryOrderDto | null;
}

/** What `ISSUE DO` opens on. */
export interface DeliveryOrderPrefillDto {
  bookingCode: string;
  addressee: string;
  hblNo: string | null;
  containers: MilestoneContainerDto[];
  igmUpdated: boolean;
}
