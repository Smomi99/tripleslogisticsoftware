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

/**
 * "USD — US Dollar" -> "USD".
 *
 * `currency.code` is the business code (CUR-001, §4 rule 2), not the ISO code;
 * the ISO code is the head of `currency.currency`. Tables dense enough to need
 * a currency beside every figure cannot afford the full name.
 *
 * Here rather than in either app because it was in both: the API kept a copy in
 * lib/currency-label and the web app inlined the same split in a rate panel,
 * which is exactly the drift its own comment warned about.
 */
/**
 * A rate as a person should read it.
 *
 * Rates are STORED to ten decimal places because they have to be: places are
 * absolute and rates are relative, so a small rate carries no significant
 * figures at four. But ten places on a screen is noise pretending to be
 * precision, and worse than noise after a rebase — dividing twice leaves
 * 33.4999999648 where 33.5 is meant, which reads as broken and invites
 * somebody to "correct" a figure that is right to nine significant figures.
 *
 * So: six significant figures, which is finer than any published rate, with at
 * least four decimal places so a column still lines up. The stored value is
 * untouched; only the reading of it is tidied.
 */
export function formatRate(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;

  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n === 0) return '0.0000';

  // toPrecision gives six significant figures wherever the decimal point is,
  // so 33.4999999648 reads 33.5000 and 0.0000186 keeps every figure it has.
  const rounded = Number(n.toPrecision(6));
  const asText = rounded.toFixed(Math.max(4, decimalsFor(rounded)));
  // Trailing zeros beyond the fourth place say nothing.
  return asText.includes('.') ? asText.replace(/(\.\d{4}\d*?)0+$/, '$1') : asText;
}

/** How many decimal places this number actually needs, up to ten. */
function decimalsFor(n: number): number {
  const text = n.toFixed(10).replace(/0+$/, '');
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

export function isoCurrency(value: string): string {
  return (value.split('—')[0] ?? value).trim();
}

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
  /**
   * What this workspace actually books at, resolved the same way
   * lib/currency-rate resolves it: 1 for the base, then the workspace's own
   * rate, then the built-in default — and that last only while the default is
   * in this workspace's base.
   *
   * NULL when none of those apply, which means this currency cannot be priced
   * here yet. It has to be nullable: showing a figure the server would refuse
   * to convert with is how a screen and its API come to disagree about money.
   */
  effectiveRate: string | null;
  /**
   * The workspace's base currency. Every other rate is units of THIS per one
   * unit of that currency, and the base's own rate is always exactly 1.
   */
  isBase: boolean;
  /**
   * True when the effective rate is the built-in default rather than one this
   * workspace set. The screen marks it, because a rate nobody chose is worth
   * knowing about before quoting against it.
   */
  usingSystemDefault: boolean;
  /**
   * Whether `conversion` is in the same base this workspace books in.
   *
   * The built-in defaults are expressed against the SYSTEM base — the shared
   * currency sitting at 1. A workspace that has moved its base off that is
   * looking at a figure on a different axis, and comparing it to the booking
   * rate would be a mistake, so the screen withholds it instead.
   */
  systemRateComparable: boolean;
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
