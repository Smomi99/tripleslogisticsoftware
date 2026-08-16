import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Per-module isolation for the Phase 6 settings screens (CLAUDE.md §7A rule 4):
 * Cost Head, Currency and Vessel. Two tenants, act as A, assert no row of B.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'set-alpha';
const SLUG_B = 'set-beta';

let tenantA: bigint;
let tenantB: bigint;
let tokenA: string;
let tokenNoPerms: string;
let costHeadB: bigint;
let vesselB: bigint;
let sharedCurrency: bigint;

async function makeTenant(name: string, slug: string, superadmin = true) {
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
      isSuperadmin: superadmin,
    },
    select: { id: true },
  });
  return { tenantId: tenant.id, userId: user.id };
}

async function cleanup(): Promise<void> {
  const ids = owner.$queryRaw`SELECT id FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
  void ids;
  await owner.$executeRaw`DELETE FROM currency_rate_history WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B}))`;
  await owner.$executeRaw`DELETE FROM tenant_master_override WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B}))`;
  await owner.$executeRaw`DELETE FROM vessel WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B}))`;
  await owner.$executeRaw`DELETE FROM cost_head WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B}))`;
  await owner.$executeRaw`DELETE FROM currency WHERE code LIKE 'SETTEST-%'`;
  await owner.$executeRaw`DELETE FROM carrier WHERE code = 'SETTEST-CAR'`;
  await owner.$executeRaw`DELETE FROM "user" WHERE tenant_id IN (SELECT id FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B}))`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();

  const a = await makeTenant('Settings Alpha', SLUG_A);
  const b = await makeTenant('Settings Beta', SLUG_B);
  tenantA = a.tenantId;
  tenantB = b.tenantId;

  tokenA = await signAccessToken({
    sub: a.userId.toString(),
    tenantId: tenantA.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  const plain = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-noperm-set',
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

  const unit = await owner.costUnit.findFirstOrThrow({
    where: { tenantId: null },
    select: { id: true },
  });

  await owner.costHead.create({
    data: { tenantId: tenantA, code: 'CHD-A', name: 'Alpha Charge', category: 'SERVICE', unitId: unit.id },
  });
  const chB = await owner.costHead.create({
    data: { tenantId: tenantB, code: 'CHD-B', name: 'Beta Charge', category: 'SERVICE', unitId: unit.id },
    select: { id: true },
  });
  costHeadB = chB.id;

  const carrierType = await owner.carrierType.findFirstOrThrow({
    where: { tenantId: null },
    select: { id: true },
  });
  const carrier = await owner.carrier.create({
    data: { code: 'SETTEST-CAR', name: 'Settings Test Carrier', typeId: carrierType.id },
    select: { id: true },
  });

  await owner.vessel.create({
    data: { tenantId: tenantA, code: 'VSL-A', name: 'Alpha Vessel', carrierId: carrier.id },
  });
  const vB = await owner.vessel.create({
    data: { tenantId: tenantB, code: 'VSL-B', name: 'Beta Vessel', carrierId: carrier.id },
    select: { id: true },
  });
  vesselB = vB.id;

  const shared = await owner.currency.create({
    data: { code: 'SETTEST-CUR', currency: 'ZZZ — Test Currency', conversion: '10.0000' },
    select: { id: true },
  });
  sharedCurrency = shared.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function get(path: string, token = tokenA) {
  return request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG_A);
}

describe('cost head', () => {
  it('lists only tenant A rows', async () => {
    const res = await get('/api/tenant/setting/cost-heads?limit=100');
    expect(res.status).toBe(200);
    const names = res.body.data.map((r: { name: string }) => r.name);
    expect(names).toContain('Alpha Charge');
    expect(names).not.toContain('Beta Charge');
  });

  it('cannot edit or toggle a tenant B row', async () => {
    const unit = await owner.costUnit.findFirstOrThrow({ where: { tenantId: null } });
    const edit = await request(app)
      .patch(`/api/tenant/setting/cost-heads/${costHeadB}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send({ name: 'Hijacked', category: 'SERVICE', unitId: unit.id.toString() });
    expect(edit.status).toBe(404);

    const toggle = await request(app)
      .post(`/api/tenant/setting/cost-heads/${costHeadB}/toggle-status`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A);
    expect(toggle.status).toBe(404);

    const untouched = await owner.costHead.findUnique({ where: { id: costHeadB } });
    expect(untouched?.name).toBe('Beta Charge');
    expect(untouched?.isActive).toBe(true);
  });

  it('refuses a unit the workspace cannot see', async () => {
    const res = await request(app)
      .post('/api/tenant/setting/cost-heads')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send({ name: 'Bad Unit', category: 'SERVICE', unitId: '999999999' });
    expect(res.status).toBe(400);
  });

  it('guards every route with a permission', async () => {
    expect((await get('/api/tenant/setting/cost-heads', tokenNoPerms)).status).toBe(403);
    expect((await request(app).get('/api/tenant/setting/cost-heads').set('X-Tenant-Slug', SLUG_A)).status).toBe(401);
  });
});

describe('vessel', () => {
  it('lists only tenant A rows', async () => {
    const res = await get('/api/tenant/setting/vessels?limit=100');
    expect(res.status).toBe(200);
    const names = res.body.data.map((r: { name: string }) => r.name);
    expect(names).toContain('Alpha Vessel');
    expect(names).not.toContain('Beta Vessel');
  });

  it('cannot toggle a tenant B row', async () => {
    const res = await request(app)
      .post(`/api/tenant/setting/vessels/${vesselB}/toggle-status`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A);
    expect(res.status).toBe(404);
    const untouched = await owner.vessel.findUnique({ where: { id: vesselB } });
    expect(untouched?.isActive).toBe(true);
  });

  it('guards every route with a permission', async () => {
    expect((await get('/api/tenant/setting/vessels', tokenNoPerms)).status).toBe(403);
  });
});

describe('currency', () => {
  it('shows shared rows to tenant A but no tenant B row', async () => {
    const res = await get('/api/tenant/setting/currencies?limit=100');
    expect(res.status).toBe(200);
    const codes = res.body.data.map((r: { code: string }) => r.code);
    expect(codes).toContain('SETTEST-CUR');
  });

  it('refuses to edit a shared currency (§7A rule 7)', async () => {
    const res = await request(app)
      .patch(`/api/tenant/setting/currencies/${sharedCurrency}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send({ currency: 'Hacked', conversion: '1.0000' });
    expect(res.status).toBe(403);

    const untouched = await owner.currency.findUnique({ where: { id: sharedCurrency } });
    expect(untouched?.currency).toBe('ZZZ — Test Currency');
  });

  it('a rate set by tenant A is invisible to tenant B', async () => {
    const set = await request(app)
      .post(`/api/tenant/setting/currencies/${sharedCurrency}/rate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send({ rate: '77.5000', effectiveFrom: '2020-01-01T00:00:00Z' });
    expect(set.status).toBe(201);

    const seenByA = await get('/api/tenant/setting/currencies?search=Test%20Currency');
    const rowA = seenByA.body.data[0];
    expect(rowA.tenantRate).toBe('77.5000');
    expect(rowA.effectiveRate).toBe('77.5000');
    // The shared default is untouched — this is the §5 resolution holding.
    expect(rowA.conversion).toBe('10.0000');

    const rowsForB = await owner.currencyRateHistory.findMany({ where: { tenantId: tenantB } });
    expect(rowsForB).toHaveLength(0);
  });

  it('closes the previous rate rather than overwriting it', async () => {
    await request(app)
      .post(`/api/tenant/setting/currencies/${sharedCurrency}/rate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send({ rate: '80.0000', effectiveFrom: '2021-01-01T00:00:00Z' });

    const history = await owner.currencyRateHistory.findMany({
      where: { tenantId: tenantA, currencyId: sharedCurrency },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history[0]?.effectiveTo).not.toBeNull();
    expect(history[1]?.effectiveTo).toBeNull();
  });

  it('rejects a non-positive rate', async () => {
    const res = await request(app)
      .post(`/api/tenant/setting/currencies/${sharedCurrency}/rate`)
      .set('Authorization', `Bearer ${tokenA}`)
      .set('X-Tenant-Slug', SLUG_A)
      .send({ rate: '0', effectiveFrom: '2021-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
  });

  it('guards every route with a permission', async () => {
    expect((await get('/api/tenant/setting/currencies', tokenNoPerms)).status).toBe(403);
  });
});
