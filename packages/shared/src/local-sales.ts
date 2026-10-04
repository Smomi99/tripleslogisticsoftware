import { z } from 'zod';

import { listQuerySchema } from './api';
import { BUSINESS_AREAS, type BusinessArea, CUSTOMER_TYPES, type CustomerType } from './customer';

/**
 * Sales & Marketing → Local Sales (docs/DESIGN-UPDATE-2026-10-04.md §6).
 *
 * The client's `Local Sales` sheet: the customer list (R7 "Table_Customer")
 * with its volumes and opening balance, and an Activity Log under each — a
 * meeting or call recorded against the customer.
 */

export const localSalesListQuerySchema = listQuerySchema.extend({
  customerType: z.enum(CUSTOMER_TYPES).optional(),
  businessArea: z.enum(BUSINESS_AREAS).optional(),
  sortBy: z.enum(['name', 'country']).optional(),
});

export interface LocalSalesRow {
  id: string;
  code: string;
  name: string;
  country: string;
  address: string | null;
  customerType: CustomerType;
  /** The sheet's "Commodity Category": the customer's industry sector. */
  commodityCategory: string;
  businessArea: BusinessArea;
  exSeaVolumeTeuMonth: string | null;
  exAirVolumeKgMonth: string | null;
  imSeaVolumeTeuMonth: string | null;
  imAirVolumeKgMonth: string | null;
  /**
   * The sheet's Opening Balance and Currency (M6–N6), as the customer has kept
   * it since 2026-09-27: what we owe them and what they owe us, in one currency.
   */
  weOwe: string | null;
  customerOwe: string | null;
  openingCurrency: string | null;
  isActive: boolean;
  activityCount: number;
  lastActivityAt: string | null;
  /** The earliest follow-up still ahead, from any of its records. */
  nextFollowupDate: string | null;
}

export const customerActivityInputSchema = z.object({
  /** C14 "Date & time", as the browser's datetime-local field gives it, in the user's zone. */
  activityAt: z.string().datetime({ offset: true, message: 'Use the date and time picker.' }),
  customerPicId: z
    .string()
    .regex(/^\d*$/, 'Choose one from the list.')
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  meetingSummary: z.string().trim().min(1, 'Write what the meeting was about.').max(5000),
  nextFollowupDate: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use the date picker.')
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  competitorAnalysis: z.string().trim().max(5000).optional().transform((v) => (v === '' ? undefined : v)),
  businessPossibility: z.string().trim().max(2000).optional().transform((v) => (v === '' ? undefined : v)),
});
export type CustomerActivityInput = z.input<typeof customerActivityInputSchema>;

export interface CustomerActivityDto {
  id: string;
  activityAt: string;
  picName: string | null;
  meetingSummary: string;
  nextFollowupDate: string | null;
  competitorAnalysis: string | null;
  businessPossibility: string | null;
  recordedBy: string | null;
}

export interface CustomerActivityLogDto {
  customerId: string;
  customerName: string;
  pics: { id: string; name: string }[];
  activities: CustomerActivityDto[];
}
