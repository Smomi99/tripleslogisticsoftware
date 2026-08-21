import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../lib/http-error';
import { verifyAccessToken } from '../lib/jwt';
import { loadAccount } from '../lib/permissions';
import { runWithActor } from '../lib/tenancy';
import { withTenant } from '../lib/tenant-client';

export interface AuthContext {
  userId: bigint;
  tenantId: bigint;
  isSuperadmin: boolean;
  permissions: ReadonlySet<string>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by authenticate. Never populated from client input. */
      auth?: AuthContext;
    }
  }
}

function bearerToken(req: Request): string {
  const header = req.get('authorization');
  if (header === undefined || !header.startsWith('Bearer ')) {
    throw HttpError.unauthorized();
  }
  const token = header.slice('Bearer '.length).trim();
  if (token.length === 0) throw HttpError.unauthorized();
  return token;
}

/**
 * Verifies the access token and establishes the auth context.
 *
 * The permission set is read from the token (§7 rule 4 caches it there), but
 * three things are still checked against the database on every request, because
 * a token cannot know them:
 *   - the user is still active, and their role is still active (§7 rule 5)
 *   - the token has not been superseded by a permission change (token_version)
 *
 * That is one indexed lookup, not a re-resolution of the whole permission set —
 * the expensive part stays cached.
 *
 * The session is authoritative for the tenant (§7A rule 1). If the host
 * resolved to a different workspace than the token was issued for, the request
 * is rejected rather than reconciled: silently preferring one would let a
 * crafted Host header probe for another company's data.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const claims = await verifyAccessToken(bearerToken(req));
  const tenantId = BigInt(claims.tenantId);

  if (req.tenant !== undefined && req.tenant.id !== tenantId) {
    throw HttpError.forbidden('This session belongs to a different workspace.');
  }

  const userId = BigInt(claims.sub);

  const account = await withTenant(tenantId, (db) => loadAccount(db, userId));

  if (account === null || !account.isActive) {
    throw HttpError.unauthorized('This account is no longer active.');
  }
  if (account.tokenVersion !== claims.tokenVersion) {
    // Permissions changed since this token was issued — force a refresh.
    throw HttpError.unauthorized('Your access has changed. Sign in again.');
  }
  // §7 rule 5: an inactive role removes access even while the user is active.
  if (!account.isSuperadmin && account.roleId !== null && account.roleIsActive !== true) {
    throw HttpError.forbidden('Your role has been deactivated.');
  }

  req.auth = {
    userId,
    tenantId,
    isSuperadmin: account.isSuperadmin,
    permissions: new Set(claims.permissions),
  };

  // next() is called INSIDE the actor context so every handler downstream runs
  // within it — Express invokes the next handler synchronously from here, which
  // is what carries the AsyncLocalStorage store forward.
  runWithActor({ userId }, () => {
    next();
  });
}
