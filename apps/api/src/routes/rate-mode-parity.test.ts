import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Mode parity (docs/MODULE_PURCHASE_SALES.md §7 phase F).
 *
 * "Clone C–E to Sea LCL and Air, driven by rate_tier. No copy-pasted screen
 * components." Nine screens run on three components, which only holds if the
 * API behaves identically across modes — so this drives entry, add-on and price
 * list through all three, and asserts the differences are exactly the ones
 * rate_tier and §4 rule 9 dictate, and no others.
 *
 * Air is the mode nothing had exercised end to end before: its tiers are weight
 * breaks with a min_value and no container size, a shape no screen had rendered.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG = 'parity-test';
const PREFIX = 'PARITY-';

type Mode = 'SEA_FCL' | 'SEA_LCL' | 'AIR';

const MODES: Mode[] = ['SEA_FCL', 'SEA_LCL', 'AIR'];

const ENTRY_FEATURE: Record<Mode, string> = {
  SEA_FCL: 'PURCHASE.SEA_FREIGHT_FCL',
  SEA_LCL: 'PURCHASE.SEA_FREIGHT_LCL',
  AIR: 'PURCHASE.AIR_FREIGHT_PURCHASE',
};
const LIST_FEATURE: Record<Mode, string> = {
  SEA_FCL: 'PURCHASE.PRICE_LIST_SEA_FCL',
  SEA_LCL: 'PURCHASE.PRICE_LIST_SEA_LCL',
  AIR: 'PURCHASE.PRICE_LIST_AIR',
};
const EXPECTED_UNIT: Record<Mode, string> = {
  SEA_FCL: 'CONTAINER',
  SEA_LCL: 'CBM',
  AIR: 'KG',
};

let tenantId: bigint;
let token: string;

let seaPolId: bigint;
let seaPodId: bigint;
let airPolId: bigint;
let airPodId: bigint;
let seaCarrierId: bigint;
let airCarrierId: bigint;
let goodsTypeId: bigint;
let currencyId: bigint;

const portFor: Record<Mode, () => { pol: bigint; pod: bigint }> = {
  SEA_FCL: () => ({ pol: seaPolId, pod: seaPodId }),
  SEA_LCL: () => ({ pol: seaPolId, pod: seaPodId }),
  AIR: () => ({ pol: airPolId, pod: airPodId }),
};
const carrierFor: Record<Mode, () => bigint> = {
  SEA_FCL: () => seaCarrierId,
  SEA_LCL: () => seaCarrierId,
  AIR: () => airCarrierId,
};

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  await owner.$executeRawUnsafe(`DELETE FROM rate_profit_log WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_local_charge WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate_line WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
  await owner.$executeRawUnsafe(`DELETE FROM goods_type WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE code LIKE '${PREFIX}%'`);
}

beforeAll(async () => {
  await cleanup();

  tenantId = (
    await owner.tenant.create({
      data: { name: 'Parity Test', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  const user = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-parity',
      username: `user-${SLUG}`,
      email: `${SLUG}@parity.test`,
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

  const mkPort = async (
    suffix: string,
    name: string,
    portCode: string,
    type: 'SEAPORT' | 'AIRPORT',
  ) =>
    (
      await owner.port.create({
        data: { code: `${PREFIX}${suffix}`, name, portCode, country: 'Bangladesh', type },
        select: { id: true },
      })
    ).id;

  seaPolId = await mkPort('SPOL', 'Parity Seaport A', 'PRSEA1', 'SEAPORT');
  seaPodId = await mkPort('SPOD', 'Parity Seaport B', 'PRSEA2', 'SEAPORT');
  airPolId = await mkPort('APOL', 'Parity Airport A', 'PRAIR1', 'AIRPORT');
  airPodId = await mkPort('APOD', 'Parity Airport B', 'PRAIR2', 'AIRPORT');

  const airlineType = await owner.carrierType.findFirstOrThrow({
    where: { name: { equals: 'Airline', mode: 'insensitive' } },
    select: { id: true },
  });
  const seaType = await owner.carrierType.findFirstOrThrow({
    where: { NOT: { name: { equals: 'Airline', mode: 'insensitive' } } },
    select: { id: true },
  });

  seaCarrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}SEA`, name: 'Parity Line', typeId: seaType.id },
      select: { id: true },
    })
  ).id;
  airCarrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}AIR`, name: 'Parity Airways', typeId: airlineType.id },
      select: { id: true },
    })
  ).id;

  goodsTypeId = (
    await owner.goodsType.create({
      data: { code: `${PREFIX}GT`, name: 'Parity Goods' },
      select: { id: true },
    })
  ).id;
  currencyId = (await owner.currency.findFirstOrThrow({ select: { id: true } })).id;
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

/** Seeded tiers for a mode, in the order the screen renders them. */
async function tiersFor(mode: Mode): Promise<{ id: string; code: string }[]> {
  const response = await api.get(`/api/tenant/purchase/rate-options?mode=${mode}`);
  expect(response.status, mode).toBe(200);
  return response.body.data.tiers;
}

describe('phase F — the tier columns come from rate_tier, per mode', () => {
  for (const mode of MODES) {
    it(`${mode}: offers only its own tiers, in sort order`, async () => {
      const tiers = await tiersFor(mode);
      expect(tiers.length, mode).toBeGreaterThan(0);

      const prefix = { SEA_FCL: 'FCL-', SEA_LCL: 'LCL-', AIR: 'AIR-' }[mode];
      for (const tier of tiers) {
        expect(tier.code.startsWith(prefix), `${mode}: ${tier.code}`).toBe(true);
      }
    });

    it(`${mode}: every offered tier is priced in ${EXPECTED_UNIT[mode]}`, async () => {
      const tiers = await tiersFor(mode);
      const rows = await owner.rateTier.findMany({
        where: { id: { in: tiers.map((t) => BigInt(t.id)) } },
        select: { unit: true, mode: true },
      });
      for (const row of rows) {
        expect(row.unit, mode).toBe(EXPECTED_UNIT[mode]);
        expect(row.mode, mode).toBe(mode);
      }
    });
  }

  it('air tiers are weight breaks with a lower bound and no container size', async () => {
    const tiers = await tiersFor('AIR');
    const rows = await owner.rateTier.findMany({
      where: { id: { in: tiers.map((t) => BigInt(t.id)) } },
      select: { code: true, minValue: true, containerSizeId: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The shape no screen had rendered before phase F.
      expect(row.containerSizeId, row.code).toBeNull();
      expect(row.minValue, row.code).not.toBeNull();
    }
  });

  it('FCL tiers name a container size, unlike the other two', async () => {
    const tiers = await tiersFor('SEA_FCL');
    const rows = await owner.rateTier.findMany({
      where: { id: { in: tiers.map((t) => BigInt(t.id)) } },
      select: { code: true, containerSizeId: true },
    });
    for (const row of rows) {
      expect(row.containerSizeId, row.code).not.toBeNull();
    }
  });
});

describe('§4 rule 9 — each mode gets the right ports and carriers', () => {
  it('a sea screen offers seaports and no airline', async () => {
    const response = await api.get('/api/tenant/purchase/rate-options?mode=SEA_LCL');
    const ports: string[] = response.body.data.ports.map((p: { name: string }) => p.name);
    const carriers: string[] = response.body.data.carriers.map((c: { name: string }) => c.name);

    expect(ports.some((n) => n.includes('PRSEA1'))).toBe(true);
    expect(ports.some((n) => n.includes('PRAIR1'))).toBe(false);
    expect(carriers).toContain('Parity Line');
    expect(carriers).not.toContain('Parity Airways');
  });

  it('the air screen offers airports and only airlines', async () => {
    const response = await api.get('/api/tenant/purchase/rate-options?mode=AIR');
    const ports: string[] = response.body.data.ports.map((p: { name: string }) => p.name);
    const carriers: string[] = response.body.data.carriers.map((c: { name: string }) => c.name);

    expect(ports.some((n) => n.includes('PRAIR1'))).toBe(true);
    expect(ports.some((n) => n.includes('PRSEA1'))).toBe(false);
    expect(carriers).toContain('Parity Airways');
    expect(carriers).not.toContain('Parity Line');
  });
});

describe('phase F — entry, add-on and price list behave identically in all three modes', () => {
  const created: Record<string, { rateId: string; lineId: string }> = {};

  for (const mode of MODES) {
    it(`${mode}: a rate can be bought, and prices against its own tiers`, async () => {
      const tiers = await tiersFor(mode);
      const ports = portFor[mode]();
      const carrier = carrierFor[mode]();

      const response = await api.post('/api/tenant/purchase/rates').send({
        mode,
        polId: ports.pol.toString(),
        podId: ports.pod.toString(),
        carrierId: carrier.toString(),
        goodsTypeId: goodsTypeId.toString(),
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrier.toString(),
        currencyId: currencyId.toString(),
        validFrom: '2034-01-01',
        validTo: '2034-06-30',
        transitDays: '21',
        freeDays: '14',
        status: 'PUBLISHED',
        lines: tiers.map((tier, index) => ({
          tierId: tier.id,
          buyPrice: String(1000 + index * 100),
          profitType: 'FLAT',
          profitValue: '100',
        })),
        localCharges: [],
      });

      expect(response.status, `${mode}: ${JSON.stringify(response.body.error ?? {})}`).toBe(201);
      expect(response.body.data.lines).toHaveLength(tiers.length);
      // Postgres computed each of these.
      expect(response.body.data.lines[0].sellPrice).toBe('1100.0000');
      expect(response.body.data.freeDays).toBe(14);

      created[mode] = {
        rateId: response.body.data.id,
        lineId: response.body.data.lines[0].id,
      };
    });

    it(`${mode}: the price list shows it, with the same shape as the others`, async () => {
      const response = await api.get(
        `/api/tenant/purchase/price-list?mode=${mode}&limit=100`,
      );
      expect(response.status, mode).toBe(200);

      const rate = response.body.data.find(
        (r: { id: string }) => r.id === created[mode]!.rateId,
      );
      expect(rate, mode).toBeDefined();
      expect(rate.transitDays).toBe(21);
      expect(rate.freeDays).toBe(14);
      expect(rate.lines[0].sellPrice).toBe('1100.0000');
    });

    it(`${mode}: the margin can be re-priced on the add-on screen`, async () => {
      // 25% of a 1000 buy price is 1250 — deliberately different from the flat
      // 100 it was created with, so this cannot pass on an unchanged row.
      const response = await api.patch('/api/tenant/purchase/addon/margins').send({
        mode,
        edits: [
          { rateLineId: created[mode]!.lineId, profitType: 'PERCENT', profitValue: '25' },
        ],
      });
      expect(response.status, mode).toBe(200);
      expect(response.body.data.changed).toBe(1);

      const line = await owner.freightRateLine.findFirstOrThrow({
        where: { id: BigInt(created[mode]!.lineId) },
        select: { profitType: true, sellPrice: true },
      });
      expect(line.profitType, mode).toBe('PERCENT');
      expect(line.sellPrice?.toFixed(4), mode).toBe('1250.0000');
    });

    it(`${mode}: exports without error`, async () => {
      const response = await request(app)
        .get(`/api/tenant/purchase/price-list/export?mode=${mode}&format=xlsx`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Slug', SLUG)
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(response.status, mode).toBe(200);
      expect((response.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    });
  }
});

describe('§4 rule 9 is enforced on the write, not just the dropdown', () => {
  it('refuses an air rate between seaports', async () => {
    const tiers = await tiersFor('AIR');
    const response = await api.post('/api/tenant/purchase/rates').send({
      mode: 'AIR',
      polId: seaPolId.toString(),
      podId: seaPodId.toString(),
      carrierId: airCarrierId.toString(),
      goodsTypeId: goodsTypeId.toString(),
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: airCarrierId.toString(),
      currencyId: currencyId.toString(),
      validFrom: '2035-01-01',
      validTo: '2035-06-30',
      status: 'DRAFT',
      lines: [{ tierId: tiers[0]!.id, buyPrice: '100' }],
      localCharges: [],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/airports/i);
  });

  it('refuses an air rate carried by a shipping line', async () => {
    const tiers = await tiersFor('AIR');
    const response = await api.post('/api/tenant/purchase/rates').send({
      mode: 'AIR',
      polId: airPolId.toString(),
      podId: airPodId.toString(),
      carrierId: seaCarrierId.toString(),
      goodsTypeId: goodsTypeId.toString(),
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: seaCarrierId.toString(),
      currencyId: currencyId.toString(),
      validFrom: '2035-01-01',
      validTo: '2035-06-30',
      status: 'DRAFT',
      lines: [{ tierId: tiers[0]!.id, buyPrice: '100' }],
      localCharges: [],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/airline/i);
  });

  it('refuses an LCL rate priced against air weight breaks', async () => {
    const airTiers = await tiersFor('AIR');
    const response = await api.post('/api/tenant/purchase/rates').send({
      mode: 'SEA_LCL',
      polId: seaPolId.toString(),
      podId: seaPodId.toString(),
      carrierId: seaCarrierId.toString(),
      goodsTypeId: goodsTypeId.toString(),
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: seaCarrierId.toString(),
      currencyId: currencyId.toString(),
      validFrom: '2035-01-01',
      validTo: '2035-06-30',
      status: 'DRAFT',
      lines: [{ tierId: airTiers[0]!.id, buyPrice: '100' }],
      localCharges: [],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/own mode/i);
  });
});

describe('§7 — the nine screens are nine permissions, not one', () => {
  async function tokenFor(permissions: string[], suffix: string): Promise<string> {
    const user = await owner.user.create({
      data: {
        tenantId,
        code: `USR-${suffix}`,
        username: `user-${suffix}`,
        email: `${suffix}@parity.test`,
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

  it('an entry permission for one mode opens neither of the other two', async () => {
    const lclOnly = await tokenFor([`${ENTRY_FEATURE.SEA_LCL}.VIEW`], 'lclonly');

    for (const mode of MODES) {
      const response = await request(app)
        .get(`/api/tenant/purchase/rates?mode=${mode}`)
        .set('Authorization', `Bearer ${lclOnly}`)
        .set('X-Tenant-Slug', SLUG);
      expect(response.status, mode).toBe(mode === 'SEA_LCL' ? 200 : 403);
    }
  });

  it('an entry permission does not open the matching price list', async () => {
    const entryOnly = await tokenFor([`${ENTRY_FEATURE.AIR}.VIEW`], 'entryonly');
    const response = await request(app)
      .get('/api/tenant/purchase/price-list?mode=AIR')
      .set('Authorization', `Bearer ${entryOnly}`)
      .set('X-Tenant-Slug', SLUG);
    expect(response.status).toBe(403);
  });

  it('a price list permission for one mode opens neither of the other two', async () => {
    const airList = await tokenFor([`${LIST_FEATURE.AIR}.VIEW`], 'airlist');

    for (const mode of MODES) {
      const response = await request(app)
        .get(`/api/tenant/purchase/price-list?mode=${mode}`)
        .set('Authorization', `Bearer ${airList}`)
        .set('X-Tenant-Slug', SLUG);
      expect(response.status, mode).toBe(mode === 'AIR' ? 200 : 403);
    }
  });
});
