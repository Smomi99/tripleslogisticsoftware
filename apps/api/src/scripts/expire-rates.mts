import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { EXPIRING_SOON_DAYS } from '@ff/shared';
import { expireLapsedRates, ratesExpiringSoon } from '../lib/rate-expiry';

/**
 * The §4 rule 3 nightly job, as a command.
 *
 * Run it from cron, a container scheduler, or by hand:
 *   pnpm --filter @ff/api rates:expire
 *
 * No scheduler is wired up here on purpose — how this gets invoked is a
 * deployment decision, and CLAUDE.md §2 fixes the stack without naming one.
 * Keeping the job a plain idempotent command means it can be driven by whatever
 * the client's hosting provides, and re-run safely if a night is missed.
 */
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const result = await expireLapsedRates(db);
console.log(`[${result.asOf}] expired ${result.expired} lapsed rate(s)`);

const soon = await ratesExpiringSoon(db, EXPIRING_SOON_DAYS);
if (soon.length > 0) {
  console.log(`\n${soon.length} rate(s) lapse within ${EXPIRING_SOON_DAYS} days:`);
  for (const rate of soon) {
    console.log(`  workspace ${rate.tenantId}  ${rate.code}  until ${rate.validTo}`);
  }
}

await db.$disconnect();
