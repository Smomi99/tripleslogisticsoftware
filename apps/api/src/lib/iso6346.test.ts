import {
  containerCheckDigit,
  isValidContainerNo,
  normaliseContainerNo,
  validateContainerNo,
} from '@ff/shared';
import { describe, expect, it } from 'vitest';

/**
 * ISO 6346 — MODULE_CLP.md §5.2.
 *
 * The check digit is the whole point, so most of this file is about proving
 * the arithmetic rather than the plumbing. The worked example below is
 * computed by hand once, because a test that only agrees with the
 * implementation proves nothing about the standard.
 */

describe('the check digit arithmetic', () => {
  it('matches a hand-worked example', () => {
    /*
      CSQU305438 — the example in the standard's own documentation.

        C=13 x   1 =    13
        S=30 x   2 =    60
        Q=28 x   4 =   112
        U=32 x   8 =   256
        3    x  16 =    48
        0    x  32 =     0
        5    x  64 =   320
        4    x 128 =   512
        3    x 256 =   768
        8    x 512 =  4096
                    ------
                      6185

      6185 / 11 = 562 remainder 3  ->  check digit 3
    */
    expect(containerCheckDigit('CSQU305438')).toBe(3);
    expect(isValidContainerNo('CSQU3054383')).toBe(true);
  });

  it('writes a remainder of 10 as 0', () => {
    // The one place the mapping is not the identity, and the reason a number
    // ending 0 is not proof of a serial ending 0.
    const tens = [
      'MSCU123456',
      'TGHU856342',
      'GATU869457',
    ].filter((head) => {
      let sum = 0;
      const values: Record<string, number> = {
        A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20,
        K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31,
        U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
      };
      for (let i = 0; i < 10; i += 1) {
        const c = head[i]!;
        sum += (i < 4 ? values[c]! : Number(c)) * 2 ** i;
      }
      return sum % 11 === 10;
    });

    // Whichever of those happen to land on 10, the function must say 0.
    for (const head of tens) {
      expect(containerCheckDigit(head)).toBe(0);
    }
    // And the case has to exist at all, or this test proves nothing.
    expect(tens.length).toBeGreaterThan(0);
  });

  it('weights by position, so a transposition is caught', () => {
    // Two adjacent digits swapped is the classic typo. The weights double at
    // each position precisely so the sum moves when they are exchanged.
    const straight = containerCheckDigit('CSQU305438');
    const swapped = containerCheckDigit('CSQU305483');
    expect(swapped).not.toBe(straight);
  });

  it('refuses to compute over something that is not 4 letters and 6 digits', () => {
    expect(containerCheckDigit('CSQU30543')).toBeNull();
    expect(containerCheckDigit('CSQ1305438')).toBeNull();
    expect(containerCheckDigit('')).toBeNull();
  });
});

describe('what an operator types', () => {
  it('accepts the spacing people actually use', () => {
    // "MSKU 123456-7" is how it appears on a bill of lading.
    expect(normaliseContainerNo('csqu 305438-3')).toBe('CSQU3054383');
    expect(isValidContainerNo('csqu 305438-3')).toBe(true);
    expect(isValidContainerNo('CSQU 3054383')).toBe(true);
  });

  it('hands back the tidy form, so one container has one spelling', () => {
    const result = validateContainerNo(' csqu-305438 3 ');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('CSQU3054383');
  });
});

describe('what it refuses, and what it says', () => {
  it('names the expected check digit rather than saying "invalid"', () => {
    // §5.2 asks for this message by name.
    const result = validateContainerNo('CSQU3054387');
    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      'Check digit should be 3, not 7. Please verify the container number.',
    );
  });

  it('catches a single mistyped digit — the error this exists for', () => {
    // Change one character of a valid number; the check digit no longer fits.
    expect(isValidContainerNo('CSQU3054383')).toBe(true);
    expect(isValidContainerNo('CSQU3154383')).toBe(false);
    expect(isValidContainerNo('CSQU3054383'.replace('C', 'D'))).toBe(false);
  });

  it('says how long the number should be when the shape is wrong', () => {
    const result = validateContainerNo('CSQU30543');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/4 letters then 7 digits/);
    expect(result.message).toMatch(/9 characters/);
  });

  it('does not let letters into the serial', () => {
    expect(isValidContainerNo('CSQU30543S3')).toBe(false);
  });

  it('names the category letter when it is not one of the three', () => {
    const result = validateContainerNo('CSQA3054383');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/equipment category/);
    expect(result.message).toMatch(/not A/);
  });

  it('accepts J and Z, which are real ISO 6346 categories', () => {
    // Rejecting a valid identifier is worse than accepting an unusual one,
    // and the check digit still does the work of catching typos.
    for (const category of ['U', 'J', 'Z']) {
      const head = `CSQ${category}305438`;
      const digit = containerCheckDigit(head);
      expect(digit).not.toBeNull();
      expect(isValidContainerNo(`${head}${digit}`)).toBe(true);
    }
  });

  it('asks for the number when the field is empty', () => {
    expect(validateContainerNo('').message).toBe('Enter the container number.');
    expect(validateContainerNo('   ').message).toBe('Enter the container number.');
  });
});
