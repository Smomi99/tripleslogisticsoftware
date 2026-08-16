import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

import { isProduction, runtimeDatabaseUrl } from '../config/env';
import { logger } from './logger';

/**
 * Prisma 7 connects through a driver adapter rather than a connection string.
 * The pool lives here so Phase 2 can set `app.tenant_id` per transaction for
 * the RLS policies (CLAUDE.md §7A rule 2).
 */
const adapter = new PrismaPg({ connectionString: runtimeDatabaseUrl });

/**
 * The raw Prisma client.
 *
 * CLAUDE.md §7A rule 3: feature code must NOT import this. From Phase 2 it is
 * wrapped in a tenant-scoped extension that injects `tenant_id` into every
 * where/create/update, and that wrapper is the only thing route handlers see.
 * It stays exported here solely for migrations, seeding and health checks.
 */
export const prisma = new PrismaClient({
  adapter,
  log: isProduction ? ['warn', 'error'] : ['warn', 'error'],
});

/** Used by the health endpoint — cheap round trip, no table dependency. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'Database health check failed');
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
