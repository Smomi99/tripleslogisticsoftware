import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Sales & Marketing → Local Sales, through HTTP — DESIGN-UPDATE-2026-10-04 §6.
 * Two workspaces, so each is also a check the other sees none of it.
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'localsales-alpha';
const SLUG_B = 'localsales-beta';
const dayFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

interface World {
  slug: string;
  salesToken: string;
  viewerToken: string;
  customerId: bigint;
  picId: bigint;
  otherCustomerPicId: bigint;
}
let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of ['customer_activity', 'customer_pic', 'customer', 'industry_sector', 'user']) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string): Promise<World> {
  const usd = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'USD' } } })).id;
  const { id: tenantId } = await owner.tenant.create({ data: { name, slug, country: 'Bangladesh' }, select: { id: true } });
  const token = async (code: string, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x' },
      select: { id: true },
    });
    return signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin: false, permissions, tokenVersion: 0 });
  };
  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = async (n: number, extra: Record<string, unknown> = {}) =>
    owner.customer.create({
      data: {
        tenantId,
        code: `CUS-${tag}${n}`,
        name: `Rahim Afroz ${tag}${n}`,
        country: 'Bangladesh',
        customerType: 'EXPORTER',
        businessArea: 'BOTH',
        industrySectorId: sector.id,
        ...extra,
      },
      select: { id: true },
    });
  const main = await customer(1, { exSeaVolumeTeuMonth: '12.5', customerOwe: '500', openingCurrencyId: usd });
  const other = await customer(2);
  const pic = await owner.customerPic.create({ data: { tenantId, code: `CPC-${tag}1`, customerId: main.id, name: 'Mr. Karim' }, select: { id: true } });
  const otherPic = await owner.customerPic.create({ data: { tenantId, code: `CPC-${tag}2`, customerId: other.id, name: 'Ms. Nila' }, select: { id: true } });
  return {
    slug,
    salesToken: await token(`USR-S${tag}`, ['SALES.LOCAL_SALES.VIEW', 'SALES.LOCAL_SALES.CREATE']),
    viewerToken: await token(`USR-V${tag}`, ['SALES.LOCAL_SALES.VIEW']),
    customerId: main.id,
    picId: pic.id,
    otherCustomerPicId: otherPic.id,
  };
}

function api(token: string, slug: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  const base = '/api/tenant/sales/local-sales';
  return {
    get: (path = '') => wrap(request(app).get(`${base}${path}`)),
    post: (path: string, body: unknown) => wrap(request(app).post(`${base}${path}`)).send(body as object),
  };
}

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Local Sales Alpha', SLUG_A, 'LA');
  B = await makeWorld('Local Sales Beta', SLUG_B, 'LB');
});
afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('Local Sales', () => {
  it("lists every customer with the sheet's columns and its opening balance", async () => {
    const res = await api(A.viewerToken, A.slug).get('?sortBy=name');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      name: 'Rahim Afroz LA1',
      commodityCategory: 'Garments LA',
      exSeaVolumeTeuMonth: '12.5000',
      customerOwe: '500.0000',
      openingCurrency: 'USD',
      activityCount: 0,
    });
  });

  it('records a meeting against the customer, with one of its own contacts', async () => {
    const path = `/${A.customerId}/activities`;
    const blank = await api(A.salesToken, A.slug).post(path, { activityAt: new Date().toISOString(), meetingSummary: ' ' });
    expect(blank.status).toBe(400);

    const wrongPic = await api(A.salesToken, A.slug).post(path, {
      activityAt: new Date().toISOString(),
      customerPicId: A.otherCustomerPicId.toString(),
      meetingSummary: 'Met at their office',
    });
    expect(wrongPic.status).toBe(400);

    const res = await api(A.salesToken, A.slug).post(path, {
      activityAt: new Date().toISOString(),
      customerPicId: A.picId.toString(),
      meetingSummary: 'Discussed Q4 volumes to Hamburg',
      nextFollowupDate: dayFromNow(7),
      competitorAnalysis: 'Another forwarder quoted lower on CTG-HAM',
      businessPossibility: 'High — 4 TEU a month',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.activities[0]).toMatchObject({
      picName: 'Mr. Karim',
      meetingSummary: 'Discussed Q4 volumes to Hamburg',
      nextFollowupDate: dayFromNow(7),
      businessPossibility: 'High — 4 TEU a month',
    });

    const list = await api(A.viewerToken, A.slug).get('?search=LA1');
    expect(list.body.data[0]).toMatchObject({ activityCount: 1, nextFollowupDate: dayFromNow(7) });
  });

  it('lets a viewer read the log but not add to it', async () => {
    expect((await api(A.viewerToken, A.slug).get(`/${A.customerId}/activities`)).status).toBe(200);
    const res = await api(A.viewerToken, A.slug).post(`/${A.customerId}/activities`, {
      activityAt: new Date().toISOString(),
      meetingSummary: 'x',
    });
    expect(res.status).toBe(403);
  });

  it("keeps each workspace's customers and log to itself", async () => {
    const b = await api(B.viewerToken, B.slug).get();
    expect(b.body.data.every((r: { name: string }) => r.name.includes('LB'))).toBe(true);
    expect((await api(B.salesToken, B.slug).get(`/${A.customerId}/activities`)).status).toBe(404);
    const crossed = await api(B.salesToken, B.slug).post(`/${A.customerId}/activities`, {
      activityAt: new Date().toISOString(),
      meetingSummary: 'x',
    });
    expect(crossed.status).toBe(404);
  });
});
