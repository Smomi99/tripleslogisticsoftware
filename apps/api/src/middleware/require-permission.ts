import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { isPermissionKey } from '@ff/shared';

import { HttpError } from '../lib/http-error';

/**
 * Route guard (CLAUDE.md §7): "a route with no permission guard is a bug".
 *
 * Superadmin passes everything (§7 rule 1). Everyone else must hold the key,
 * where DENY has already been applied when the set was resolved at sign-in.
 */
export function requirePermission(key: string): RequestHandler {
  // Fail at startup, not at request time, if a route names a permission the
  // registry does not define — a typo would otherwise be a silent open door
  // only for the superadmin who never gets checked.
  if (!isPermissionKey(key)) {
    throw new Error(
      `Unknown permission "${key}". Add it to packages/shared/src/permissions.ts.`,
    );
  }

  return function guard(req: Request, _res: Response, next: NextFunction): void {
    const auth = req.auth;
    if (auth === undefined) {
      throw HttpError.unauthorized();
    }
    if (auth.isSuperadmin || auth.permissions.has(key)) {
      next();
      return;
    }
    throw HttpError.forbidden('You do not have permission to do this.');
  };
}
