import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OverviewDto } from '@ff/shared';

/**
 * Overview, through HTTP.
 *
 * Two workspaces with different amounts of everything, so a figure that leaks
 * across the tenant boundary shows up as a wrong count (CLAUDE.md §7A rule 4).
 * Each also holds what no section may count: an inquiry from before the
 * period, a cancelled booking, a draft invoice.
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'overview-alpha';
const SLUG_B = 'overview-beta';
const YEAR = new Date().getUTCFullYear();
const DAY = 24 * 60 * 60 * 1000;
/** A calendar date this many days back — safely inside a 6-month period for small n. */
const daysAgo = (n: number) => new Date(new Date(new Date().toISOString().slice(0, 10)).getTime() - n * DAY);

interface World {
  slug: string;
  tokens: { super: string; sales: string; invoiceOnly: string; unrelated: string };
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of ['debit_invoice', 'shipment', 'quotation', 'inquiry', 'customer', 'carrier', 'port', 'industry_sector', 'user']) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

/** `extra` more sea inquiries and bookings than the baseline, so the two workspaces never agree. */
async function makeWorld(name: string, slug: string, tag: string, extra: number): Promise<World> {
  const bdt = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } } })).id;
  const { id: tenantId } = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh', currencyId: bdt },
    select: { id: true },
  });
  const user = async (code: string, isSuperadmin: boolean, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x', isSuperadmin },
      select: { id: true },
    });
    return { id, token: await signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin, permissions, tokenVersion: 0 }) };
  };
  const superUser = await user(`USR-S${tag}`, true, []);

  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = await owner.customer.create({
    data: { tenantId, code: `CUS-${tag}`, name: `Exporter ${tag}`, country: 'Bangladesh', customerType: 'EXPORTER', businessArea: 'BOTH', industrySectorId: sector.id },
    select: { id: true },
  });
  const port = async (code: string, country: string) =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${code}`, name: `${code} ${tag}`, portCode: `${tag}${code}`, country, type: 'SEAPORT' },
        select: { id: true },
      })
    ).id;
  const ctg = await port('CTG', 'Bangladesh');
  const ham = await port('HAM', 'Germany');
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({ data: { tenantId, code: `CAR-${tag}`, name: `Line ${tag}`, typeId: carrierType.id }, select: { id: true } });
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });

  let inquiryNo = 0;
  const inquiry = async (
    shipmentType: 'SEA' | 'AIR',
    status: 'OPEN' | 'QUOTED' | 'WON' | 'LOST',
    inquiryDate: Date,
    validTo?: Date,
  ) => {
    inquiryNo += 1;
    return owner.inquiry.create({
      data: {
        tenantId,
        code: `INQ-${YEAR}-8${tag}${String(inquiryNo).padStart(2, '0')}`,
        seriesYear: YEAR,
        inquiryDate,
        sourceId: source.id,
        shipmentType,
        customerId: customer.id,
        movementType: 'OUTBOUND',
        polId: ctg,
        podId: ham,
        status,
        ...(validTo === undefined ? {} : { validTo }),
      },
      select: { id: true },
    });
  };
  const first = await inquiry('SEA', 'WON', daysAgo(3));
  await inquiry('SEA', 'LOST', daysAgo(3));
  await inquiry('AIR', 'QUOTED', daysAgo(3));
  // Still OPEN, past its valid-to: the Live Inquiry list calls it Lapsed.
  await inquiry('SEA', 'OPEN', daysAgo(3), daysAgo(1));
  for (let i = 0; i < extra; i++) await inquiry('SEA', 'OPEN', daysAgo(3));
  // Two years back: outside any period.
  await inquiry('SEA', 'WON', new Date(Date.UTC(YEAR - 2, 0, 15)));

  const quotation = await owner.quotation.create({
    data: {
      tenantId,
      code: `QTN-${YEAR}-8${tag}01`,
      revisionNo: 1,
      seriesYear: YEAR,
      inquiryId: first.id,
      quotationDate: daysAgo(3),
      customerId: customer.id,
      shipmentType: 'SEA',
      movementType: 'OUTBOUND',
      polId: ctg,
      podId: ham,
      carrierId: carrier.id,
      localCurrencyId: bdt,
      conversionRate: '1',
      status: 'ACCEPTED',
    },
    select: { id: true },
  });

  let bookingNo = 0;
  const booking = async (shipmentType: 'SEA' | 'AIR', status: 'BOOKING_RECEIVED' | 'SO_ISSUED' | 'CANCELLED') => {
    bookingNo += 1;
    return owner.shipment.create({
      data: {
        tenantId,
        code: `BKG-${YEAR}-8${tag}${String(bookingNo).padStart(2, '0')}`,
        seriesYear: YEAR,
        quotationId: quotation.id,
        shipmentType,
        customerId: customer.id,
        carrierId: carrier.id,
        polId: ctg,
        podId: ham,
        status,
        ...(status === 'CANCELLED'
          ? { cancelledAt: new Date(), cancelledBy: superUser.id, cancelReason: 'Customer withdrew.' }
          : {}),
      },
      select: { id: true },
    });
  };
  const live = await booking('SEA', 'BOOKING_RECEIVED');
  await booking('AIR', 'SO_ISSUED');
  for (let i = 0; i < extra; i++) await booking('SEA', 'BOOKING_RECEIVED');
  await booking('SEA', 'CANCELLED');

  let invoiceNo = 0;
  const invoice = async (status: 'ISSUED' | 'DRAFT', amount: string, cost: string) => {
    invoiceNo += 1;
    await owner.debitInvoice.create({
      data: {
        tenantId,
        code: `DN-${YEAR}-8${tag}0${invoiceNo}`,
        seriesYear: YEAR,
        kind: status === 'ISSUED' ? 'FREIGHT' : 'OTHER',
        shipmentId: live.id,
        quotationId: quotation.id,
        customerId: customer.id,
        invoiceDate: daysAgo(3),
        currencyId: bdt,
        currencyCode: 'BDT',
        conversionRate: '1',
        totalAmount: amount,
        totalAmountBase: amount,
        costTotalBase: cost,
        status,
      },
    });
  };
  await invoice('ISSUED', String(4000 + extra * 1000), '2500');
  await invoice('DRAFT', '999', '111');

  return {
    slug,
    tokens: {
      super: superUser.token,
      sales: (await user(`USR-L${tag}`, false, ['SALES.INQUIRY.VIEW'])).token,
      invoiceOnly: (await user(`USR-I${tag}`, false, ['ACCOUNTS.DEBIT_INVOICE.VIEW'])).token,
      unrelated: (await user(`USR-U${tag}`, false, ['CRM.CUSTOMER.VIEW'])).token,
    },
  };
}

function get(world: World, token: string, path = '/api/tenant/overview') {
  return request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', world.slug);
}

async function overview(world: World, token: string, query = ''): Promise<OverviewDto> {
  const res = await get(world, token, `/api/tenant/overview${query}`);
  expect(res.status).toBe(200);
  return (res.body as { data: OverviewDto }).data;
}

const total = (rows: { SEA: number; AIR: number }[]) => rows.reduce((n, r) => n + r.SEA + r.AIR, 0);

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Overview Alpha', SLUG_A, 'OA', 0);
  B = await makeWorld('Overview Beta', SLUG_B, 'OB', 2);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

/** YYYY-MM-DD, n days back — the same calendar day the fixtures were dated with daysAgo(n). */
const isoDaysAgo = (n: number) => daysAgo(n).toISOString().slice(0, 10);

const revenue = (rows: { revenue: string }[]) => rows.reduce((n, m) => n + Number(m.revenue), 0);

describe('GET /overview', () => {
  it('counts only this workspace, and only what each screen counts', async () => {
    const a = await overview(A, A.tokens.super);
    // The default is the last 6 months, a column per month.
    expect(a.range).toMatchObject({ period: '6months', bucket: 'month' });
    expect(a.buckets).toHaveLength(6);

    // Four inquiries in the range; the one from two years back is not.
    expect(total(a.sales!.byBucket)).toBe(4);
    expect(a.sales!.total).toBe(4);
    expect(a.sales!.byBucket.reduce((n, r) => n + r.AIR, 0)).toBe(1);
    expect(a.sales!.byStatus).toEqual([
      { status: 'LAPSED', count: 1 },
      { status: 'QUOTED', count: 1 },
      { status: 'WON', count: 1 },
      { status: 'LOST', count: 1 },
    ]);
    expect(a.sales!.winRate).toBe(0.5);

    // Two live bookings; the cancelled one is a status, never a booking in a column.
    expect(total(a.bookings!.byBucket)).toBe(2);
    expect(a.bookings!.total).toBe(2);
    expect(a.bookings!.byStatus.find((s) => s.status === 'CANCELLED')?.count).toBe(1);
    expect(a.bookings!.topCustomers).toEqual([expect.objectContaining({ name: 'Exporter OA', count: 2 })]);
    expect(a.bookings!.topDestinations).toEqual([
      expect.objectContaining({ name: 'HAM OA', detail: 'Germany', count: 2 }),
    ]);

    // The issued invoice only — a draft is not yet a bill.
    expect(a.invoicing!.currency).toBe('BDT');
    expect(revenue(a.invoicing!.byBucket)).toBe(4000);
    expect(a.invoicing!.total).toBe('4000.00');
    expect(a.invoicing!.byBucket.reduce((n, m) => n + Number(m.cost), 0)).toBe(2500);

    // Workspace B has more of everything; none of it reached A, and vice versa.
    const b = await overview(B, B.tokens.super);
    expect(b.sales!.total).toBe(6);
    expect(b.bookings!.total).toBe(4);
    expect(b.invoicing!.total).toBe('6000.00');
  });

  it('counts today, day by day, against yesterday', async () => {
    const a = await overview(A, A.tokens.super, '?period=today');
    expect(a.range.from).toBe(a.range.to);
    expect(a.range.bucket).toBe('day');
    expect(a.buckets).toEqual([a.range.from]);
    // The bookings were opened just now; the inquiries are dated three days back.
    expect(a.bookings!.total).toBe(2);
    expect(a.sales!.total).toBe(0);
  });

  it('takes a custom range, and compares it with the same number of days before it', async () => {
    const day = isoDaysAgo(3);
    const on = await overview(A, A.tokens.super, `?period=custom&from=${day}&to=${day}`);
    expect(on.range).toMatchObject({ period: 'custom', from: day, to: day, bucket: 'day' });
    expect(on.sales!.total).toBe(4);
    expect(on.invoicing!.total).toBe('4000.00');

    // The day after: nothing in it, and the day before it is the one above.
    const next = isoDaysAgo(2);
    const after = await overview(A, A.tokens.super, `?period=custom&from=${next}&to=${next}`);
    expect(after.range).toMatchObject({ previousFrom: day, previousTo: day });
    expect(after.sales).toMatchObject({ total: 0, previousTotal: 4 });
    expect(after.invoicing).toMatchObject({ total: '0.00', previousTotal: '4000.00' });

    // A whole year two years back, month by month: only the old inquiry.
    const old = await overview(A, A.tokens.super, `?period=custom&from=${YEAR - 2}-01-01&to=${YEAR - 2}-12-31`);
    expect(old.range.bucket).toBe('month');
    expect(old.buckets).toHaveLength(12);
    expect(old.sales!.total).toBe(1);
  });

  it('repeats the Receivable-Payable list total exactly', async () => {
    const a = await overview(A, A.tokens.super);
    const list = await get(A, A.tokens.super, '/api/tenant/accounts/receivable-payable');
    expect(list.status).toBe(200);
    const totals = (list.body as { meta: { totals: { receivableBase: string; payableBase: string; unbilledBase: string } } }).meta.totals;
    expect(a.balances).toEqual({
      currency: 'BDT',
      receivable: totals.receivableBase,
      unbilled: totals.unbilledBase,
      payable: totals.payableBase,
    });
  });

  it('returns only the sections the user may open', async () => {
    const sales = await overview(A, A.tokens.sales);
    expect(sales.sales).not.toBeNull();
    expect(sales.bookings).toBeNull();
    expect(sales.invoicing).toBeNull();
    expect(sales.balances).toBeNull();

    // Invoices without VIEW_BUY_PRICE: revenue, never cost.
    const invoiceOnly = await overview(A, A.tokens.invoiceOnly);
    expect(invoiceOnly.sales).toBeNull();
    expect(invoiceOnly.invoicing!.byBucket.every((m) => m.cost === null)).toBe(true);
  });

  it('refuses a user who may open none of the screens behind it', async () => {
    expect((await get(A, A.tokens.unrelated)).status).toBe(403);
  });

  it('refuses a period it does not know, and a custom range it cannot use', async () => {
    const status = async (query: string) => (await get(A, A.tokens.super, `/api/tenant/overview${query}`)).status;
    expect(await status('?period=decade')).toBe(400);
    expect(await status('?period=custom')).toBe(400);
    expect(await status(`?period=custom&from=${YEAR}-03-10&to=${YEAR}-03-01`)).toBe(400);
    expect(await status(`?period=custom&from=${YEAR - 4}-01-01&to=${YEAR}-01-01`)).toBe(400);
    for (const period of ['today', 'month', '6months', 'year']) expect(await status(`?period=${period}`)).toBe(200);
  });
});
