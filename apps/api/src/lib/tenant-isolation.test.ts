import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { prisma } from './prisma';
import {
  PLATFORM_MODELS,
  requireTenantId,
  SYSTEM_CAPABLE_MODELS,
  TENANT_OWNED_MODELS,
  tierOf,
} from './tenancy';
import { resolveTenantBySlug, withTenant } from './tenant-client';

/**
 * The two-tenant isolation suite CLAUDE.md §7A rule 4 makes mandatory before
 * any module ships.
 *
 * It seeds two tenants, then asserts that acting as tenant A never yields a row
 * of tenant B — through the Prisma extension (layer one) and independently
 * through raw SQL (layer two, RLS), so a bug in either layer is still caught.
 */

const SLUG_A = 'test-alpha';
const SLUG_B = 'test-beta';

let tenantA: bigint;
let tenantB: bigint;

/**
 * Owner connection (ff_erp). Bypasses RLS because it owns the tables, which is
 * exactly why the API must NOT use it — see DATABASE_URL_APP. Used here only to
 * seed both tenants and to assert from outside the tenant boundary.
 */
const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

async function seedTenant(name: string, slug: string): Promise<bigint> {
  const row = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh' },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  await cleanup();

  tenantA = await seedTenant('Alpha Freight', SLUG_A);
  tenantB = await seedTenant('Beta Logistics', SLUG_B);

  // A system row: no tenant, visible to everybody (§7A rule 7).
  await owner.port.create({
    data: {
      code: 'PL-SYS-TEST',
      name: 'Test System Port',
      portCode: 'TSTSYS',
      country: 'Singapore',
      type: 'SEAPORT',
    },
  });

  // One private port each, same shape, so only tenancy distinguishes them.
  await owner.port.createMany({
    data: [
      {
        tenantId: tenantA,
        code: 'PL-A-001',
        name: 'Alpha Private Port',
        portCode: 'ALPHAP',
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
      {
        tenantId: tenantB,
        code: 'PL-B-001',
        name: 'Beta Private Port',
        portCode: 'BETAPP',
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
    ],
  });

  // Tenant-owned data on both sides.
  for (const [tenantId, label] of [
    [tenantA, 'Alpha'],
    [tenantB, 'Beta'],
  ] as const) {
    const sector = await owner.industrySector.create({
      data: { tenantId, code: `ISC-${label}`, name: `${label} Garments` },
      select: { id: true },
    });
    await owner.customer.create({
      data: {
        tenantId,
        code: `CUS-${label}`,
        name: `${label} Apparel Ltd`,
        country: 'Bangladesh',
        customerType: 'EXPORTER',
        businessArea: 'OUTBOUND',
        industrySectorId: sector.id,
      },
    });
  }
});

/**
 * Scoped to this suite's own tenants, NOT to a code prefix.
 *
 * It originally matched `code LIKE 'CUS-%'` and `'ISC-%'`, which were unique to
 * this test until those became the real business-code prefixes in Phase 6 — at
 * which point the suite started deleting live application rows. A foreign key
 * caught it, which is the argument for §4 rule 5 in one line.
 *
 * The only rows not covered by tenant scope are the deliberately shared test
 * rows (tenant_id IS NULL), which carry a code no real row uses.
 */
async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  await owner.$executeRawUnsafe(`DELETE FROM customer WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM commodity_item WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM industry_sector WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM port WHERE tenant_id IS NULL AND code = 'PL-SYS-TEST'`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
  await prisma.$disconnect();
});

describe('model tier registry', () => {
  it('covers every table in the database', async () => {
    // Checked against the database rather than the client, so adding a table
    // and forgetting tenancy.ts fails here instead of shipping unscoped.
    const known = [...PLATFORM_MODELS, ...SYSTEM_CAPABLE_MODELS, ...TENANT_OWNED_MODELS];
    const toSnake = (s: string): string =>
      s.replace(/[A-Z]/g, (c, i: number) => (i === 0 ? c.toLowerCase() : `_${c.toLowerCase()}`));

    // BASE TABLE only: a view is not a model and has no tenancy tier. Views
    // are not waved through, though — the test below pins every one of them.
    const rows = await owner.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> '_prisma_migrations'
    `;
    const inDb = new Set(rows.map((r) => r.table_name));
    const mapped = new Set(known.map(toSnake));

    const missingFromRegistry = [...inDb].filter((t) => !mapped.has(t));
    const missingFromDb = [...mapped].filter((t) => !inDb.has(t));

    expect(missingFromRegistry, `tables absent from tenancy.ts: ${missingFromRegistry.join(', ')}`).toEqual([]);
    expect(missingFromDb, `registry names with no table: ${missingFromDb.join(', ')}`).toEqual([]);
    expect(known.length).toBe(60);
  });

  it('applies the caller row level security to every view', async () => {
    // A view runs with its OWNER's privileges unless security_invoker is set,
    // and the owner here is the table owner, who bypasses RLS entirely. A view
    // added without it would hand every caller every row in the workspace —
    // silently, and only over the columns someone thought were safe.
    const views = await owner.$queryRaw<{ viewname: string; invoker: string | null }[]>`
      SELECT c.relname AS viewname,
             (SELECT option_value FROM pg_options_to_table(c.reloptions)
               WHERE option_name = 'security_invoker') AS invoker
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'v'
       ORDER BY c.relname`;

    expect(views.map((v) => v.viewname)).toEqual([
      'agent_inquiry_v',
      'agent_inquiry_volume_v',
    ]);
    for (const view of views) {
      expect(view.invoker, view.viewname).toBe('true');
    }
  });

  it('grants the application read and nothing else on a view', async () => {
    // ALTER DEFAULT PRIVILEGES grants SELECT, INSERT and UPDATE on "TABLES",
    // which in Postgres includes views — and both of these are simple enough
    // to be auto-updatable, so those grants were a write path through to the
    // base tables over columns chosen only for reading. A view that exists to
    // narrow what can be READ must never be a way to write.
    const grants = await owner.$queryRaw<{ table_name: string; privilege_type: string }[]>`
      SELECT t.table_name, p.privilege_type
        FROM information_schema.views t
        LEFT JOIN information_schema.table_privileges p
          ON p.table_name = t.table_name AND p.grantee = 'ff_app'
       WHERE t.table_schema = 'public'
       ORDER BY t.table_name, p.privilege_type`;

    const byView = new Map<string, string[]>();
    for (const row of grants) {
      byView.set(row.table_name, [...(byView.get(row.table_name) ?? []), row.privilege_type]);
    }
    expect(byView.size).toBeGreaterThan(0);
    for (const [view, privileges] of byView) {
      expect(privileges, view).toEqual(['SELECT']);
    }
  });

  it('classifies each tier correctly', () => {
    expect(tierOf('Customer')).toBe('tenant-owned');
    expect(tierOf('Port')).toBe('system-capable');
    expect(tierOf('Permission')).toBe('platform');
    expect(tierOf('NotAModel')).toBeUndefined();
  });
});

describe('§4 rule 10 — cross-tenant parent guard', () => {
  /**
   * A tenant-owned row pointing at a system-capable parent cannot have the
   * composite (tenant_id, id) foreign key the rule asks for: a shared port has
   * tenant_id NULL and the reference would never resolve. Neither the plain FK
   * nor RLS notices when such a reference names another workspace's private
   * row — the FK check bypasses RLS, and the policy tests the CHILD's tenant.
   * A trigger per edge is what closes it.
   */
  it('guards every tenant-owned reference to a system-capable parent', async () => {
    // Read from the catalogue, not from a list — a table added next month is
    // covered by this test the day it exists, which is the point.
    const edges = await owner.$queryRaw<{ child: string; col: string; guarded: boolean }[]>`
      WITH cols AS (
        SELECT c.relname AS tbl, a.attname, a.attnotnull
          FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
         WHERE c.relkind = 'r' AND a.attname = 'tenant_id' AND a.attnum > 0),
      edges AS (
        SELECT con.conrelid::regclass::text AS child,
               (SELECT att.attname FROM unnest(con.conkey) k
                  JOIN pg_attribute att
                    ON att.attrelid = con.conrelid AND att.attnum = k) AS col
          FROM pg_constraint con
         WHERE con.contype = 'f'
           AND array_length(con.conkey, 1) = 1
           AND con.conrelid::regclass::text IN (SELECT tbl FROM cols WHERE attnotnull)
           AND con.confrelid::regclass::text IN (SELECT tbl FROM cols WHERE NOT attnotnull))
      SELECT child, col, EXISTS (
               SELECT 1 FROM pg_trigger t
                WHERE t.tgrelid = child::regclass
                  AND NOT t.tgisinternal
                  AND t.tgname = child || '_' || col || '_tenant_guard') AS guarded
        FROM edges
    `;

    // Without this the test passes when the query finds nothing at all, which
    // is how a coverage check quietly stops covering anything.
    expect(edges.length).toBeGreaterThanOrEqual(28);

    const unguarded = edges.filter((e) => !e.guarded).map((e) => `${e.child}.${e.col}`);
    expect(unguarded, `references with no tenant guard: ${unguarded.join(', ')}`).toEqual([]);
  });

  it('refuses a row whose parent belongs to another tenant', async () => {
    // Written through the OWNER client, which bypasses both the Prisma
    // extension and RLS — so this exercises the database on its own, with
    // every application layer removed.
    const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null } });
    const carrierOfB = await owner.carrier.create({
      data: { tenantId: tenantB, code: 'GUARD-CAR', name: 'Beta Only Line', typeId: carrierType.id },
      select: { id: true },
    });

    await expect(
      owner.vessel.create({
        data: {
          tenantId: tenantA,
          code: 'GUARD-VSL',
          name: 'Trespasser',
          carrierId: carrierOfB.id,
        },
      }),
    ).rejects.toThrow(/cross-tenant reference/);

    // And the same reference is fine once it points at a shared carrier.
    const shared = await owner.carrier.findFirstOrThrow({ where: { tenantId: null } });
    const ok = await owner.vessel.create({
      data: { tenantId: tenantA, code: 'GUARD-VSL', name: 'Legitimate', carrierId: shared.id },
      select: { id: true },
    });

    await owner.vessel.delete({ where: { id: ok.id } });
    await owner.carrier.delete({ where: { id: carrierOfB.id } });
  });
});

describe('layer 1 — Prisma tenant extension', () => {
  it('returns only the acting tenant rows from a list query', async () => {
    const aCustomers = await withTenant(tenantA, (db) =>
      db.customer.findMany({ select: { name: true, tenantId: true } }),
    );
    expect(aCustomers).toHaveLength(1);
    expect(aCustomers[0]?.name).toBe('Alpha Apparel Ltd');
    expect(aCustomers.every((c) => c.tenantId === tenantA)).toBe(true);

    const bCustomers = await withTenant(tenantB, (db) =>
      db.customer.findMany({ select: { name: true } }),
    );
    expect(bCustomers).toHaveLength(1);
    expect(bCustomers[0]?.name).toBe('Beta Apparel Ltd');
  });

  it('counts only the acting tenant rows', async () => {
    expect(await withTenant(tenantA, (db) => db.customer.count())).toBe(1);
    expect(await withTenant(tenantB, (db) => db.customer.count())).toBe(1);
  });

  it('refuses to hand over another tenant row by id', async () => {
    const beta = await owner.customer.findFirst({
      where: { tenantId: tenantB },
      select: { id: true },
    });
    expect(beta).not.toBeNull();

    const leaked = await withTenant(tenantA, (db) =>
      db.customer.findUnique({ where: { id: beta!.id } }),
    );
    expect(leaked).toBeNull();
  });

  it('overrides a caller-supplied tenantId with the acting tenant', async () => {
    // Claims tenant B while acting as tenant A. The extension must overwrite
    // it rather than trust the caller — the §7A rule 1 failure mode, expressed
    // as a write instead of a read.
    const created = await withTenant(tenantA, (db) =>
      db.industrySector.create({
        data: { tenantId: tenantB, code: 'ISC-Alpha2', name: 'Alpha Leather' },
        select: { tenantId: true },
      }),
    );
    expect(created.tenantId).toBe(tenantA);
  });

  it('cannot update another tenant row', async () => {
    const beta = await owner.customer.findFirst({
      where: { tenantId: tenantB },
      select: { id: true },
    });
    const result = await withTenant(tenantA, (db) =>
      db.customer.updateMany({ where: { id: beta!.id }, data: { name: 'Hijacked' } }),
    );
    expect(result.count).toBe(0);

    const untouched = await owner.customer.findUnique({ where: { id: beta!.id } });
    expect(untouched?.name).toBe('Beta Apparel Ltd');
  });

  it('shows system rows to every tenant but keeps private rows private', async () => {
    const aPorts = await withTenant(tenantA, (db) =>
      db.port.findMany({ where: { OR: [{ code: 'PL-SYS-TEST' }, { code: { startsWith: 'PL-' } }] }, select: { code: true } }),
    );
    const codes = aPorts.map((p) => p.code);
    expect(codes).toContain('PL-SYS-TEST');
    expect(codes).toContain('PL-A-001');
    expect(codes).not.toContain('PL-B-001');
  });

  it('blocks hard deletes (§4 rule 3)', async () => {
    await expect(
      withTenant(tenantA, (db) => db.customer.deleteMany({ where: {} })),
    ).rejects.toThrow(/not allowed/i);
  });

  it('denies by default outside a tenant context', () => {
    // Nothing established a context, so resolving one must throw rather than
    // fall back to an unscoped read.
    expect(() => requireTenantId()).toThrow(/tenant context/i);
  });
});

describe('layer 2 — Postgres RLS, independent of the extension', () => {
  /**
   * These bypass the extension entirely and speak SQL as ff_app, proving the
   * net catches a query where a developer forgot the where clause.
   */
  it('returns only the acting tenant rows from raw SQL', async () => {
    const rows = await withTenant(tenantA, (db) =>
      db.$queryRaw<{ name: string }[]>`SELECT name FROM customer`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Alpha Apparel Ltd');
  });

  it('yields nothing when app.tenant_id is unset — denies, never falls open', async () => {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM customer
    `;
    expect(rows[0]?.count).toBe(0n);
  });

  it('refuses a cross-tenant insert at the database', async () => {
    await expect(
      withTenant(tenantA, async (db) => {
        await db.$executeRaw`
          INSERT INTO industry_sector (tenant_id, code, name, updated_at)
          VALUES (${tenantB}, 'ISC-Smuggled', 'Smuggled', now())
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('will not let a tenant create a system row', async () => {
    await expect(
      withTenant(tenantA, async (db) => {
        await db.$executeRaw`
          INSERT INTO port (tenant_id, code, name, port_code, country, type, updated_at)
          VALUES (NULL, 'PL-FAKE-SYS', 'Fake System Port', 'FAKESY', 'X', 'SEAPORT', now())
        `;
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('grants the app role DELETE on pure join tables and nowhere else', async () => {
    /*
     * §4 rule 3 is enforced by privilege, not discipline: ff_app simply cannot
     * DELETE a business record. The exception is M:N join rows, which have no
     * is_active or deleted_at to soft-delete with and reference nothing, so
     * deselecting one can only mean removing it. The list is enumerated so that
     * granting DELETE on a real table fails this test rather than passing
     * quietly.
     */
    const allowed = [
      'agent_expert_area',
      'agent_network_member',
      'agent_port_coverage',
      // An inquiry's recipients are the same shape: a link with no is_active,
      // no deleted_at and nothing referencing it, rewritten wholesale each time
      // the inquiry is saved. Unticking an agent can only mean removing the row.
      'inquiry_party',
      'inquiry_party_contact',
      'role_permission',
      'user_permission',
    ];

    const rows = await owner.$queryRaw<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.table_privileges
      WHERE grantee = 'ff_app' AND privilege_type = 'DELETE'
      ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual(allowed);
  });

  it('does not own any table, so policies actually bind', async () => {
    const rows = await owner.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'ff_app'
    `;
    expect(rows[0]?.count).toBe(0n);
  });
});

describe('tenant resolution', () => {
  it('resolves a slug to its tenant', async () => {
    const resolved = await resolveTenantBySlug(SLUG_A);
    expect(resolved?.id).toBe(tenantA);
    expect(resolved?.status).toBe('TRIAL');
  });

  it('returns null for an unknown slug', async () => {
    expect(await resolveTenantBySlug('no-such-workspace')).toBeNull();
  });
});
