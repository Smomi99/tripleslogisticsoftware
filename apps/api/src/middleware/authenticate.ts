import type { NextFunction, Request, RequestHandler, Response } from 'express';

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
  /**
   * Set on an agent session, null otherwise. Read from the user row on every
   * request — never from the token. See `authenticateAs`.
   */
  agentId: bigint | null;
  /**
   * True for any login belonging to an outside company: an agent, a customer
   * or a vendor. STAFF routers refuse all of them.
   */
  isExternal: boolean;
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
 *   - whether this account is staff or an agent
 *
 * That is one indexed lookup, not a re-resolution of the whole permission set —
 * the expensive part stays cached.
 *
 * The session is authoritative for the tenant (§7A rule 1). If the host
 * resolved to a different workspace than the token was issued for, the request
 * is rejected rather than reconciled: silently preferring one would let a
 * crafted Host header probe for another company's data.
 *
 * **There is no unqualified `authenticate`.** Every caller picks a side, and a
 * session of the wrong kind is refused before any handler runs. A guard you
 * have to remember to add is one you will eventually forget, and the forgotten
 * one is the hole; making the choice part of authenticating means a router
 * added next year cannot accidentally be open to both.
 *
 * This survives agents becoming ordinary users. They now sign in at the same
 * door as staff and hold a role like anyone else — but a role is a list someone
 * ticked, and ticking CRM.CUSTOMER.VIEW onto an agent's role must not show them
 * your customers. The kind check is structural and sits above the permission
 * check, so a misconfigured role widens nothing.
 */
function authenticateAs(kind: 'STAFF' | 'AGENT' | 'ANY'): RequestHandler {
  return async function guard(
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

    // The database is the authority. The claim exists so the web app can route
    // without an extra call; if the two disagree the token is tampered with or
    // stale, and neither is a request worth serving.
    const claimedAgentId = claims.agentId ?? null;
    const actualAgentId = account.agentId === null ? null : account.agentId.toString();
    if (claimedAgentId !== actualAgentId) {
      throw HttpError.unauthorized('Your access has changed. Sign in again.');
    }

    // Any external link, not just an agent. Until this existed, "no agent id"
    // meant "is staff" — so a customer login would have been a staff login the
    // day the column was added.
    if (kind === 'STAFF' && account.isExternal) {
      throw HttpError.forbidden('This area is for staff accounts.');
    }
    if (kind === 'AGENT' && account.agentId === null) {
      throw HttpError.forbidden('This area is for agent accounts.');
    }

    req.auth = {
      userId,
      tenantId,
      isSuperadmin: account.isSuperadmin,
      permissions: new Set(claims.permissions),
      agentId: account.agentId,
      isExternal: account.isExternal,
    };

    // next() is called INSIDE the actor context so every handler downstream runs
    // within it — Express invokes the next handler synchronously from here, which
    // is what carries the AsyncLocalStorage store forward.
    runWithActor({ userId }, () => {
      next();
    });
  };
}

/**
 * Staff sessions only. Every existing router already calls this, so an agent
 * credential is refused at all forty of them without one line being added.
 */
export const authenticate: RequestHandler = authenticateAs('STAFF');

/**
 * Agent sessions only — the Agent Inquiry router and nothing else.
 *
 * Staff tokens are refused here just as firmly, so a staff member cannot read
 * the screen through an agent's row level security and see a workspace that is
 * not the one they think they are in.
 */
export const authenticateAgent: RequestHandler = authenticateAs('AGENT');

/**
 * Either kind — the deliberate exception, and the list is one endpoint long.
 *
 * `/auth/me` answers "who am I?" and returns nothing but the caller's own
 * identity and their own permission set. Both kinds of user need it to restore
 * a session on page load, and neither learns anything about the other from it.
 *
 * Anything that returns business data must pick a side instead.
 */
export const authenticateAny: RequestHandler = authenticateAs('ANY');
