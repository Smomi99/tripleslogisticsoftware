import { z } from 'zod';

/**
 * Settings → Business Settings (owner request, 2026-11-17).
 *
 * "We print lots of things; the business name and the rest should come from
 * here." The company's own details, entered once, at the head of every printed
 * document — quotation, debit invoice, money receipt, shipping order, shipment
 * advise, delivery order — and the name on every other one.
 *
 * Only the name is required: a letterhead needs one. Everything else prints
 * when it is filled in and is simply absent when it is not, so a workspace
 * decides what its letterhead says by what it types here.
 */

/** The address sits under the name on every page; more than this crowds the title. */
export const BUSINESS_ADDRESS_MAX_LINES = 4;

const optionalText = (max: number, tooLong: string) =>
  z.string().trim().max(max, tooLong).default('');

export const businessProfileSchema = z.object({
  businessName: z
    .string()
    .trim()
    .min(1, 'Enter the business name. It heads every printed document.')
    .max(200, 'Keep the name under 200 characters.'),
  address: z
    .string()
    .trim()
    .max(500, 'Keep the address under 500 characters.')
    .refine(
      (v) => addressLines(v).length <= BUSINESS_ADDRESS_MAX_LINES,
      `Keep the address to ${BUSINESS_ADDRESS_MAX_LINES} lines or fewer.`,
    )
    .default(''),
  phone: optionalText(100, 'Keep the phone numbers under 100 characters.'),
  email: z
    .string()
    .trim()
    .max(320, 'That email address is too long.')
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email address.')
    .default(''),
  website: z
    .string()
    .trim()
    .max(200, 'That website address is too long.')
    .refine((v) => !/\s/.test(v), 'A website address has no spaces.')
    .default(''),
  binNo: optionalText(50, 'Keep the BIN under 50 characters.'),
  tinNo: optionalText(50, 'Keep the TIN under 50 characters.'),
  tradeLicenceNo: optionalText(50, 'Keep the trade licence number under 50 characters.'),
});

export type BusinessProfileInput = z.input<typeof businessProfileSchema>;
export type BusinessProfileValues = z.output<typeof businessProfileSchema>;

export interface BusinessProfileDto {
  businessName: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  binNo: string;
  tinNo: string;
  tradeLicenceNo: string;
  /** Whether a logo is on file; the image itself is fetched from `/logo`. */
  hasLogo: boolean;
  /**
   * Null until the screen is first saved — the name shown is then the
   * workspace's own, and that is what documents print until somebody saves.
   */
  updatedAt: string | null;
}

/** The address as printed: one entry per non-blank line, trimmed. */
export function addressLines(address: string): string[] {
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Parts on one printed line, separated the way the documents separate references. */
const LINE_SEPARATOR = '  ·  ';

function oneLine(parts: readonly [label: string, value: string][]): string {
  return parts
    .map(([label, value]) => [label, value.trim()] as const)
    .filter(([, value]) => value !== '')
    .map(([label, value]) => `${label}: ${value}`)
    .join(LINE_SEPARATOR);
}

/**
 * What prints under the name, top to bottom: the address line for line, then
 * one line of contact details, then one of registration numbers. A blank
 * detail drops out of its line, and an empty line drops out of the block.
 *
 * Shared so the screen's preview and the PDFs cannot disagree about what a
 * letterhead says — the screen draws exactly these strings.
 */
export function letterheadDetailLines(
  profile: Pick<
    BusinessProfileValues,
    'address' | 'phone' | 'email' | 'website' | 'binNo' | 'tinNo' | 'tradeLicenceNo'
  >,
): string[] {
  const contact = oneLine([
    ['Tel', profile.phone],
    ['Email', profile.email],
    ['Web', profile.website],
  ]);
  const registration = oneLine([
    ['BIN', profile.binNo],
    ['TIN', profile.tinNo],
    ['Trade Licence', profile.tradeLicenceNo],
  ]);
  return [...addressLines(profile.address), contact, registration].filter((line) => line !== '');
}
