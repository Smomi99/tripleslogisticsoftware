import { z } from 'zod';

/**
 * The opening figures a party's ledger starts from.
 *
 * These are not derived from anything the system holds: they are what the
 * account already stood at when the workspace began using it. Entered once,
 * then only ever corrected — the ledger itself will post movements on top.
 *
 * Money is NUMERIC(18,4) per CLAUDE.md §4 rule 6, and §4 rule 6 also requires a
 * currency stored alongside every amount. That is enforced twice on purpose:
 * here, so the operator is told which field to fix, and by a CHECK constraint
 * in the database, so no future write path can post a figure with no currency.
 */

/** Signed: a customer or vendor balance can fall either side of zero. */
export const signedMoneyField = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || /^-?\d{1,14}(\.\d{1,4})?$/.test(v), message)
    .optional();

/** Unsigned: the agent's two columns each name their own side already. */
export const unsignedMoneyField = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{1,14}(\.\d{1,4})?$/.test(v), message)
    .optional();

export const openingCurrencyField = z
  .string()
  .regex(/^\d*$/, 'Choose a currency.')
  .optional();

/** True when the string holds an actual figure rather than a blank. */
export function hasAmount(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

/**
 * The shared rule: a figure with no currency cannot be posted to a ledger.
 *
 * Written as a predicate so each entity can attach it with its own field path,
 * which is what puts the error under the currency box rather than at the top of
 * the form.
 */
export function currencyRequiredFor(
  amounts: (string | undefined)[],
  currencyId: string | undefined,
): boolean {
  return !amounts.some(hasAmount) || (currencyId ?? '') !== '';
}

export interface OpeningBalanceDto {
  openingBalance: string | null;
  openingCurrencyId: string | null;
  openingCurrencyCode: string | null;
}
