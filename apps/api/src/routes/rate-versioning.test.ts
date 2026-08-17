import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';
import { expireLapsedRates, ratesExpiringSoon } from '../lib/rate-expiry';

/**
 * Rate versioning and expiry (docs/MODULE_PURCHASE_SALES.md §4 rules 1, 2, 3).
 *
 * §7 names phase G alongside phase D as mandatory-test territory. Rule 1 calls
 * mutating a published rate in place "the single most expensive mistake
 * available in this module", because a quotation issued last month must still
 * resolve to the rate that was live when it was issued.
 *
 * So the central assertion here is not that supersede produces a new row. It is
 * that the OLD row still holds every figure it was quoted at afterwards.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG = 'versioning-test';
const PREFIX = 'VERTEST-';

let tenantId: bigint;
let token: string;
let polId: bigint;
let podId: bigint;
let carrierId: bigint;
let goodsTypeId: bigint;
let currencyId: bigint;
let tierId: bigint;

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  await owner.$executeRawUnsafe(`DELETE FROM rate_profit_log WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_local_charge WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate_line WHERE tenant_id IN (${t})`);
  // superseded_by_id is a self-reference, so break the chain before deleting.
  await owner.$executeRawUnsafe(
    `UPDATE freight_rate SET superseded_by_id = NULL WHERE tenant_id IN (${t})`,
  );
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_tier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM goods_type WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE code LIKE '${PREFIX}%'`);
}

beforeAll(async () => {
  await cleanup();

  tenantId = (
    await owner.tenant.create({
      data: { name: 'Versioning Test', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  const user = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-ver',
      username: `user-${SLUG}`,
      email: `${SLUG}@ver.test`,
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

  const mkPort = async (suffix: string, name: string, portCode: string) =>
    (
      await owner.port.create({
        data: {
          code: `${PREFIX}${suffix}`,
          name,
          portCode,
          country: 'Bangladesh',
          type: 'SEAPORT',
        },
        select: { id: true },
      })
    ).id;

  polId = await mkPort('POL', 'Version Origin', 'VRPOL1');
  podId = await mkPort('POD', 'Version Dest', 'VRPOD1');

  const seaType = await owner.carrierType.findFirstOrThrow({
    where: { NOT: { name: { equals: 'Airline', mode: 'insensitive' } } },
    select: { id: true },
  });
  carrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}CAR`, name: 'Version Line', typeId: seaType.id },
      select: { id: true },
    })
  ).id;
  goodsTypeId = (
    await owner.goodsType.create({
      data: { code: `${PREFIX}GT`, name: 'Version Goods' },
      select: { id: true },
    })
  ).id;
  currencyId = (await owner.currency.findFirstOrThrow({ select: { id: true } })).id;
  tierId = (
    await owner.rateTier.create({
      data: { code: `${PREFIX}TIER`, mode: 'SEA_FCL', label: 'Version Tier', unit: 'CONTAINER' },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  await owner.$executeRawUnsafe(`DELETE FROM rate_profit_log WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_local_charge WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate_line WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(
    `UPDATE freight_rate SET superseded_by_id = NULL WHERE tenant_id IN (${t})`,
  );
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate WHERE tenant_id IN (${t})`);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

const api = {
  get: (path: string) =>
    request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
  post: (path: string) =>
    request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
  patch: (path: string) =>
    request(app).patch(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
};

function rateBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'SEA_FCL',
    polId: polId.toString(),
    podId: podId.toString(),
    carrierId: carrierId.toString(),
    goodsTypeId: goodsTypeId.toString(),
    purchaseSourceType: 'CARRIER',
    purchaseCarrierId: carrierId.toString(),
    currencyId: currencyId.toString(),
    validFrom: '2026-01-01',
    validTo: '2033-12-31',
    transitDays: '21',
    freeDays: '14',
    status: 'PUBLISHED',
    lines: [
      { tierId: tierId.toString(), buyPrice: '1000.0000', profitType: 'FLAT', profitValue: '200.0000' },
    ],
    localCharges: [],
    ...over,
  };
}

async function createRate(over: Record<string, unknown> = {}): Promise<string> {
  const response = await api.post('/api/tenant/purchase/rates').send(rateBody(over));
  expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
  return response.body.data.id;
}

const yesterday = (): string => {
  const d = new Date(new Date().toISOString().slice(0, 10));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

describe('§4 rule 1 — a published rate is superseded, never overwritten', () => {
  it('leaves the original row holding every figure it was quoted at', async () => {
    const originalId = await createRate();

    const before = await owner.freightRate.findFirstOrThrow({
      where: { id: BigInt(originalId) },
      include: { lines: true },
    });
    const originalSell = before.lines[0]!.sellPrice!.toFixed(4);
    expect(originalSell).toBe('1200.0000');

    // Re-buy the lane at a higher price.
    const response = await api.patch(`/api/tenant/purchase/rates/${originalId}`).send(
      rateBody({
        validFrom: '2034-01-01',
        validTo: '2034-12-31',
        lines: [
          {
            tierId: tierId.toString(),
            buyPrice: '1500.0000',
            profitType: 'FLAT',
            profitValue: '300.0000',
          },
        ],
      }),
    );
    expect(response.status).toBe(200);

    const replacementId = response.body.data.id;
    expect(replacementId).not.toBe(originalId);

    // The old row: same prices, same transit, closed off and marked expired.
    const after = await owner.freightRate.findFirstOrThrow({
      where: { id: BigInt(originalId) },
      include: { lines: true },
    });
    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]!.buyPrice.toFixed(4)).toBe('1000.0000');
    expect(after.lines[0]!.sellPrice!.toFixed(4)).toBe('1200.0000');
    expect(after.transitDays).toBe(21);
    expect(after.status).toBe('EXPIRED');
    expect(after.validTo.toISOString().slice(0, 10)).toBe(yesterday());
    expect(after.supersededById).toBe(BigInt(replacementId));

    // The new row carries the new figures.
    const replacement = await owner.freightRate.findFirstOrThrow({
      where: { id: BigInt(replacementId) },
      include: { lines: true },
    });
    expect(replacement.status).toBe('PUBLISHED');
    expect(replacement.lines[0]!.buyPrice.toFixed(4)).toBe('1500.0000');
    expect(replacement.lines[0]!.sellPrice!.toFixed(4)).toBe('1800.0000');
    expect(replacement.supersededById).toBeNull();
  });

  it('gives the replacement its own code, leaving the original code intact', async () => {
    const originalId = await createRate();
    const originalCode = (
      await owner.freightRate.findFirstOrThrow({ where: { id: BigInt(originalId) } })
    ).code;

    const response = await api
      .patch(`/api/tenant/purchase/rates/${originalId}`)
      .send(rateBody({ validFrom: '2034-01-01', validTo: '2034-12-31' }));
    expect(response.status).toBe(200);
    expect(response.body.data.code).not.toBe(originalCode);

    const still = await owner.freightRate.findFirstOrThrow({ where: { id: BigInt(originalId) } });
    expect(still.code).toBe(originalCode);
  });

  it('supersedes twice, leaving a walkable chain', async () => {
    const v1 = await createRate();
    const r2 = await api
      .patch(`/api/tenant/purchase/rates/${v1}`)
      .send(rateBody({ validFrom: '2034-01-01', validTo: '2034-12-31' }));
    const v2 = r2.body.data.id;
    const r3 = await api
      .patch(`/api/tenant/purchase/rates/${v2}`)
      .send(rateBody({ validFrom: '2035-01-01', validTo: '2035-12-31' }));
    const v3 = r3.body.data.id;

    expect(r3.status).toBe(200);
    const [a, b, c] = await Promise.all(
      [v1, v2, v3].map((id) =>
        owner.freightRate.findFirstOrThrow({
          where: { id: BigInt(id) },
          select: { status: true, supersededById: true },
        }),
      ),
    );
    expect(a!.supersededById).toBe(BigInt(v2));
    expect(b!.supersededById).toBe(BigInt(v3));
    expect(c!.supersededById).toBeNull();
    expect(a!.status).toBe('EXPIRED');
    expect(b!.status).toBe('EXPIRED');
    expect(c!.status).toBe('PUBLISHED');
  });

  it('refuses to supersede an already superseded row', async () => {
    const v1 = await createRate();
    await api
      .patch(`/api/tenant/purchase/rates/${v1}`)
      .send(rateBody({ validFrom: '2034-01-01', validTo: '2034-12-31' }));

    const again = await api
      .patch(`/api/tenant/purchase/rates/${v1}`)
      .send(rateBody({ validFrom: '2036-01-01', validTo: '2036-12-31' }));
    expect(again.status).toBe(409);
  });

  it('closes off a rate that has not started yet without breaking the date check', async () => {
    // valid_to would have to be yesterday, which is before this rate begins.
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 2);
    const startsAt = future.toISOString().slice(0, 10);

    const id = await createRate({ validFrom: startsAt, validTo: '2037-12-31' });
    const response = await api
      .patch(`/api/tenant/purchase/rates/${id}`)
      .send(rateBody({ validFrom: startsAt, validTo: '2038-12-31' }));

    expect(response.status).toBe(200);
    const old = await owner.freightRate.findFirstOrThrow({ where: { id: BigInt(id) } });
    // Collapsed to a single day rather than an impossible window.
    expect(old.validTo.toISOString().slice(0, 10)).toBe(startsAt);
    expect(old.validFrom.toISOString().slice(0, 10)).toBe(startsAt);
    expect(old.status).toBe('EXPIRED');
  });

  it('does not trip the §4 rule 8 overlap constraint on its own successor', async () => {
    // Both rows cover the same lane and carrier; the sequence only works
    // because the old one is expired before the new one is inserted.
    const id = await createRate({ validFrom: '2026-01-01', validTo: '2033-12-31' });
    const response = await api
      .patch(`/api/tenant/purchase/rates/${id}`)
      .send(rateBody({ validFrom: '2026-01-01', validTo: '2033-12-31' }));
    expect(response.status).toBe(200);
  });

  it('still edits a DRAFT in place, since nothing can reference it', async () => {
    const id = await createRate({ status: 'DRAFT' });
    const response = await api
      .patch(`/api/tenant/purchase/rates/${id}`)
      .send(rateBody({ status: 'DRAFT', transitDays: '30' }));

    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(200);
    expect(response.body.data.id).toBe(id);
    expect(response.body.data.transitDays).toBe(30);

    const count = await owner.freightRate.count({ where: { tenantId, deletedAt: null } });
    expect(count).toBe(1);
  });

  it('refuses to edit an expired rate at all', async () => {
    const id = await createRate();
    await owner.freightRate.update({
      where: { id: BigInt(id) },
      data: { status: 'EXPIRED' },
    });

    const response = await api
      .patch(`/api/tenant/purchase/rates/${id}`)
      .send(rateBody({ validFrom: '2034-01-01', validTo: '2034-12-31' }));
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/expired/i);
  });
});

describe('§4 rule 2 — the superseded version leaves the price list', () => {
  it('shows the replacement and not its predecessor', async () => {
    const originalId = await createRate();
    const originalCode = (
      await owner.freightRate.findFirstOrThrow({ where: { id: BigInt(originalId) } })
    ).code;

    const response = await api
      .patch(`/api/tenant/purchase/rates/${originalId}`)
      .send(rateBody({ validFrom: '2026-01-01', validTo: '2033-12-31' }));
    const newCode = response.body.data.code;

    const list = await api.get('/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100');
    const codes: string[] = list.body.data.map((r: { code: string }) => r.code);
    expect(codes).toContain(newCode);
    expect(codes).not.toContain(originalCode);
  });
});

describe('§4 rule 3 — the nightly expiry job', () => {
  it('expires a published rate whose validity has passed', async () => {
    const lapsed = await owner.freightRate.create({
      data: {
        tenantId,
        code: 'RATE-VER-LAPSED',
        mode: 'SEA_FCL',
        polId,
        podId,
        carrierId,
        goodsTypeId,
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrierId,
        currencyId,
        validFrom: new Date('2020-01-01'),
        validTo: new Date('2020-12-31'),
        status: 'PUBLISHED',
      },
      select: { id: true },
    });

    const result = await expireLapsedRates(owner);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const after = await owner.freightRate.findFirstOrThrow({ where: { id: lapsed.id } });
    expect(after.status).toBe('EXPIRED');
  });

  it('leaves a rate that is still valid alone', async () => {
    const id = await createRate({ validFrom: '2026-01-01', validTo: '2033-12-31' });
    await expireLapsedRates(owner);

    const after = await owner.freightRate.findFirstOrThrow({ where: { id: BigInt(id) } });
    expect(after.status).toBe('PUBLISHED');
  });

  it('leaves a lapsed DRAFT alone — it was never quotable', async () => {
    const draft = await owner.freightRate.create({
      data: {
        tenantId,
        code: 'RATE-VER-OLDDRAFT',
        mode: 'SEA_FCL',
        polId,
        podId,
        carrierId,
        goodsTypeId,
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrierId,
        currencyId,
        validFrom: new Date('2020-01-01'),
        validTo: new Date('2020-12-31'),
        status: 'DRAFT',
      },
      select: { id: true },
    });

    await expireLapsedRates(owner);
    const after = await owner.freightRate.findFirstOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe('DRAFT');
  });

  it('is idempotent — a second run changes nothing', async () => {
    await owner.freightRate.create({
      data: {
        tenantId,
        code: 'RATE-VER-TWICE',
        mode: 'SEA_FCL',
        polId,
        podId,
        carrierId,
        goodsTypeId,
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrierId,
        currencyId,
        validFrom: new Date('2020-01-01'),
        validTo: new Date('2020-12-31'),
        status: 'PUBLISHED',
      },
    });

    const first = await expireLapsedRates(owner);
    expect(first.expired).toBeGreaterThanOrEqual(1);
    const second = await expireLapsedRates(owner);
    expect(second.expired).toBe(0);
  });

  it('lists rates lapsing inside the warning window, and not beyond it', async () => {
    const inDays = (n: number): Date => {
      const d = new Date(new Date().toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + n);
      return d;
    };

    const mk = async (code: string, validTo: Date, destination: bigint) =>
      owner.freightRate.create({
        data: {
          tenantId,
          code,
          mode: 'SEA_FCL',
          polId,
          podId: destination,
          carrierId,
          goodsTypeId,
          purchaseSourceType: 'CARRIER',
          purchaseCarrierId: carrierId,
          currencyId,
          validFrom: new Date('2026-01-01'),
          validTo,
          status: 'PUBLISHED',
        },
      });

    // Different PODs: two published rates on one lane would trip the §4 rule 8
    // exclusion constraint, which is the constraint working, not a fixture.
    await mk('RATE-VER-SOON', inDays(3), polId);
    await mk('RATE-VER-LATER', inDays(30), podId);

    const soon = await ratesExpiringSoon(owner, 7);
    const codes = soon.map((r) => r.code);
    expect(codes).toContain('RATE-VER-SOON');
    expect(codes).not.toContain('RATE-VER-LATER');
  });
});
