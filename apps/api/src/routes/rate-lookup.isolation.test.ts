import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Isolation suite for the five §3.1 Purchase & Sales lookups
 * (docs/MODULE_PURCHASE_SALES.md, CLAUDE.md §7A rule 4).
 *
 * All five go through lib/system-lookup, so a leak in one would be a leak in
 * all five — which is exactly why they are all asserted here rather than one
 * being taken as representative.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG_A = 'lookup-alpha';
const SLUG_B = 'lookup-beta';
const PREFIX = 'LKTEST-';

/** endpoint path -> the table its rows live in. */
const ENDPOINTS = [
  ['goods-types', 'goods_type'],
  ['container-sizes', 'container_size'],
  ['rate-tiers', 'rate_tier'],
  ['tos', 'tos'],
  ['inquiry-sources', 'inquiry_source'],
] as const;

const TABLE_OF = new Map<string, string>(ENDPOINTS.map(([e, t]) => [e, t]));

let tenantA: bigint;
let tokenA: string;
let userA: bigint;

/** Tenant B's rows, keyed by endpoint — the ones tenant A must never see. */
const rowsB = new Map<string, bigint>();
/** Shared rows, keyed by endpoint — visible to both, editable by neither. */
const sharedRows = new Map<string, bigint>();

let sharedContainerSize: bigint;

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
  const tenantIds = `SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`;
  await owner.$executeRawUnsafe(
    `DELETE FROM tenant_master_override WHERE tenant_id IN (${tenantIds})`,
  );
  // rate_tier references container_size, so it goes first.
  await owner.$executeRawUnsafe(`DELETE FROM rate_tier WHERE code LIKE '${PREFIX}%'`);
  for (const [, table] of ENDPOINTS) {
    if (table === 'rate_tier') continue;
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE code LIKE '${PREFIX}%'`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN (${tenantIds})`);
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`);
}

beforeAll(async () => {
  await cleanup();

  const a = await makeTenantWithUser('Lookup Alpha', SLUG_A);
  const b = await makeTenantWithUser('Lookup Beta', SLUG_B);
  tenantA = a.tenantId;
  userA = a.userId;

  tokenA = await signAccessToken({
    sub: a.userId.toString(),
    tenantId: tenantA.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  // A shared container size, so the shared Sea FCL tier has something to name.
  const ct = await owner.containerSize.create({
    data: { code: `${PREFIX}SYS-CT`, name: 'Shared Test Box', teuFactor: '1.00' },
    select: { id: true },
  });
  sharedContainerSize = ct.id;
  sharedRows.set('container-sizes', ct.id);

  await owner.containerSize.create({
    data: { tenantId: tenantA, code: `${PREFIX}A-CT`, name: 'Alpha Box', teuFactor: '1.00' },
  });
  const ctB = await owner.containerSize.create({
    data: { tenantId: b.tenantId, code: `${PREFIX}B-CT`, name: 'Beta Box', teuFactor: '1.00' },
    select: { id: true },
  });
  rowsB.set('container-sizes', ctB.id);

  await owner.goodsType.create({
    data: { tenantId: tenantA, code: `${PREFIX}A-GT`, name: 'Alpha Goods' },
  });
  const gtB = await owner.goodsType.create({
    data: { tenantId: b.tenantId, code: `${PREFIX}B-GT`, name: 'Beta Goods' },
    select: { id: true },
  });
  rowsB.set('goods-types', gtB.id);
  const gtS = await owner.goodsType.create({
    data: { code: `${PREFIX}SYS-GT`, name: 'Shared Goods' },
    select: { id: true },
  });
  sharedRows.set('goods-types', gtS.id);

  await owner.rateTier.create({
    data: {
      tenantId: tenantA,
      code: `${PREFIX}A-RT`,
      mode: 'SEA_LCL',
      label: 'Alpha Tier',
      unit: 'CBM',
    },
  });
  const rtB = await owner.rateTier.create({
    data: {
      tenantId: b.tenantId,
      code: `${PREFIX}B-RT`,
      mode: 'SEA_LCL',
      label: 'Beta Tier',
      unit: 'CBM',
    },
    select: { id: true },
  });
  rowsB.set('rate-tiers', rtB.id);
  const rtS = await owner.rateTier.create({
    data: {
      code: `${PREFIX}SYS-RT`,
      mode: 'SEA_FCL',
      label: 'Shared Tier',
      unit: 'CONTAINER',
      containerSizeId: sharedContainerSize,
    },
    select: { id: true },
  });
  sharedRows.set('rate-tiers', rtS.id);

  await owner.tos.create({ data: { tenantId: tenantA, code: `${PREFIX}A-TOS`, name: 'Alpha TOS' } });
  const tosB = await owner.tos.create({
    data: { tenantId: b.tenantId, code: `${PREFIX}B-TOS`, name: 'Beta TOS' },
    select: { id: true },
  });
  rowsB.set('tos', tosB.id);
  const tosS = await owner.tos.create({
    data: { code: `${PREFIX}SYS-TOS`, name: 'Shared TOS' },
    select: { id: true },
  });
  sharedRows.set('tos', tosS.id);

  await owner.inquirySource.create({
    data: { tenantId: tenantA, code: `${PREFIX}A-IS`, name: 'Alpha Source' },
  });
  const isB = await owner.inquirySource.create({
    data: { tenantId: b.tenantId, code: `${PREFIX}B-IS`, name: 'Beta Source' },
    select: { id: true },
  });
  rowsB.set('inquiry-sources', isB.id);
  const isS = await owner.inquirySource.create({
    data: { code: `${PREFIX}SYS-IS`, name: 'Shared Source' },
    select: { id: true },
  });
  sharedRows.set('inquiry-sources', isS.id);
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

/** The payload each endpoint's write accepts — shapes differ, rules do not. */
function editPayload(endpoint: string, code: string): Record<string, unknown> {
  switch (endpoint) {
    case 'container-sizes':
      return { code, name: 'Hijacked', teuFactor: '1' };
    case 'rate-tiers':
      return { code, mode: 'SEA_LCL', label: 'Hijacked', unit: 'CBM' };
    default:
      return { code, name: 'Hijacked' };
  }
}

async function codeOf(table: string, id: bigint): Promise<string> {
  const rows = await owner.$queryRawUnsafe<{ code: string }[]>(
    `SELECT code FROM "${table}" WHERE id = $1`,
    id,
  );
  return rows[0]!.code;
}

describe('§7A rule 4 — no lookup list leaks another tenant', () => {
  for (const [endpoint] of ENDPOINTS) {
    it(`${endpoint}: returns own and shared rows, never tenant B's`, async () => {
      const response = await asTenantA(`/api/tenant/setting/${endpoint}?limit=100`);
      expect(response.status).toBe(200);

      const codes: string[] = response.body.data.map((r: { code: string }) => r.code);
      const mine = codes.filter((c) => c.startsWith(PREFIX));
      expect(mine.some((c) => c.includes('A-'))).toBe(true);
      expect(mine.some((c) => c.includes('SYS-'))).toBe(true);
      expect(mine.some((c) => c.includes('B-'))).toBe(false);
    });

    it(`${endpoint}: leaks nothing through search either`, async () => {
      const response = await asTenantA(`/api/tenant/setting/${endpoint}?search=Beta&limit=100`);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(0);
    });
  }
});

describe('cross-tenant writes are refused', () => {
  for (const [endpoint] of ENDPOINTS) {
    it(`${endpoint}: cannot edit tenant B's row`, async () => {
      const id = rowsB.get(endpoint)!;
      const response = await request(app)
        .patch(`/api/tenant/setting/${endpoint}/${id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-Tenant-Slug', SLUG_A)
        .send(editPayload(endpoint, `${PREFIX}HIJACK`));

      expect(response.status).toBe(404);
    });

    it(`${endpoint}: cannot toggle tenant B's row`, async () => {
      const id = rowsB.get(endpoint)!;
      const response = await request(app)
        .post(`/api/tenant/setting/${endpoint}/${id}/toggle-status`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-Tenant-Slug', SLUG_A);

      expect(response.status).toBe(404);
    });
  }
});

describe('§7A rule 7 — shared rows are read-only, switchable per workspace', () => {
  for (const [endpoint, table] of ENDPOINTS) {
    it(`${endpoint}: refuses to edit a shared row`, async () => {
      const id = sharedRows.get(endpoint)!;
      const response = await request(app)
        .patch(`/api/tenant/setting/${endpoint}/${id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-Tenant-Slug', SLUG_A)
        .send(editPayload(endpoint, `${PREFIX}SYS-RENAMED`));

      expect(response.status).toBe(403);
    });

    it(`${endpoint}: deactivating a shared row writes an override, not the row`, async () => {
      const id = sharedRows.get(endpoint)!;
      const toggle = await request(app)
        .post(`/api/tenant/setting/${endpoint}/${id}/toggle-status`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-Tenant-Slug', SLUG_A);

      expect(toggle.status).toBe(200);
      expect(toggle.body.data.isActive).toBe(false);

      // The shared row itself is untouched — every other workspace still sees it.
      const rows = await owner.$queryRawUnsafe<{ is_active: boolean }[]>(
        `SELECT is_active FROM "${table}" WHERE id = $1`,
        id,
      );
      expect(rows[0]?.is_active).toBe(true);

      const override = await owner.tenantMasterOverride.findFirst({
        where: { tenantId: tenantA, tableName: table, recordId: id },
      });
      expect(override?.isActive).toBe(false);

      // And tenant A now reads it as inactive.
      const list = await asTenantA(`/api/tenant/setting/${endpoint}?limit=100`);
      const seen = list.body.data.find((r: { id: string }) => r.id === id.toString());
      expect(seen.isActive).toBe(false);
    });
  }
});

describe('a workspace cannot shadow a shared code', () => {
  for (const [endpoint] of ENDPOINTS) {
    it(`${endpoint}: rejects a code a shared row already holds`, async () => {
      const table = TABLE_OF.get(endpoint)!;
      const sharedCode = await codeOf(table, sharedRows.get(endpoint)!);

      const response = await request(app)
        .post(`/api/tenant/setting/${endpoint}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('X-Tenant-Slug', SLUG_A)
        .send(editPayload(endpoint, sharedCode));

      expect(response.status).toBe(409);
    });
  }
});

describe('rate tier keeps its own rules', () => {
  function postTier(body: Record<string, unknown>) {
    return request(app)
      .post('/api/tenant/setting/rate-tiers')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send(body);
  }

  it('refuses a unit that does not match the mode', async () => {
    const response = await postTier({
      code: `${PREFIX}BADUNIT`,
      mode: 'AIR',
      label: 'Wrong unit',
      unit: 'CBM',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.fields.unit).toBeDefined();
  });

  it('refuses a Sea FCL tier with no container size', async () => {
    const response = await postTier({
      code: `${PREFIX}NOCT`,
      mode: 'SEA_FCL',
      label: 'Boxless',
      unit: 'CONTAINER',
    });
    expect(response.status).toBe(400);
  });

  it('refuses an upper bound below the lower bound', async () => {
    const response = await postTier({
      code: `${PREFIX}BADRANGE`,
      mode: 'AIR',
      label: 'Inverted',
      unit: 'KG',
      minValue: '500',
      maxValue: '100',
    });
    expect(response.status).toBe(400);
  });

  it('will not point a tier at another tenant container size', async () => {
    const response = await postTier({
      code: `${PREFIX}FOREIGNCT`,
      mode: 'SEA_FCL',
      label: 'Foreign box',
      unit: 'CONTAINER',
      containerSizeId: rowsB.get('container-sizes')!.toString(),
    });
    expect(response.status).toBe(400);
  });

  it('offers only container sizes this workspace can see', async () => {
    const response = await asTenantA('/api/tenant/setting/rate-tiers/container-options');
    expect(response.status).toBe(200);
    const names: string[] = response.body.data.map((o: { name: string }) => o.name);
    expect(names.some((n) => n.includes('Alpha Box'))).toBe(true);
    expect(names.some((n) => n.includes('Beta Box'))).toBe(false);
  });
});

describe('§7 — every lookup route is permission guarded', () => {
  for (const [endpoint] of ENDPOINTS) {
    it(`${endpoint}: rejects an unauthenticated request`, async () => {
      const response = await request(app)
        .get(`/api/tenant/setting/${endpoint}`)
        .set('X-Tenant-Slug', SLUG_A);
      expect(response.status).toBe(401);
    });
  }

  it('rejects a user lacking the VIEW permission on every one of them', async () => {
    const plain = await owner.user.create({
      data: {
        tenantId: tenantA,
        code: 'USR-plain-lookup',
        username: `plain-${SLUG_A}`,
        email: `plain@${SLUG_A}.test`,
        passwordHash: 'x',
        isSuperadmin: false,
        createdBy: userA,
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

    for (const [endpoint] of ENDPOINTS) {
      const response = await request(app)
        .get(`/api/tenant/setting/${endpoint}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Slug', SLUG_A);
      expect(response.status, endpoint).toBe(403);
    }
  });
});
