import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * The §3.1 lookups from docs/MODULE_PURCHASE_SALES.md.
 *
 * Five small master tables that everything in Purchase and Sales references.
 * They are seeded as shared rows and editable in Settings, so a workspace can
 * add a container size or an air weight break without a migration — which is
 * the whole point of §2's parent/child rate design.
 */

// -------------------------------------------------------------- shared bits

export const RATE_MODES = ['SEA_FCL', 'SEA_LCL', 'AIR'] as const;
export type RateMode = (typeof RATE_MODES)[number];

export const RATE_MODE_LABEL: Record<RateMode, string> = {
  SEA_FCL: 'Sea FCL',
  SEA_LCL: 'Sea LCL',
  AIR: 'Air',
};

export const RATE_TIER_UNITS = ['CONTAINER', 'CBM', 'KG'] as const;
export type RateTierUnit = (typeof RATE_TIER_UNITS)[number];

export const RATE_TIER_UNIT_LABEL: Record<RateTierUnit, string> = {
  CONTAINER: 'Container',
  CBM: 'CBM',
  KG: 'KG',
};

/** The unit each mode is priced in — §1's rate-unit column. */
export const MODE_UNIT: Record<RateMode, RateTierUnit> = {
  SEA_FCL: 'CONTAINER',
  SEA_LCL: 'CBM',
  AIR: 'KG',
};

const nameField = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(200, 'Name must be 200 characters or fewer.');

const codeField = z
  .string()
  .trim()
  .min(1, 'Enter a code.')
  .max(32, 'Code must be 32 characters or fewer.')
  .regex(/^[A-Za-z0-9._/-]+$/, 'Code may use letters, digits, dot, slash, underscore or hyphen.')
  .transform((v) => v.toUpperCase());

/** Decimal fields travel as strings — §4 rule 6 forbids float for numerics. */
const decimalField = (max: number, message: string) =>
  z
    .string()
    .trim()
    .refine(
      (v) => new RegExp(`^\\d{1,${max}}(\\.\\d{1,3})?$`).test(v) && Number(v) >= 0,
      message,
    );

/** A row that only exists to be looked up carries no business identity. */
export interface LookupRowDto {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  /** Shared row (§7A rule 7) — visible to all, editable by none. */
  isSystem: boolean;
}

// ---------------------------------------------------------------- goodsType

export const goodsTypeInputSchema = z.object({
  code: codeField,
  name: nameField,
  description: z.string().trim().max(2000, 'Description is too long.').optional(),
});
export type GoodsTypeInput = z.input<typeof goodsTypeInputSchema>;

export interface GoodsTypeDto extends LookupRowDto {
  description: string | null;
}

// ------------------------------------------------------------ containerSize

export const containerSizeInputSchema = z.object({
  code: codeField,
  name: nameField,
  /** 20STD = 1.00, 40ft = 2.00, 45ft = 2.25. Drives TEU reporting. */
  teuFactor: decimalField(2, 'Enter a TEU factor, e.g. 1 or 2.25.'),
  sortOrder: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{1,4}$/.test(v), 'Enter a whole number.')
    .optional(),
});
export type ContainerSizeInput = z.input<typeof containerSizeInputSchema>;

export interface ContainerSizeDto extends LookupRowDto {
  teuFactor: string;
  sortOrder: number;
}

// ----------------------------------------------------------------- rateTier

export const rateTierInputSchema = z
  .object({
    code: codeField,
    mode: z.enum(RATE_MODES, { message: 'Choose a freight mode.' }),
    label: z.string().trim().min(1, 'Enter a label.').max(100, 'Label is too long.'),
    unit: z.enum(RATE_TIER_UNITS, { message: 'Choose a unit.' }),
    minValue: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{1,14}(\.\d{1,3})?$/.test(v), 'Enter a number.')
      .optional(),
    maxValue: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{1,14}(\.\d{1,3})?$/.test(v), 'Enter a number.')
      .optional(),
    sortOrder: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{1,4}$/.test(v), 'Enter a whole number.')
      .optional(),
    /**
     * Required for SEA_FCL, meaningless for the weight/volume modes.
     *
     * The empty string is accepted because a <select> with nothing chosen sends
     * one, and the field is not even rendered on the other two modes — rejecting
     * '' here made the form refuse to submit with no error anyone could see.
     */
    containerSizeId: z.union([z.string().regex(/^\d+$/), z.literal('')]).optional(),
  })
  .refine(
    (v) => v.unit === MODE_UNIT[v.mode],
    { message: 'That unit does not match the mode — Sea FCL is per container, LCL per CBM, Air per KG.', path: ['unit'] },
  )
  .refine(
    (v) => v.mode !== 'SEA_FCL' || (v.containerSizeId !== undefined && v.containerSizeId !== ''),
    { message: 'Choose the container size this tier prices.', path: ['containerSizeId'] },
  )
  .refine(
    (v) =>
      v.minValue === undefined ||
      v.minValue === '' ||
      v.maxValue === undefined ||
      v.maxValue === '' ||
      Number(v.maxValue) > Number(v.minValue),
    { message: 'The upper bound must be greater than the lower bound.', path: ['maxValue'] },
  );

export type RateTierInput = z.input<typeof rateTierInputSchema>;

export interface RateTierDto extends LookupRowDto {
  mode: RateMode;
  label: string;
  unit: RateTierUnit;
  minValue: string | null;
  maxValue: string | null;
  sortOrder: number;
  containerSizeId: string | null;
  containerSizeName: string | null;
}

export const rateTierListQuerySchema = listQuerySchema.extend({
  mode: z.enum(RATE_MODES).optional(),
});

// ---------------------------------------------------------- tos / inquiry

export const tosInputSchema = z.object({ code: codeField, name: nameField });
export type TosInput = z.input<typeof tosInputSchema>;
export type TosDto = LookupRowDto;

export const inquirySourceInputSchema = z.object({ code: codeField, name: nameField });
export type InquirySourceInput = z.input<typeof inquirySourceInputSchema>;
export type InquirySourceDto = LookupRowDto;
