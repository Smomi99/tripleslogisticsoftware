/**
 * "USD — US Dollar" -> "USD".
 *
 * `currency.code` is the business code (CUR-001, §4 rule 2), not the ISO code;
 * the ISO code is the head of `currency.currency`. Tables dense enough to need
 * a currency beside every figure cannot afford the full name.
 *
 * Extracted from freight-rate.route.ts when the portal needed the same rule —
 * two copies of this would drift the first time someone changed the separator.
 */
export function isoCurrency(value: string): string {
  return (value.split('—')[0] ?? value).trim();
}
