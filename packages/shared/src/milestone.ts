import { z } from 'zod';

import { listQuerySchema } from './api';
import { SHIPMENT_TYPES, type ShipmentType } from './inquiry';
import type { ShipmentStatus } from './shipment';

/**
 * Customer Service → Depart-Arrive Confirmation
 * (docs/DESIGN-UPDATE-2026-10-04.md §2).
 *
 * Transcribed from the client's `Depart-Arrival Landing page` and the six
 * sheets behind its tiles. What no sheet answers is §11 Q1–Q6 of that spec,
 * with the default used here named there.
 */

export const MILESTONE_KINDS = ['DEPARTED', 'TRANSSHIPPED', 'ARRIVED'] as const;
export type MilestoneKind = (typeof MILESTONE_KINDS)[number];

/** The sheets' Action values once saved: "Departed" on both departure screens, "Arrived" on arrival. */
export const MILESTONE_DONE_LABEL: Record<MilestoneKind, string> = {
  DEPARTED: 'Departed',
  TRANSSHIPPED: 'Departed',
  ARRIVED: 'Arrived',
};

/** Which leg's vessel or flight a screen names (row 6 of each sheet). */
export const MILESTONE_LEG_LABEL: Record<MilestoneKind, { sea: string; air: string }> = {
  DEPARTED: { sea: '1st Leg vsl', air: '1st Leg Flight No' },
  TRANSSHIPPED: { sea: '2nd Leg vsl', air: '2nd Leg Flight No' },
  ARRIVED: { sea: 'Last Leg vsl', air: 'Last Leg flight' },
};

/** ETD on the departure screens, ETA on arrival. */
export const MILESTONE_DATE_LABEL: Record<MilestoneKind, string> = {
  DEPARTED: 'ETD',
  TRANSSHIPPED: 'ETD',
  ARRIVED: 'ETA',
};

export interface MilestoneScreen {
  slug: string;
  kind: MilestoneKind;
  shipmentType: ShipmentType;
  title: string;
}

/** The landing page's six tiles (B6–N6), in the sheet's order. */
export const MILESTONE_SCREENS: readonly MilestoneScreen[] = [
  { slug: 'onboard-sea', kind: 'DEPARTED', shipmentType: 'SEA', title: 'On board confirmation - Sea' },
  { slug: 'onboard-air', kind: 'DEPARTED', shipmentType: 'AIR', title: 'On board confirmation - Air' },
  { slug: 'transshipment-sea', kind: 'TRANSSHIPPED', shipmentType: 'SEA', title: 'Transshipment confirmation - Sea' },
  { slug: 'transshipment-air', kind: 'TRANSSHIPPED', shipmentType: 'AIR', title: 'Transshipment confirmation - Air' },
  { slug: 'arrival-sea', kind: 'ARRIVED', shipmentType: 'SEA', title: 'Arrival - Sea' },
  { slug: 'arrival-air', kind: 'ARRIVED', shipmentType: 'AIR', title: 'Arrival - Air' },
];

export function milestoneScreenOf(slug: string): MilestoneScreen | undefined {
  return MILESTONE_SCREENS.find((s) => s.slug === slug);
}

/** Awaiting is the worklist; Confirmed is the record; All is both. */
export const MILESTONE_VIEWS = ['AWAITING', 'CONFIRMED', 'ALL'] as const;
export type MilestoneView = (typeof MILESTONE_VIEWS)[number];

export const MILESTONE_VIEW_LABEL: Record<MilestoneView, string> = {
  AWAITING: 'Awaiting',
  CONFIRMED: 'Confirmed',
  ALL: 'All',
};

export const MILESTONE_SORT_FIELDS = ['date', 'code', 'customer'] as const;
export type MilestoneSortField = (typeof MILESTONE_SORT_FIELDS)[number];

export const milestoneListQuerySchema = listQuerySchema.extend({
  kind: z.enum(MILESTONE_KINDS),
  shipmentType: z.enum(SHIPMENT_TYPES),
  view: z.enum(MILESTONE_VIEWS).default('AWAITING'),
  sortBy: z.enum(MILESTONE_SORT_FIELDS).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');

/**
 * The sheet's `Save` with Departed or Arrived selected. Saving again corrects
 * the date and tells the customer again.
 */
export const milestoneConfirmSchema = z.object({
  kind: z.enum(MILESTONE_KINDS),
  date: isoDate,
  /** Required when the date is not the one pulled from the advise (rule 5). */
  reason: z
    .string()
    .trim()
    .max(2000, 'Keep the reason under 2,000 characters.')
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  /** "An email will automatically send" — on unless the operator says otherwise. */
  notify: z.boolean().default(true),
});
export type MilestoneConfirmInput = z.input<typeof milestoneConfirmSchema>;

export interface MilestoneContainerDto {
  containerNo: string | null;
  sealNo: string | null;
  size: string | null;
}

export interface MilestoneConfirmationDto {
  confirmedOn: string;
  pulledOn: string | null;
  changeReason: string | null;
  confirmedAt: string;
  confirmedByName: string | null;
  /** Whether a notice was queued with the last save. */
  notified: boolean;
}

/** One row of a confirmation list (row 6 of each sheet). */
export interface MilestoneRow {
  shipmentId: string;
  bookingCode: string;
  bookingStatus: ShipmentStatus;
  quotationCode: string;
  /** Blank on inbound, which skips the shipping order. */
  soCode: string | null;
  customerName: string;
  exporterName: string | null;
  shipmentType: ShipmentType;
  polName: string;
  polCode: string;
  podName: string;
  podCode: string;
  carrierName: string;
  /** Sea only; one booking can fill several boxes. */
  containers: MilestoneContainerDto[];
  /** The leg this screen confirms: "MSC ANNA / 245W", or a flight number. */
  legLabel: string | null;
  /** The date pulled from the advise, or the approved schedule before there is one. */
  plannedOn: string | null;
  confirmation: MilestoneConfirmationDto | null;
  /** Who the notice goes to: the customer's contacts with an email. */
  recipients: string[];
}

/** Awaiting counts for the landing page's tiles, by slug. */
export type MilestoneSummaryDto = Record<string, number>;

/** What a confirmation returns: the row as it now stands, and what else moved. */
export interface MilestoneConfirmResultDto {
  row: MilestoneRow;
  /** BL drafts whose laden-on-board date this departure set. */
  blDraftsUpdated: number;
  /** Whether a notice was queued; false when asked not to, or nobody had an email. */
  notified: boolean;
}
