import { describe, expect, it } from 'vitest';

import { amountInWords } from './amount-in-words';

/**
 * §5.3 rule 7. The words go on a binding document beside the digits, and exist
 * precisely so that a disagreement between the two can be settled — so they are
 * worth testing more carefully than their size suggests.
 */
describe('amount in words', () => {
  it('writes the client sample', () => {
    // 2 x 5252 from the wireframe.
    expect(amountInWords('10504.00')).toBe('US Dollars Ten thousand five hundred and four only');
  });

  it('reads the whole sample total', () => {
    expect(amountInWords('40046.00')).toBe('US Dollars Forty thousand and forty-six only');
  });

  it('keeps the cents', () => {
    expect(amountInWords('1450.50')).toBe(
      'US Dollars One thousand four hundred and fifty and 50/100 only',
    );
  });

  it('reads a lone decimal digit as tenths, not units', () => {
    // ".5" is fifty cents. Reading it as five would be a hundredfold error on
    // a document somebody pays against.
    expect(amountInWords('10.5')).toBe('US Dollars Ten and 50/100 only');
  });

  it('handles zero', () => {
    expect(amountInWords('0.00')).toBe('US Dollars Zero only');
  });

  it('handles a round hundred without a stray "and"', () => {
    expect(amountInWords('100.00')).toBe('US Dollars One hundred only');
  });

  it('handles millions', () => {
    expect(amountInWords('1355016.00')).toBe(
      'US Dollars One million three hundred and fifty-five thousand and sixteen only',
    );
  });

  it('names a currency that is not the dollar', () => {
    expect(amountInWords('129.00', 'BDT')).toBe('BDT One hundred and twenty-nine only');
  });

  it('refuses rather than printing nonsense', () => {
    // A number past what a double can hold exactly would be silently wrong,
    // and silently wrong is the one thing this field must never be.
    expect(amountInWords('999999999999999999999.00')).toBe('');
  });
});
