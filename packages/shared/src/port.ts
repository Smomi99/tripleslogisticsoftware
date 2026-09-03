import { z } from 'zod';

import { listQuerySchema } from './api';
import { countrySchema } from './countries';

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
  country: countrySchema,
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

/**
 * What a picker needs, and no more — the payload of `GET /ports/lookup`.
 *
 * Narrower than PortDto on purpose. The lookup is unpaginated because a picker
 * has to offer every port, so the row it sends goes out two hundred times and
 * the fields a list screen needs (the business code, the active flag, whether
 * the row is shared) are all things a dropdown never shows. Its own type rather
 * than a lie about PortDto: the endpoint really does send less.
 */
export interface PortLookupDto {
  id: string;
  name: string;
  portCode: string;
  country: string;
  type: PortType;
}

/**
 * How a port reads in a picker: `Chittagong - CGP`.
 *
 * Name first, deliberately. An operator hunting for Hamburg types "Ham", and a
 * list that leads with the code makes them read past five characters of
 * unfamiliar alphabet on every row to find it. The code still earns its place
 * — two ports share a name often enough that dropping it would be worse — but
 * it belongs after the word somebody actually knows.
 *
 * Here rather than at each call site because it was at each call site: some
 * screens read `CGP — Chittagong` and others `Chittagong (CGP)`, which is how
 * the same list ends up sorted two ways in one product.
 */
export function portLabel(port: { name: string; portCode: string }): string {
  return `${port.name} - ${port.portCode}`;
}
