import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { HttpError } from '../lib/http-error';

/**
 * Superadmin only — no permission key can substitute for it.
 *
 * §7's permission registry covers what staff may do to business records.
 * Handing an outside company a login is a different kind of decision: it widens
 * who can see the workspace at all, and there is no §7 feature that means "may
 * create accounts for people outside this company". Rather than invent one and
 * risk it being granted to a role by mistake, this is reserved to the
 * superadmin the way §7A's tenant boundary is.
 */
export const requireSuperadmin: RequestHandler = function guard(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const auth = req.auth;
  if (auth === undefined) throw HttpError.unauthorized();
  if (!auth.isSuperadmin) {
    throw HttpError.forbidden('Only a superadmin can manage portal access.');
  }
  next();
};
