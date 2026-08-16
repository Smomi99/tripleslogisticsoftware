import { Router } from 'express';

import type { ApiSuccess } from '@ff/shared';

import { HttpError } from '../lib/http-error';
import { resolveTenant } from '../middleware/resolve-tenant';
import { authRouter } from './auth.route';

/**
 * Every tenant-scoped route mounts under this router, so tenant resolution
 * cannot be forgotten on a new endpoint. Business routers are added here from
 * Phase 3 onward, each with its own requirePermission guard (CLAUDE.md §7).
 */
export const tenantRouter: Router = Router();

tenantRouter.use(resolveTenant);

// Sign-in happens before there is a session, so this sits inside the tenant
// router but outside `authenticate`.
tenantRouter.use('/auth', authRouter);

interface TenantContextPayload {
  id: string;
  status: string;
}

/** Which workspace the caller resolved to. Feeds the §12 top bar. */
tenantRouter.get('/context', (req, res) => {
  if (req.tenant === undefined) {
    throw new HttpError(500, 'TENANT_CONTEXT_MISSING', 'Tenant was not resolved.');
  }
  const payload: ApiSuccess<TenantContextPayload> = {
    success: true,
    // BigInt is not JSON-serialisable; ids cross the wire as strings.
    data: { id: req.tenant.id.toString(), status: req.tenant.status },
  };
  res.json(payload);
});
