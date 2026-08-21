import { Router } from 'express';

import {
  acceptInviteSchema,
  type ApiSuccess,
  completeResetSchema,
  type PortalLoginResponse,
  type PortalUser,
  portalLoginSchema,
  requestResetSchema,
} from '@ff/shared';

import { env, isProduction } from '../config/env';
import { recordAudit } from '../lib/audit';
import { issueCredentialToken, redeemCredentialToken } from '../lib/credential-token';
import { HttpError } from '../lib/http-error';
import {
  PORTAL_REFRESH_COOKIE,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt';
import { hashPassword, verifyPassword } from '../lib/password';
import { sendResetMail } from '../lib/portal-mail';
import {
  clearFailures,
  isLockedOut,
  PORTAL_LOGIN_LIMIT,
  PORTAL_RESET_LIMIT,
  recordFailure,
} from '../lib/rate-limit';
import { withTenant } from '../lib/tenant-client';
import { authenticatePortal } from '../middleware/authenticate';

export const portalAuthRouter: Router = Router();

/**
 * Agent sign-in (docs/AGENT_PORTAL_DESIGN.md §2.2).
 *
 * A separate endpoint from the staff login rather than one that branches. A
 * stolen agent credential is useless here even if some later check regresses,
 * because the query itself will not return a staff row: `agentId: { not: null }`
 * is part of the WHERE, not a condition applied afterwards.
 */

/** Scoped to /api/portal, so it is never sent to a staff endpoint. */
const portalCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/api/portal/auth',
} as const;

function refreshMaxAgeMs(): number {
  const match = /^(\d+)([smhd])$/.exec(env.JWT_REFRESH_TTL);
  if (match === null) return 7 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * multiplier;
}

/** A hash to verify against when the account does not exist, so timing matches. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';

function tenantOf(req: { tenant?: { id: bigint } }): { id: bigint } {
  if (req.tenant === undefined) {
    throw new HttpError(500, 'TENANT_CONTEXT_MISSING', 'Tenant was not resolved.');
  }
  return req.tenant;
}

/** POST /api/portal/auth/login */
portalAuthRouter.post('/login', async (req, res) => {
  const tenant = tenantOf(req);
  const { username, password } = portalLoginSchema.parse(req.body);

  const ipKey = `portal-login:ip:${req.ip ?? 'unknown'}`;
  const accountKey = `portal-login:user:${tenant.id}:${username}`;

  // Checked before the password is verified, so a locked-out caller does not
  // even cost an argon2 hash. Per IP stops one host trying many accounts; per
  // account stops many hosts trying one — a per-IP limit alone misses the
  // second entirely.
  if (isLockedOut(ipKey) || isLockedOut(accountKey)) {
    await recordAudit({
      tenantId: tenant.id,
      action: 'LOGIN_FAILURE',
      tableName: 'user',
      recordId: null,
      actorId: null,
      details: { username, reason: 'rate-limited', ip: req.ip ?? null, portal: true },
    });
    throw HttpError.unauthorized('Too many attempts. Try again later.');
  }

  const result = await withTenant(tenant.id, async (db) => {
    const user = await db.user.findFirst({
      // The narrow query IS the guard: a staff account cannot be returned here
      // at all, so no later check can accidentally let one through.
      where: { username, agentId: { not: null }, deletedAt: null },
      select: {
        id: true,
        username: true,
        email: true,
        passwordHash: true,
        isActive: true,
        agentId: true,
        agent: { select: { name: true, isActive: true, deletedAt: true } },
      },
    });

    const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

    // An agent whose company has been deactivated loses access with it —
    // otherwise removing an agent from the CRM would leave their login working.
    const agentUsable =
      user?.agent != null && user.agent.isActive && user.agent.deletedAt === null;

    if (user === null || !passwordOk || !user.isActive || !agentUsable) {
      await recordAudit({
        tenantId: tenant.id,
        action: 'LOGIN_FAILURE',
        tableName: 'user',
        recordId: user?.id ?? null,
        actorId: null,
        details: {
          username,
          reason:
            user === null
              ? 'no-such-user'
              : !passwordOk
                ? 'bad-password'
                : !user.isActive
                  ? 'inactive'
                  : 'agent-inactive',
          ip: req.ip ?? null,
          portal: true,
        },
      });
      return null;
    }

    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const account = await db.user.findFirstOrThrow({
      where: { id: user.id },
      select: { tokenVersion: true },
    });

    await recordAudit({
      tenantId: tenant.id,
      action: 'LOGIN_SUCCESS',
      tableName: 'user',
      recordId: user.id,
      actorId: user.id,
      details: { username: user.username, ip: req.ip ?? null, portal: true },
    });

    return { user, tokenVersion: account.tokenVersion };
  });

  if (result === null) {
    recordFailure(ipKey, PORTAL_LOGIN_LIMIT);
    recordFailure(accountKey, PORTAL_LOGIN_LIMIT);
    throw HttpError.unauthorized('Incorrect username or password.');
  }

  clearFailures(ipKey);
  clearFailures(accountKey);

  const { user, tokenVersion } = result;
  const agentId = user.agentId as bigint;

  // No permissions and never superadmin. An agent holds neither, and the §7
  // resolution order is not consulted for them at all — what they may reach is
  // decided by the portal's own routes and by RLS, not by a permission set.
  const accessToken = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenant.id.toString(),
    isSuperadmin: false,
    permissions: [],
    tokenVersion,
    agentId: agentId.toString(),
  });
  const refreshToken = await signRefreshToken({
    sub: user.id.toString(),
    tenantId: tenant.id.toString(),
    tokenVersion,
    agentId: agentId.toString(),
  });

  res.cookie(PORTAL_REFRESH_COOKIE, refreshToken, {
    ...portalCookieOptions,
    maxAge: refreshMaxAgeMs(),
  });

  const payload: ApiSuccess<PortalLoginResponse> = {
    success: true,
    data: {
      accessToken,
      user: {
        id: user.id.toString(),
        username: user.username,
        email: user.email,
        agentId: agentId.toString(),
        agentName: user.agent?.name ?? '',
      },
    },
  };
  res.json(payload);
});

/** POST /api/portal/auth/refresh */
portalAuthRouter.post('/refresh', async (req, res) => {
  const cookies = req.cookies as Record<string, string | undefined>;
  const token = cookies[PORTAL_REFRESH_COOKIE];
  if (token === undefined) {
    throw HttpError.unauthorized('Sign in to continue.');
  }

  const claims = await verifyRefreshToken(token);
  const tenantId = BigInt(claims.tenantId);

  if (req.tenant !== undefined && req.tenant.id !== tenantId) {
    throw HttpError.forbidden('This session belongs to a different workspace.');
  }

  const account = await withTenant(tenantId, (db) =>
    db.user.findFirst({
      where: { id: BigInt(claims.sub), agentId: { not: null }, deletedAt: null },
      select: {
        id: true,
        isActive: true,
        tokenVersion: true,
        agentId: true,
        agent: { select: { isActive: true, deletedAt: true } },
      },
    }),
  );

  if (
    account === null ||
    !account.isActive ||
    account.agent === null ||
    !account.agent.isActive ||
    account.agent.deletedAt !== null
  ) {
    res.clearCookie(PORTAL_REFRESH_COOKIE, portalCookieOptions);
    throw HttpError.unauthorized('This account is no longer active.');
  }
  if (account.tokenVersion !== claims.tokenVersion) {
    res.clearCookie(PORTAL_REFRESH_COOKIE, portalCookieOptions);
    throw HttpError.unauthorized('Your access has changed. Sign in again.');
  }

  const accessToken = await signAccessToken({
    sub: claims.sub,
    tenantId: claims.tenantId,
    isSuperadmin: false,
    permissions: [],
    tokenVersion: account.tokenVersion,
    agentId: account.agentId?.toString() ?? null,
  });

  const payload: ApiSuccess<{ accessToken: string }> = { success: true, data: { accessToken } };
  res.json(payload);
});

/** POST /api/portal/auth/logout */
portalAuthRouter.post('/logout', async (req, res) => {
  const token: unknown = (req.cookies as Record<string, unknown> | undefined)?.[
    PORTAL_REFRESH_COOKIE
  ];
  if (typeof token === 'string' && token.length > 0) {
    try {
      const claims = await verifyRefreshToken(token);
      await recordAudit({
        tenantId: BigInt(claims.tenantId),
        action: 'LOGOUT',
        tableName: 'user',
        recordId: BigInt(claims.sub),
        actorId: BigInt(claims.sub),
        details: { portal: true },
      });
    } catch {
      // Nothing to attribute. Sign them out anyway.
    }
  }

  res.clearCookie(PORTAL_REFRESH_COOKIE, portalCookieOptions);
  const payload: ApiSuccess<{ signedOut: true }> = { success: true, data: { signedOut: true } };
  res.json(payload);
});

/** GET /api/portal/auth/me */
portalAuthRouter.get('/me', authenticatePortal, async (req, res) => {
  const auth = req.auth;
  if (auth === undefined) throw HttpError.unauthorized();

  const user = await withTenant(auth.tenantId, (db) =>
    db.user.findFirst({
      where: { id: auth.userId },
      select: {
        id: true,
        username: true,
        email: true,
        agentId: true,
        agent: { select: { name: true } },
      },
    }),
  );

  if (user === null || user.agentId === null) throw HttpError.unauthorized();

  const payload: ApiSuccess<PortalUser> = {
    success: true,
    data: {
      id: user.id.toString(),
      username: user.username,
      email: user.email,
      agentId: user.agentId.toString(),
      agentName: user.agent?.name ?? '',
    },
  };
  res.json(payload);
});

/**
 * POST /api/portal/auth/accept-invite
 *
 * The agent chooses their own password here, and this is the only place one is
 * ever set for them. A password your staff typed is a password your staff knows.
 */
portalAuthRouter.post('/accept-invite', async (req, res) => {
  const tenant = tenantOf(req);
  const { token, password } = acceptInviteSchema.parse(req.body);

  const accepted = await withTenant(tenant.id, async (db) => {
    const redeemed = await redeemCredentialToken(db, {
      tenantId: tenant.id,
      purpose: 'INVITE',
      token,
    });
    if (redeemed === null) return null;

    // The account must still be an agent account and still exist. An invite
    // outlives a lot of decisions — seven days is long enough for the agent to
    // have been removed in the meantime.
    const user = await db.user.findFirst({
      where: { id: redeemed.userId, agentId: { not: null }, deletedAt: null },
      select: { id: true, tokenVersion: true },
    });
    if (user === null) return null;

    await db.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(password),
        // The account is dormant until the invite is accepted, so this is where
        // it comes to life.
        isActive: true,
        // Kills any session opened before the password existed.
        tokenVersion: user.tokenVersion + 1,
      },
    });
    await db.userCredentialToken.update({
      where: { id: redeemed.tokenId },
      data: { usedAt: new Date() },
    });

    return user.id;
  });

  if (accepted === null) {
    throw new HttpError(
      400,
      'INVITE_INVALID',
      'That invitation has expired or has already been used. Ask for a new one.',
    );
  }

  await recordAudit({
    tenantId: tenant.id,
    action: 'INVITE_ACCEPTED',
    tableName: 'user',
    recordId: accepted,
    actorId: accepted,
    details: { ip: req.ip ?? null },
  });

  const payload: ApiSuccess<{ accepted: true }> = { success: true, data: { accepted: true } };
  res.json(payload);
});

/**
 * POST /api/portal/auth/request-reset
 *
 * Self-service: an external user has no admin of yours to phone.
 *
 * The response is identical whether or not the address exists, so this is not
 * a way to find out who a forwarder works with — which is commercially
 * sensitive quite apart from being an account-enumeration hole.
 */
portalAuthRouter.post('/request-reset', async (req, res) => {
  const tenant = tenantOf(req);
  const { email } = requestResetSchema.parse(req.body);

  const ipKey = `portal-reset:ip:${req.ip ?? 'unknown'}`;
  const accountKey = `portal-reset:email:${tenant.id}:${email}`;
  const throttled = isLockedOut(ipKey) || isLockedOut(accountKey);

  if (!throttled) {
    recordFailure(ipKey, PORTAL_RESET_LIMIT);
    recordFailure(accountKey, PORTAL_RESET_LIMIT);

    const issued = await withTenant(tenant.id, async (db) => {
      const user = await db.user.findFirst({
        where: { email, agentId: { not: null }, isActive: true, deletedAt: null },
        select: { id: true, email: true, agent: { select: { name: true } } },
      });
      if (user === null) return null;

      const credential = await issueCredentialToken(db, {
        tenantId: tenant.id,
        userId: user.id,
        purpose: 'RESET',
      });
      // The workspace's own row is readable inside its own scope (the
      // tenant_self policy); ResolvedTenant carries only id and status.
      const forwarder = await db.tenant.findFirst({
        where: { id: tenant.id },
        select: { name: true },
      });
      return { user, credential, forwarderName: forwarder?.name ?? 'Your forwarder' };
    });

    if (issued !== null) {
      await recordAudit({
        tenantId: tenant.id,
        action: 'PASSWORD_RESET_REQUESTED',
        tableName: 'user',
        recordId: issued.user.id,
        actorId: null,
        details: { ip: req.ip ?? null },
      });
      // After the transaction commits, and never fails the request: a mail
      // server being down is not a reason to tell the caller anything.
      await sendResetMail({
        to: issued.user.email,
        forwarderName: issued.forwarderName,
        token: issued.credential.token,
      });
    }
  }

  const payload: ApiSuccess<{ requested: true }> = { success: true, data: { requested: true } };
  res.json(payload);
});

/** POST /api/portal/auth/complete-reset */
portalAuthRouter.post('/complete-reset', async (req, res) => {
  const tenant = tenantOf(req);
  const { token, password } = completeResetSchema.parse(req.body);

  const changed = await withTenant(tenant.id, async (db) => {
    const redeemed = await redeemCredentialToken(db, {
      tenantId: tenant.id,
      purpose: 'RESET',
      token,
    });
    if (redeemed === null) return null;

    const user = await db.user.findFirst({
      where: { id: redeemed.userId, agentId: { not: null }, deletedAt: null },
      select: { id: true, tokenVersion: true },
    });
    if (user === null) return null;

    await db.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(password),
        // Every open session dies with the old password. That is the point of a
        // reset: whoever had it no longer does.
        tokenVersion: user.tokenVersion + 1,
      },
    });
    await db.userCredentialToken.update({
      where: { id: redeemed.tokenId },
      data: { usedAt: new Date() },
    });

    return user.id;
  });

  if (changed === null) {
    throw new HttpError(
      400,
      'RESET_INVALID',
      'That reset link has expired or has already been used. Ask for a new one.',
    );
  }

  await recordAudit({
    tenantId: tenant.id,
    action: 'PASSWORD_RESET_COMPLETED',
    tableName: 'user',
    recordId: changed,
    actorId: changed,
    details: { ip: req.ip ?? null },
  });

  const payload: ApiSuccess<{ reset: true }> = { success: true, data: { reset: true } };
  res.json(payload);
});
