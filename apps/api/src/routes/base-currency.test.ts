import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * The base currency, and the rate a workspace actually books at.
 *
 * Client request, 2026-09-08. Two faults met here, and the second is the
 * expensive one:
 *
 *   - the base was BDT by convention, never declared, so a forwarder outside
 *     Bangladesh had no way to say otherwise;
 *   - Settings → Currency let a workspace set its own rate, wrote it to
 *     currency_rate_history, showed it back on the screen, and NOTHING outside
 *     that screen ever read it. A team could put BDT/USD at 122 and every
 *     quotation would still bill at the system's 120.
 *
 * These hold both, and the property that matters most: money the workspace
 * quoted must come out at the workspace's rate, not the server's default.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'base-alpha';

let tenantId: bigint;
let token: string;
let bdt: bigint;
let usd: bigint;
let aed: bigint;
/** A currency this workspace has no rate for at all. */
let jpy: bigint;
let inquiryId: bigint;
let carrierId: bigint;
let costHeadId: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  // The tenant points at a currency, so let go of it before the currencies die.
  await owner.$executeRawUnsafe(`UPDATE tenant SET currency_id = NULL WHERE slug = '${SLUG}'`);
  for (const table of [
    'quotation_line',
    'quotation',
    'inquiry_volume',
    'inquiry',
    'currency_rate_history',
    'audit_log',
    'cost_head',
    'customer',
    'industry_sector',
    'inquiry_source',
    'carrier',
    'port',
    'currency',
    '"user"',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
}

const api = {
  get: (path: string) =>
    request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
  post: (path: string) =>
    request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
};

/** The rate this workspace is currently booking `id` at, per the list screen. */
async function effective(id: bigint): Promise<string> {
  const res = await api.get('/api/tenant/setting/currencies?limit=100');
  const row = (res.body.data as { id: string; effectiveRate: string }[]).find(
    (c) => c.id === id.toString(),
  );
  return row?.effectiveRate ?? 'missing';
}

const setBase = (id: bigint) => api.post(`/api/tenant/setting/currencies/${id}/set-base`);

const setRate = (id: bigint, rate: string) =>
  api.post(`/api/tenant/setting/currencies/${id}/rate`).send({
    rate,
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
  });

/** Raises a quotation billing in `currencyId` and returns its frozen rate. */
async function quoteAt(currencyId: bigint): Promise<{ status: number; rate?: string; body: unknown }> {
  const res = await api.post('/api/tenant/cs/quotations').send({
    inquiryId: inquiryId.toString(),
    carrierId: carrierId.toString(),
    localCurrencyId: currencyId.toString(),
    quotationDate: '2026-09-08',
    freightCostHeadId: costHeadId.toString(),
  });
  return {
    status: res.status,
    rate: (res.body as { data?: { conversionRate?: string } }).data?.conversionRate,
    body: res.body,
  };
}

beforeAll(async () => {
  await cleanup();

  const tenant = await owner.tenant.create({
    data: { name: 'Base Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const user = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-base',
      username: 'admin-base',
      email: 'a@base.test',
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  /*
   * The workspace's OWN currencies, not the shared rows. A shared row's
   * conversion belongs to every tenant at once, and a test that moved one
   * would move it under whoever else is running.
   */
  const currency = async (name: string, conversion: string) =>
    (
      await owner.currency.create({
        data: { tenantId, code: `BC-${name.slice(0, 3)}`, currency: name, conversion },
        select: { id: true },
      })
    ).id;
  bdt = await currency('BDT — Base Test Taka', '1');
  usd = await currency('USD — Base Test Dollar', '120');
  aed = await currency('AED — Base Test Dirham', '32.7');
  jpy = await currency('JPY — Base Test Yen', '0');

  // Declared through the API, the way a workspace would.
  await owner.tenant.update({ where: { id: tenantId }, data: { currencyId: bdt } });

  // Enough of an inquiry to raise a quotation against.
  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  carrierId = (
    await owner.carrier.create({
      data: { tenantId, code: 'BC-CAR', name: 'Base Lines', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
  const port = (code: string, name: string) =>
    owner.port.create({
      data: { tenantId, code, name, portCode: code, country: 'Bangladesh', type: 'SEAPORT' },
      select: { id: true },
    });
  const pol = await port('BCPOL', 'Chittagong');
  const pod = await port('BCPOD', 'Hamburg');
  const source = await owner.inquirySource.create({
    data: { tenantId, code: 'BCSRC', name: 'Direct' },
    select: { id: true },
  });
  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'BCIS', name: 'Garments' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'BCCUS',
      name: 'Base Test Customer',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const unit = await owner.costUnit.findFirstOrThrow({ select: { id: true } });
  costHeadId = (
    await owner.costHead.create({
      data: { tenantId, code: 'BCCH', name: 'Ocean Freight', category: 'SERVICE', unitId: unit.id },
      select: { id: true },
    })
  ).id;
  inquiryId = (
    await owner.inquiry.create({
      data: {
        tenantId,
        code: 'INQ-2026-000001',
        seriesYear: 2026,
        inquiryDate: new Date('2026-09-08'),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        movementType: 'OUTBOUND',
        loadingType: 'FCL',
        polId: pol.id,
        podId: pod.id,
        status: 'OPEN',
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the workspace declares its base', () => {
  it('reports which currency it books in', async () => {
    const res = await api.get('/api/tenant/setting/currencies/base');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { data: { iso: string } }).data.iso).toBe('BDT');
  });

  it('marks it on the list, and only it', async () => {
    const res = await api.get('/api/tenant/setting/currencies?limit=100');
    const rows = (res.body.data as { id: string; isBase: boolean }[]);
    const bases = rows.filter((r) => r.isBase).map((r) => r.id);
    expect(bases).toEqual([bdt.toString()]);
  });

  it('books the base at exactly 1', async () => {
    expect(await effective(bdt)).toBe('1.0000000000');
  });
});

describe("the workspace's own rate is the one that counts", () => {
  it('falls back to the built-in default until one is set', async () => {
    // The base is the currency the defaults are expressed in, so the fallback
    // is sound here — that is the only case where it is.
    expect(await effective(usd)).toBe('120.0000000000');
  });

  it('uses the rate the workspace set instead', async () => {
    const res = await setRate(usd, '122.5');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await effective(usd)).toBe('122.5000000000');
  });

  it('freezes THAT rate onto a quotation — the bug this fixes', async () => {
    /*
     * Before 2026-09-08 the quotation read currency.conversion and froze 120,
     * silently discarding the 122.5 the workspace had just set. A rate captured
     * on one screen and ignored by the document it exists for.
     */
    const quote = await quoteAt(usd);
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    expect(quote.rate).toBe('122.5');
  });

  it('freezes 1 when billing in the base itself', async () => {
    const quote = await quoteAt(bdt);
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    expect(quote.rate).toBe('1');
  });

  it('refuses to quote in a currency with no usable rate', async () => {
    // JPY was seeded at 0. Multiplying money by nought is not a conversion.
    const quote = await quoteAt(jpy);
    expect(quote.status).toBe(409);
    expect(JSON.stringify(quote.body)).toMatch(/Settings → Currency|exchange rate/i);
  });

  it('offers the same rate on the form that the quotation will freeze', async () => {
    // The figure shown and the figure stored used to come from different
    // columns, so they could disagree.
    const res = await api.get('/api/tenant/cs/quotation-options');
    const row = (res.body.data.currencies as { id: string; conversion: string }[]).find(
      (c) => c.id === usd.toString(),
    );
    expect(row?.conversion).toBe('122.5');
  });
});

describe('changing the base', () => {
  it('moves every rate onto the new one, keeping the ratios', async () => {
    await setRate(aed, '32.7');

    const res = await setBase(usd);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { data: { changed: boolean } }).data.changed).toBe(true);

    // The new base is 1, and the old one is worth 1/122.5 of it.
    expect(await effective(usd)).toBe('1.0000000000');
    expect(Number(await effective(bdt))).toBeCloseTo(1 / 122.5, 9);
    // A dirham was 32.7 taka and is now 32.7/122.5 dollars — the ratio held.
    expect(Number(await effective(aed))).toBeCloseTo(32.7 / 122.5, 9);
  });

  it('says so on the list', async () => {
    const res = await api.get('/api/tenant/setting/currencies?limit=100');
    const rows = res.body.data as { id: string; isBase: boolean }[];
    expect(rows.filter((r) => r.isBase).map((r) => r.id)).toEqual([usd.toString()]);
  });

  it('leaves an already-issued quotation exactly as it was sent', async () => {
    /*
     * §2.2. The quotation frozen at 122.5 was a price a customer was given;
     * rebasing the workspace must not restate it, whatever the new base is.
     */
    const rows = await owner.quotation.findMany({
      where: { tenantId, localCurrencyId: usd },
      select: { conversionRate: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.conversionRate.toString()).toBe('122.5');
  });

  it('stops falling back to the built-in default once the base has moved', async () => {
    /*
     * The silent-money-bug guard. The shared defaults mean "per taka"; the
     * workspace now books in dollars. A currency with no workspace rate must
     * be refused rather than priced two orders of magnitude out.
     */
    const orphan = await owner.currency.create({
      data: { tenantId, code: 'BC-EUR', currency: 'EUR — Base Test Euro', conversion: '130' },
      select: { id: true },
    });

    const quote = await quoteAt(orphan.id);
    expect(quote.status).toBe(409);
    expect(JSON.stringify(quote.body)).toMatch(/not in USD|no .* rate on file/i);

    await owner.currency.delete({ where: { id: orphan.id } });
  });

  it('is a no-op when it is already the base', async () => {
    const res = await setBase(usd);
    expect(res.status).toBe(200);
    expect((res.body as { data: { changed: boolean } }).data.changed).toBe(false);
  });

  it('refuses a currency with no rate to express anything against', async () => {
    const res = await setBase(jpy);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/rate/i);
  });

  it('can be moved back, landing where it started', async () => {
    const res = await setBase(bdt);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await effective(bdt)).toBe('1.0000000000');
    // 122.5 and 32.7, within the rounding two divisions cost.
    expect(Number(await effective(usd))).toBeCloseTo(122.5, 6);
    expect(Number(await effective(aed))).toBeCloseTo(32.7, 6);
  });

  it('keeps the whole trail — no rate was overwritten', async () => {
    // Every rebase closes the rate in force and writes a new one, so the
    // history answers "what were we booking at in March?" for ever.
    const history = await owner.currencyRateHistory.findMany({
      where: { tenantId, currencyId: usd },
      orderBy: { effectiveFrom: 'asc' },
      select: { rate: true, effectiveTo: true },
    });
    expect(history.length).toBeGreaterThanOrEqual(3);
    // Exactly one is still in force.
    expect(history.filter((h) => h.effectiveTo === null)).toHaveLength(1);
  });
});

describe('§7 — the base is behind the currency permission', () => {
  it('refuses a user without SETTING.CURRENCY.EDIT', async () => {
    const plain = await owner.user.create({
      data: {
        tenantId,
        code: 'USR-base-ro',
        username: 'plain-base',
        email: 'plain@base.test',
        passwordHash: 'x',
        isSuperadmin: false,
      },
      select: { id: true },
    });
    const readOnly = await signAccessToken({
      sub: plain.id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      permissions: ['SETTING.CURRENCY.VIEW'],
      tokenVersion: 0,
    });

    const res = await request(app)
      .post(`/api/tenant/setting/currencies/${aed}/set-base`)
      .set('Authorization', `Bearer ${readOnly}`)
      .set('X-Tenant-Slug', SLUG);
    expect(res.status).toBe(403);

    // ...but they may still see what the workspace books in.
    const read = await request(app)
      .get('/api/tenant/setting/currencies/base')
      .set('Authorization', `Bearer ${readOnly}`)
      .set('X-Tenant-Slug', SLUG);
    expect(read.status).toBe(200);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(app)
      .post(`/api/tenant/setting/currencies/${aed}/set-base`)
      .set('X-Tenant-Slug', SLUG);
    expect(res.status).toBe(401);
  });
});

describe('the system default is only shown where it means something', () => {
  /*
   * Client, 2026-09-08: "still it has rate against bdt . but rate will be
   * against base rate".
   *
   * The built-in defaults are expressed against the SYSTEM base — whichever
   * shared currency sits at 1. While a workspace books in that currency they
   * are comparable to its own rates. The moment it moves its base they are on
   * a different axis, and a column of figures against a base nobody named is
   * exactly how somebody reads the wrong number.
   */
  const rowFor = async (id: bigint) => {
    const res = await api.get('/api/tenant/setting/currencies?limit=100');
    return (res.body.data as { id: string; systemRateComparable: boolean; conversion: string }[])
      .find((c) => c.id === id.toString());
  };

  it('is comparable while the workspace books in the system base', async () => {
    // The fixture's base sits at 1, so the defaults and the base agree.
    await setBase(bdt);
    expect((await rowFor(usd))?.systemRateComparable).toBe(true);
  });

  it('stops being comparable the moment the base moves', async () => {
    await setRate(usd, '120');
    await setBase(usd);

    const row = await rowFor(aed);
    expect(row?.systemRateComparable).toBe(false);
    // The figure is still carried — the screen decides to withhold it, and a
    // later report may want to know what the default was.
    expect(row?.conversion).toBe('32.7000000000');
  });

  it('becomes comparable again on the way back', async () => {
    await setBase(bdt);
    expect((await rowFor(aed))?.systemRateComparable).toBe(true);
  });
});

describe('§7 — the base is admin work, not editing', () => {
  /*
   * Client, 2026-09-08: "base rate is for admin". Setting a rate changes one
   * number; changing the base re-expresses every rate the workspace holds, so
   * it is SET_BASE rather than EDIT.
   */
  async function tokenWith(permissions: string[], name: string): Promise<string> {
    const user = await owner.user.create({
      data: {
        tenantId,
        code: `USR-perm-${name}`,
        username: `perm-${name}-base`,
        email: `perm-${name}@base.test`,
        passwordHash: 'x',
        isSuperadmin: false,
      },
      select: { id: true },
    });
    return signAccessToken({
      sub: user.id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      permissions,
      tokenVersion: 0,
    });
  }

  it('refuses someone who may edit currencies but not set the base', async () => {
    const editor = await tokenWith(
      ['SETTING.CURRENCY.VIEW', 'SETTING.CURRENCY.EDIT'],
      'editor',
    );

    // They can still set a rate — that is EDIT, and it is their job.
    const rate = await request(app)
      .post(`/api/tenant/setting/currencies/${aed}/rate`)
      .set('Authorization', `Bearer ${editor}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ rate: '32.9', effectiveFrom: new Date().toISOString() });
    expect(rate.status, JSON.stringify(rate.body)).toBe(201);

    // ...but not move the base under everybody.
    const base = await request(app)
      .post(`/api/tenant/setting/currencies/${aed}/set-base`)
      .set('Authorization', `Bearer ${editor}`)
      .set('X-Tenant-Slug', SLUG);
    expect(base.status).toBe(403);
  });

  it('allows someone holding SET_BASE', async () => {
    const admin = await tokenWith(
      ['SETTING.CURRENCY.VIEW', 'SETTING.CURRENCY.SET_BASE'],
      'admin',
    );
    const res = await request(app)
      .post(`/api/tenant/setting/currencies/${aed}/set-base`)
      .set('Authorization', `Bearer ${admin}`)
      .set('X-Tenant-Slug', SLUG);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Put it back for anything that runs after.
    await setBase(bdt);
  });
});

describe('the list never shows a rate the server would refuse', () => {
  /*
   * The screen and the resolver must agree. A booking rate on the list that
   * lib/currency-rate would refuse to convert with is a promise the API will
   * not keep — and it is how the "rate against BDT" the client spotted was
   * still leaking through after the base had moved.
   */
  const rowFor = async (id: bigint) => {
    const res = await api.get('/api/tenant/setting/currencies?limit=100');
    return (
      res.body.data as { id: string; effectiveRate: string | null; usingSystemDefault: boolean }[]
    ).find((c) => c.id === id.toString());
  };

  it('offers the built-in default while the base is the one it is expressed in', async () => {
    await setBase(bdt);
    // Its own currency: the others have picked up workspace rates by now, and
    // the point here is the row that has none.
    const fresh = await owner.currency.create({
      data: { tenantId, code: 'BC-SGD', currency: 'SGD — Base Test Dollar', conversion: '89' },
      select: { id: true },
    });

    const row = await rowFor(fresh.id);
    expect(row?.effectiveRate).toBe('89.0000000000');
    expect(row?.usingSystemDefault).toBe(true);

    await owner.currency.delete({ where: { id: fresh.id } });
  });

  it('offers no rate at all once the base has moved away', async () => {
    await setRate(usd, '120');
    await setBase(usd);

    /*
     * A currency created after the rebase, so it has no workspace rate and its
     * only default is in the old base. The list must say there is no rate
     * rather than print the old-base figure.
     */
    const eur = await owner.currency.create({
      data: { tenantId, code: 'BC-EU2', currency: 'EUR — Base Test Euro 2', conversion: '130' },
      select: { id: true },
    });

    const row = await rowFor(eur.id);
    expect(row?.effectiveRate).toBeNull();
    expect(row?.usingSystemDefault).toBe(false);

    // And the server agrees — this is the pair that must never disagree.
    const quote = await quoteAt(eur.id);
    expect(quote.status).toBe(409);

    await owner.currency.delete({ where: { id: eur.id } });
    await setBase(bdt);
  });

  it('always offers the base itself, at 1', async () => {
    const row = await rowFor(bdt);
    expect(row?.effectiveRate).toBe('1.0000000000');
    expect(row?.usingSystemDefault).toBe(false);
  });
});

/*
  The reason the columns are NUMERIC(18,10). A rate is a ratio, and how small
  it gets is decided by the base: the moment a workspace books in dollars
  rather than taka, the taka rate needs far more than four places to stay
  honest.
*/
describe('a rate keeps the precision a small currency needs', () => {
  it('stores all ten decimals, unrounded', async () => {
    // One taka in US dollars. At four places this is 0.0081 — two significant
    // figures, and half a percent of error on every line it converts.
    const res = await setRate(usd, '0.0080645161');
    expect(res.status).toBe(201);
    expect(await effective(usd)).toBe('0.0080645161');
  });

  it('freezes those ten decimals onto a quotation', async () => {
    const quote = await quoteAt(usd);
    expect(quote.status).toBe(201);
    expect(quote.rate).toBe('0.0080645161');
  });

  it('refuses more decimals than the column holds, without reaching Postgres', async () => {
    const res = await setRate(usd, '0.00806451612903');
    expect(res.status).toBe(400);
  });

  it('refuses more digits than the column holds, without reaching Postgres', async () => {
    // NUMERIC(18,10) leaves eight digits in front of the point. This used to
    // pass validation and fail as a 500 on the insert.
    const res = await setRate(usd, '123456789.5');
    expect(res.status).toBe(400);
  });

  it('still refuses a rate of zero', async () => {
    expect((await setRate(usd, '0')).status).toBe(400);
  });

  afterAll(async () => {
    await setRate(usd, '122.5');
  });
});
