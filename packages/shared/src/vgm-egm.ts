import { z } from 'zod';

import { listQuerySchema } from './api';
import { SHIPMENT_TYPES } from './inquiry';
import { MILESTONE_SORT_FIELDS, type MilestoneRow } from './milestone';

/**
 * Operation → Upload VGM & EGM, outbound bookings only
 * (docs/DESIGN-UPDATE-2026-10-28.md §2). The sheet `VGM`, titled "VGM & EGM":
 * the booking row (Booking NO · S/O NO · Customer · Exporter · Commodity ·
 * Shipment Type · POL/AOL · POD/AOD · Container no · Carrier · CLP NO), the
 * two statuses, and a panel each for the VGM and the EGM.
 */

/** M7 / N7 "Pending", and what it becomes once the file is in (§6 Q10). */
export const VGM_EGM_STATUSES = ['PENDING', 'UPLOADED'] as const;
export type VgmEgmStatus = (typeof VGM_EGM_STATUSES)[number];

export const VGM_EGM_STATUS_LABEL: Record<VgmEgmStatus, string> = {
  PENDING: 'Pending',
  UPLOADED: 'Uploaded',
};

/** Pending is a booking still waiting on either; Uploaded has both in. */
export const VGM_EGM_VIEWS = ['PENDING', 'UPLOADED', 'ALL'] as const;
export type VgmEgmView = (typeof VGM_EGM_VIEWS)[number];

export const VGM_EGM_VIEW_LABEL: Record<VgmEgmView, string> = {
  PENDING: 'Pending',
  UPLOADED: 'Uploaded',
  ALL: 'All',
};

export const vgmEgmListQuerySchema = listQuerySchema.extend({
  shipmentType: z.enum(SHIPMENT_TYPES),
  view: z.enum(VGM_EGM_VIEWS).default('PENDING'),
  sortBy: z.enum(MILESTONE_SORT_FIELDS).optional(),
});

const kg = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,3})?$/, 'Use digits in kg, up to three decimal places.');

/**
 * The VGM panel (B12–F24). Sent as JSON, or as fields beside the uploaded
 * file. Carrier Booking No, VGM and Name are what the declaration consists of
 * (§6 Q9); Gross Weight opens on the CLP's.
 */
export const vgmSaveSchema = z
  .object({
    carrierBookingNo: z
      .string()
      .trim()
      .min(1, 'Type the carrier booking no.')
      .max(64, 'A carrier booking no is at most 64 characters.'),
    vgmKg: kg.refine((v) => Number(v) > 0, 'The VGM is the packed container’s weight, so it is more than 0 kg.'),
    grossWeightKg: kg
      .optional()
      .or(z.literal(''))
      .transform((v) => (v === '' ? undefined : v)),
    signatoryName: z
      .string()
      .trim()
      .min(1, 'Type the name of the person who signs the VGM.')
      .max(200, 'A name is at most 200 characters.'),
  })
  .refine((v) => v.grossWeightKg === undefined || Number(v.vgmKg) >= Number(v.grossWeightKg), {
    message: 'The VGM includes the cargo, so it cannot be less than the gross weight.',
    path: ['vgmKg'],
  });
export type VgmSaveInput = z.input<typeof vgmSaveSchema>;

export interface VgmDto {
  carrierBookingNo: string;
  vgmKg: string;
  grossWeightKg: string | null;
  signatoryName: string;
  /** The uploaded file's own name, when there is one. */
  fileName: string | null;
  /** The file is in: the container reads Uploaded. */
  uploaded: boolean;
  updatedAt: string;
  updatedByName: string | null;
}

/** One finalised container of the booking — a line of the row (sheet rows 7–9). */
export interface VgmContainerDto {
  clpId: string;
  /** L6 "CLP NO". */
  clpCode: string;
  containerNo: string | null;
  sealNo: string | null;
  size: string;
  /** The CLP's total gross weight, which Gross Weight opens on. */
  cargoGrossWeightKg: string | null;
  /**
   * Every booking in the container, this one included. A consolidated box
   * (CR-002) has one VGM, so it reads the same under each of them.
   */
  bookingCodes: string[];
  vgm: VgmDto | null;
}

export interface EgmFileDto {
  id: string;
  fileName: string;
  uploadedAt: string;
  uploadedByName: string | null;
}

/** The EGM panel (H12–M24), read from the booking's live shipment advise. */
export interface EgmDto {
  adviseId: string;
  adviseCode: string;
  /** H13 "BL Number": the House BL (HAWB on air). */
  houseBlNo: string;
  /** J13 "MBL Number", as typed on the advise. */
  mblNo: string | null;
  /** K13 "carrier". */
  carrierName: string;
  /** Every booking on the advise (CR-005). They share these copies. */
  bookingCodes: string[];
  files: EgmFileDto[];
}

export interface VgmEgmRow extends MilestoneRow {
  /** F6 "Commodity": the booking's commodities, in one line. */
  commodity: string | null;
  /** Sea only. Empty until a load plan is finalised. */
  vgmContainers: VgmContainerDto[];
  /** Null on air: VGM is sea only (answered 2026-09-03). */
  vgmStatus: VgmEgmStatus | null;
  /** Null until the booking has a live shipment advise, which the EGM is filed against. */
  egm: EgmDto | null;
  egmStatus: VgmEgmStatus;
  /**
   * The Carrier Booking No on the schedule the booking sails on (the vessel
   * schedule form, 2026-10-28). A new VGM opens on it.
   */
  scheduleCarrierBookingNo: string | null;
}
