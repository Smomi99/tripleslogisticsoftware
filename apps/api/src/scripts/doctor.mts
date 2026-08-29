import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Does the database match the code that is about to talk to it?
 *
 * Written after a production deploy answered 500 on every customer read and
 * write. The cause was ordinary — the image was rebuilt and the migrations were
 * not, so the code selected two columns the database did not have — but the
 * browser showed only "500", and the one fact that would have settled it in a
 * minute was several levels down in a container log.
 *
 * So this reports that fact as a sentence, and does it for every model rather
 * than the one table that happened to break: any deploy where the schema is
 * behind the code is named here, by table and column.
 *
 * Read-only. It creates nothing and changes nothing, which is what makes it
 * safe to run against production whenever something looks wrong.
 *
 *   pnpm exec tsx apps/api/src/scripts/doctor.mts
 *
 * On the VPS, through the tools container:
 *
 *   $COMPOSE run --rm tools pnpm exec tsx apps/api/src/scripts/doctor.mts
 */

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });

let problems = 0;
const say = (line: string) => console.log(line);
const bad = (line: string) => {
  problems += 1;
  console.log(`  FAIL  ${line}`);
};
const good = (line: string) => console.log(`  ok    ${line}`);

// ---------------------------------------------------------------- migrations
say('');
say('=== migrations ===');

const rows = await db.$queryRaw<
  { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
>`SELECT migration_name, finished_at, rolled_back_at
    FROM _prisma_migrations ORDER BY started_at`;

/*
 * Grouped by name, because a migration that failed once and was then fixed and
 * re-applied leaves both rows behind. Only a name with no successful row at
 * all is a problem — that is the state that blocks every later migration.
 */
const succeeded = new Set(
  rows.filter((r) => r.finished_at !== null && r.rolled_back_at === null).map((r) => r.migration_name),
);
const stuck = [...new Set(rows.map((r) => r.migration_name))].filter((n) => !succeeded.has(n));

say(`  ${succeeded.size} applied`);
if (stuck.length > 0) {
  for (const name of stuck) bad(`never applied successfully: ${name}`);
  say('        A failed migration blocks every later one, so the schema will be');
  say('        stuck wherever it stopped. Resolve it with `prisma migrate resolve`');
  say('        before deploying again.');
} else {
  good('none left in a failed state');
}

// ------------------------------------------------- schema against the client
say('');
say('=== does the database have what the code selects? ===');

/*
 * What the code expects, read from schema.prisma itself.
 *
 * Prisma 7 no longer exposes the DMMF on the generated client, and a
 * hand-written list would fall behind the first model somebody added. Parsing
 * the schema keeps this honest with no edit here, ever.
 */
function expectedColumns(schema: string): Map<string, string[]> {
  const modelNames = new Set([...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!));
  const expected = new Map<string, string[]>();

  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const model = block[1]!;
    const body = block[2]!;
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? model;

    const columns: string[] = [];
    for (const line of body.split('\n')) {
      const text = line.trim();
      if (text === '' || text.startsWith('//') || text.startsWith('@@') || text.startsWith('///')) {
        continue;
      }
      const field = /^(\w+)\s+(\w+)(\[\])?\??/.exec(text);
      if (field === null) continue;
      const [, name, type, list] = field;
      // A relation is a join, not a column. Its own scalar (the foreign key) is
      // declared separately and gets checked on its own line.
      if (list !== undefined || modelNames.has(type!)) continue;
      columns.push(/@map\("([^"]+)"\)/.exec(text)?.[1] ?? name!);
    }
    expected.set(table, columns);
  }
  return expected;
}

// The schema sits at the repo root, two levels above apps/api.
const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');
const rootSchema = path.resolve(process.cwd(), '../../prisma/schema.prisma');
const schema = readFileSync(
  (() => {
    try {
      readFileSync(schemaPath);
      return schemaPath;
    } catch {
      return rootSchema;
    }
  })(),
  'utf8',
);

const actual = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public'`;
const byTable = new Map<string, Set<string>>();
for (const row of actual) {
  const set = byTable.get(row.table_name) ?? new Set<string>();
  set.add(row.column_name);
  byTable.set(row.table_name, set);
}

const missingTables: string[] = [];
const missingColumns: string[] = [];

for (const [table, columns] of expectedColumns(schema)) {
  const present = byTable.get(table);
  if (present === undefined) {
    missingTables.push(table);
    continue;
  }
  for (const column of columns) {
    if (!present.has(column)) missingColumns.push(`${table}.${column}`);
  }
}

for (const table of missingTables) bad(`table missing: ${table}`);
for (const column of missingColumns) bad(`column missing: ${column}`);
if (missingTables.length === 0 && missingColumns.length === 0) {
  good('every table and column the code expects is present');
} else {
  say('');
  say('        The code is ahead of the database — this is what answers 500 on');
  say('        every read and write of those tables. Run the migrations:');
  say('          $COMPOSE run --rm tools pnpm db:deploy');
  say('        then this script again, before restarting anything.');
}

// ------------------------------------------------------------ seeded lookups
say('');
say('=== seeded lookups ===');
const counts: [string, number][] = [
  ['permissions', await db.permission.count()],
  ['expert areas', await db.expertArea.count({ where: { tenantId: null } })],
  ['cost units', await db.costUnit.count({ where: { tenantId: null } })],
  ['carrier types', await db.carrierType.count({ where: { tenantId: null } })],
  ['email templates', await db.emailTemplate.count({ where: { tenantId: null } })],
];
for (const [label, n] of counts) {
  if (n === 0) bad(`${label}: none — run \`pnpm db:seed\``);
  else good(`${label}: ${n}`);
}

// ----------------------------------------------------------------- workspaces
say('');
say('=== workspaces ===');
for (const tenant of await db.tenant.findMany({
  select: { id: true, slug: true, name: true, status: true },
})) {
  const users = await db.user.count({ where: { tenantId: tenant.id } });
  say(`  ${tenant.slug.padEnd(16)} ${tenant.status.padEnd(10)} ${users} user(s)  ${tenant.name}`);
}

say('');
say('='.repeat(62));
say(problems === 0 ? '  Nothing to fix.' : `  ${problems} problem(s) above.`);
say('='.repeat(62));
say('');

await db.$disconnect();
process.exitCode = problems === 0 ? 0 : 1;
