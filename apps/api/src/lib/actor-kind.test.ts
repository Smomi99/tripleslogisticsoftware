import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

import { recordAudit } from './audit';

/**
 * CR-004: a session declares what kind it is, and an undeclared one is denied.
 *
 * Like agent-rls.test.ts, **nothing here goes through the application**. It
 * opens a raw connection as the runtime role `ff_app`, sets the session GUCs by
 * hand, and asks Postgres directly.
 *
 * The rule this file exists to pin down: `app_staff_tenant()` used to mean "not
 * an agent", so a customer session — which sets no agent id — was admitted by
 * all 81 staff policies. Measured before the fix: such a session read every
 * shipment, every customer and the whole `user` table including its password
 * hashes. Staff is now a positive claim, and absence denies.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

/** The runtime role. It owns nothing, so RLS actually applies to it (§7A). */
let app: Client;

const SLUG = 'actor-kind-alpha';

let tenantId: bigint;
let customerId: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of ['audit_log', 'customer', 'industry_sector', 'carrier', 'carrier_type']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
}

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await app.query(sql, params);
  return result.rows as Record<string, unknown>[];
}

async function count(table: string): Promise<number> {
  const result = await rows(`SELECT count(*)::int AS n FROM ${table}`);
  return result[0]?.['n'] as number;
}

/** Sets the session exactly as one of the with* helpers does at runtime. */
async function session(opts: {
  tenant?: bigint;
  agent?: bigint;
  customer?: bigint;
  kind?: string;
}): Promise<void> {
  await app.query(`SELECT set_config('app.tenant_id', $1, false)`, [
    opts.tenant?.toString() ?? '',
  ]);
  await app.query(`SELECT set_config('app.agent_id', $1, false)`, [opts.agent?.toString() ?? '']);
  await app.query(`SELECT set_config('app.customer_id', $1, false)`, [
    opts.customer?.toString() ?? '',
  ]);
  await app.query(`SELECT set_config('app.actor_kind', $1, false)`, [opts.kind ?? '']);
}

/** Every tenant-owned table a staff session can read in this fixture. */
const TENANT_OWNED = ['customer', 'industry_sector', 'audit_log'] as const;
/** A system-capable table: the 16 that keep the two-conjunct predicate. */
const SYSTEM_CAPABLE = 'carrier';

beforeAll(async () => {
  await cleanup();

  const tenant = await owner.tenant.create({
    data: { name: 'Actor Kind Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'AK-SEC', name: 'Actor Kind Sector' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'AK-CUS',
      name: 'Actor Kind Shipper',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  customerId = customer.id;

  // A tenant-private row on a system-capable table — the case the 16 policies
  // left in the old shape would have leaked to a customer session.
  const carrierType = await owner.carrierType.create({
    data: { tenantId, code: 'AK-CTY', name: 'Actor Kind Type' },
    select: { id: true },
  });
  await owner.carrier.create({
    data: { tenantId, code: 'AK-CAR', name: 'Actor Kind Lines', typeId: carrierType.id },
  });

  app = new Client({ connectionString: env.DATABASE_URL_APP ?? env.DATABASE_URL });
  await app.connect();
});

afterAll(async () => {
  await app?.end();
  await cleanup();
  await owner.$disconnect();
});

describe('the role these tests run as', () => {
  it('is not the table owner, or none of this would apply', async () => {
    const result = await rows(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    expect(result[0]?.['rolbypassrls']).toBe(false);
    expect(result[0]?.['rolsuper']).toBe(false);
  });
});

describe('a staff session is unchanged', () => {
  beforeAll(() => session({ tenant: tenantId, kind: 'STAFF' }));

  it('reads its own workspace', async () => {
    expect(await count('customer')).toBe(1);
    expect(await count('industry_sector')).toBe(1);
  });

  it('reads a tenant-private row on a system-capable table', async () => {
    expect(await count(SYSTEM_CAPABLE)).toBeGreaterThanOrEqual(1);
  });

  it('still cannot cross into a workspace it did not name', async () => {
    await session({ tenant: tenantId + 999_999n, kind: 'STAFF' });
    for (const table of TENANT_OWNED) expect(await count(table)).toBe(0);
  });
});

describe('an undeclared session is not staff', () => {
  /*
   * The whole point of CR-004, and the test that must fail against the bridge
   * migration and pass against the closed-world one. Before the fix this exact
   * session read the entire workspace.
   */
  beforeAll(() => session({ tenant: tenantId }));

  it('reads nothing from any tenant-owned table', async () => {
    for (const table of TENANT_OWNED) expect(await count(table)).toBe(0);
  });

  it('reads nothing from a system-capable table, not even the shared rows', async () => {
    expect(await count(SYSTEM_CAPABLE)).toBe(0);
  });
});

describe('a customer session reaches only what was opened for it', () => {
  beforeAll(() => session({ tenant: tenantId, customer: customerId, kind: 'CUSTOMER' }));

  /*
   * The openings themselves are pinned by customer-rls.test.ts. What this one
   * holds is the floor underneath them: a table nobody opened stays shut,
   * including a system-capable one, where the old two-conjunct predicate would
   * have let a customer read every tenant-private carrier in the workspace.
   */
  it('reads nothing a policy has not explicitly opened', async () => {
    expect(await count('industry_sector')).toBe(0);
    expect(await count('audit_log')).toBe(0);
    expect(await count(SYSTEM_CAPABLE)).toBe(0);
  });

  it('cannot read the staff account table', async () => {
    expect(await count('"user"')).toBe(0);
  });

  it('reads its own customer row, and only that one', async () => {
    expect(await count('customer')).toBe(1);
  });
});

describe('an unrecognised kind is denied, not assumed', () => {
  beforeAll(() => session({ tenant: tenantId, kind: 'ROBOT' }));

  it('reads nothing', async () => {
    for (const table of TENANT_OWNED) expect(await count(table)).toBe(0);
    expect(await count(SYSTEM_CAPABLE)).toBe(0);
  });
});

describe('the catalogue itself', () => {
  beforeAll(() => session({ tenant: tenantId, kind: 'STAFF' }));

  /*
   * This is the test that fails when somebody adds a table and copies the
   * predicate out of a migration written before CR-004. It is cheaper than
   * noticing the leak later.
   */
  it('has no policy left that infers staff from an absent agent id', async () => {
    const offenders = await rows(
      `SELECT tablename, policyname FROM pg_policies
        WHERE schemaname = 'public'
          AND (qual LIKE '%app_current_agent() IS NULL%'
               OR with_check LIKE '%app_current_agent() IS NULL%')`,
    );
    expect(offenders).toEqual([]);
  });

  it('resolves staff through app_is_staff, so one function governs every policy', async () => {
    const result = await rows(`SELECT app_is_staff() AS staff, app_staff_tenant() AS tenant`);
    expect(result[0]?.['staff']).toBe(true);
    expect(String(result[0]?.['tenant'])).toBe(tenantId.toString());
  });
});

describe('the audit trail still writes under the closed world', () => {
  /*
   * CR-004 F3. recordAudit opens its own transaction and used to rely on an
   * unset agent id meaning staff. It also swallows every error by design, so
   * the assertion has to read the row back — "it did not throw" would pass
   * even if the trail had stopped being written.
   */
  it('records an event, verified by reading it back', async () => {
    await recordAudit({
      tenantId,
      action: 'LOGIN_SUCCESS',
      tableName: 'user',
      recordId: null,
      actorId: null,
      details: { probe: 'actor-kind' },
    });

    const written = await owner.auditLog.count({
      where: { tenantId, tableName: 'user', action: 'LOGIN_SUCCESS' },
    });
    expect(written).toBe(1);
  });
});
