import { z } from 'zod';

/**
 * Shared by the login form and the API (CLAUDE.md §2, §9).
 *
 * Usernames are normalised to lower case on both sides. Matching them
 * case-sensitively meant "SuperAdmin" resolved to *no such user* — and browsers,
 * phone keyboards and Windows autocorrect all capitalise the first letter of a
 * text field, so the failure looks identical to a wrong password. Passwords are
 * of course left exactly as typed.
 */
export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Enter your username.'),
  password: z.string().min(1, 'Enter your password.'),
});

/** The one place usernames are normalised, so storage and lookup cannot drift. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthenticatedUser {
  /** BigInt ids cross the wire as strings — JSON has no bigint. */
  id: string;
  username: string;
  email: string;
  name: string | null;
  isSuperadmin: boolean;
  /**
   * Set when this account belongs to an agent rather than to staff.
   *
   * The web app uses it to label the top bar with the agent's own company —
   * never to decide what may be reached. That is the API's job, and it reads
   * the value from the user row rather than from anything the client holds.
   */
  agentId: string | null;
  agentName: string | null;
  roleName: string | null;
  /** Resolved permission keys. Empty for a superadmin, who bypasses the check. */
  permissions: string[];
}

export interface LoginResponse {
  accessToken: string;
  user: AuthenticatedUser;
}
