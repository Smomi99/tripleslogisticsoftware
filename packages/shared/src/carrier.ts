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
  /**
   * Lanes that would be left dangling if this port were deactivated, as
   * "CGP → LON" labels. CR-001 §4 rule 5: warn and list them, then let the user
   * proceed — never cascade.
   */
  activePairs: string[];
}

// ----------------------------------------------------- carrier port pair

/**
 * Carrier → Port Pair (CR-001 §3, client: Table_Carrier_Service_Port_pairing).
 *
 * The lane and this workspace's rank of the carrier on it.
 */

/**
 * NUMERIC(5,2): up to three digits before the point, two after. Decimals are
 * the point of the type — 1.5 slots a carrier between ranks 1 and 2 without
 * renumbering the lane (CR-001 §3) — so this accepts them and rejects the
 * fourth integer digit the column cannot hold.
 */
const rankSchema = z
  .string()
  .trim()
  .refine(
    (v) => v === '' || /^\d{1,3}(\.\d{1,2})?$/.test(v),
    'Enter a rank like 1, 2 or 1.5 — up to three digits and two decimal places.',
  )
  .refine((v) => v === '' || Number(v) > 0, 'A rank starts at 1.')
  .optional();

export const carrierPortPairInputSchema = z
  .object({
    polId: z.string().regex(/^\d+$/, 'Choose a port of loading.'),
    podId: z.string().regex(/^\d+$/, 'Choose a port of discharge.'),
    lowPricePosition: rankSchema,
    servicePosition: rankSchema,
    remarks: z.string().trim().max(2000, 'Remark is too long.').optional(),
  })
  // CR-001 §4 rule 2. The CHECK constraint is what makes it true; this is what
  // makes it legible, and it names the field the user has to change.
  .refine((v) => v.polId !== v.podId, {
    message: 'A lane runs between two different ports.',
    path: ['podId'],
  });

export type CarrierPortPairInput = z.input<typeof carrierPortPairInputSchema>;

export const CARRIER_PORT_PAIR_SORT_FIELDS = [
  'lowPricePosition',
  'servicePosition',
  'pol',
] as const;
export type CarrierPortPairSortField = (typeof CARRIER_PORT_PAIR_SORT_FIELDS)[number];

export const carrierPortPairListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(CARRIER_PORT_PAIR_SORT_FIELDS).default('lowPricePosition'),
});

export interface CarrierPortPairDto {
  id: string;
  code: string;
  polId: string;
  polName: string;
  polCode: string;
  podId: string;
  podName: string;
  podCode: string;
  /** Sent as strings: NUMERIC(18,4)-style precision does not survive a float. */
  lowPricePosition: string | null;
  servicePosition: string | null;
  rankSource: 'MANUAL' | 'CALCULATED';
  remarks: string | null;
  isActive: boolean;
}

/** A port this carrier serves — the only ports a lane may use (§4 rule 1). */
export interface CarrierLanePortOption {
  id: string;
  portCode: string;
  name: string;
  country: string;
}

/**
 * What the POL and POD dropdowns may offer, and why they might be empty.
 *
 * Two very different empty cases hide behind a zero-length list: this carrier
 * has no service ports at all, or it has some and §4 rule 6 excluded every one
 * of them. Telling a user to add a port on a screen where that port already
 * sits is a dead end, so the count comes back with the list.
 */
export interface CarrierLanePorts {
  ports: CarrierLanePortOption[];
  /** Service ports of the wrong type for this carrier — rule 6 excluded them. */
  excludedByType: number;
  /** SEAPORT for MLO/NVOCC/SOC, AIRPORT for Airline, null if unconstrained. */
  requiredPortType: 'SEAPORT' | 'AIRPORT' | null;
}
