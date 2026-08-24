import { createApp } from './app';
import { env } from './config/env';
import { startMailWorker, stopMailWorker } from './lib/email-queue';
import { logger } from './lib/logger';
import { disconnectDatabase } from './lib/prisma';

const app = createApp();

const server = app.listen(env.API_PORT, () => {
  logger.info(`API listening on http://localhost:${env.API_PORT} (${env.NODE_ENV})`);
});

/*
 * The outbox drains in the API process rather than in a service of its own.
 *
 * Two containers running this is safe — app_claim_email_batch takes rows with
 * FOR UPDATE SKIP LOCKED, so each takes what the other has not. Splitting it
 * out becomes worth doing when mail volume justifies a second thing to deploy
 * and monitor, and not before.
 */
startMailWorker();

/** Finish in-flight requests and close the pool before exiting. */
async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received — shutting down`);
  // Stop taking new mail before closing the pool the sender needs.
  stopMailWorker();
  server.close(() => {
    void disconnectDatabase().then(() => process.exit(0));
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
