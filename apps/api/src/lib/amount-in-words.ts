/**
 * §5.3 rule 7 — "Amount in words is generated from the USD total on save",
 * and §6.6 prints it as **In word (USD)** at the foot of the PDF.
 *
 * It exists on the document for the same reason it exists on a cheque: digits
 * can be altered or misread, and the words are the arbiter when they disagree.
 * So this is generated, never typed, and generated from the stored total rather
 * than from anything the browser sent.
 *
 * Short scale, and deliberately not localised. The quotation is issued in USD
 * to an international customer, and "one lakh" on an invoice a German consignee
 * reads is not a kindness. The Bengali rendering, if the client ever wants one,
 * belongs beside this rather than instead of it.
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
];
/** Enough for a freight quotation several times over. */
const SCALES: [number, string][] = [
  [1_000_000_000, 'billion'],
  [1_000_000, 'million'],
  [1_000, 'thousand'],
];

function underThousand(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const rest = n % 10;
    return TENS[Math.floor(n / 10)]! + (rest === 0 ? '' : `-${ONES[rest]!}`);
  }
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]!} hundred${rest === 0 ? '' : ` and ${underThousand(rest)}`}`;
}

function whole(n: number): string {
  if (n === 0) return 'zero';
  const parts: string[] = [];
  let left = n;
  for (const [value, name] of SCALES) {
    if (left >= value) {
      parts.push(`${whole(Math.floor(left / value))} ${name}`);
      left %= value;
    }
  }
  if (left > 0) {
    // "one thousand and forty", not "one thousand forty" — the reading a
    // cheque uses, and the one the client's sample follows.
    parts.push((parts.length > 0 && left < 100 ? 'and ' : '') + underThousand(left));
  }
  return parts.join(' ');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `"10504.50"` → `"US Dollars Ten thousand five hundred and four and 50/100 only"`.
 *
 * Takes the string the database holds rather than a number: NUMERIC(18,4) does
 * not fit a float, and rounding the total on the way to its own words would be
 * a strange way to lose money.
 */
export function amountInWords(total: string, currencyCode = 'USD'): string {
  const trimmed = total.trim();
  const negative = trimmed.startsWith('-');
  const [rawWhole = '0', rawFraction = ''] = trimmed.replace(/^[-+]/, '').split('.');

  const units = Number(rawWhole);
  if (!Number.isFinite(units) || units > Number.MAX_SAFE_INTEGER) {
    // Refusing beats printing nonsense on a binding document.
    return '';
  }

  // Two decimal places, as money is read aloud: .5 is fifty cents, not five.
  const cents = Number(`${(rawFraction + '00').slice(0, 2)}`);

  const name = currencyCode === 'USD' ? 'US Dollars' : currencyCode;
  const head = `${name} ${capitalise(whole(units))}`;
  const tail = cents === 0 ? '' : ` and ${String(cents).padStart(2, '0')}/100`;
  return `${negative ? 'Minus ' : ''}${head}${tail} only`;
}
