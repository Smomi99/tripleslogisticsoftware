import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Live Inquiry's tabs and order (owner, 2026-11-01), through HTTP.
 *
 *   Active          OPEN, RFQ_SENT, PRICED, QUOTED
 *   Won             WON
 *   Lost & closed   LOST, EXPIRED, CANCELLED
 *
 * Each tab's count is what the tab lists under the other filters; the list
 * reads newest first; and neither workspace counts the other's (§7A rule 4).
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'inqtab-alpha';
const SLUG_B = 'inqtab-beta';
const YEAR = new Date().getUTCFullYear();
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Status = 'OPEN' | 'RFQ_SENT' | 'PRICED' | 'QUOTED' | 'WON' | 'LOST' | 'EXPIRED' | 'CANCELLED';

interface World {
  slug: string;
  superToken: string;
  /** Holds no inquiry permission at all. */
  outsiderToken: string;
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of ['inquiry', 'customer', 'port', 'industry_sector', 'user']) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string, statuses: [Status, string, string][]): Promise<World> {
  const bdt = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } } })).id;
  const { id: tenantId } = await owner.tenant.create({ data: { name, slug, country: 'Bangladesh', currencyId: bdt }, select: { id: true } });
  const user = async (code: string, isSuperadmin: boolean, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x', isSuperadmin },
      select: { id: true },
    });
    return signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin, permissions, tokenVersion: 0 });
  };
  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = async (n: string) =>
    (
      await owner.customer.create({
        data: { tenantId, code: `CUS-${tag}${n}`, name: `${n} Exports ${tag}`, country: 'Bangladesh', customerType: 'EXPORTER', businessArea: 'BOTH', industrySectorId: sector.id },
        select: { id: true },
      })
    ).id;
  const dhaka = await customer('Dhaka');
  const sylhet = await customer('Sylhet');
  const port = async (code: string) =>
    (await owner.port.create({ data: { tenantId, code: `PL-${tag}${code}`, name: `${code} ${tag}`, portCode: `${tag}${code}`, country: 'Bangladesh', type: 'SEAPORT' }, select: { id: true } })).id;
  const ctg = await port('CTG');
  const ham = await port('HAM');
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });

  // Created in this order, so a later row of the same date has the higher id.
  for (const [status, code, date] of statuses) {
    await owner.inquiry.create({
      data: {
        tenantId,
        code: `INQ-${YEAR}-${tag}${code}`,
        seriesYear: YEAR,
        inquiryDate: at(date),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: code.endsWith('S') ? sylhet : dhaka,
        movementType: 'OUTBOUND',
        polId: ctg,
        podId: ham,
        status,
      },
    });
  }

  return {
    slug,
    superToken: await user(`USR-S${tag}`, true, []),
    outsiderToken: await user(`USR-O${tag}`, false, ['CRM.CUSTOMER.VIEW']),
  };
}

function api(world: World, token = world.superToken) {
  return (path: string) =>
    request(app).get(`/api/tenant/sales${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', world.slug);
}

const codes = (rows: { code: string }[]) => rows.map((r) => r.code.replace(/^INQ-\d+-[A-Z]+/, ''));

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Tabs Alpha', SLUG_A, 'TA', [
    ['OPEN', '01', `${YEAR}-01-10`],
    ['RFQ_SENT', '02', `${YEAR}-03-05`],
    ['PRICED', '03', `${YEAR}-03-05`],
    ['QUOTED', '04S', `${YEAR}-02-20`],
    ['WON', '05', `${YEAR}-02-01`],
    ['LOST', '06S', `${YEAR}-01-15`],
    ['EXPIRED', '07', `${YEAR}-01-20`],
    ['CANCELLED', '08', `${YEAR}-03-01`],
  ]);
  B = await makeWorld('Tabs Beta', SLUG_B, 'TB', [
    ['OPEN', '01', `${YEAR}-01-10`],
    ['WON', '02', `${YEAR}-01-11`],
  ]);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the Live Inquiry tabs', () => {
  it('list each tab’s statuses and only those', async () => {
    const list = (tab: string) => api(A)(`/inquiries?tab=${tab}&sortBy=code&sortOrder=asc`);
    const active = await list('ACTIVE');
    expect(active.status, JSON.stringify(active.body.error ?? {})).toBe(200);
    expect(codes(active.body.data)).toEqual(['01', '02', '03', '04S']);
    expect(codes((await list('WON')).body.data)).toEqual(['05']);
    expect(codes((await list('CLOSED')).body.data)).toEqual(['06S', '07', '08']);
    // No tab is every inquiry, as before.
    expect((await api(A)('/inquiries')).body.meta.total).toBe(8);
  });

  it('narrow by status within a tab, and a status from another tab finds nothing', async () => {
    const quoted = await api(A)('/inquiries?tab=ACTIVE&status=QUOTED');
    expect(codes(quoted.body.data)).toEqual(['04S']);
    const elsewhere = await api(A)('/inquiries?tab=ACTIVE&status=WON');
    expect(elsewhere.body.data).toEqual([]);
    expect(elsewhere.body.meta.total).toBe(0);
  });

  it('are counted under the other filters', async () => {
    const all = await api(A)('/inquiries/tab-counts');
    expect(all.status, JSON.stringify(all.body.error ?? {})).toBe(200);
    expect(all.body.data).toEqual({ ACTIVE: 4, WON: 1, CLOSED: 3 });
    // The search narrows the counts as it narrows the list; the status filter does not.
    const sylhet = await api(A)('/inquiries/tab-counts?search=Sylhet&status=QUOTED');
    expect(sylhet.body.data).toEqual({ ACTIVE: 1, WON: 0, CLOSED: 1 });
    const march = await api(A)(`/inquiries/tab-counts?fromDate=${YEAR}-03-01&toDate=${YEAR}-03-31`);
    expect(march.body.data).toEqual({ ACTIVE: 2, WON: 0, CLOSED: 1 });
  });

  it('need the Live Inquiry permission', async () => {
    expect((await api(A, A.outsiderToken)('/inquiries/tab-counts')).status).toBe(403);
  });

  it('keep each workspace to its own inquiries', async () => {
    expect((await api(B)('/inquiries/tab-counts')).body.data).toEqual({ ACTIVE: 1, WON: 1, CLOSED: 0 });
  });
});

describe('the Live Inquiry order', () => {
  it('reads the most recent date first, the later-created first within a day', async () => {
    const res = await api(A)('/inquiries?tab=ACTIVE&sortBy=inquiryDate&sortOrder=desc');
    // 03 and 02 share 5 March; 03 was created after 02, so it leads.
    expect(codes(res.body.data)).toEqual(['03', '02', '04S', '01']);
  });
});
