import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * Sea-Air Port (CLAUDE.md §5, client table: Table_Port_List).
 *
 * Fields are exactly the client's: code, name, port_code, country, type,
 * is_active. Nothing added, nothing merged.
 */

export const PORT_TYPES = ['SEAPORT', 'AIRPORT'] as const;
export type PortType = (typeof PORT_TYPES)[number];

export const PORT_TYPE_LABEL: Record<PortType, string> = {
  SEAPORT: 'Seaport',
  AIRPORT: 'Airport',
};

export const portInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the port name.')
    .max(200, 'Port name must be 200 characters or fewer.'),
  /** UN/LOCODE for a seaport (BDCGP), IATA for an airport (DAC). */
  portCode: z
    .string()
    .trim()
    .min(2, 'Enter the port code, e.g. BDCGP or DAC.')
    .max(20, 'Port code must be 20 characters or fewer.')
    .regex(/^[A-Za-z0-9-]+$/, 'Port code may use only letters, numbers and hyphens.')
    .transform((value) => value.toUpperCase()),
  country: z
    .string()
    .trim()
    .min(1, 'Enter the country.')
    .max(100, 'Country must be 100 characters or fewer.'),
  type: z.enum(PORT_TYPES, { message: 'Choose Seaport or Airport.' }),
});

export type PortInput = z.input<typeof portInputSchema>;
export type PortPayload = z.output<typeof portInputSchema>;

/** Sortable columns, so an unknown value can never reach the database. */
export const PORT_SORT_FIELDS = ['code', 'name', 'portCode', 'country', 'type'] as const;
export type PortSortField = (typeof PORT_SORT_FIELDS)[number];

export const portListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(PORT_SORT_FIELDS).default('name'),
  type: z.enum(PORT_TYPES).optional(),
});

export type PortListQuery = z.infer<typeof portListQuerySchema>;

export interface PortDto {
  /** BigInt crosses the wire as a string — JSON has no bigint. */
  id: string;
  code: string;
  name: string;
  portCode: string;
  country: string;
  type: PortType;
  isActive: boolean;
  /**
   * True when this is a shared system row rather than the workspace's own
   * (§7A rule 7). System rows can be deactivated for the workspace but never
   * edited, so the UI hides Edit on them.
   */
  isSystem: boolean;
}
