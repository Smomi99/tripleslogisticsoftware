import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * Commodity Category (CLAUDE.md §5).
 *   industry_sector  Table_Commodity_Class              e.g. Garments
 *   commodity_item   Table_Industry_Sector_Item_List    [child]
 *
 * Both tenant-owned: the item list a forwarder cares about is its own.
 */

export const industrySectorInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the category name.')
    .max(200, 'Name must be 200 characters or fewer.'),
});

export type IndustrySectorInput = z.input<typeof industrySectorInputSchema>;

export const INDUSTRY_SECTOR_SORT_FIELDS = ['code', 'name'] as const;
export type IndustrySectorSortField = (typeof INDUSTRY_SECTOR_SORT_FIELDS)[number];

export const industrySectorListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(INDUSTRY_SECTOR_SORT_FIELDS).default('name'),
});

export interface IndustrySectorDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  itemCount: number;
  businessPortCount: number;
  /** "CGP, NGB → JEA", or null where no lane is on file. */
  businessPortSummary: string | null;
}

export const commodityItemInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the item name.').max(200, 'Name is too long.'),
  /** HS codes are 6–10 digits, sometimes written with dots. */
  hsCode: z
    .string()
    .trim()
    .max(20, 'HS code is too long.')
    .refine(
      (v) => v === '' || /^[0-9.]{4,20}$/.test(v),
      'HS code may use only digits and dots.',
    )
    .optional(),
});

export type CommodityItemInput = z.input<typeof commodityItemInputSchema>;

export interface CommodityItemDto {
  id: string;
  code: string;
  name: string;
  hsCode: string | null;
  isActive: boolean;
}

/**
 * Business Port — the lanes a category is traded on (client, 2026-09-12).
 *
 * POL -> POD pairs hung off a commodity category, with one rule over the whole
 * set: a category fans in or it fans out, never both. Several loading ports
 * feeding one discharge port is a lane somebody buys against; several
 * discharge ports served from one loading port is too. A full grid of origins
 * against destinations is not a lane, it is a list of guesses, so it is
 * refused.
 */
export const BUSINESS_PORT_ONE_SIDE =
  'A category runs many loading ports into one discharge port, or one loading port out to many — not both.';

export const commodityBusinessPortInputSchema = z
  .object({
    polIds: z.array(z.string().min(1)).min(1, 'Choose at least one loading port.'),
    podIds: z.array(z.string().min(1)).min(1, 'Choose at least one discharge port.'),
  })
  /*
    The rule lives on the input because the lane is chosen in one go: pick
    three loading ports and one discharge port and that is the lane, saved as
    three pairs. Asking for them one pair at a time made "select multiple POL"
    impossible to express, which is how the client asked for it.
  */
  .refine((v) => v.polIds.length === 1 || v.podIds.length === 1, {
    message: BUSINESS_PORT_ONE_SIDE,
    path: ['podIds'],
  });

export type CommodityBusinessPortInput = z.input<typeof commodityBusinessPortInputSchema>;

export interface CommodityBusinessPortDto {
  id: string;
  code: string;
  polId: string;
  polName: string;
  polCode: string | null;
  podId: string;
  podName: string;
  podCode: string | null;
  isActive: boolean;
}

/** Which side of the lane may still take new ports. */
export type BusinessPortShape = 'EMPTY' | 'OPEN' | 'FANS_IN' | 'FANS_OUT';

/**
 * The shape of a category's lane, and what that leaves selectable.
 *
 * EMPTY   nothing on file — either side is free.
 * OPEN    one pair — still either, because one pair fans both ways.
 * FANS_IN many loading ports into one discharge port; the POD is fixed.
 * FANS_OUT one loading port out to many discharge ports; the POL is fixed.
 */
export function businessPortShape(
  rows: { polId: string; podId: string }[],
): { shape: BusinessPortShape; fixedPolId: string | null; fixedPodId: string | null } {
  if (rows.length === 0) return { shape: 'EMPTY', fixedPolId: null, fixedPodId: null };

  const pols = new Set(rows.map((r) => r.polId));
  const pods = new Set(rows.map((r) => r.podId));
  const onePol = pols.size === 1;
  const onePod = pods.size === 1;

  // A single pair satisfies both, and constrains neither yet.
  if (onePol && onePod) {
    return {
      shape: 'OPEN',
      fixedPolId: [...pols][0] ?? null,
      fixedPodId: [...pods][0] ?? null,
    };
  }
  if (onePod) return { shape: 'FANS_IN', fixedPolId: null, fixedPodId: [...pods][0] ?? null };
  if (onePol) return { shape: 'FANS_OUT', fixedPolId: [...pols][0] ?? null, fixedPodId: null };

  // Unreachable through the API, which refuses the save that would cause it.
  // Reachable by reading a row written before the rule existed.
  return { shape: 'EMPTY', fixedPolId: null, fixedPodId: null };
}

/** Whether adding these pairs would leave the set still a lane. */
export function businessPortAccepts(
  rows: { polId: string; podId: string }[],
  next: { polId: string; podId: string } | { polId: string; podId: string }[],
): boolean {
  const added = Array.isArray(next) ? next : [next];
  const pols = new Set([...rows.map((r) => r.polId), ...added.map((r) => r.polId)]);
  const pods = new Set([...rows.map((r) => r.podId), ...added.map((r) => r.podId)]);
  return pols.size === 1 || pods.size === 1;
}

/** Every pair a selection stands for. One side is always a single port. */
export function businessPortPairs(
  polIds: string[],
  podIds: string[],
): { polId: string; podId: string }[] {
  const pairs: { polId: string; podId: string }[] = [];
  for (const polId of polIds) {
    for (const podId of podIds) {
      if (polId !== podId) pairs.push({ polId, podId });
    }
  }
  return pairs;
}

/** "CGP, NGB → JEA" for the category list. Null when nothing is on file. */
export function businessPortSummary(
  rows: { polCode: string | null; polName: string; podCode: string | null; podName: string }[],
): string | null {
  if (rows.length === 0) return null;
  const label = (code: string | null, name: string): string => code ?? name;
  const pols = [...new Set(rows.map((r) => label(r.polCode, r.polName)))];
  const pods = [...new Set(rows.map((r) => label(r.podCode, r.podName)))];
  return `${pols.join(', ')} → ${pods.join(', ')}`;
}
