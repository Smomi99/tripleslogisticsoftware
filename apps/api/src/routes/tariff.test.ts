import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Purchase → Tariff, through HTTP — docs/DESIGN-UPDATE-2026-10-04.md §5.
 * Two workspaces, so each is also a check the other sees none of it.
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'tariff-alpha';
const SLUG_B = 'tariff-beta';

interface World {
  slug: string;
  editorToken: string;
  viewerToken: string;
  portId: bigint;
  costHeadId: bigint;
}
let A: World;
let B: World;
let size20: bigint;
let containerUnit: bigint;
let usd: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of ['tariff_line', 'tariff', 'cost_head', 'port', 'user']) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string): Promise<World> {
  const { id: tenantId } = await owner.tenant.create({ data: { name, slug, country: 'Bangladesh' }, select: { id: true } });
  const token = async (code: string, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x' },
      select: { id: true },
    });
    return signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin: false, permissions, tokenVersion: 0 });
  };
  const port = await owner.port.create({
    data: { tenantId, code: `PL-${tag}1`, name: `Chattogram ${tag}`, portCode: `${tag}CGP`, country: 'Bangladesh', type: 'SEAPORT' },
    select: { id: true },
  });
  const head = await owner.costHead.create({
    data: { tenantId, code: `CH-${tag}1`, category: 'SERVICE', name: `Port Charges ${tag}`, unitId: containerUnit },
    select: { id: true },
  });
  return {
    slug,
    editorToken: await token(`USR-E${tag}`, ['PURCHASE.TARIFF.VIEW', 'PURCHASE.TARIFF.CREATE', 'PURCHASE.TARIFF.EDIT', 'PURCHASE.TARIFF.TOGGLE_STATUS']),
    viewerToken: await token(`USR-V${tag}`, ['PURCHASE.TARIFF.VIEW']),
    portId: port.id,
    costHeadId: head.id,
  };
}

function api(token: string, slug: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  const base = '/api/tenant/purchase/tariffs';
  return {
    get: (path = '') => wrap(request(app).get(`${base}${path}`)),
    post: (path: string, body: unknown) => wrap(request(app).post(`${base}${path}`)).send(body as object),
    put: (path: string, body: unknown) => wrap(request(app).put(`${base}${path}`)).send(body as object),
  };
}

const body = (w: World, lines: Record<string, unknown>[]) => ({
  polId: w.portId.toString(),
  movementType: 'OUTBOUND',
  tariffType: 'PORT_TARIFF',
  lines,
});
const line = (w: World, over: Record<string, unknown> = {}) => ({
  costHeadId: w.costHeadId.toString(),
  containerSizeId: size20.toString(),
  costUnitId: containerUnit.toString(),
  unitPrice: '1250.5',
  currencyId: usd.toString(),
  ...over,
});

beforeAll(async () => {
  size20 = (await owner.containerSize.findFirstOrThrow({ where: { tenantId: null, code: '20STD' } })).id;
  containerUnit = (await owner.costUnit.findFirstOrThrow({ where: { tenantId: null, name: 'Container' } })).id;
  usd = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'USD' } } })).id;
  await cleanup();
  A = await makeWorld('Tariff Alpha', SLUG_A, 'TA');
  B = await makeWorld('Tariff Beta', SLUG_B, 'TB');
});
afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('Tariff', () => {
  let tariffId: string;

  it("saves the sheet's header and grid, numbered, with the POL's country", async () => {
    const res = await api(A.editorToken, A.slug).post('', body(A, [line(A), line(A, { containerSizeId: null, unitPrice: '15' })]));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'TRF-001',
      country: 'Bangladesh',
      polCode: 'TACGP',
      movementType: 'OUTBOUND',
      tariffType: 'PORT_TARIFF',
      lineCount: 2,
    });
    expect(res.body.data.lines[0]).toMatchObject({ containerSizeName: '20STD', unitPrice: '1250.5000', currencyCode: 'USD' });
    expect(res.body.data.lines[1].containerSizeId).toBeNull();
    tariffId = res.body.data.id;

    const list = await api(A.viewerToken, A.slug).get('?search=chattogram');
    expect(list.body.data.map((r: { code: string }) => r.code)).toEqual(['TRF-001']);
  });

  it('refuses a charge naming something this workspace cannot use, and an empty grid', async () => {
    const foreign = await api(A.editorToken, A.slug).post('', body(A, [line(A, { costHeadId: B.costHeadId.toString() })]));
    expect(foreign.status).toBe(400);
    const empty = await api(A.editorToken, A.slug).post('', body(A, []));
    expect(empty.status).toBe(400);
    const negative = await api(A.editorToken, A.slug).post('', body(A, [line(A, { unitPrice: '-5' })]));
    expect(negative.status).toBe(400);
  });

  it('replaces the charges on save, keeping the old ones retired', async () => {
    const res = await api(A.editorToken, A.slug).put(`/${tariffId}`, {
      ...body(A, [line(A, { unitPrice: '1300' })]),
      tariffType: 'CFS_CHARGE',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tariffType: 'CFS_CHARGE', lineCount: 1 });
    expect(res.body.data.lines[0].unitPrice).toBe('1300.0000');
    const retired = await owner.tariffLine.count({ where: { tariffId: BigInt(tariffId), deletedAt: { not: null } } });
    expect(retired).toBe(2);
  });

  it('goes inactive and back, and a viewer can do neither that nor add one', async () => {
    const off = await api(A.editorToken, A.slug).post(`/${tariffId}/toggle-status`, {});
    expect(off.body.data.isActive).toBe(false);
    expect((await api(A.editorToken, A.slug).get('?isActive=false')).body.data).toHaveLength(1);
    expect((await api(A.viewerToken, A.slug).post(`/${tariffId}/toggle-status`, {})).status).toBe(403);
    expect((await api(A.viewerToken, A.slug).post('', body(A, [line(A)]))).status).toBe(403);
  });

  it("keeps each workspace's tariffs to itself", async () => {
    expect((await api(B.viewerToken, B.slug).get()).body.data).toHaveLength(0);
    expect((await api(B.viewerToken, B.slug).get(`/${tariffId}`)).status).toBe(404);
  });
});
