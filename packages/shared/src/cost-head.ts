import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * Cost Head (CLAUDE.md §5, client table: Table_Cost_Head).
 * Fields: code, category, name, unit → cost_unit lookup.
 */

export const COST_HEAD_CATEGORIES = ['SERVICE', 'ADMINISTRATIVE'] as const;
export type CostHeadCategory = (typeof COST_HEAD_CATEGORIES)[number];

export const COST_HEAD_CATEGORY_LABEL: Record<CostHeadCategory, string> = {
  SERVICE: 'Service',
  ADMINISTRATIVE: 'Administrative',
};

export const costHeadInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter the cost head name.')
    .max(200, 'Name must be 200 characters or fewer.'),
  category: z.enum(COST_HEAD_CATEGORIES, {
    message: 'Choose Service or Administrative.',
  }),
  /** Ids cross the wire as strings — JSON has no bigint. */
  unitId: z.string().regex(/^\d+$/, 'Choose a unit.'),
});

export type CostHeadInput = z.input<typeof costHeadInputSchema>;

export const COST_HEAD_SORT_FIELDS = ['code', 'name', 'category'] as const;
export type CostHeadSortField = (typeof COST_HEAD_SORT_FIELDS)[number];

export const costHeadListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(COST_HEAD_SORT_FIELDS).default('name'),
  category: z.enum(COST_HEAD_CATEGORIES).optional(),
});

export interface CostHeadDto {
  id: string;
  code: string;
  name: string;
  category: CostHeadCategory;
  unitId: string;
  unitName: string;
  isActive: boolean;
}

/** A selectable option — the shape every reference dropdown uses. */
export interface LookupOption {
  id: string;
  name: string;
}
