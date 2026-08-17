import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Isolation for the Phase 7 parent/child screens (CLAUDE.md §7A rule 4).
 *
 * The case that matters here and nowhere else: Carrier is SHARED while its
 * children are tenant-owned, so two workspaces attach their own contacts and
 * lane rankings to the very same carrier row. If child scoping were keyed off
 * the parent rather than the tenant, every forwarder would see its
 * competitors' contacts and pricing rankings.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'pc-alpha';
const SLUG_B = 'pc-beta';

let tenantA: bigint;
let tenantB: bigint;
let tokenA: string;
let tokenB: string;
let tokenNoPerms: string;
let sharedCarrier: bigint;
let sharedPort: bigint;
let vendorB: bigint;
let sectorB: bigint;

async function makeTenant(name: string, slug: string) {
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
  const token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenant.id.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  return { tenantId: tenant.id, token };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  await owner.$executeRawUnsafe(`DELETE FROM carrier_pic WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier_service_port WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM vendor_pic WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM vendor WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM commodity_item WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM industry_sector WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM carrier WHERE code = 'PCTEST-CAR'`;
  await owner.$executeRaw`DELETE FROM port WHERE code = 'PCTEST-PORT'`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();

  const a = await makeTenant('PC Alpha', SLUG_A);
  const b = await makeTenant('PC Beta', SLUG_B);
  tenantA = a.tenantId;
  tenantB = b.tenantId;
  tokenA = a.token;
  tokenB = b.token;

  const plain = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-noperm-pc',
      username: `noperm-${SLUG_A}`,
      email: `noperm@${SLUG_A}.test`,
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenNoPerms = await signAccessToken({
    sub: plain.id.toString(),
    tenantId: tenantA.toString(),
    isSuperadmin: false,
    permissions: [],
    tokenVersion: 0,
  });

  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null } });
  const carrier = await owner.carrier.create({
    data: { code: 'PCTEST-CAR', name: 'Shared Test Line', typeId: carrierType.id },
    select: { id: true },
  });
  sharedCarrier = carrier.id;

  const port = await owner.port.create({
    data: {
      code: 'PCTEST-PORT',
      name: 'Shared Test Port',
      portCode: 'PCTPRT',
      country: 'Singapore',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  sharedPort = port.id;

  const vendorType = await owner.vendorType.findFirstOrThrow({ where: { tenantId: null } });
  const vb = await owner.vendor.create({
    data: {
      tenantId: tenantB,
      code: 'VEN-B',
      name: 'Beta Vendor',
      country: 'Bangladesh',
      vendorTypeId: vendorType.id,
    },
    select: { id: true },
  });
  vendorB = vb.id;

  const sb = await owner.industrySector.create({
    data: { tenantId: tenantB, code: 'ISC-B', name: 'Beta Sector' },
    select: { id: true },
  });
  sectorB = sb.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function as(token: string, slug: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    patch: (path: string) =>
      request(app).patch(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
  };
}

describe('two workspaces, one shared carrier', () => {
  it('each sees only its own contacts on that carrier', async () => {
    const A = as(tokenA, SLUG_A);
    const B = as(tokenB, SLUG_B);

    const createdA = await A.post(`/api/tenant/setting/carriers/${sharedCarrier}/pics`).send({
      name: 'Alpha Contact',
      email: 'alpha@test.local',
    });
    expect(createdA.status).toBe(201);

    const createdB = await B.post(`/api/tenant/setting/carriers/${sharedCarrier}/pics`).send({
      name: 'Beta Contact',
      email: 'beta@test.local',
    });
    expect(createdB.status).toBe(201);

    const listA = await A.get(`/api/tenant/setting/carriers/${sharedCarrier}/pics?limit=100`);
    const namesA = listA.body.data.map((r: { name: string }) => r.name);
    expect(namesA).toContain('Alpha Contact');
    expect(namesA).not.toContain('Beta Contact');

    const listB = await B.get(`/api/tenant/setting/carriers/${sharedCarrier}/pics?limit=100`);
    const namesB = listB.body.data.map((r: { name: string }) => r.name);
    expect(namesB).toContain('Beta Contact');
    expect(namesB).not.toContain('Alpha Contact');
  });

  it('each sees only its own service port on that carrier', async () => {
    const A = as(tokenA, SLUG_A);
    const B = as(tokenB, SLUG_B);

    // Both record the SAME carrier serving the SAME port.
    const spA = await A.post(`/api/tenant/setting/carriers/${sharedCarrier}/service-ports`).send({
      portId: sharedPort.toString(),
    });
    expect(spA.status).toBe(201);

    const spB = await B.post(`/api/tenant/setting/carriers/${sharedCarrier}/service-ports`).send({
      portId: sharedPort.toString(),
    });
    // Not a duplicate: the uniqueness check is scoped to the tenant's own rows.
    expect(spB.status).toBe(201);

    const listA = await A.get(
      `/api/tenant/setting/carriers/${sharedCarrier}/service-ports?limit=100`,
    );
    expect(listA.body.data).toHaveLength(1);
    expect(listA.body.data[0].id).toBe(spA.body.data.id);

    const listB = await B.get(
      `/api/tenant/setting/carriers/${sharedCarrier}/service-ports?limit=100`,
    );
    expect(listB.body.data).toHaveLength(1);
    expect(listB.body.data[0].id).toBe(spB.body.data.id);

    // Two distinct rows over one shared carrier and one shared port.
    expect(spA.body.data.id).not.toBe(spB.body.data.id);
  });

  it('cannot edit a contact belonging to the other workspace', async () => {
    const B = as(tokenB, SLUG_B);
    const listB = await B.get(`/api/tenant/setting/carriers/${sharedCarrier}/pics?limit=100`);
    const betaPicId = listB.body.data[0].id;

    const A = as(tokenA, SLUG_A);
    const attempt = await A.patch(
      `/api/tenant/setting/carriers/${sharedCarrier}/pics/${betaPicId}`,
    ).send({ name: 'Hijacked' });
    expect(attempt.status).toBe(404);
  });

  it('refuses to edit the shared carrier itself', async () => {
    const A = as(tokenA, SLUG_A);
    const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null } });
    const attempt = await A.patch(`/api/tenant/setting/carriers/${sharedCarrier}`).send({
      name: 'Renamed',
      typeId: carrierType.id.toString(),
    });
    expect(attempt.status).toBe(403);

    const untouched = await owner.carrier.findUnique({ where: { id: sharedCarrier } });
    expect(untouched?.name).toBe('Shared Test Line');
  });
});

describe('vendor and its contacts', () => {
  it('does not list another workspace vendor', async () => {
    const A = as(tokenA, SLUG_A);
    const list = await A.get('/api/tenant/setting/vendors?limit=100');
    const names = list.body.data.map((r: { name: string }) => r.name);
    expect(names).not.toContain('Beta Vendor');
  });

  it('cannot reach another workspace vendor children', async () => {
    const A = as(tokenA, SLUG_A);
    expect((await A.get(`/api/tenant/setting/vendors/${vendorB}/pics`)).status).toBe(404);
    expect((await A.get(`/api/tenant/setting/vendors/${vendorB}/summary`)).status).toBe(404);
    expect(
      (await A.post(`/api/tenant/setting/vendors/${vendorB}/pics`).send({ name: 'X' })).status,
    ).toBe(404);
  });
});

describe('commodity category and its items', () => {
  it('cannot reach another workspace category children', async () => {
    const A = as(tokenA, SLUG_A);
    expect((await A.get(`/api/tenant/setting/commodity-categories/${sectorB}/items`)).status).toBe(404);
    expect(
      (await A.post(`/api/tenant/setting/commodity-categories/${sectorB}/items`).send({
        name: 'X',
      })).status,
    ).toBe(404);
  });
});

describe('§7 — every route is permission guarded', () => {
  const paths = [
    '/api/tenant/setting/carriers',
    '/api/tenant/setting/vendors',
    '/api/tenant/setting/commodity-categories',
  ];

  it('rejects a user with no permissions', async () => {
    for (const path of paths) {
      const res = await as(tokenNoPerms, SLUG_A).get(path);
      expect(res.status, path).toBe(403);
    }
  });

  it('rejects an unauthenticated caller', async () => {
    for (const path of paths) {
      const res = await request(app).get(path).set('X-Tenant-Slug', SLUG_A);
      expect(res.status, path).toBe(401);
    }
  });
});
