import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { Prisma, PrismaClient } from '../generated/prisma/client';

/**
 * The database-level guarantees on the rate tables
 * (docs/MODULE_PURCHASE_SALES.md §3.2 and §4).
 *
 * Every rule asserted here protects money, and every one of them lives in the
 * migration's appendix rather than in Prisma's schema — which means nothing in
 * the type system will tell us if a later migration drops one. Only a test
 * that actually tries the illegal write will.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const SLUG = 'rate-constraints';
const PREFIX = 'RCTEST-';

let tenantId: bigint;
let polId: bigint;
let podId: bigint;
let carrierId: bigint;
let goodsTypeId: bigint;
let currencyId: bigint;
let vendorId: bigint;
let tierId: bigint;

/** A valid rate, with only the named fields overridden. */
function rateData(
  over: Partial<Prisma.FreightRateUncheckedCreateInput> & { code: string },
): Prisma.FreightRateUncheckedCreateInput {
  return {
    tenantId,
    mode: 'SEA_FCL',
    polId,
    podId,
    carrierId,
    goodsTypeId,
    purchaseSourceType: 'CARRIER',
    purchaseCarrierId: carrierId,
    currencyId,
    validFrom: new Date('2026-01-01'),
    validTo: new Date('2026-12-31'),
    status: 'PUBLISHED',
    ...over,
  };
}

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  await owner.$executeRawUnsafe(`DELETE FROM rate_profit_log WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_local_charge WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate_line WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM vendor WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_tier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM goods_type WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
}

beforeAll(async () => {
  await cleanup();

  const tenant = await owner.tenant.create({
    data: { name: 'Rate Constraints', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const pol = await owner.port.create({
    data: {
      code: `${PREFIX}POL`,
      name: 'Constraint POL',
      portCode: 'RCPOL1',
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  polId = pol.id;

  const pod = await owner.port.create({
    data: {
      code: `${PREFIX}POD`,
      name: 'Constraint POD',
      portCode: 'RCPOD1',
      country: 'Singapore',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  podId = pod.id;

  // Reuse whatever carrier and currency the seed already provides — the rate
  // tables only need a valid FK target, not a particular one.
  const carrier = await owner.carrier.findFirstOrThrow({ select: { id: true } });
  carrierId = carrier.id;
  const currency = await owner.currency.findFirstOrThrow({ select: { id: true } });
  currencyId = currency.id;

  const goodsType = await owner.goodsType.create({
    data: { code: `${PREFIX}GT`, name: 'Constraint Goods' },
    select: { id: true },
  });
  goodsTypeId = goodsType.id;

  const tier = await owner.rateTier.create({
    data: {
      code: `${PREFIX}TIER`,
      mode: 'SEA_FCL',
      label: 'Constraint Tier',
      unit: 'CONTAINER',
    },
    select: { id: true },
  });
  tierId = tier.id;

  const vendorType = await owner.vendorType.findFirstOrThrow({ select: { id: true } });
  const vendor = await owner.vendor.create({
    data: {
      tenantId,
      code: `${PREFIX}VEN`,
      name: 'Constraint Vendor',
      country: 'Bangladesh',
      vendorTypeId: vendorType.id,
    },
    select: { id: true },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('§4 rule 4 — sell_price is computed by the database', () => {
  it('adds a flat profit to the buy price', async () => {
    const rate = await owner.freightRate.create({
      data: rateData({ code: `${PREFIX}FLAT`, status: 'DRAFT' }),
      select: { id: true },
    });
    const line = await owner.freightRateLine.create({
      data: {
        tenantId,
        rateId: rate.id,
        tierId,
        buyPrice: '1000.0000',
        profitType: 'FLAT',
        profitValue: '150.0000',
      },
      select: { sellPrice: true },
    });
    expect(line.sellPrice?.toFixed(4)).toBe('1150.0000');
  });

  it('applies a percentage profit to the buy price', async () => {
    const rate = await owner.freightRate.create({
      data: rateData({ code: `${PREFIX}PCT`, status: 'DRAFT' }),
      select: { id: true },
    });
    const line = await owner.freightRateLine.create({
      data: {
        tenantId,
        rateId: rate.id,
        tierId,
        buyPrice: '1000.0000',
        profitType: 'PERCENT',
        profitValue: '12.5000',
      },
      select: { sellPrice: true },
    });
    expect(line.sellPrice?.toFixed(4)).toBe('1125.0000');
  });

  it('recomputes when the margin changes, without anyone writing it', async () => {
    const rate = await owner.freightRate.create({
      data: rateData({ code: `${PREFIX}RECALC`, status: 'DRAFT' }),
      select: { id: true },
    });
    const line = await owner.freightRateLine.create({
      data: { tenantId, rateId: rate.id, tierId, buyPrice: '500.0000', profitValue: '50.0000' },
      select: { id: true },
    });
    const updated = await owner.freightRateLine.update({
      where: { id: line.id },
      data: { profitValue: '75.0000' },
      select: { sellPrice: true },
    });
    expect(updated.sellPrice?.toFixed(4)).toBe('575.0000');
  });

  it('refuses a hand-written sell price', async () => {
    const rate = await owner.freightRate.create({
      data: rateData({ code: `${PREFIX}FORCED`, status: 'DRAFT' }),
      select: { id: true },
    });
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO freight_rate_line (tenant_id, rate_id, tier_id, buy_price, profit_value, sell_price, updated_at)
         VALUES ($1, $2, $3, 100, 0, 999999, now())`,
        tenantId,
        rate.id,
        tierId,
      ),
    ).rejects.toThrow();
  });
});

describe('§3.2 — a rate cannot describe an impossible period', () => {
  it('refuses a validity window that runs backwards', async () => {
    await expect(
      owner.freightRate.create({
        data: rateData({
          code: `${PREFIX}BACKWARDS`,
          validFrom: new Date('2026-06-01'),
          validTo: new Date('2026-05-01'),
        }),
      }),
    ).rejects.toThrow();
  });

  it('allows a single-day rate', async () => {
    const rate = await owner.freightRate.create({
      data: rateData({
        code: `${PREFIX}ONEDAY`,
        status: 'DRAFT',
        validFrom: new Date('2026-06-01'),
        validTo: new Date('2026-06-01'),
      }),
      select: { id: true },
    });
    expect(rate.id).toBeDefined();
  });
});

describe('§9 Q3 — "purchase via" names exactly one master', () => {
  it('refuses a CARRIER source pointing at a vendor', async () => {
    await expect(
      owner.freightRate.create({
        data: rateData({
          code: `${PREFIX}MISMATCH`,
          purchaseSourceType: 'CARRIER',
          purchaseCarrierId: null,
          purchaseVendorId: vendorId,
        }),
      }),
    ).rejects.toThrow();
  });

  it('refuses a source naming two masters at once', async () => {
    await expect(
      owner.freightRate.create({
        data: rateData({
          code: `${PREFIX}BOTH`,
          purchaseSourceType: 'VENDOR',
          purchaseVendorId: vendorId,
          purchaseCarrierId: carrierId,
        }),
      }),
    ).rejects.toThrow();
  });

  it('refuses a source naming none', async () => {
    await expect(
      owner.freightRate.create({
        data: rateData({
          code: `${PREFIX}NEITHER`,
          purchaseSourceType: 'VENDOR',
          purchaseCarrierId: null,
        }),
      }),
    ).rejects.toThrow();
  });

  it('accepts a vendor source naming only a vendor', async () => {
    const rate = await owner.freightRate.create({
      data: rateData({
        code: `${PREFIX}VENDORSRC`,
        status: 'DRAFT',
        purchaseSourceType: 'VENDOR',
        purchaseCarrierId: null,
        purchaseVendorId: vendorId,
      }),
      select: { id: true },
    });
    expect(rate.id).toBeDefined();
  });
});

describe('§4 rule 8 — two published rates for one lane cannot overlap', () => {
  it('refuses an overlapping published rate on the same lane and carrier', async () => {
    await owner.freightRate.create({
      data: rateData({
        code: `${PREFIX}LANE1`,
        validFrom: new Date('2027-01-01'),
        validTo: new Date('2027-06-30'),
      }),
    });

    await expect(
      owner.freightRate.create({
        data: rateData({
          code: `${PREFIX}LANE2`,
          validFrom: new Date('2027-06-30'),
          validTo: new Date('2027-12-31'),
        }),
      }),
    ).rejects.toThrow();
  });

  it('allows the next period to start the day after the last one ends', async () => {
    const rate = await owner.freightRate.create({
      data: rateData({
        code: `${PREFIX}LANE3`,
        validFrom: new Date('2027-07-01'),
        validTo: new Date('2027-12-31'),
      }),
      select: { id: true },
    });
    expect(rate.id).toBeDefined();
  });

  it('allows overlapping drafts — the pricing team is comparing options', async () => {
    const rate = await owner.freightRate.create({
      data: rateData({
        code: `${PREFIX}DRAFTOVERLAP`,
        status: 'DRAFT',
        validFrom: new Date('2027-01-01'),
        validTo: new Date('2027-06-30'),
      }),
      select: { id: true },
    });
    expect(rate.id).toBeDefined();
  });

  it('allows the same period from a different carrier', async () => {
    const other = await owner.carrier.findFirst({
      where: { id: { not: carrierId } },
      select: { id: true },
    });
    // Only meaningful when the seed provides more than one carrier.
    if (other === null) return;

    const rate = await owner.freightRate.create({
      data: rateData({
        code: `${PREFIX}OTHERCARRIER`,
        carrierId: other.id,
        purchaseCarrierId: other.id,
        validFrom: new Date('2027-01-01'),
        validTo: new Date('2027-06-30'),
      }),
      select: { id: true },
    });
    expect(rate.id).toBeDefined();
  });
});

describe('§4 rule 6 — the profit log is append-only for the app role', () => {
  it('does not grant ff_app UPDATE on rate_profit_log', async () => {
    const grants = await owner.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'ff_app' AND table_name = 'rate_profit_log'
    `;
    const held = grants.map((g) => g.privilege_type).sort();
    expect(held).toContain('INSERT');
    expect(held).toContain('SELECT');
    expect(held).not.toContain('UPDATE');
    expect(held).not.toContain('DELETE');
  });
});

describe('RLS is enabled on every rate table (§7A rule 2)', () => {
  it('has row level security on all four', async () => {
    const rows = await owner.$queryRaw<{ relname: string; relrowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('freight_rate', 'freight_rate_line', 'rate_local_charge', 'rate_profit_log')
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
    }
  });
});
