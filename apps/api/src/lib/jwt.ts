import { jwtVerify, SignJWT } from 'jose';

import { env } from '../config/env';
import { HttpError } from './http-error';

/**
 * JWT issuing and verification (CLAUDE.md §2): a 15-minute access token and a
 * long-lived refresh token delivered as an httpOnly cookie.
 *
 * The access token carries the resolved permission set (§7 step 4) so a guard
 * does not hit the database on every request. That makes the token a cache,
 * which is why it is short-lived and why `tokenVersion` exists: bumping the
 * user's version invalidates every token already issued to them, which is how
 * a role or permission change takes effect immediately.
 */

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshSecret = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

const ISSUER = 'ff-erp';
const ACCESS_AUDIENCE = 'ff-erp:access';
const REFRESH_AUDIENCE = 'ff-erp:refresh';

export interface AccessTokenClaims {
  /** User id, as a string — JWT has no bigint. */
  sub: string;
  tenantId: string;
  isSuperadmin: boolean;
  /** Resolved permission keys. Empty for a superadmin, who bypasses the check. */
  permissions: string[];
  tokenVersion: number;
  /**
   * Set on an agent portal session, null on a staff one.
   *
   * Carried so the web app can route without an extra call. The SERVER NEVER
   * TRUSTS IT — authenticate reads the real value from the user row and rejects
   * the request if the two disagree. §7A rule 1 applied to the second boundary:
   * a client that can name its own agent id can read another agent's inquiries.
   */
  agentId?: string | null;
}

export interface RefreshTokenClaims {
  sub: string;
  tenantId: string;
  tokenVersion: number;
  /** Same claim, same rule: informative, never authoritative. */
  agentId?: string | null;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({
    tenantId: claims.tenantId,
    isSuperadmin: claims.isSuperadmin,
    permissions: claims.permissions,
    tokenVersion: claims.tokenVersion,
    agentId: claims.agentId ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_TTL)
    .sign(accessSecret);
}

export async function signRefreshToken(claims: RefreshTokenClaims): Promise<string> {
  return new SignJWT({
    tenantId: claims.tenantId,
    tokenVersion: claims.tokenVersion,
    agentId: claims.agentId ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(REFRESH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.JWT_REFRESH_TTL)
    .sign(refreshSecret);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw HttpError.unauthorized(`Malformed token: ${field}.`);
  }
  return value;
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, accessSecret, {
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
    });
    return {
      sub: asString(payload.sub, 'sub'),
      tenantId: asString(payload['tenantId'], 'tenantId'),
      isSuperadmin: payload['isSuperadmin'] === true,
      permissions: Array.isArray(payload['permissions'])
        ? payload['permissions'].filter((p): p is string => typeof p === 'string')
        : [],
      tokenVersion: typeof payload['tokenVersion'] === 'number' ? payload['tokenVersion'] : 0,
      agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : null,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw HttpError.unauthorized('Your session has expired. Sign in again.');
  }
}

export async function verifyRefreshToken(token: string): Promise<RefreshTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, refreshSecret, {
      issuer: ISSUER,
      audience: REFRESH_AUDIENCE,
    });
    return {
      sub: asString(payload.sub, 'sub'),
      tenantId: asString(payload['tenantId'], 'tenantId'),
      tokenVersion: typeof payload['tokenVersion'] === 'number' ? payload['tokenVersion'] : 0,
      agentId: typeof payload['agentId'] === 'string' ? payload['agentId'] : null,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw HttpError.unauthorized('Your session has expired. Sign in again.');
  }
}

export const REFRESH_COOKIE = 'ff_refresh';

/**
 * The portal's own refresh cookie, scoped to /api/portal.
 *
 * Two reasons it is not the staff cookie under a different path: a staff
 * session and an agent session can coexist in one browser without overwriting
 * each other, and this cookie is never sent to a staff endpoint at all.
 */
export const PORTAL_REFRESH_COOKIE = 'ff_portal_refresh';
