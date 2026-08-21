import { randomBytes } from 'node:crypto';

import { hashPassword, verifyPassword } from './password';
import type { TenantDb } from './tenant-client';

/**
 * One-time links: the invite that lets an agent set a first password, and the
 * self-service reset (docs/AGENT_PORTAL_DESIGN.md §2.4).
 *
 * **The link is never stored.** Only a salted argon2 hash of its secret half
 * goes into user_credential_token, so a copy of that table — a backup, a dump
 * handed to a contractor, a compromised replica — is not a set of working
 * invitations.
 *
 * The link reads `<id>.<secret>`. Storing a salted hash means it cannot be
 * looked up by value, so the row id travels alongside to say which row to
 * check. The id is not a secret; it identifies, it does not authorise. The
 * secret is 32 random bytes, and guessing it is the only way in.
 */

/** Invite links sit in an inbox; resets are expected to be used at once. */
const TTL_MS = {
  INVITE: 7 * 24 * 60 * 60 * 1000,
  RESET: 60 * 60 * 1000,
} as const;

export type TokenPurpose = keyof typeof TTL_MS;

export interface IssuedToken {
  /** Goes in the email, and nowhere else. Never logged, never returned twice. */
  token: string;
  expiresAt: Date;
}

/**
 * Issues a link, replacing any live one for the same user and purpose.
 *
 * Replacing rather than adding is the point: asking for a second reset must
 * kill the first, so a link intercepted in transit stops working the moment the
 * real owner notices and asks again. The partial unique index
 * user_credential_token_live enforces it at the database level too.
 */
export async function issueCredentialToken(
  db: TenantDb,
  params: { tenantId: bigint; userId: bigint; purpose: TokenPurpose; issuedBy?: bigint | null },
): Promise<IssuedToken> {
  const { tenantId, userId, purpose } = params;

  // Supersede, never delete: a spent or replaced token is the evidence that a
  // link existed, and §4 rule 3 does not hard-delete anything.
  await db.userCredentialToken.updateMany({
    where: { tenantId, userId, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });

  const secret = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS[purpose]);

  const row = await db.userCredentialToken.create({
    data: {
      tenantId,
      userId,
      purpose,
      tokenHash: await hashPassword(secret),
      expiresAt,
      createdBy: params.issuedBy ?? null,
    },
    select: { id: true },
  });

  return { token: `${row.id.toString()}.${secret}`, expiresAt };
}

export interface RedeemedToken {
  tokenId: bigint;
  userId: bigint;
}

/**
 * Checks a link and returns whose it is, or null.
 *
 * Null for every failure — wrong id, wrong secret, expired, already used, wrong
 * purpose. The caller cannot tell those apart, and neither can an attacker
 * probing with guessed ids.
 *
 * Does NOT consume the token: the caller does that inside the same transaction
 * as the password change, so a failure there cannot burn the link.
 */
export async function redeemCredentialToken(
  db: TenantDb,
  params: { tenantId: bigint; purpose: TokenPurpose; token: string },
): Promise<RedeemedToken | null> {
  const separator = params.token.indexOf('.');
  if (separator <= 0) return null;

  const rawId = params.token.slice(0, separator);
  const secret = params.token.slice(separator + 1);
  if (!/^\d+$/.test(rawId) || secret.length === 0) return null;

  const row = await db.userCredentialToken.findFirst({
    where: {
      id: BigInt(rawId),
      tenantId: params.tenantId,
      purpose: params.purpose,
      usedAt: null,
    },
    select: { id: true, userId: true, tokenHash: true, expiresAt: true },
  });

  if (row === null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (!(await verifyPassword(secret, row.tokenHash))) return null;

  return { tokenId: row.id, userId: row.userId };
}
