import { z } from 'zod';

/**
 * The agent portal's contracts (docs/AGENT_PORTAL_DESIGN.md §2).
 *
 * Kept apart from auth.ts on purpose. The two sign-ins are different doors with
 * different audiences, and a shared schema is the first step towards a shared
 * handler that branches — which is exactly what the design refuses.
 */

/**
 * Same rule as staff (§2): length beats composition. An agent picking their own
 * password is the whole point of the invite flow — a password your staff typed
 * is a password your staff knows.
 */
const portalPasswordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'That password is too long.');

export const portalLoginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1, 'Enter your username.'),
  password: z.string().min(1, 'Enter your password.'),
});

/**
 * The link carries `<id>.<secret>`. The id is not a secret — it only says which
 * row to check — and it is what lets the secret itself be stored as a salted
 * argon2 hash rather than something reversible.
 */
export const credentialTokenSchema = z
  .string()
  .trim()
  .regex(/^\d+\.[A-Za-z0-9_-]{20,}$/, 'That link is not valid. Ask for a new one.');

export const acceptInviteSchema = z.object({
  token: credentialTokenSchema,
  password: portalPasswordSchema,
});

export const requestResetSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter the email address you were invited on.'),
});

export const completeResetSchema = z.object({
  token: credentialTokenSchema,
  password: portalPasswordSchema,
});

export type PortalLoginInput = z.infer<typeof portalLoginSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type RequestResetInput = z.infer<typeof requestResetSchema>;
export type CompleteResetInput = z.infer<typeof completeResetSchema>;

/**
 * Who the agent is, as the portal sees them.
 *
 * Deliberately not AuthenticatedUser: no permissions array, no roleName, no
 * isSuperadmin. An agent holds none of those, and a shape that carries the
 * fields invites code that reads them.
 */
export interface PortalUser {
  /** BigInt ids cross the wire as strings — JSON has no bigint. */
  id: string;
  username: string;
  email: string;
  /** The forwarding company this login belongs to. */
  agentId: string;
  agentName: string;
}

export interface PortalLoginResponse {
  accessToken: string;
  user: PortalUser;
}

/** What the invite screen shows before a password is chosen. */
export interface InvitePreview {
  agentName: string;
  email: string;
}

/**
 * Superadmin-side: turning an agent contact into a login (§2.4).
 *
 * The only input is which contact — the address is whatever agent_pic already
 * holds, so nobody retypes it, and the account is created dormant until the
 * invite is accepted.
 */
export const portalInviteSchema = z.object({
  agentPicId: z.string().regex(/^\d+$/, 'Choose a contact.'),
});

export type PortalInviteInput = z.infer<typeof portalInviteSchema>;

/** One agent login, as the CRM screen lists it. */
export interface PortalUserDto {
  id: string;
  username: string;
  email: string;
  /** The agent contact this login was created from, if that row still exists. */
  contactName: string | null;
  isActive: boolean;
  /** True while an unaccepted invite is still live. */
  invitePending: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}
