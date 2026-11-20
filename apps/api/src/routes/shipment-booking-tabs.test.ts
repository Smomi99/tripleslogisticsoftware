import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Booking List's tabs and date filter (owner, 2026-11-20), through HTTP.
 *
 *   Active      every status but CANCELLED
 *   Cancelled   CANCELLED
 *
 * From / To read the day the booking was made in the workspace's own zone
 * (Asia/Dhaka, UTC+6), both days included. Each tab's count is what the tab
 * lists under the other filters, and neither workspace counts the other's
 * (§7A rule 4).
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'bkgtab-alpha';
const SLUG_B = 'bkgtab-beta';

type Status = 'BOOKING_RECEIVED' | 'REJECTED' | 'APPROVED_FOR_SHIPMENT' | 'SHORT_CLOSED' | 'CANCELLED';

/** [status, code suffix, created at (UTC), mode, customer] */
type Seed = [Status, string, string, 'SEA' | 'AIR', 'Dhaka' | 'Sylhet'];

interface World {
  slug: string;
  superToken: string;
  /** Holds no booking permission at all. */
  outsiderToken: string;
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'shipment',
    'quotation',
    'inquiry',
    'customer',
    'industry_sector',
    'carrier',
    'port',
    '"user"',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string, seeds: Seed[]): Promise<World> {
  const { id: tenantId } = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh' },
    select: { id: true },
  });
  const user = async (code: string, isSuperadmin: boolean, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: {
        tenantId,
        code,
        username: `${code.toLowerCase()}-${slug}`,
        email: `${code.toLowerCase()}@${slug}.test`,
        passwordHash: 'x',
        isSuperadmin,
      },
      select: { id: true },
    });
    const token = await signAccessToken({
      sub: id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin,
      permissions,
      tokenVersion: 0,
    });
    return { id, token };
  };
  const admin = await user(`USR-S${tag}`, true, []);
  const outsider = await user(`USR-O${tag}`, false, ['CRM.CUSTOMER.VIEW']);

  const sector = await owner.industrySector.create({
    data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` },
    select: { id: true },
  });
  const customer = async (n: string) =>
    (
      await owner.customer.create({
        data: {
          tenantId,
          code: `CUS-${tag}${n}`,
          name: `${n} Exports ${tag}`,
          country: 'Bangladesh',
          customerType: 'EXPORTER',
          businessArea: 'BOTH',
          industrySectorId: sector.id,
        },
        select: { id: true },
      })
    ).id;
  const customers = { Dhaka: await customer('Dhaka'), Sylhet: await customer('Sylhet') };
  const port = (
    await owner.port.create({
      data: {
        tenantId,
        code: `PL-${tag}`,
        name: `Port ${tag}`,
        portCode: `ZZ${tag}`,
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
      select: { id: true },
    })
  ).id;
  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  const carrier = (
    await owner.carrier.create({
      data: { tenantId, code: `CAR-${tag}`, name: `Line ${tag}`, typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const currency = await owner.currency.findFirstOrThrow({ select: { id: true } });

  // One quotation per customer and mode, so each booking can hang off the
  // quotation its own columns would have come from.
  const quotations = new Map<string, bigint>();
  const quotationFor = async (who: 'Dhaka' | 'Sylhet', mode: 'SEA' | 'AIR'): Promise<bigint> => {
    const key = `${who}-${mode}`;
    const known = quotations.get(key);
    if (known !== undefined) return known;
    const inquiry = await owner.inquiry.create({
      data: {
        tenantId,
        code: `INQ-${tag}-${key}`,
        seriesYear: 2026,
        inquiryDate: new Date('2026-01-01'),
        sourceId: source.id,
        shipmentType: mode,
        customerId: customers[who],
        movementType: 'OUTBOUND',
        polId: port,
        podId: port,
        status: 'WON',
      },
      select: { id: true },
    });
    const { id } = await owner.quotation.create({
      data: {
        tenantId,
        code: `QTN-${tag}-${key}`,
        seriesYear: 2026,
        inquiryId: inquiry.id,
        quotationDate: new Date('2026-01-01'),
        customerId: customers[who],
        shipmentType: mode,
        movementType: 'OUTBOUND',
        polId: port,
        podId: port,
        carrierId: carrier,
        localCurrencyId: currency.id,
        conversionRate: '122.0000',
      },
      select: { id: true },
    });
    quotations.set(key, id);
    return id;
  };

  for (const [status, code, createdAt, mode, who] of seeds) {
    const at = new Date(createdAt);
    await owner.shipment.create({
      data: {
        tenantId,
        code: `BKG-2026-${tag}${code}`,
        seriesYear: 2026,
        quotationId: await quotationFor(who, mode),
        shipmentType: mode,
        customerId: customers[who],
        carrierId: carrier,
        polId: port,
        podId: port,
        status,
        createdAt: at,
        createdBy: admin.id,
        // The database will not hold a cancel or a short close without who, when and why.
        ...(status === 'CANCELLED'
          ? { cancelledAt: at, cancelledBy: admin.id, cancelReason: 'Customer withdrew.' }
          : {}),
        ...(status === 'SHORT_CLOSED'
          ? { shortClosedAt: at, shortClosedBy: admin.id, shortCloseReason: 'Balance not coming.' }
          : {}),
      },
    });
  }

  return { slug, superToken: admin.token, outsiderToken: outsider.token };
}

function api(world: World, token = world.superToken) {
  return (path: string) =>
    request(app).get(`/api/tenant/cs${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', world.slug);
}

const codes = (rows: { code: string }[]) => rows.map((r) => r.code.replace(/^BKG-2026-[A-Z]+/, ''));

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Booking Tabs Alpha', SLUG_A, 'TA', [
    ['BOOKING_RECEIVED', '01', '2026-03-01T06:00:00Z', 'SEA', 'Dhaka'],
    // 01:30 on 5 March in Dhaka, though still the 4th in UTC.
    ['REJECTED', '02', '2026-03-04T19:30:00Z', 'SEA', 'Dhaka'],
    // 23:59 on 5 March in Dhaka — the last minute of the day.
    ['APPROVED_FOR_SHIPMENT', '03', '2026-03-05T17:59:00Z', 'SEA', 'Sylhet'],
    // Midnight in Dhaka: the 6th, not the 5th.
    ['SHORT_CLOSED', '04', '2026-03-05T18:00:00Z', 'SEA', 'Dhaka'],
    ['CANCELLED', '05', '2026-03-05T06:00:00Z', 'SEA', 'Sylhet'],
    ['CANCELLED', '06', '2026-03-20T06:00:00Z', 'SEA', 'Dhaka'],
    // Air: the other menu item, never on the sea list or its counts.
    ['BOOKING_RECEIVED', '07', '2026-03-05T06:00:00Z', 'AIR', 'Dhaka'],
    ['CANCELLED', '08', '2026-03-05T06:00:00Z', 'AIR', 'Dhaka'],
  ]);
  B = await makeWorld('Booking Tabs Beta', SLUG_B, 'TB', [
    ['BOOKING_RECEIVED', '01', '2026-03-05T06:00:00Z', 'SEA', 'Dhaka'],
  ]);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the Booking List tabs', () => {
  const sea = (query: string) => api(A)(`/bookings?shipmentType=SEA&sortBy=code&sortOrder=asc&${query}`);

  it('list each tab’s statuses and only those', async () => {
    const active = await sea('tab=ACTIVE');
    expect(active.status, JSON.stringify(active.body.error ?? {})).toBe(200);
    // Rejected goes back to a new proposal and short closed did ship: both still Active.
    expect(codes(active.body.data)).toEqual(['01', '02', '03', '04']);
    expect(codes((await sea('tab=CANCELLED')).body.data)).toEqual(['05', '06']);
    // No tab is every booking, as before.
    expect((await sea('')).body.meta.total).toBe(6);
  });

  it('narrow by status within a tab, and a status from another tab finds nothing', async () => {
    expect(codes((await sea('tab=ACTIVE&status=REJECTED')).body.data)).toEqual(['02']);
    const elsewhere = await sea('tab=ACTIVE&status=CANCELLED');
    expect(elsewhere.body.data).toEqual([]);
    expect(elsewhere.body.meta.total).toBe(0);
  });

  it('are counted under the other filters, but not the status', async () => {
    const all = await api(A)('/bookings/tab-counts?shipmentType=SEA');
    expect(all.status, JSON.stringify(all.body.error ?? {})).toBe(200);
    expect(all.body.data).toEqual({ ACTIVE: 4, CANCELLED: 2 });

    const sylhet = await api(A)('/bookings/tab-counts?shipmentType=SEA&search=Sylhet&status=REJECTED');
    expect(sylhet.body.data).toEqual({ ACTIVE: 1, CANCELLED: 1 });

    const fifth = await api(A)('/bookings/tab-counts?shipmentType=SEA&fromDate=2026-03-05&toDate=2026-03-05');
    expect(fifth.body.data).toEqual({ ACTIVE: 2, CANCELLED: 1 });

    expect((await api(A)('/bookings/tab-counts?shipmentType=AIR')).body.data).toEqual({ ACTIVE: 1, CANCELLED: 1 });
  });

  it('need the booking permission', async () => {
    expect((await api(A, A.outsiderToken)('/bookings/tab-counts')).status).toBe(403);
  });

  it('keep each workspace to its own bookings', async () => {
    expect((await api(B)('/bookings/tab-counts?shipmentType=SEA')).body.data).toEqual({ ACTIVE: 1, CANCELLED: 0 });
    const list = await api(B)('/bookings?shipmentType=SEA');
    expect(codes(list.body.data)).toEqual(['01']);
    expect(list.body.data[0].code).toBe('BKG-2026-TB01');
  });
});

describe('the Booking List date filter', () => {
  const sea = (query: string) => api(A)(`/bookings?shipmentType=SEA&sortBy=code&sortOrder=asc&${query}`);

  it('reads the day the booking was made in the workspace’s zone', async () => {
    const res = await sea('tab=ACTIVE');
    const dates = Object.fromEntries(
      (res.body.data as { code: string; bookingDate: string }[]).map((r) => [codes([r])[0], r.bookingDate]),
    );
    expect(dates).toEqual({ '01': '2026-03-01', '02': '2026-03-05', '03': '2026-03-05', '04': '2026-03-06' });
  });

  it('includes both days, from the first minute of From to the last of To', async () => {
    expect(codes((await sea('fromDate=2026-03-05&toDate=2026-03-05')).body.data)).toEqual(['02', '03', '05']);
    expect(codes((await sea('fromDate=2026-03-06')).body.data)).toEqual(['04', '06']);
    expect(codes((await sea('toDate=2026-03-04')).body.data)).toEqual(['01']);
    // Blank is no bound, as the screen sends it when a box is cleared.
    expect((await sea('fromDate=&toDate=')).body.meta.total).toBe(6);
  });

  it('works within a tab', async () => {
    expect(codes((await sea('tab=CANCELLED&fromDate=2026-03-10')).body.data)).toEqual(['06']);
  });

  it('refuses a date that is not one', async () => {
    expect((await sea('fromDate=5-3-2026')).status).toBe(400);
    expect((await sea('toDate=2026-13-45')).status).toBe(400);
  });

  it('sorts by the booking date', async () => {
    const res = await api(A)('/bookings?shipmentType=SEA&tab=ACTIVE&sortBy=bookingDate&sortOrder=desc');
    expect(codes(res.body.data)).toEqual(['04', '03', '02', '01']);
  });
});
