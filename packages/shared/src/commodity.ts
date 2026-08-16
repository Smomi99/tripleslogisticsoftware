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
