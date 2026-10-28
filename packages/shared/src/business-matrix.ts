import { z } from 'zod';

import { listQuerySchema } from './api';
import type { LookupOption } from './cost-head';
import type { MovementType } from './inquiry';

/**
 * Sales & Marketing → Business Matrix (docs/DESIGN-UPDATE-2026-10-28.md §1).
 *
 * Transcribed from the client's `Business Matrix` sheet: trade lanes defined
 * as one POL to many PODs (OUTBOUND SHIPMENT) or many POLs to one POD (INBOUND
 * SHIPMENT), each shown as a table of Inquiry Received · No of Quotation ·
 * Shipment Volume (TEUs) · Total Revenue per port pair.
 */

/** The sheet's two sections, E4 and E25. Cross Border has none (§6 Q4). */
export const TRADE_LANE_DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const satisfies readonly MovementType[];
export type TradeLaneDirection = (typeof TRADE_LANE_DIRECTIONS)[number];

export const TRADE_LANE_DIRECTION_LABEL: Record<TradeLaneDirection, string> = {
  OUTBOUND: 'Outbound shipment',
  INBOUND: 'Inbound shipment',
};

/**
 * Which side of a lane is the single port, by direction: rows 5–6 "Single POL /
 * Muliple POD" outbound, and the mirror image inbound (row 27's labels are
 * swapped on the sheet; its sample rows are many POLs into Chittagong).
 */
export const TRADE_LANE_SIDES: Record<TradeLaneDirection, { single: 'POL' | 'POD'; many: 'POL' | 'POD' }> = {
  OUTBOUND: { single: 'POL', many: 'POD' },
  INBOUND: { single: 'POD', many: 'POL' },
};

/** A lane holds up to this many ports on its many side. */
export const TRADE_LANE_MAX_PORTS = 100;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');
const portId = z.string().regex(/^\d+$/, 'Choose a port from the list.');

export const tradeLaneSaveSchema = z
  .object({
    /** E5 "Trade lane name". */
    name: z.string().trim().min(1, 'Name the trade lane.').max(200, 'A lane name is at most 200 characters.'),
    movementType: z.enum(TRADE_LANE_DIRECTIONS),
    /** The single side: C6 "Single POL" outbound, the POD inbound. */
    portId: z.string().regex(/^\d+$/, 'Choose the port.'),
    /** The many side, in the order the matrix reads them. */
    portIds: z
      .array(portId)
      .min(1, 'Choose at least one port.')
      .max(TRADE_LANE_MAX_PORTS, `A lane holds up to ${TRADE_LANE_MAX_PORTS} ports.`)
      .refine((ids) => new Set(ids).size === ids.length, 'Each port goes on the lane once.'),
  })
  .refine((lane) => !lane.portIds.includes(lane.portId), {
    message: 'A port cannot be on both sides of the lane.',
    path: ['portIds'],
  });
export type TradeLaneSaveInput = z.input<typeof tradeLaneSaveSchema>;

export const BUSINESS_MATRIX_SORT_FIELDS = ['name', 'code'] as const;
export type BusinessMatrixSortField = (typeof BUSINESS_MATRIX_SORT_FIELDS)[number];

/**
 * The sheet has no period (§6 Q1). From and To are optional and inclusive;
 * each figure is counted by its own date.
 */
export const businessMatrixQuerySchema = listQuerySchema
  .extend({
    movementType: z.enum(TRADE_LANE_DIRECTIONS).default('OUTBOUND'),
    sortBy: z.enum(BUSINESS_MATRIX_SORT_FIELDS).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'The From date must be on or before the To date.',
    path: ['to'],
  });

export interface TradeLanePortDto {
  id: string;
  name: string;
  portCode: string;
  country: string;
}

/** One row of a lane's table — sheet rows 10–14 and 18–19 (outbound), 30–34 (inbound). */
export interface BusinessMatrixRowDto {
  pol: TradeLanePortDto;
  pod: TradeLanePortDto;
  /** E9 "Inquiry Received". */
  inquiries: number;
  /** F9 "No of Quotation". */
  quotations: number;
  /** G9 "Shipment Volume ( TEUs)", a decimal string. Null on an air lane, which has no containers. */
  teus: string | null;
  /** H9 "Total Revenue", in the workspace's base currency, a decimal string. */
  revenue: string;
}

export interface TradeLaneDto {
  id: string;
  code: string;
  name: string;
  movementType: TradeLaneDirection;
  isActive: boolean;
  /** The single side. */
  port: TradeLanePortDto;
  /** The many side, in order. */
  ports: TradeLanePortDto[];
  /** All its ports are airports (§6 Q3). */
  isAir: boolean;
  /** ISO code of the base currency Total Revenue is in, e.g. "BDT". */
  revenueCurrency: string;
  rows: BusinessMatrixRowDto[];
}

export interface TradeLanePortOption extends LookupOption {
  portCode: string;
  type: 'SEAPORT' | 'AIRPORT';
}

export interface TradeLaneOptionsDto {
  ports: TradeLanePortOption[];
}
