import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Per-module isolation suite for Sea-Air Port (CLAUDE.md §7A rule 4):
 * "seed two tenants, authenticate as tenant A, assert every list endpoint
 * returns zero rows of tenant B."
 *
 * This is the HTTP-level assertion the tenancy suite could not make in Phase 2,
 * because no list endpoint existed yet.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG_A = 'port-alpha';
const SLUG_B = 'port-beta';

let tenantA: bigint;
let tenantB: bigint;
let tokenA: string;
let portB: bigint;
let systemPort: bigint;

async function makeTenantWithUser(
  name: string,
  slug: string,
): Promise<{ tenantId: bigint; userId: bigint }> {
  const tenant = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh' },
    select: { id: true },
  });
  const user = await owner.user.create({
    data: {
      tenantId: tenant.id,
      code: `USR-${slug}`,
      username: `admin-${slug}`,
      email: `admin@${slug}.test`,
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  return { tenantId: tenant.id, userId: user.id };
}

async function cleanup(): Promise<void> {
  await owner.$executeRaw`DELETE FROM tenant_master_override WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B}))`;
  await owner.$executeRaw`DELETE FROM port WHERE code LIKE 'PORTTEST-%' OR code LIKE 'PORTTEST-BULK-%' OR port_code IN ('AAAAAA','BBBBBB','SYSSYS','NEWNEW')`;
  await owner.$executeRaw`DELETE FROM "user" WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B}))`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();

  const a = await makeTenantWithUser('Port Alpha', SLUG_A);
  const b = await makeTenantWithUser('Port Beta', SLUG_B);
  tenantA = a.tenantId;
  tenantB = b.tenantId;

  tokenA = await signAccessToken({
    sub: a.userId.toString(),
    tenantId: tenantA.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  await owner.port.create({
    data: {
      tenantId: tenantA,
      code: 'PORTTEST-A',
      name: 'Alpha Private Port',
      portCode: 'AAAAAA',
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
  });
  const beta = await owner.port.create({
    data: {
      tenantId: tenantB,
      code: 'PORTTEST-B',
      name: 'Beta Private Port',
      portCode: 'BBBBBB',
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  portB = beta.id;

  const shared = await owner.port.create({
    data: {
      code: 'PORTTEST-SYS',
      name: 'Shared Test Port',
      portCode: 'SYSSYS',
      country: 'Singapore',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  systemPort = shared.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function asTenantA(path: string) {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${tokenA}`)
    .set('X-Tenant-Slug', SLUG_A);
}

describe('§7A rule 4 — the port list leaks no other tenant', () => {
  it('returns tenant A rows and shared rows, never tenant B rows', async () => {
    const response = await asTenantA('/api/tenant/setting/ports?limit=100');
    expect(response.status).toBe(200);

    const codes: string[] = response.body.data.map((p: { code: string }) => p.code);
    expect(codes).toContain('PORTTEST-A');
    expect(codes).toContain('PORTTEST-SYS');
    expect(codes).not.toContain('PORTTEST-B');
  });

  it('leaks nothing through search either', async () => {
    const response = await asTenantA('/api/tenant/setting/ports?search=Beta%20Private&limit=100');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('marks shared rows and own rows distinctly', async () => {
    const response = await asTenantA('/api/tenant/setting/ports?limit=100');
    const rows: { code: string; isSystem: boolean }[] = response.body.data;
    expect(rows.find((r) => r.code === 'PORTTEST-SYS')?.isSystem).toBe(true);
    expect(rows.find((r) => r.code === 'PORTTEST-A')?.isSystem).toBe(false);
  });
});

describe('cross-tenant writes are refused', () => {
  it('cannot edit another tenant port', async () => {
    const response = await request(app)
      .patch(`/api/tenant/setting/ports/${portB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send({ name: 'Hijacked', portCode: 'NEWNEW', country: 'Bangladesh', type: 'SEAPORT' });

    expect(response.status).toBe(404);

    const untouched = await owner.port.findUnique({ where: { id: portB } });
    expect(untouched?.name).toBe('Beta Private Port');
  });

  it('cannot toggle another tenant port', async () => {
    const response = await request(app)
      .post(`/api/tenant/setting/ports/${portB}/toggle-status`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A);

    expect(response.status).toBe(404);

    const untouched = await owner.port.findUnique({ where: { id: portB } });
    expect(untouched?.isActive).toBe(true);
  });
});

describe('§7A rule 7 — shared rows are read-only', () => {
  it('refuses to edit a shared port', async () => {
    const response = await request(app)
      .patch(`/api/tenant/setting/ports/${systemPort}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send({ name: 'Renamed', portCode: 'SYSSYS', country: 'Bangladesh', type: 'SEAPORT' });

    expect(response.status).toBe(403);
  });

  it('deactivates a shared port for this tenant only, leaving the row intact', async () => {
    const toggle = await request(app)
      .post(`/api/tenant/setting/ports/${systemPort}/toggle-status`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A);
    expect(toggle.status).toBe(200);
    expect(toggle.body.data.isActive).toBe(false);

    // The shared row itself is untouched — other tenants still see it active.
    const row = await owner.port.findUnique({ where: { id: systemPort } });
    expect(row?.isActive).toBe(true);

    const override = await owner.tenantMasterOverride.findFirst({
      where: { tenantId: tenantA, tableName: 'port', recordId: systemPort },
    });
    expect(override?.isActive).toBe(false);

    // And tenant A now sees it as inactive.
    const list = await asTenantA('/api/tenant/setting/ports?limit=100');
    const seen = list.body.data.find((p: { code: string }) => p.code === 'PORTTEST-SYS');
    expect(seen.isActive).toBe(false);
  });
});

describe('§7 — every route is permission guarded', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await request(app)
      .get('/api/tenant/setting/ports')
      .set('X-Tenant-Slug', SLUG_A);
    expect(response.status).toBe(401);
  });

  it('rejects a user lacking the VIEW permission', async () => {
    const plain = await owner.user.create({
      data: {
        tenantId: tenantA,
        code: 'USR-plain-port',
        username: `plain-${SLUG_A}`,
        email: `plain@${SLUG_A}.test`,
        passwordHash: 'x',
        isSuperadmin: false,
      },
      select: { id: true },
    });
    const token = await signAccessToken({
      sub: plain.id.toString(),
      tenantId: tenantA.toString(),
      isSuperadmin: false,
      permissions: [],
      tokenVersion: 0,
    });

    const response = await request(app)
      .get('/api/tenant/setting/ports')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG_A);

    expect(response.status).toBe(403);
  });
});

describe('the port picker (/ports/lookup)', () => {
  /*
   * Reported from production, 2026-09-03: the Carrier Service Port screen
   * showed a fraction of the workspace's ports.
   *
   * It was asking the paginated list for `?limit=100`, and §9 caps limit at
   * 100 — so a workspace holding two hundred ports was offered the first
   * hundred, in silence, with no page control on a picker to reach the rest.
   * No page size fixes that; a picker needs the whole set, so it gets its own
   * unpaginated endpoint.
   */
  /*
   * An earlier test in this file switches the shared port off for tenant A and
   * leaves the override standing. These tests are about what the picker offers,
   * so they start from a workspace that has switched nothing off.
   */
  beforeAll(async () => {
    await owner.tenantMasterOverride.deleteMany({
      where: { tenantId: tenantA, tableName: 'port', recordId: systemPort },
    });
  });

  it('returns every active port, past any page limit', async () => {
    const bulk = 140;
    await owner.port.createMany({
      data: Array.from({ length: bulk }, (_, i) => ({
        tenantId: tenantA,
        code: `PORTTEST-BULK-${String(i).padStart(3, '0')}`,
        name: `Bulk Port ${String(i).padStart(3, '0')}`,
        portCode: `ZB${String(i).padStart(4, '0')}`,
        country: 'Testland',
        type: 'SEAPORT' as const,
      })),
    });

    const response = await asTenantA('/api/tenant/setting/ports/lookup');
    expect(response.status).toBe(200);
    const names = (response.body.data as { name: string }[]).map((p) => p.name);

    expect(names.length).toBeGreaterThan(100);
    // The whole run is there — not the first page of it.
    for (const i of [0, 99, 100, bulk - 1]) {
      expect(names).toContain(`Bulk Port ${String(i).padStart(3, '0')}`);
    }

    await owner.$executeRaw`DELETE FROM port WHERE code LIKE 'PORTTEST-BULK-%'`;
  });

  it('is scoped like the list it replaces', async () => {
    // §7A rule 4 again, because a second endpoint over the same table is a
    // second chance to leak it: tenant A's own rows and the shared rows, never
    // tenant B's.
    const response = await asTenantA('/api/tenant/setting/ports/lookup');
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: string }[]).map((p) => p.id);

    expect(ids).toContain(systemPort.toString());
    expect(ids).not.toContain(portB.toString());
  });

  it('drops a shared port this workspace switched off', async () => {
    /*
     * §7A rule 7: a tenant cannot deactivate a shared row, it overrides it. A
     * picker reading is_active alone would go on offering a port the workspace
     * has said it does not use — the bug lib/master-visibility exists to stop.
     */
    await owner.tenantMasterOverride.create({
      data: { tenantId: tenantA, tableName: 'port', recordId: systemPort, isActive: false },
    });

    const response = await asTenantA('/api/tenant/setting/ports/lookup');
    expect(response.status).toBe(200);
    const ids = (response.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(systemPort.toString());

    await owner.tenantMasterOverride.deleteMany({
      where: { tenantId: tenantA, tableName: 'port', recordId: systemPort },
    });
  });

  it('leaves out what is inactive or deleted', async () => {
    const gone = await owner.port.create({
      data: {
        tenantId: tenantA,
        code: 'PORTTEST-OFF',
        name: 'Closed Port',
        portCode: 'ZZOFF1',
        country: 'Bangladesh',
        type: 'SEAPORT',
        isActive: false,
      },
      select: { id: true },
    });

    const response = await asTenantA('/api/tenant/setting/ports/lookup');
    const ids = (response.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(gone.id.toString());

    await owner.$executeRaw`DELETE FROM port WHERE code = 'PORTTEST-OFF'`;
  });

  it('needs the same permission as the list', async () => {
    const response = await request(app)
      .get('/api/tenant/setting/ports/lookup')
      .set('X-Tenant-Slug', SLUG_A);
    expect(response.status).toBe(401);
  });
});
