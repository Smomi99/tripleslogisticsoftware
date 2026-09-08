import { describe, expect, it } from 'vitest';

import { formatRate, isoCurrency } from '@ff/shared';

/**
 * How a rate reads.
 *
 * Rates are stored to ten decimal places because they must be — decimal places
 * are absolute and rates are relative, so a small rate carries no significant
 * figures at four. Showing ten is a different mistake: after a rebase the
 * arithmetic leaves 33.4999999648 where 33.5 is meant, and a figure that is
 * right to nine significant figures reads as broken.
 */
describe('formatRate', () => {
  it('tidies the drift a rebase leaves behind', () => {
    // Two divisions, ten places each. The value is right; the reading was not.
    expect(formatRate('33.4999999648')).toBe('33.5000');
    expect(formatRate('119.9999999520')).toBe('120.0000');
  });

  it('keeps four places, so a column lines up', () => {
    expect(formatRate('1.0000000000')).toBe('1.0000');
    expect(formatRate('120.0000000000')).toBe('120.0000');
    expect(formatRate('32.7000000000')).toBe('32.7000');
  });

  it('keeps the figures a small rate actually has', () => {
    // One taka in dirhams, and a weak currency against a strong base. Trimming
    // these to four places would leave 0.0299 and 0.0000 — the second is not a
    // rate at all.
    expect(formatRate('0.0298507463')).toBe('0.0298507');
    expect(formatRate('0.0000186000')).toBe('0.0000186');
    expect(formatRate('0.0083333333')).toBe('0.00833333');
  });

  it('shows six significant figures, not six decimal places', () => {
    // The distinction that makes it work across four orders of magnitude.
    expect(formatRate('1234.56789')).toBe('1234.5700');
    expect(formatRate('0.000012345678')).toBe('0.0000123457');
  });

  it('handles zero and negatives without inventing a rate', () => {
    expect(formatRate('0')).toBe('0.0000');
    expect(formatRate('0.0000000000')).toBe('0.0000');
    expect(formatRate('-5.25')).toBe('-5.2500');
  });

  it('hands back anything that is not a number untouched', () => {
    // The API is the source of these strings; a screen should not crash on a
    // shape it did not expect.
    expect(formatRate('')).toBe('');
    expect(formatRate('n/a')).toBe('n/a');
  });
});

describe('isoCurrency', () => {
  it('takes the code off the front of the master name', () => {
    expect(isoCurrency('USD — US Dollar')).toBe('USD');
    expect(isoCurrency('BDT — Bangladeshi Taka')).toBe('BDT');
  });

  it('leaves a name with no separator alone', () => {
    expect(isoCurrency('USD')).toBe('USD');
    expect(isoCurrency('')).toBe('');
  });
});
