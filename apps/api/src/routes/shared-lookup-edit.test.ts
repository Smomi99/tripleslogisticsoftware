import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Edit and Delete on the shared Settings lookups — asked for by the client on
 * 2026-09-25 for TOS, Modes, Inquiry Source, Rate Tier and Container Size.
 *
 * §7A rule 7 is what these tests guard, exactly as customise.test.ts does for
 * ports: a shared row belongs to every workspace, so neither action may change
 * it. Workspace A edits and deletes; workspace B must see nothing move.
 *
 * The container size cases are the ones with teeth. The seeded Sea FCL tiers
 * are shared rows naming shared container sizes, and a quotation matches a
 * rate to a container through the tier — so editing a container has to carry
 * its tiers along, and must not do it by writing to the shared tier.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'slt-alpha';
const SLUG_B = 'slt-beta';
const BASE = '/api/tenant/setting';

let tokenA: string;
let tokenB: string;
let tenantA: bigint;

let sharedTos: bigint;
let sharedMode: bigint;
let sharedSource: bigint;
let sharedBox: bigint;
let sharedBoxTier: bigint;
let usedBox: bigint;
let bareBox: bigint;
let bareBoxTier: bigint;

function as(token: string, slug: string) {
  const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(app)[method](`${BASE}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', slug);
  return {
    get: (path: string) => call('get', path),
    post: (path: string) => call('post', path),
    patch: (path: string) => call('patch', path),
    delete: (path: string) => call('delete', path),
  };
}
const A = () => as(tokenA, SLUG_A);
const B = () => as(tokenB, SLUG_B);

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
  await owner.$executeRawUnsafe(`DELETE FROM tenant_master_override WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_tier WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM container_size WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM tos WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM mode WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_source WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM rate_tier WHERE code LIKE 'SLT%' AND tenant_id IS NULL`;
  await owner.$executeRaw`DELETE FROM container_size WHERE code LIKE 'SLT%' AND tenant_id IS NULL`;
  await owner.$executeRaw`DELETE FROM tos WHERE code LIKE 'SLT%' AND tenant_id IS NULL`;
  await owner.$executeRaw`DELETE FROM mode WHERE code LIKE 'SLT%' AND tenant_id IS NULL`;
  await owner.$executeRaw`DELETE FROM inquiry_source WHERE code LIKE 'SLT%' AND tenant_id IS NULL`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

/** A shared container with one shared Sea FCL tier built on it. */
async function sharedBoxWithTier(code: string): Promise<{ box: bigint; tier: bigint }> {
  const box = await owner.containerSize.create({
    data: { code, name: `Shared ${code}`, teuFactor: '1.00', maxWeightKg: '26000' },
    select: { id: true },
  });
  const tier = await owner.rateTier.create({
    data: {
      code: `${code}-FCL`,
      mode: 'SEA_FCL',
      label: code,
      unit: 'CONTAINER',
      sortOrder: 3,
      containerSizeId: box.id,
    },
    select: { id: true },
  });
  return { box: box.id, tier: tier.id };
}

beforeAll(async () => {
  await cleanup();
  const a = await makeTenant('SLT Alpha', SLUG_A);
  const b = await makeTenant('SLT Beta', SLUG_B);
  tenantA = a.tenantId;
  tokenA = a.token;
  tokenB = b.token;

  sharedTos = (
    await owner.tos.create({ data: { code: 'SLTFOB', name: 'Free On Board', sortOrder: 7 }, select: { id: true } })
  ).id;
  sharedMode = (
    await owner.mode.create({ data: { code: 'SLT/CY', name: 'Shared CY', }, select: { id: true } })
  ).id;
  sharedSource = (
    await owner.inquirySource.create({ data: { code: 'SLTSRC', name: 'Shared Source' }, select: { id: true } })
  ).id;

  ({ box: sharedBox, tier: sharedBoxTier } = await sharedBoxWithTier('SLT20'));
  ({ box: bareBox, tier: bareBoxTier } = await sharedBoxWithTier('SLT45'));

  usedBox = (
    await owner.containerSize.create({
      data: { code: 'SLT40', name: 'Shared 40', teuFactor: '2.00' },
      select: { id: true },
    })
  ).id;

  // Workspace A's own records naming shared rows — what an edit must move and a
  // delete must be refused over.
  for (const [code, box] of [
    ['SLTOWN20', sharedBox],
    ['SLTOWN40', usedBox],
  ] as const) {
    await owner.rateTier.create({
      data: {
        tenantId: tenantA,
        code,
        mode: 'SEA_FCL',
        label: code,
        unit: 'CONTAINER',
        containerSizeId: box,
      },
    });
  }
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

type Row = { id: string; code: string; name: string; isActive: boolean; isSystem: boolean };

async function listed(who: typeof A, path: string, search: string): Promise<Row[]> {
  const res = await who().get(`${path}?limit=100&search=${encodeURIComponent(search)}`);
  expect(res.status).toBe(200);
  return res.body.data as Row[];
}

describe('Edit on a shared row', () => {
  it('saves this workspace its own copy and leaves the shared row untouched', async () => {
    const res = await A()
      .post(`/tos/${sharedTos}/customise`)
      .send({ code: 'SLTFOB', name: 'Free On Board (ours)' });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);

    const shared = await owner.tos.findUniqueOrThrow({ where: { id: sharedTos } });
    expect(shared.name).toBe('Free On Board');
    expect(shared.tenantId).toBeNull();

    const mine = await listed(A, '/tos', 'SLTFOB');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'Free On Board (ours)', isSystem: false, isActive: true });

    const theirs = await listed(B, '/tos', 'SLTFOB');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ name: 'Free On Board', isSystem: true });
  });

  it('keeps a TOS copy in the shared row’s place in EXW…DDP order', async () => {
    const copy = await owner.tos.findFirstOrThrow({ where: { tenantId: tenantA, code: 'SLTFOB' } });
    expect(copy.sortOrder).toBe(7);
  });

  it('keeps a row this workspace had deactivated deactivated', async () => {
    expect((await A().post(`/modes/${sharedMode}/toggle-status`)).status).toBe(200);
    const res = await A().post(`/modes/${sharedMode}/customise`).send({ code: 'SLT/CY', name: 'Our CY' });
    expect(res.status).toBe(201);

    const mine = await listed(A, '/modes', 'SLT/CY');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'Our CY', isActive: false, isSystem: false });
  });

  it('refuses a second copy of the same shared row', async () => {
    const res = await A().post(`/tos/${sharedTos}/customise`).send({ code: 'SLTFOB', name: 'Again' });
    expect(res.status).toBe(409);
  });

  it('still refuses a PATCH straight at a shared row', async () => {
    const res = await B().patch(`/inquiry-sources/${sharedSource}`).send({ code: 'SLTSRC', name: 'Renamed' });
    expect(res.status).toBe(403);
    const shared = await owner.inquirySource.findUniqueOrThrow({ where: { id: sharedSource } });
    expect(shared.name).toBe('Shared Source');
  });
});

describe('Edit on a shared container size', () => {
  let copyId: bigint;

  it('saves the copy with the new capacity and moves this workspace’s own tier onto it', async () => {
    const res = await A().post(`/container-sizes/${sharedBox}/customise`).send({
      code: 'SLT20',
      name: '20 Standard (ours)',
      teuFactor: '1',
      maxWeightKg: '30000',
    });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    copyId = BigInt(res.body.data.id);

    const copy = await owner.containerSize.findUniqueOrThrow({ where: { id: copyId } });
    expect(copy.tenantId).toBe(tenantA);
    expect(copy.maxWeightKg?.toString()).toBe('30000');

    const own = await owner.rateTier.findFirstOrThrow({ where: { tenantId: tenantA, code: 'SLTOWN20' } });
    expect(own.containerSizeId).toBe(copyId);

    const shared = await owner.containerSize.findUniqueOrThrow({ where: { id: sharedBox } });
    expect(shared.name).toBe('Shared SLT20');
    expect(shared.maxWeightKg?.toString()).toBe('26000');
  });

  it('carries the shared FCL tier along without writing to it', async () => {
    const sharedTier = await owner.rateTier.findUniqueOrThrow({ where: { id: sharedBoxTier } });
    expect(sharedTier.containerSizeId).toBe(sharedBox);
    expect(sharedTier.tenantId).toBeNull();

    const tierCopy = await owner.rateTier.findFirstOrThrow({
      where: { tenantId: tenantA, code: 'SLT20-FCL' },
    });
    expect(tierCopy.containerSizeId).toBe(copyId);
    expect(tierCopy.sortOrder).toBe(3);

    const mine = await listed(A, '/rate-tiers', 'SLT20');
    expect(mine.every((r) => !r.isSystem)).toBe(true);
    expect(mine.map((r) => r.code).sort()).toEqual(['SLT20-FCL']);

    const theirs = await listed(B, '/rate-tiers', 'SLT20');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ code: 'SLT20-FCL', isSystem: true });
  });

  it('leaves the other workspace on the shared container', async () => {
    const theirs = await listed(B, '/container-sizes', 'SLT20');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ name: 'Shared SLT20', isSystem: true });
  });
});

describe('Delete', () => {
  it('takes a shared row off this workspace’s list and nobody else’s', async () => {
    const res = await A().delete(`/inquiry-sources/${sharedSource}`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);

    expect(await listed(A, '/inquiry-sources', 'SLTSRC')).toHaveLength(0);
    expect(await listed(B, '/inquiry-sources', 'SLTSRC')).toHaveLength(1);

    const shared = await owner.inquirySource.findUniqueOrThrow({ where: { id: sharedSource } });
    expect(shared.deletedAt).toBeNull();
    expect(shared.isActive).toBe(true);
  });

  it('reads a shared row already deleted here as not found', async () => {
    expect((await A().delete(`/inquiry-sources/${sharedSource}`)).status).toBe(404);
    expect(
      (await A().post(`/inquiry-sources/${sharedSource}/customise`).send({ code: 'SLTSRC', name: 'x' })).status,
    ).toBe(404);
  });

  it('refuses a shared container this workspace’s records still use, and says what', async () => {
    const res = await A().delete(`/container-sizes/${usedBox}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/rate tier/);
    expect(await listed(A, '/container-sizes', 'SLT40')).toHaveLength(1);
  });

  it('takes a shared container’s shared tiers off the list with it', async () => {
    const res = await A().delete(`/container-sizes/${bareBox}`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);

    expect(await listed(A, '/container-sizes', 'SLT45')).toHaveLength(0);
    expect(await listed(A, '/rate-tiers', 'SLT45')).toHaveLength(0);
    expect(await listed(B, '/rate-tiers', 'SLT45')).toHaveLength(1);

    const tier = await owner.rateTier.findUniqueOrThrow({ where: { id: bareBoxTier } });
    expect(tier.deletedAt).toBeNull();
  });

  it('deletes the workspace’s own row and gives its code back', async () => {
    const created = await A().post('/tos').send({ code: 'SLTTYPO', name: 'Typo' });
    expect(created.status).toBe(201);

    const res = await A().delete(`/tos/${created.body.data.id}`);
    expect(res.status).toBe(200);
    expect(await listed(A, '/tos', 'SLTTYPO')).toHaveLength(0);

    // The code a person typed is theirs to type again.
    const again = await A().post('/tos').send({ code: 'SLTTYPO', name: 'Typo, fixed' });
    expect(again.status, JSON.stringify(again.body.error ?? {})).toBe(201);
  });

  it('refuses the workspace’s own row while something uses it', async () => {
    const own = await owner.containerSize.create({
      data: { tenantId: tenantA, code: 'SLTMINE', name: 'Mine', teuFactor: '1.00' },
      select: { id: true },
    });
    await owner.rateTier.create({
      data: {
        tenantId: tenantA,
        code: 'SLTMINE-FCL',
        mode: 'SEA_FCL',
        label: 'Mine',
        unit: 'CONTAINER',
        containerSizeId: own.id,
      },
    });
    const res = await A().delete(`/container-sizes/${own.id}`);
    expect(res.status).toBe(409);
  });
});
