import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { healthRouter } from './routes/health.route';
import { tenantRouter } from './routes/tenant.route';

export function createApp(): Express {
  const app = express();

  // Behind a reverse proxy in production; needed for correct client IPs.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      // Required for the httpOnly refresh-token cookie (CLAUDE.md §2).
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // Health is deliberately outside the tenant router — Docker and uptime checks
  // have no workspace.
  app.use('/api', healthRouter);

  // Everything tenant-scoped goes under here, behind tenant resolution.
  app.use('/api/tenant', tenantRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
