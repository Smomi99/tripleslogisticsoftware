import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * Currency (CLAUDE.md §5, client table: Table_Currency).
 *
 * Like Port, this is system-capable (§7A rule 7): the world's currencies are
 * shared, and a workspace may add its own. `conversion` on a shared row is the
 * system default — a workspace cannot edit it, so its own rates live in the
 * tenant-owned currency_rate_history. See the §5 resolution in schema.prisma.
 */

/** Money and rates are NUMERIC(18,4) (§4 rule 6) — never a float, so a string. */
const rateSchema = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Enter a rate with up to 4 decimal places.')
  .refine((value) => Number(value) > 0, 'Rate must be greater than zero.');

export const currencyInputSchema = z.object({
  currency: z
    .string()
    .trim()
    .min(1, 'Enter the currency, e.g. USD — US Dollar.')
    .max(100, 'Currency must be 100 characters or fewer.'),
  conversion: rateSchema,
});

export type CurrencyInput = z.input<typeof currencyInputSchema>;

export const CURRENCY_SORT_FIELDS = ['code', 'currency', 'conversion'] as const;
export type CurrencySortField = (typeof CURRENCY_SORT_FIELDS)[number];

export const currencyListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(CURRENCY_SORT_FIELDS).default('currency'),
});

export interface CurrencyDto {
  id: string;
  code: string;
  currency: string;
  /** The system default rate, as a decimal string. */
  conversion: string;
  /** This workspace's current rate if it has set one, otherwise null. */
  tenantRate: string | null;
  /** tenantRate when set, else conversion — what the workspace actually books at. */
  effectiveRate: string;
  isActive: boolean;
  isSystem: boolean;
}

/** A rate a workspace set for itself (currency_rate_history). */
export const currencyRateInputSchema = z.object({
  rate: rateSchema,
  effectiveFrom: z.string().min(1, 'Choose the date this rate takes effect.'),
});

export type CurrencyRateInput = z.input<typeof currencyRateInputSchema>;

export interface CurrencyRateDto {
  id: string;
  rate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}
