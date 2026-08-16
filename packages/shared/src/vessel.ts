import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * Vessel (CLAUDE.md §5, client table: Table_Vessel).
 * Fields: code, name, carrier_id → carrier.
 */

export const vesselInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the vessel name.')
    .max(200, 'Name must be 200 characters or fewer.'),
  carrierId: z.string().regex(/^\d+$/, 'Choose a carrier.'),
});

export type VesselInput = z.input<typeof vesselInputSchema>;

export const VESSEL_SORT_FIELDS = ['code', 'name'] as const;
export type VesselSortField = (typeof VESSEL_SORT_FIELDS)[number];

export const vesselListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(VESSEL_SORT_FIELDS).default('name'),
  carrierId: z.string().regex(/^\d+$/).optional(),
});

export interface VesselDto {
  id: string;
  code: string;
  name: string;
  carrierId: string;
  carrierName: string;
  isActive: boolean;
}
