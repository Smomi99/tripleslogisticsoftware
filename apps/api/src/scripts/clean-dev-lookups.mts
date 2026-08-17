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

const rates = await db.$queryRawUnsafe<{ code: string; status: string; deleted: boolean }[]>(
  `SELECT code, status::text AS status, (deleted_at IS NOT NULL) AS deleted FROM freight_rate ORDER BY code`,
);
console.log(
  `freight_rate     ${rates.length} row(s)` +
    (rates.length > 0
      ? `: ${rates.map((r) => `${r.code} (${r.status}${r.deleted ? ', deleted' : ''})`).join(', ')}`
      : ''),
);

const inquiries = await db.$queryRawUnsafe<{ code: string; customer: string }[]>(
  `SELECT i.code, c.name AS customer
     FROM inquiry i JOIN customer c ON c.id = i.customer_id
    ORDER BY i.code`,
);
console.log(
  `inquiry          ${inquiries.length} row(s)` +
    (inquiries.length > 0
      ? `: ${inquiries.map((i) => `${i.code} (${i.customer})`).join(', ')}`
      : ''),
);

/** --inquiry=INQ-2026-000001 removes one inquiry and its child rows. */
const inquiryFlag = process.argv.find((a) => a.startsWith('--inquiry='));
if (inquiryFlag !== undefined) {
  const code = inquiryFlag.slice('--inquiry='.length);
  if (!/^[A-Z0-9-]{1,32}$/.test(code)) throw new Error(`Refusing an odd inquiry code: ${code}`);
  const scope = `(SELECT id FROM inquiry WHERE code = $1)`;
  for (const table of ['inquiry_rate', 'inquiry_followup', 'inquiry_volume']) {
    await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE inquiry_id IN ${scope}`, code);
  }
  await db.$executeRawUnsafe(`DELETE FROM inquiry WHERE code = $1`, code);
  console.log(`\nremoved ${code}`);
}

const leads = await db.$queryRawUnsafe<{ code: string; name: string }[]>(
  `SELECT code, name FROM sales_lead ORDER BY code`,
);
console.log(
  `sales_lead       ${leads.length} row(s)` +
    (leads.length > 0 ? `: ${leads.map((l) => `${l.code} (${l.name})`).join(', ')}` : ''),
);

/** --lead=LED-001 removes a lead and its follow-ups, if no inquiry cites it. */
const leadFlag = process.argv.find((a) => a.startsWith('--lead='));
if (leadFlag !== undefined) {
  const code = leadFlag.slice('--lead='.length);
  if (!/^[A-Z0-9-]{1,32}$/.test(code)) throw new Error(`Refusing an odd lead code: ${code}`);
  await db.$executeRawUnsafe(
    `DELETE FROM sales_lead_followup
      WHERE lead_id IN (SELECT id FROM sales_lead WHERE code = $1)`,
    code,
  );
  const removed = await db.$executeRawUnsafe(
    `DELETE FROM sales_lead
      WHERE code = $1
        AND NOT EXISTS (SELECT 1 FROM inquiry WHERE inquiry.lead_id = sales_lead.id)`,
    code,
  );
  console.log(`\nremoved ${removed} lead row(s) coded ${code}`);
}

/** --customer=NAME removes a customer with no inquiries against it. */
const customerFlag = process.argv.find((a) => a.startsWith('--customer='));
if (customerFlag !== undefined) {
  const name = customerFlag.slice('--customer='.length);
  const removed = await db.$executeRawUnsafe(
    `DELETE FROM customer
      WHERE name = $1
        AND NOT EXISTS (SELECT 1 FROM inquiry WHERE inquiry.customer_id = customer.id)`,
    name,
  );
  console.log(`\nremoved ${removed} customer row(s) named ${name}`);
}

/** --rate=RATE-001 removes one rate outright, for clearing a test entry. */
const rateFlag = process.argv.find((a) => a.startsWith('--rate='));
if (rateFlag !== undefined) {
  const code = rateFlag.slice('--rate='.length);
  if (!/^[A-Z0-9-]{1,32}$/.test(code)) throw new Error(`Refusing an odd rate code: ${code}`);
  // superseded_by_id is a self-reference (§4 rule 1), so break any chain
  // pointing at this rate first — otherwise deleting a successor before its
  // predecessor fails on the foreign key.
  await db.$executeRawUnsafe(
    `UPDATE freight_rate SET superseded_by_id = NULL
      WHERE superseded_by_id IN (SELECT id FROM freight_rate WHERE code = $1)`,
    code,
  );
  await db.$executeRawUnsafe(
    `DELETE FROM rate_profit_log WHERE rate_line_id IN (
       SELECT l.id FROM freight_rate_line l JOIN freight_rate r ON r.id = l.rate_id WHERE r.code = $1)`,
    code,
  );
  await db.$executeRawUnsafe(
    `DELETE FROM rate_local_charge WHERE rate_id IN (SELECT id FROM freight_rate WHERE code = $1)`,
    code,
  );
  await db.$executeRawUnsafe(
    `DELETE FROM freight_rate_line WHERE rate_id IN (SELECT id FROM freight_rate WHERE code = $1)`,
    code,
  );
  await db.$executeRawUnsafe(`DELETE FROM freight_rate WHERE code = $1`, code);
  console.log(`\nremoved ${code}`);
}

if (process.argv.includes('--delete')) {
  // Soft-deleted rates are invisible to the app but still hold their code, so
  // clearing them keeps a development database's numbering tidy.
  await db.$executeRawUnsafe(
    `DELETE FROM rate_local_charge WHERE rate_id IN (SELECT id FROM freight_rate WHERE deleted_at IS NOT NULL)`,
  );
  await db.$executeRawUnsafe(
    `DELETE FROM freight_rate_line WHERE rate_id IN (SELECT id FROM freight_rate WHERE deleted_at IS NOT NULL)`,
  );
  await db.$executeRawUnsafe(`DELETE FROM freight_rate WHERE deleted_at IS NOT NULL`);

  // rate_tier references container_type, so it goes first.
  await db.$executeRawUnsafe(`DELETE FROM rate_tier WHERE tenant_id IS NOT NULL`);
  for (const table of TABLES) {
    if (table === 'rate_tier') continue;
    await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IS NOT NULL`);
  }
  console.log('\ndeleted');
}

await db.$disconnect();
