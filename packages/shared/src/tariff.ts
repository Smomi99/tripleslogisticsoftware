import { z } from 'zod';

import { listQuerySchema } from './api';
import type { LookupOption } from './cost-head';
import { MOVEMENT_TYPES, type MovementType } from './inquiry';

/**
 * Purchase → Price List → Tariff (docs/DESIGN-UPDATE-2026-10-04.md §5).
 *
 * Transcribed from the client's `Tarrif` sheet: a header of Country, POL,
 * Movement Type and Tariff Type (row 4), and a grid of Cost Head, Container
 * Size, Unit, Unit Price and Currency (rows 8 and 12). Nothing else reads a
 * tariff yet (§11 Q14).
 */

export const TARIFF_TYPES = ['PORT_TARIFF', 'CFS_CHARGE'] as const;
export type TariffType = (typeof TARIFF_TYPES)[number];

/** H5 "Port Tarrif , CFS Charge". */
export const TARIFF_TYPE_LABEL: Record<TariffType, string> = {
  PORT_TARIFF: 'Port Tariff',
  CFS_CHARGE: 'CFS Charge',
};

const id = (what: string) => z.string().regex(/^\d+$/, `Choose the ${what}.`);

/** §4 rule 6: money travels as a string, never a float. */
const price = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use digits, up to four decimal places.');

export const tariffLineInputSchema = z.object({
  costHeadId: id('cost head'),
  /** Optional: a per-CBM or per-document charge has no box. */
  containerSizeId: z
    .string()
    .regex(/^\d*$/, 'Choose one from the list.')
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  costUnitId: id('unit'),
  unitPrice: price,
  currencyId: id('currency'),
});
export type TariffLineInput = z.input<typeof tariffLineInputSchema>;

export const tariffSaveSchema = z.object({
  polId: id('POL'),
  movementType: z.enum(MOVEMENT_TYPES),
  tariffType: z.enum(TARIFF_TYPES),
  lines: z.array(tariffLineInputSchema).min(1, 'Add at least one charge.').max(200, 'A tariff holds up to 200 charges.'),
});
export type TariffSaveInput = z.input<typeof tariffSaveSchema>;

export const TARIFF_SORT_FIELDS = ['code', 'pol', 'country'] as const;

export const tariffListQuerySchema = listQuerySchema.extend({
  movementType: z.enum(MOVEMENT_TYPES).optional(),
  tariffType: z.enum(TARIFF_TYPES).optional(),
  sortBy: z.enum(TARIFF_SORT_FIELDS).optional(),
});

export interface TariffListRow {
  id: string;
  code: string;
  country: string;
  polId: string;
  polName: string;
  polCode: string;
  movementType: MovementType;
  tariffType: TariffType;
  lineCount: number;
  isActive: boolean;
}

export interface TariffLineDto {
  id: string;
  costHeadId: string;
  costHeadName: string;
  containerSizeId: string | null;
  containerSizeName: string | null;
  costUnitId: string;
  unitName: string;
  unitPrice: string;
  currencyId: string;
  currencyCode: string;
}

export interface TariffDto extends TariffListRow {
  lines: TariffLineDto[];
}

/** The pickers the tariff form needs, each filtered to what this workspace sees. */
export interface TariffOptionsDto {
  ports: (LookupOption & { country: string; portCode: string })[];
  costHeads: LookupOption[];
  containerSizes: LookupOption[];
  costUnits: LookupOption[];
  currencies: LookupOption[];
}
