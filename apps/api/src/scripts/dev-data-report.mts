import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * What is actually in the development database, beyond what the seed puts
 * there. Written after a browser check surfaced a port code no seed defines —
 * leftovers from an aborted test run look exactly like real data until you
 * count them.
 */
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const ports = await db.port.findMany({
  select: { id: true, code: true, portCode: true, name: true, type: true, tenantId: true },
  orderBy: [{ type: 'asc' }, { portCode: 'asc' }],
});
console.log(`port  ${ports.length} row(s)`);
for (const p of ports) {
  console.log(
    `  ${p.type.padEnd(8)} ${p.portCode.padEnd(8)} ${p.code.padEnd(10)} ${
      p.tenantId === null ? 'shared   ' : `tenant ${p.tenantId}`
    } ${p.name}`,
  );
}

for (const [label, rows] of [
  ['carrier', await db.carrier.findMany({ select: { code: true, name: true, tenantId: true } })],
  ['goods_type', await db.goodsType.findMany({ select: { code: true, name: true, tenantId: true } })],
] as const) {
  console.log(`\n${label}  ${rows.length} row(s)`);
  for (const r of rows) {
    console.log(`  ${r.code.padEnd(12)} ${r.tenantId === null ? 'shared' : `tenant ${r.tenantId}`}  ${r.name}`);
  }
}

await db.$disconnect();
