import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { disconnectDatabase } from './lib/prisma';

const app = createApp();

const server = app.listen(env.API_PORT, () => {
  logger.info(`API listening on http://localhost:${env.API_PORT} (${env.NODE_ENV})`);
});

/** Finish in-flight requests and close the pool before exiting. */
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received — shutting down`);
  server.close(() => {
    void disconnectDatabase().then(() => process.exit(0));
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
