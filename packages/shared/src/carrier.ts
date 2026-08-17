import { z } from 'zod';

import { listQuerySchema } from './api';
import { optionalCountrySchema } from './countries';

/**
 * Carrier and its two children (CLAUDE.md §5).
 *   carrier              Table_Carrier
 *   carrier_pic          Table_Carrier_PIC              [child]
 *   carrier_service_port Table_Carrier_Service_Port     [child]
 *
 * Carrier itself is system-capable (§7A rule 7) — Maersk is Maersk for every
 * forwarder. Both children are tenant-owned, because each forwarder keeps its
 * own contacts and knows a different part of that carrier's network. So a
 * workspace adds children to a parent it cannot itself edit.
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
  country: optionalCountrySchema,
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
 * Which ports this carrier serves — a plain list since CR-001 §2. Ranking moved
 * to carrier_port_pair, because a rank at a port says nothing without the POD
 * it is cheap to.
 *
 * `country` is not an input: the server reads it off the chosen port. A typed
 * country was free to disagree with the port it described, and did — the
 * migration found Changi filed under Bangladesh.
 */
export const carrierServicePortInputSchema = z.object({
  portId: z.string().regex(/^\d+$/, 'Choose a port.'),
});

export type CarrierServicePortInput = z.input<typeof carrierServicePortInputSchema>;

export interface CarrierServicePortDto {
  id: string;
  code: string;
  portId: string;
  portName: string;
  portCode: string;
  /** Derived from the port, never typed. */
  country: string | null;
  isActive: boolean;
}
