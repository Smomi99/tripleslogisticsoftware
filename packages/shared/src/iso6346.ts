/**
 * ISO 6346 container numbers — MODULE_CLP.md §5.2, client-confirmed as
 * "enforce, with check digit".
 *
 * One utility, because §5.2 says so and the reason is sound: Stuffing, the
 * BL and the customs declaration all key the same identifier, and three
 * implementations of a check digit are three chances to disagree about
 * whether a container exists.
 *
 * The format is 11 characters:
 *
 *     M S K U   1 2 3 4 5 6   7
 *     └─┬─┘ │   └────┬────┘   │
 *   owner  cat     serial   check
 *
 * The check digit is the point of the exercise. A container number is read
 * off a steel box in a yard, typed by someone who is not looking at the box,
 * and then used to claim cargo. The check digit catches a single mistyped
 * character and almost every transposition, which is exactly the error a
 * warehouse makes at 2am.
 */

/**
 * Letter values, per the standard.
 *
 * A=10 and then upward, SKIPPING every multiple of 11 — so K=21 is followed
 * by L=23, not 22. That gap is deliberate in ISO 6346: the weights below are
 * powers of two and the sum is taken modulo 11, so a letter worth a multiple
 * of 11 would be invisible to the check digit and a whole class of typos
 * would pass unnoticed.
 */
const LETTER_VALUES: Readonly<Record<string, number>> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20,
  K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31,
  U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};

/**
 * The equipment category, position 4.
 *
 * U is a freight container and is what a CLP will always carry. J and Z are
 * accepted because they are equally valid ISO 6346 identifiers, and refusing
 * a real container number would be a worse failure than accepting an unusual
 * one. Nothing is lost by it: a typo that turns U into J changes the check
 * digit too, so it is still caught one line further down.
 */
const CATEGORIES = new Set(['U', 'J', 'Z']);

/** 4 letters, then 7 digits. Nothing else, in either case. */
const SHAPE = /^[A-Z]{4}\d{7}$/;

/**
 * Strips what people put between the parts.
 *
 * Container numbers are written "MSKU 123456-7" on paperwork and "MSKU1234567"
 * in systems. Both are the same container, and asking an operator to delete a
 * space they copied from a bill of lading is the kind of friction that gets a
 * validator switched off.
 */
export function normaliseContainerNo(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * The ISO 6346 check digit for the first 10 characters.
 *
 * Each character's value is multiplied by 2^position, the products are summed,
 * and the remainder modulo 11 is the check digit — with 10 written as 0,
 * because the field holds one digit.
 *
 * Returns null if the first 10 characters are not 4 letters and 6 digits,
 * since there is then nothing to compute over.
 */
export function containerCheckDigit(first10: string): number | null {
  const head = normaliseContainerNo(first10);
  if (!/^[A-Z]{4}\d{6}$/.test(head)) return null;

  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const char = head[i]!;
    const value = i < 4 ? LETTER_VALUES[char] : Number(char);
    if (value === undefined) return null;
    sum += value * 2 ** i;
  }

  const remainder = sum % 11;
  // 10 is recorded as 0. The standard's own worked example does this, and it
  // is why a container number ending 0 is not proof of a serial ending 0.
  return remainder === 10 ? 0 : remainder;
}

export interface ContainerNoResult {
  ok: boolean;
  /** The normalised number, present only when ok. */
  value?: string;
  /** Names the fix, per CLAUDE.md §12: errors "name the fix". */
  message?: string;
}

/**
 * Validates a container number, format and check digit both.
 *
 * The messages are deliberately specific. "Invalid container number" tells an
 * operator nothing they can act on; "Check digit should be 3, not 7" tells
 * them to look at the last character, and more often than not the box in the
 * yard really does end in 3.
 */
export function validateContainerNo(input: string): ContainerNoResult {
  const value = normaliseContainerNo(input ?? '');

  if (value === '') {
    return { ok: false, message: 'Enter the container number.' };
  }

  if (!SHAPE.test(value)) {
    return {
      ok: false,
      message:
        'A container number is 4 letters then 7 digits, like MSKU1234565. ' +
        `You entered ${value.length} character${value.length === 1 ? '' : 's'}.`,
    };
  }

  const category = value[3]!;
  if (!CATEGORIES.has(category)) {
    return {
      ok: false,
      message:
        `The fourth letter is the equipment category and should be U, J or Z — not ${category}. ` +
        'Freight containers use U.',
    };
  }

  const expected = containerCheckDigit(value.slice(0, 10));
  const actual = Number(value[10]);
  if (expected === null) {
    // Unreachable while SHAPE has matched; kept so a future change to the
    // shape cannot silently skip the check digit.
    return { ok: false, message: 'That container number could not be checked.' };
  }
  if (expected !== actual) {
    return {
      ok: false,
      message: `Check digit should be ${expected}, not ${actual}. Please verify the container number.`,
    };
  }

  return { ok: true, value };
}

/** True when the number is a valid ISO 6346 identifier. */
export function isValidContainerNo(input: string): boolean {
  return validateContainerNo(input).ok;
}
