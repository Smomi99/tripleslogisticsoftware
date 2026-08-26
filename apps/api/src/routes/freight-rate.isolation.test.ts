import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Purchase rate entry — isolation and the two rules that guard money
 * (docs/MODULE_PURCHASE_SALES.md §4, CLAUDE.md §7A rule 4).
 *
 * The §4 rule 5 assertions are the point of this file. "Hiding a column in
 * React while the JSON still carries the margin is not access control" — so
 * these check the actual response body for the absence of the key, not the
 * absence of a rendered column.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG_A = 'rate-alpha';
const SLUG_B = 'rate-beta';
const PREFIX = 'FRTEST-';

const ALL_FCL = [
  'PURCHASE.SEA_FREIGHT_FCL.VIEW',
  'PURCHASE.SEA_FREIGHT_FCL.CREATE',
  'PURCHASE.SEA_FREIGHT_FCL.EDIT',
];

let tenantA: bigint;
let tenantB: bigint;
/** Superadmin — sees everything, including the margin. */
let tokenA: string;
/** Holds the FCL screen permissions but neither rate-column permission. */
let tokenNoMargin: string;
/** Holds nothing at all. */
let tokenNothing: string;

let seaPolId: bigint;
let seaPodId: bigint;
let airPortId: bigint;
let seaCarrierId: bigint;
let airCarrierId: bigint;
let goodsTypeId: bigint;
let currencyId: bigint;
let fclTierId: bigint;
let airTierId: bigint;
let rateBId: bigint;

async function makeTenant(name: string, slug: string): Promise<bigint> {
  const tenant = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh' },
    select: { id: true },
  });
  return tenant.id;
}

async function makeUser(
  tenantId: bigint,
  suffix: string,
  isSuperadmin: boolean,
  permissions: string[],
): Promise<string> {
  const user = await owner.user.create({
    data: {
      tenantId,
      code: `USR-${suffix}`,
      username: `user-${suffix}`,
      email: `${suffix}@rate.test`,
      passwordHash: 'x',
      isSuperadmin,
    },
    select: { id: true },
  });
  return signAccessToken({
    sub: user.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin,
    permissions,
    tokenVersion: 0,
  });
}

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`;
  await owner.$executeRawUnsafe(`DELETE FROM rate_profit_log WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_local_charge WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate_line WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_tier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM goods_type WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE code LIKE '${PREFIX}%'`);
}

beforeAll(async () => {
  await cleanup();

  tenantA = await makeTenant('Rate Alpha', SLUG_A);
  tenantB = await makeTenant('Rate Beta', SLUG_B);

  tokenA = await makeUser(tenantA, `super-${SLUG_A}`, true, []);
  tokenNoMargin = await makeUser(tenantA, `plain-${SLUG_A}`, false, ALL_FCL);
  tokenNothing = await makeUser(tenantA, `none-${SLUG_A}`, false, []);

  const mkPort = async (code: string, name: string, portCode: string, type: 'SEAPORT' | 'AIRPORT') =>
    (
      await owner.port.create({
        data: { code: `${PREFIX}${code}`, name, portCode, country: 'Bangladesh', type },
        select: { id: true },
      })
    ).id;

  seaPolId = await mkPort('POL', 'Rate Test Seaport A', 'FRPOL1', 'SEAPORT');
  seaPodId = await mkPort('POD', 'Rate Test Seaport B', 'FRPOD1', 'SEAPORT');
  airPortId = await mkPort('AIR', 'Rate Test Airport', 'FRAIR1', 'AIRPORT');

  const carrierTypes = await owner.carrierType.findMany({ select: { id: true, name: true } });
  const airlineType = carrierTypes.find((t) => t.name.toLowerCase() === 'airline');
  const seaType = carrierTypes.find((t) => t.name.toLowerCase() !== 'airline');
  if (airlineType === undefined || seaType === undefined) {
    throw new Error('Seed must provide an Airline carrier type and at least one sea type.');
  }

  seaCarrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}SEACAR`, name: 'Rate Test Line', typeId: seaType.id },
      select: { id: true },
    })
  ).id;
  airCarrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}AIRCAR`, name: 'Rate Test Airways', typeId: airlineType.id },
      select: { id: true },
    })
  ).id;

  goodsTypeId = (
    await owner.goodsType.create({
      data: { code: `${PREFIX}GT`, name: 'Rate Test Goods' },
      select: { id: true },
    })
  ).id;

  currencyId = (await owner.currency.findFirstOrThrow({ select: { id: true } })).id;

  fclTierId = (
    await owner.rateTier.create({
      data: { code: `${PREFIX}FCL`, mode: 'SEA_FCL', label: 'Test Box', unit: 'CONTAINER' },
      select: { id: true },
    })
  ).id;
  airTierId = (
    await owner.rateTier.create({
      data: { code: `${PREFIX}AIRT`, mode: 'AIR', label: 'Test Break', unit: 'KG' },
      select: { id: true },
    })
  ).id;

  // Tenant B's rate, which tenant A must never see.
  rateBId = (
    await owner.freightRate.create({
      data: {
        tenantId: tenantB,
        code: 'RATE-999',
        mode: 'SEA_FCL',
        polId: seaPolId,
        podId: seaPodId,
        carrierId: seaCarrierId,
        goodsTypeId,
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: seaCarrierId,
        currencyId,
        validFrom: new Date('2026-01-01'),
        validTo: new Date('2030-12-31'),
        status: 'PUBLISHED',
        // tenantId is derived from the parent through the composite FK, so
        // Prisma refuses it here.
        lines: { create: [{ tierId: fclTierId, buyPrice: '4444.0000' }] },
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function as(token: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG_A),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG_A),
    patch: (path: string) =>
      request(app).patch(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG_A),
  };
}

/** A valid Sea FCL rate body, with only the named fields overridden. */
function rateBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'SEA_FCL',
    polId: seaPolId.toString(),
    podId: seaPodId.toString(),
    carrierId: seaCarrierId.toString(),
    goodsTypeId: goodsTypeId.toString(),
    purchaseSourceType: 'CARRIER',
    purchaseCarrierId: seaCarrierId.toString(),
    currencyId: currencyId.toString(),
    validFrom: '2026-02-01',
    validTo: '2026-02-28',
    status: 'DRAFT',
    lines: [
      { tierId: fclTierId.toString(), buyPrice: '1000.0000', profitType: 'FLAT', profitValue: '200.0000' },
    ],
    localCharges: [],
    ...over,
  };
}

describe('§7A rule 4 — the rate list leaks no other tenant', () => {
  it('never returns another workspace rate', async () => {
    const response = await as(tokenA).get(
      '/api/tenant/purchase/rates?mode=SEA_FCL&limit=100&includeExpired=true',
    );
    expect(response.status).toBe(200);
    const codes: string[] = response.body.data.map((r: { code: string }) => r.code);
    expect(codes).not.toContain('RATE-999');
  });

  it('cannot read another workspace rate by id', async () => {
    const response = await as(tokenA).get(
      `/api/tenant/purchase/rates/${rateBId}?mode=SEA_FCL`,
    );
    expect(response.status).toBe(404);
  });

  it('cannot soft-delete another workspace rate', async () => {
    const response = await as(tokenA)
      .post(`/api/tenant/purchase/rates/${rateBId}/delete`)
      .send({ mode: 'SEA_FCL' });
    expect(response.status).toBe(404);

    const still = await owner.freightRate.findUnique({ where: { id: rateBId } });
    expect(still?.deletedAt).toBeNull();
  });
});

describe('§4 rule 5 — buy price and margin never leave the server unpermitted', () => {
  let rateId: string;

  beforeAll(async () => {
    const created = await as(tokenA)
      .post('/api/tenant/purchase/rates')
      .send(rateBody({ validFrom: '2026-03-01', validTo: '2026-03-31' }));
    expect(created.status).toBe(201);
    rateId = created.body.data.id;
  });

  it('gives a superadmin the buy price and the margin', async () => {
    const response = await as(tokenA).get(
      `/api/tenant/purchase/rates/${rateId}?mode=SEA_FCL`,
    );
    const line = response.body.data.lines[0];
    expect(line.buyPrice).toBe('1000.0000');
    expect(line.profitValue).toBe('200.0000');
    expect(line.sellPrice).toBe('1200.0000');
  });

  it('omits the keys entirely for a user without VIEW_BUY_PRICE', async () => {
    const response = await as(tokenNoMargin).get(
      `/api/tenant/purchase/rates/${rateId}?mode=SEA_FCL`,
    );
    expect(response.status).toBe(200);

    const line = response.body.data.lines[0];
    // Absent, not blanked, not zeroed — a zero would read as a real margin.
    expect(line).not.toHaveProperty('buyPrice');
    expect(line).not.toHaveProperty('profitType');
    expect(line).not.toHaveProperty('profitValue');
    // The sell price is what they are entitled to see, and it is intact.
    expect(line.sellPrice).toBe('1200.0000');
  });

  it('keeps them out of the list response too, not just the detail one', async () => {
    const response = await as(tokenNoMargin).get(
      '/api/tenant/purchase/rates?mode=SEA_FCL&limit=100&includeExpired=true',
    );
    expect(response.status).toBe(200);

    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('buyPrice');
    expect(raw).not.toContain('profitValue');
    expect(response.body.data.length).toBeGreaterThan(0);
  });

  it('ignores a margin posted by a user without MANAGE_PROFIT', async () => {
    const created = await as(tokenNoMargin)
      .post('/api/tenant/purchase/rates')
      .send(
        rateBody({
          validFrom: '2026-04-01',
          validTo: '2026-04-30',
          lines: [
            {
              tierId: fclTierId.toString(),
              buyPrice: '900.0000',
              profitType: 'PERCENT',
              profitValue: '99.0000',
            },
          ],
        }),
      );
    expect(created.status).toBe(201);

    // Recorded at zero margin: the buyer captures cost, the price team adds
    // the margin later. Read back as owner, since the creator cannot see it.
    const line = await owner.freightRateLine.findFirstOrThrow({
      where: { rateId: BigInt(created.body.data.id) },
      select: { profitType: true, profitValue: true, sellPrice: true },
    });
    expect(line.profitType).toBe('FLAT');
    expect(line.profitValue.toFixed(4)).toBe('0.0000');
    expect(line.sellPrice?.toFixed(4)).toBe('900.0000');
  });
});

describe('§7 — every rate route is permission guarded, per mode', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await request(app)
      .get('/api/tenant/purchase/rates?mode=SEA_FCL')
      .set('X-Tenant-Slug', SLUG_A);
    expect(response.status).toBe(401);
  });

  it('rejects a user holding no permission', async () => {
    const response = await as(tokenNothing).get('/api/tenant/purchase/rates?mode=SEA_FCL');
    expect(response.status).toBe(403);
  });

  it('does not let an FCL permission open the Air screen', async () => {
    const response = await as(tokenNoMargin).get('/api/tenant/purchase/rates?mode=AIR');
    expect(response.status).toBe(403);
  });

  it('refuses a request with no mode rather than guessing one', async () => {
    const response = await as(tokenA).get('/api/tenant/purchase/rates');
    expect(response.status).toBe(400);
  });
});

describe('§4 rule 9 — air uses airports and airlines, sea uses neither', () => {
  it('refuses a sea rate routed through an airport', async () => {
    const response = await as(tokenA)
      .post('/api/tenant/purchase/rates')
      .send(rateBody({ podId: airPortId.toString(), validFrom: '2026-05-01', validTo: '2026-05-31' }));
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/seaport/i);
  });

  it('refuses a sea rate carried by an airline', async () => {
    const response = await as(tokenA)
      .post('/api/tenant/purchase/rates')
      .send(
        rateBody({
          carrierId: airCarrierId.toString(),
          purchaseCarrierId: airCarrierId.toString(),
          validFrom: '2026-05-01',
          validTo: '2026-05-31',
        }),
      );
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/airline/i);
  });

  it('refuses a rate priced against another mode tier', async () => {
    const response = await as(tokenA)
      .post('/api/tenant/purchase/rates')
      .send(
        rateBody({
          validFrom: '2026-05-01',
          validTo: '2026-05-31',
          lines: [{ tierId: airTierId.toString(), buyPrice: '100.0000' }],
        }),
      );
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/own mode/i);
  });
});

describe('§4 rule 8 — the overlap constraint reaches the user as a sentence', () => {
  it('refuses a second published rate covering the same lane and period', async () => {
    const first = await as(tokenA)
      .post('/api/tenant/purchase/rates')
      .send(
        rateBody({ status: 'PUBLISHED', validFrom: '2028-01-01', validTo: '2028-06-30' }),
      );
    expect(first.status).toBe(201);

    const second = await as(tokenA)
      .post('/api/tenant/purchase/rates')
      .send(
        rateBody({ status: 'PUBLISHED', validFrom: '2028-06-01', validTo: '2028-12-31' }),
      );
    expect(second.status).toBe(409);
    expect(second.body.error.message).toMatch(/already covers this lane/i);
  });
});

describe('§4 rules 1 and 2 — published rates are immutable, expired ones hidden', () => {
  it('edits a published rate in place', async () => {
    // Phase C refused this edit outright; phase G versioned it instead. It now
    // edits, because audit_log already holds the history a duplicate row was
    // standing in for. rate-versioning.test.ts covers that in full.
    const published = await as(tokenA)
      .post('/api/tenant/purchase/rates')
      .send(
        rateBody({ status: 'PUBLISHED', validFrom: '2029-01-01', validTo: '2029-06-30' }),
      );
    expect(published.status).toBe(201);
    const originalId = published.body.data.id;

    const edit = await as(tokenA)
      .patch(`/api/tenant/purchase/rates/${originalId}`)
      .send(rateBody({ status: 'PUBLISHED', validFrom: '2029-01-01', validTo: '2029-07-31' }));
    expect(edit.status).toBe(200);
    expect(edit.body.data.id).toBe(originalId);

    const original = await owner.freightRate.findUnique({ where: { id: BigInt(originalId) } });
    expect(original?.status).toBe('PUBLISHED');
    expect(original?.supersededById).toBeNull();
    expect(original?.validTo.toISOString().slice(0, 10)).toBe('2029-07-31');
  });

  it('hides an expired rate by default and shows it on request', async () => {
    const expired = await owner.freightRate.create({
      data: {
        tenantId: tenantA,
        code: 'RATE-EXPIRED',
        mode: 'SEA_FCL',
        polId: seaPolId,
        podId: seaPodId,
        carrierId: seaCarrierId,
        goodsTypeId,
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: seaCarrierId,
        currencyId,
        validFrom: new Date('2020-01-01'),
        validTo: new Date('2020-12-31'),
        status: 'EXPIRED',
      },
      select: { id: true },
    });

    const byDefault = await as(tokenA).get('/api/tenant/purchase/rates?mode=SEA_FCL&limit=100');
    const defaultCodes: string[] = byDefault.body.data.map((r: { code: string }) => r.code);
    expect(defaultCodes).not.toContain('RATE-EXPIRED');

    const withExpired = await as(tokenA).get(
      '/api/tenant/purchase/rates?mode=SEA_FCL&limit=100&includeExpired=true',
    );
    const allCodes: string[] = withExpired.body.data.map((r: { code: string }) => r.code);
    expect(allCodes).toContain('RATE-EXPIRED');

    await owner.freightRate.delete({ where: { id: expired.id } });
  });
});

describe('§4 rule 3 — delete is soft', () => {
  it('marks the rate deleted and drops it from the list, keeping the row', async () => {
    const created = await as(tokenA)
      .post('/api/tenant/purchase/rates')
      .send(rateBody({ validFrom: '2026-09-01', validTo: '2026-09-30' }));
    const id = created.body.data.id;

    const removed = await as(tokenA)
      .post(`/api/tenant/purchase/rates/${id}/delete`)
      .send({ mode: 'SEA_FCL' });
    expect(removed.status).toBe(200);

    const row = await owner.freightRate.findUnique({ where: { id: BigInt(id) } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();

    const list = await as(tokenA).get(
      '/api/tenant/purchase/rates?mode=SEA_FCL&limit=100&includeExpired=true',
    );
    const ids: string[] = list.body.data.map((r: { id: string }) => r.id);
    expect(ids).not.toContain(id);
  });
});

describe('form options follow §4 rule 9 and report what the caller may see', () => {
  it('offers seaports and non-airlines for a sea screen', async () => {
    const response = await as(tokenA).get('/api/tenant/purchase/rate-options?mode=SEA_FCL');
    expect(response.status).toBe(200);

    const portNames: string[] = response.body.data.ports.map((p: { name: string }) => p.name);
    expect(portNames.some((n) => n.includes('FRPOL1'))).toBe(true);
    expect(portNames.some((n) => n.includes('FRAIR1'))).toBe(false);

    const carrierNames: string[] = response.body.data.carriers.map((c: { name: string }) => c.name);
    expect(carrierNames).toContain('Rate Test Line');
    expect(carrierNames).not.toContain('Rate Test Airways');
  });

  it('offers only this mode tiers', async () => {
    const response = await as(tokenA).get('/api/tenant/purchase/rate-options?mode=SEA_FCL');
    const codes: string[] = response.body.data.tiers.map((t: { code: string }) => t.code);
    expect(codes).toContain(`${PREFIX}FCL`);
    expect(codes).not.toContain(`${PREFIX}AIRT`);
  });

  it('tells the client what the server already decided about the margin', async () => {
    const permitted = await as(tokenA).get('/api/tenant/purchase/rate-options?mode=SEA_FCL');
    expect(permitted.body.data.canSeeBuyPrice).toBe(true);
    expect(permitted.body.data.canManageProfit).toBe(true);

    const restricted = await as(tokenNoMargin).get(
      '/api/tenant/purchase/rate-options?mode=SEA_FCL',
    );
    expect(restricted.body.data.canSeeBuyPrice).toBe(false);
    expect(restricted.body.data.canManageProfit).toBe(false);
  });
});
