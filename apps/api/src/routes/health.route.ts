import { Router } from 'express';

import type { ApiSuccess } from '@ff/shared';

import { checkDatabase } from '../lib/prisma';

export const healthRouter: Router = Router();

interface HealthPayload {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  uptimeSeconds: number;
}

/** Liveness + database reachability. No auth — used by Docker and by humans. */
healthRouter.get('/health', async (_req, res) => {
  const database = (await checkDatabase()) ? 'up' : 'down';
  const payload: ApiSuccess<HealthPayload> = {
    success: true,
    data: {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      uptimeSeconds: Math.round(process.uptime()),
    },
  };
  res.status(database === 'up' ? 200 : 503).json(payload);
});
