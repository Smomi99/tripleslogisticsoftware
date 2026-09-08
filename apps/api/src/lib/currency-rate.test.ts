import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client';
import { rebase } from './currency-rate';

/**
 * Rebasing — the arithmetic behind changing a workspace's base currency.
 *
 * Pure, and tested apart from the database, because it is the one place where
 * getting it wrong restates every price in the system at once. The property
 * that matters is not any single number: it is that every RATIO between two
 * currencies survives the change. A rebase that alters what a dirham is worth
 * in dollars has corrupted the ledger, however tidy the new figures look.
 */

const d = (n: string) => new Prisma.Decimal(n);

/** Rates as a BDT-based workspace holds them: BDT per one unit. */
const BDT = 1n;
const USD = 2n;
const AED = 3n;
const JPY = 4n;

const inBdt = [
  { id: BDT, rateInOldBase: d('1') },
  { id: USD, rateInOldBase: d('120') },
  { id: AED, rateInOldBase: d('32.7') },
  { id: JPY, rateInOldBase: d('0.78') },
];

const asMap = (rows: { currencyId: bigint; rate: Prisma.Decimal }[]) =>
  new Map(rows.map((r) => [r.currencyId, r.rate]));

describe('rebasing to another currency', () => {
  it('puts the new base at exactly 1', () => {
    const out = asMap(rebase(inBdt, USD, d('120')));
    expect(out.get(USD)?.toString()).toBe('1');
  });

  it('re-expresses the old base against the new one', () => {
    // One taka is 1/120 of a dollar.
    const out = asMap(rebase(inBdt, USD, d('120')));
    expect(out.get(BDT)?.toString()).toBe('0.0083333333');
  });

  it('keeps every ratio between two currencies', () => {
    /*
     * The property the whole feature rests on. A dirham was 32.7/120 of a
     * dollar before the change; it must be exactly that after, or somebody's
     * price moved because an administrator pressed a button.
     */
    const before = new Map(inBdt.map((c) => [c.id, c.rateInOldBase]));
    const after = asMap(rebase(inBdt, USD, d('120')));

    for (const a of [BDT, USD, AED, JPY]) {
      for (const b of [BDT, USD, AED, JPY]) {
        const wanted = before.get(a)!.dividedBy(before.get(b)!);
        const got = after.get(a)!.dividedBy(after.get(b)!);
        /*
          Relative, not absolute. These ratios span four orders of magnitude —
          a dollar is 120 taka, a taka is 0.0083 dollars — and one absolute
          tolerance cannot be meaningful for both. What matters is that no
          ratio moved by a noticeable FRACTION of itself.
        */
        const drift = got.minus(wanted).abs().dividedBy(wanted.abs());
        expect(
          drift.lessThan(d('0.00000001')),
          `${a}/${b}: wanted ${wanted.toString()}, got ${got.toString()}`,
        ).toBe(true);
      }
    }
  });

  it('holds precision on a small rate, which four decimals would not', () => {
    /*
     * Why the columns went to ten decimals. At four, one taka in dollars is
     * 0.0083, and 0.0083 x 120 is 0.996 — a 0.4% error on every converted
     * figure, in a table nobody would think to check.
     */
    const out = asMap(rebase(inBdt, USD, d('120')));
    const roundTrip = out.get(BDT)!.times(d('120'));
    expect(roundTrip.minus(1).abs().lessThan(d('0.00001'))).toBe(true);

    const atFourPlaces = out.get(BDT)!.toDecimalPlaces(4).times(d('120'));
    expect(atFourPlaces.minus(1).abs().greaterThan(d('0.003'))).toBe(true);
  });

  it('rebases to a currency worth less than the old base', () => {
    // Yen: everything gets bigger, and the ratios still hold.
    const out = asMap(rebase(inBdt, JPY, d('0.78')));
    expect(out.get(JPY)?.toString()).toBe('1');
    // 120 / 0.78 — a dollar is a bit over 153 yen.
    expect(out.get(USD)?.toDecimalPlaces(4).toString()).toBe('153.8462');
  });

  it('is a no-op on the base it already has', () => {
    const out = asMap(rebase(inBdt, BDT, d('1')));
    expect(out.get(BDT)?.toString()).toBe('1');
    expect(out.get(USD)?.toString()).toBe('120');
    expect(out.get(AED)?.toString()).toBe('32.7');
  });

  it('refuses a base with no usable rate', () => {
    // Dividing by nought, or by a negative, is not a currency conversion.
    expect(() => rebase(inBdt, USD, d('0'))).toThrow(/no usable rate/i);
    expect(() => rebase(inBdt, USD, d('-5'))).toThrow(/no usable rate/i);
  });

  it('survives being applied twice — there and back', () => {
    /*
     * BDT to USD, then USD back to BDT. Somebody will do this by accident, and
     * they should land where they started rather than on drifted rates.
     */
    const toUsd = rebase(inBdt, USD, d('120'));
    const usdMap = asMap(toUsd);
    const backToBdt = asMap(
      rebase(
        toUsd.map((r) => ({ id: r.currencyId, rateInOldBase: r.rate })),
        BDT,
        usdMap.get(BDT)!,
      ),
    );

    expect(backToBdt.get(BDT)?.toString()).toBe('1');
    // 120 within the rounding the two divisions cost.
    expect(backToBdt.get(USD)!.minus(120).abs().lessThan(d('0.0001'))).toBe(true);
    expect(backToBdt.get(AED)!.minus(d('32.7')).abs().lessThan(d('0.0001'))).toBe(true);
  });

  it('leaves a currency it was not given alone', () => {
    // Only what is passed in moves; a currency with no rate has no position.
    const out = rebase([{ id: USD, rateInOldBase: d('120') }], USD, d('120'));
    expect(out).toHaveLength(1);
    expect(out[0]?.currencyId).toBe(USD);
  });
});
