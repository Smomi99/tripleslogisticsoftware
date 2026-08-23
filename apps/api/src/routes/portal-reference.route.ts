import { Router } from 'express';

import type { ApiSuccess, PortalCurrencyOption } from '@ff/shared';

import { isoCurrency } from '../lib/currency-label';
import { HttpError } from '../lib/http-error';
import { withAgent } from '../lib/tenant-client';
import { authenticatePortal } from '../middleware/authenticate';

/**
 * The little reference data an agent needs to fill in a quote form.
 *
 * Currently one endpoint. It is a separate router rather than a method on the
 * inquiry router so that the list of things an outside company can enumerate
 * stays visible in one file — the same reasoning as Phase 3's short policy list.
 */
export const portalReferenceRouter: Router = Router();

portalReferenceRouter.use(authenticatePortal);

/** GET /api/portal/currencies */
portalReferenceRouter.get('/', async (req, res) => {
  const auth = req.auth!;
  if (auth.agentId === null) throw HttpError.forbidden('This area is for agent accounts.');

  const rows = await withAgent(auth.tenantId, auth.agentId, (db) =>
    db.currency.findMany({
      where: { isActive: true, deletedAt: null },
      // Three columns. conversion, tenantRate and the rate history say
      // something about the forwarder's margins and are none of an agent's
      // business, so they are not selected rather than selected and dropped.
      select: { id: true, currency: true },
      orderBy: { currency: 'asc' },
    }),
  );

  const payload: ApiSuccess<PortalCurrencyOption[]> = {
    success: true,
    data: rows.map((row) => ({
      id: row.id.toString(),
      code: isoCurrency(row.currency),
      label: row.currency,
    })),
  };
  res.json(payload);
});
