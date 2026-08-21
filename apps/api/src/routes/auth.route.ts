import { Router } from 'express';

import {
  type ApiSuccess,
  type AuthenticatedUser,
  type LoginResponse,
  loginSchema,
} from '@ff/shared';

import { env, isProduction } from '../config/env';
import { recordAudit } from '../lib/audit';
import { HttpError } from '../lib/http-error';
import {
  REFRESH_COOKIE,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../lib/jwt';
import { verifyPassword } from '../lib/password';
import { loadAccount, resolvePermissions } from '../lib/permissions';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';

export const authRouter: Router = Router();

/** Refresh token lives in an httpOnly cookie, never in JS-readable storage. */
const refreshCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'lax',
  path: '/api/tenant/auth',
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

/**
 * POST /api/tenant/auth/login
 *
 * The tenant comes from the request's workspace (resolved upstream), never
 * from the body — §7A rule 1. Two users at two companies may share a username.
 */
authRouter.post('/login', async (req, res) => {
  const tenant = req.tenant;
  if (tenant === undefined) {
    throw new HttpError(500, 'TENANT_CONTEXT_MISSING', 'Tenant was not resolved.');
  }
  // A SUSPENDED workspace can still sign in on purpose: §7B makes suspension
  // read-only plus export, never a lockout, so the owner can always get their
  // data out. Enforcing read-only on write routes is Phase 10; sign-in is not
  // where that belongs.

  const { username, password } = loginSchema.parse(req.body);

  const result = await withTenant(tenant.id, async (db) => {
    const user = await db.user.findFirst({
      // agentId: null is part of the WHERE, not a check applied afterwards: an
      // agent credential cannot return a row here at all, so a stolen one is
      // useless at the staff door even if some later guard regresses.
      where: { username, agentId: null, deletedAt: null },
      select: {
        id: true,
        username: true,
        email: true,
        passwordHash: true,
        isActive: true,
        employee: { select: { name: true } },
        role: { select: { name: true } },
      },
    });

    // Verify a hash even when the user does not exist, so a missing account and
    // a wrong password take the same time and cannot be told apart.
    const hash =
      user?.passwordHash ??
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000';
    const passwordOk = await verifyPassword(password, hash);

    if (user === null || !passwordOk || !user.isActive) {
      // Recorded even when the username does not exist: a run of failures
      // against names that were never accounts is exactly what credential
      // stuffing looks like, and it is invisible if only real users are logged.
      // The attempted username is kept; the password never is.
      await recordAudit({
        tenantId: tenant.id,
        action: 'LOGIN_FAILURE',
        tableName: 'user',
        recordId: user?.id ?? null,
        actorId: null,
        details: {
          username,
          reason: user === null ? 'no-such-user' : !passwordOk ? 'bad-password' : 'inactive',
          ip: req.ip ?? null,
        },
      });
      return null;
    }

    const account = await loadAccount(db, user.id);
    if (account === null) return null;
    const access = await resolvePermissions(db, account);

    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    await recordAudit({
      tenantId: tenant.id,
      action: 'LOGIN_SUCCESS',
      tableName: 'user',
      recordId: user.id,
      actorId: user.id,
      details: { username: user.username, ip: req.ip ?? null },
    });

    return { user, access };
  });

  if (result === null) {
    throw HttpError.unauthorized('Incorrect username or password.');
  }

  const { user, access } = result;
  const permissions = [...access.permissions];

  const accessToken = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenant.id.toString(),
    isSuperadmin: access.isSuperadmin,
    permissions,
    tokenVersion: access.tokenVersion,
  });
  const refreshToken = await signRefreshToken({
    sub: user.id.toString(),
    tenantId: tenant.id.toString(),
    tokenVersion: access.tokenVersion,
  });

  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...refreshCookieOptions,
    maxAge: refreshMaxAgeMs(),
  });

  const payload: ApiSuccess<LoginResponse> = {
    success: true,
    data: {
      accessToken,
      user: {
        id: user.id.toString(),
        username: user.username,
        email: user.email,
        name: user.employee?.name ?? null,
        isSuperadmin: access.isSuperadmin,
        roleName: user.role?.name ?? null,
        permissions,
      },
    },
  };
  res.json(payload);
});

/** POST /api/tenant/auth/refresh — trades the cookie for a new access token. */
authRouter.post('/refresh', async (req, res) => {
  const cookies = req.cookies as Record<string, string | undefined>;
  const token = cookies[REFRESH_COOKIE];
  if (token === undefined) {
    throw HttpError.unauthorized('Sign in to continue.');
  }

  const claims = await verifyRefreshToken(token);
  const tenantId = BigInt(claims.tenantId);

  if (req.tenant !== undefined && req.tenant.id !== tenantId) {
    throw HttpError.forbidden('This session belongs to a different workspace.');
  }

  const access = await withTenant(tenantId, async (db) => {
    const account = await loadAccount(db, BigInt(claims.sub));
    if (account === null || !account.isActive) return null;
    return resolvePermissions(db, account);
  });

  if (access === null) {
    throw HttpError.unauthorized('This account is no longer active.');
  }
  // A permission change since the refresh token was issued invalidates it too.
  if (access.tokenVersion !== claims.tokenVersion) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
    throw HttpError.unauthorized('Your access has changed. Sign in again.');
  }

  const accessToken = await signAccessToken({
    sub: claims.sub,
    tenantId: claims.tenantId,
    isSuperadmin: access.isSuperadmin,
    permissions: [...access.permissions],
    tokenVersion: access.tokenVersion,
  });

  const payload: ApiSuccess<{ accessToken: string }> = {
    success: true,
    data: { accessToken },
  };
  res.json(payload);
});

/** POST /api/tenant/auth/logout */
authRouter.post('/logout', async (req, res) => {
  // Signing out carries no Authorization header, so the actor comes from the
  // refresh cookie — best effort. An expired or absent cookie still signs the
  // caller out; it simply cannot be attributed, and an unattributable logout is
  // not worth failing the request over.
  const token: unknown = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  if (typeof token === 'string' && token.length > 0) {
    try {
      const claims = await verifyRefreshToken(token);
      await recordAudit({
        tenantId: BigInt(claims.tenantId),
        action: 'LOGOUT',
        tableName: 'user',
        recordId: BigInt(claims.sub),
        actorId: BigInt(claims.sub),
      });
    } catch {
      // Nothing to attribute. Sign them out anyway.
    }
  }

  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
  const payload: ApiSuccess<{ signedOut: true }> = { success: true, data: { signedOut: true } };
  res.json(payload);
});

/** GET /api/tenant/auth/me — who the caller is, and what they may reach. */
authRouter.get('/me', authenticate, async (req, res) => {
  const auth = req.auth;
  if (auth === undefined) throw HttpError.unauthorized();

  const user = await withTenant(auth.tenantId, (db) =>
    db.user.findFirst({
      where: { id: auth.userId },
      select: {
        id: true,
        username: true,
        email: true,
        employee: { select: { name: true } },
        role: { select: { name: true } },
      },
    }),
  );

  if (user === null) throw HttpError.unauthorized();

  const payload: ApiSuccess<AuthenticatedUser> = {
    success: true,
    data: {
      id: user.id.toString(),
      username: user.username,
      email: user.email,
      name: user.employee?.name ?? null,
      isSuperadmin: auth.isSuperadmin,
      roleName: user.role?.name ?? null,
      permissions: [...auth.permissions],
    },
  };
  res.json(payload);
});
