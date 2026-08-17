import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Lists — and with --delete, removes — the workspace-owned rows in the five
 * §3.1 lookups.
 *
 * For clearing verification detritus out of a development database. It runs as
 * the owner role and hard-deletes, which is exactly what CLAUDE.md §4 rule 3
 * forbids the application from doing; that rule governs the product, not a
 * developer's own scratch data. Never point this at anything shared.
 */
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const TABLES = ['goods_type', 'container_type', 'rate_tier', 'tos', 'inquiry_source'] as const;

for (const table of TABLES) {
  const display = table === 'rate_tier' ? 'label' : 'name';
  const rows = await db.$queryRawUnsafe<{ code: string; display: string }[]>(
    `SELECT code, ${display} AS display FROM "${table}" WHERE tenant_id IS NOT NULL`,
  );
  console.log(
    `${table.padEnd(16)} ${rows.length} workspace row(s)` +
      (rows.length > 0 ? `: ${rows.map((r) => `${r.code} (${r.display})`).join(', ')}` : ''),
  );
}

if (process.argv.includes('--delete')) {
  // rate_tier references container_type, so it goes first.
  await db.$executeRawUnsafe(`DELETE FROM rate_tier WHERE tenant_id IS NOT NULL`);
  for (const table of TABLES) {
    if (table === 'rate_tier') continue;
    await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IS NOT NULL`);
  }
  console.log('\ndeleted');
}

await db.$disconnect();
