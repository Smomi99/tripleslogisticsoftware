import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * Carrier and its two children (CLAUDE.md §5).
 *   carrier              Table_Carrier
 *   carrier_pic          Table_Carrier_PIC              [child]
 *   carrier_service_port Table_Carrier_Service_Port     [child]
 *
 * Carrier itself is system-capable (§7A rule 7) — Maersk is Maersk for every
 * forwarder. Both children are tenant-owned, because each forwarder keeps its
 * own contacts and its own ranking of that carrier on a lane. So a workspace
 * adds children to a parent it cannot itself edit.
 */

// ---------------------------------------------------------------- carrier

export const carrierInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the carrier name.')
    .max(200, 'Name must be 200 characters or fewer.'),
  typeId: z.string().regex(/^\d+$/, 'Choose a carrier type.'),
  officeAddress: z.string().trim().max(2000, 'Address is too long.').optional(),
});

export type CarrierInput = z.input<typeof carrierInputSchema>;

export const CARRIER_SORT_FIELDS = ['code', 'name'] as const;
export type CarrierSortField = (typeof CARRIER_SORT_FIELDS)[number];

export const carrierListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(CARRIER_SORT_FIELDS).default('name'),
  typeId: z.string().regex(/^\d+$/).optional(),
});

export interface CarrierDto {
  id: string;
  code: string;
  name: string;
  typeId: string;
  typeName: string;
  officeAddress: string | null;
  isActive: boolean;
  isSystem: boolean;
  /** Counts for the contextual §8 buttons on the row. */
  picCount: number;
  servicePortCount: number;
}

// ------------------------------------------------------------ carrier PIC

/** Person in charge — the client's term, kept verbatim (§4 rule 1). */
export const carrierPicInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the contact name.').max(200, 'Name is too long.'),
  department: z.string().trim().max(100, 'Department is too long.').optional(),
  designation: z.string().trim().max(100, 'Designation is too long.').optional(),
  telNo: z.string().trim().max(50, 'Telephone number is too long.').optional(),
  mobileNo: z.string().trim().max(50, 'Mobile number is too long.').optional(),
  email: z
    .string()
    .trim()
    .max(255, 'Email is too long.')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address.')
    .optional(),
  country: z.string().trim().max(100, 'Country is too long.').optional(),
});

export type CarrierPicInput = z.input<typeof carrierPicInputSchema>;

export interface CarrierPicDto {
  id: string;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  telNo: string | null;
  mobileNo: string | null;
  email: string | null;
  country: string | null;
  isActive: boolean;
}

// --------------------------------------------------- carrier service port

/**
 * low_price_position and service_position are this forwarder's own ranking of
 * the carrier on that lane — 1 is best. Hence the row is tenant-owned.
 */
const positionSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{1,4}$/.test(v), 'Enter a whole number, 1 or higher.')
  .optional();

export const carrierServicePortInputSchema = z.object({
  portId: z.string().regex(/^\d+$/, 'Choose a port.'),
  country: z.string().trim().max(100, 'Country is too long.').optional(),
  lowPricePosition: positionSchema,
  servicePosition: positionSchema,
});

export type CarrierServicePortInput = z.input<typeof carrierServicePortInputSchema>;

export interface CarrierServicePortDto {
  id: string;
  code: string;
  portId: string;
  portName: string;
  portCode: string;
  country: string | null;
  lowPricePosition: number | null;
  servicePosition: number | null;
  isActive: boolean;
}
