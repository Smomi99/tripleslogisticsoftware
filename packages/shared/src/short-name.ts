import { z } from 'zod';

/**
 * A party's short name — Agent, Carrier, Vendor (client, 2026-10-17; not in
 * §5/§6).
 *
 * What the rate screens' Purchase via column shows, with the full name on
 * hover: "MSK" in a dense grid, "Maersk Line Bangladesh Ltd" when you ask.
 * Optional, so a party without one is shown by its full name as before.
 */
export const SHORT_NAME_MAX = 50;

export const shortNameSchema = z
  .string()
  .trim()
  .max(SHORT_NAME_MAX, `Short name must be ${SHORT_NAME_MAX} characters or fewer.`)
  .optional();
