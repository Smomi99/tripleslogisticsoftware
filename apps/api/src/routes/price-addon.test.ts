import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Price Add-on — margin logic (docs/MODULE_PURCHASE_SALES.md §5.2, §4 rules 4–6).
 *
 * §7 names phase D as one of two phases where tests are mandatory: "Margin
 * calculation and rate versioning are where a silent bug costs the client real
 * money, and neither is visible from the UI."
 *
 * So these assert the arithmetic against the database's own generated column,
 * the all-or-nothing transaction, and that every accepted change left a
 * rate_profit_log entry naming who moved it.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG = 'addon-test';
const PREFIX = 'ADTEST-';

const ADDON_PERMS = [
  'PURCHASE.PRICE_ADDON_FCL_SEA.VIEW',
  'PURCHASE.PRICE_ADDON_FCL_SEA.EDIT',
];

let tenantId: bigint;
/** Superadmin: sees the buy price and may move the margin. */
let tokenAll: string;
/** Add-on screen permissions, but no MANAGE_PROFIT. */
let tokenNoProfit: string;
/** MANAGE_PROFIT but no VIEW_BUY_PRICE — may price without seeing cost. */
let tokenBlindPricer: string;
let blindPricerId: bigint;

let polId: bigint;
let podId: bigint;
let carrierId: bigint;
let goodsTypeId: bigint;
let currencyId: bigint;
let tierAId: bigint;
let tierBId: bigint;

let rateId: bigint;
let lineAId: bigint;
let lineBId: bigint;

async function makeUser(
  suffix: string,
  isSuperadmin: boolean,
  permissions: string[],
): Promise<{ id: bigint; token: string }> {
  const user = await owner.user.create({
    data: {
      tenantId,
      code: `USR-${suffix}`,
      username: `user-${suffix}`,
      email: `${suffix}@addon.test`,
      passwordHash: 'x',
      isSuperadmin,
    },
    select: { id: true },
  });
  const token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin,
    permissions,
    tokenVersion: 0,
  });
  return { id: user.id, token };
}

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  await owner.$executeRawUnsafe(`DELETE FROM rate_profit_log WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_local_charge WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM freight_rate_line WHERE tenant_id IN (${t})`);
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
      data: { name: 'Add-on Test', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  tokenAll = (await makeUser(`super-${SLUG}`, true, [])).token;
  tokenNoProfit = (await makeUser(`noprofit-${SLUG}`, false, ADDON_PERMS)).token;
  const blind = await makeUser(`blind-${SLUG}`, false, [
    ...ADDON_PERMS,
    'PURCHASE.RATE.MANAGE_PROFIT',
  ]);
  tokenBlindPricer = blind.token;
  blindPricerId = blind.id;

  polId = (
    await owner.port.create({
      data: {
        code: `${PREFIX}POL`,
        name: 'Add-on POL',
        portCode: 'ADPOL1',
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
      select: { id: true },
    })
  ).id;
  podId = (
    await owner.port.create({
      data: {
        code: `${PREFIX}POD`,
        name: 'Add-on POD',
        portCode: 'ADPOD1',
        country: 'Singapore',
        type: 'SEAPORT',
      },
      select: { id: true },
    })
  ).id;

  const seaType = await owner.carrierType.findFirstOrThrow({
    where: { NOT: { name: { equals: 'Airline', mode: 'insensitive' } } },
    select: { id: true },
  });
  carrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}CAR`, name: 'Add-on Line', typeId: seaType.id },
      select: { id: true },
    })
  ).id;

  goodsTypeId = (
    await owner.goodsType.create({
      data: { code: `${PREFIX}GT`, name: 'Add-on Goods' },
      select: { id: true },
    })
  ).id;
  currencyId = (await owner.currency.findFirstOrThrow({ select: { id: true } })).id;

  tierAId = (
    await owner.rateTier.create({
      data: { code: `${PREFIX}T1`, mode: 'SEA_FCL', label: 'Tier A', unit: 'CONTAINER' },
      select: { id: true },
    })
  ).id;
  tierBId = (
    await owner.rateTier.create({
      data: { code: `${PREFIX}T2`, mode: 'SEA_FCL', label: 'Tier B', unit: 'CONTAINER' },
      select: { id: true },
    })
  ).id;
});

/** A fresh rate before each test, so one test's margins cannot colour another. */
beforeEach(async () => {
  await owner.$executeRawUnsafe(
    `DELETE FROM rate_profit_log WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = '${SLUG}')`,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM freight_rate_line WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = '${SLUG}')`,
  );
  await owner.$executeRawUnsafe(
    `DELETE FROM freight_rate WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = '${SLUG}')`,
  );

  const rate = await owner.freightRate.create({
    data: {
      tenantId,
      code: 'RATE-ADDON',
      mode: 'SEA_FCL',
      polId,
      podId,
      carrierId,
      goodsTypeId,
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: carrierId,
      currencyId,
      validFrom: new Date('2026-01-01'),
      validTo: new Date('2032-12-31'),
      status: 'DRAFT',
      lines: {
        create: [
          { tierId: tierAId, buyPrice: '1000.0000' },
          { tierId: tierBId, buyPrice: '2000.0000' },
        ],
      },
    },
    select: { id: true, lines: { select: { id: true, tierId: true } } },
  });
  rateId = rate.id;
  lineAId = rate.lines.find((l) => l.tierId === tierAId)!.id;
  lineBId = rate.lines.find((l) => l.tierId === tierBId)!.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function as(token: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
    patch: (path: string) =>
      request(app).patch(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG),
  };
}

const saveMargins = (token: string, body: Record<string, unknown>) =>
  as(token).patch('/api/tenant/purchase/addon/margins').send(body);

async function lineState(id: bigint) {
  return owner.freightRateLine.findFirstOrThrow({
    where: { id },
    select: { buyPrice: true, profitType: true, profitValue: true, sellPrice: true },
  });
}

describe('§4 rule 4 — the margin arithmetic is the database’s, not ours', () => {
  it('applies a flat margin', async () => {
    const response = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '150.0000' }],
    });
    expect(response.status).toBe(200);
    expect(response.body.data.changed).toBe(1);

    const line = await lineState(lineAId);
    expect(line.sellPrice?.toFixed(4)).toBe('1150.0000');
  });

  it('applies a percentage margin', async () => {
    const response = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'PERCENT', profitValue: '12.5000' }],
    });
    expect(response.status).toBe(200);

    const line = await lineState(lineAId);
    expect(line.sellPrice?.toFixed(4)).toBe('1125.0000');
  });

  it('switches a line from percent back to flat and recomputes', async () => {
    await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'PERCENT', profitValue: '10.0000' }],
    });
    expect((await lineState(lineAId)).sellPrice?.toFixed(4)).toBe('1100.0000');

    await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '10.0000' }],
    });
    expect((await lineState(lineAId)).sellPrice?.toFixed(4)).toBe('1010.0000');
  });

  it('prices each tier from its own buy price, not the first one', async () => {
    await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [
        { rateLineId: lineAId.toString(), profitType: 'PERCENT', profitValue: '10.0000' },
        { rateLineId: lineBId.toString(), profitType: 'PERCENT', profitValue: '10.0000' },
      ],
    });
    expect((await lineState(lineAId)).sellPrice?.toFixed(4)).toBe('1100.0000');
    expect((await lineState(lineBId)).sellPrice?.toFixed(4)).toBe('2200.0000');
  });

  it('never accepts a sell price posted by the client', async () => {
    const response = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [
        {
          rateLineId: lineAId.toString(),
          profitType: 'FLAT',
          profitValue: '100.0000',
          sellPrice: '999999.0000',
        },
      ],
    });
    expect(response.status).toBe(200);

    const line = await lineState(lineAId);
    expect(line.sellPrice?.toFixed(4)).toBe('1100.0000');
  });
});

describe('§5.2 — one transaction, all or nothing', () => {
  it('applies every edited row together', async () => {
    const response = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [
        { rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '100.0000' },
        { rateLineId: lineBId.toString(), profitType: 'FLAT', profitValue: '250.0000' },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.data.changed).toBe(2);

    expect((await lineState(lineAId)).sellPrice?.toFixed(4)).toBe('1100.0000');
    expect((await lineState(lineBId)).sellPrice?.toFixed(4)).toBe('2250.0000');
  });

  it('rolls back a write already applied when a later line is refused', async () => {
    // The unknown-line case is caught before anything is written. This one is
    // not: line A updates, then line B's expired rate throws — so it only
    // passes if the surrounding transaction actually rolls the update back.
    const expired = await owner.freightRate.create({
      data: {
        tenantId,
        code: 'RATE-ADDON-EXP',
        mode: 'SEA_FCL',
        polId,
        podId,
        carrierId,
        goodsTypeId,
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrierId,
        currencyId,
        validFrom: new Date('2021-01-01'),
        validTo: new Date('2021-12-31'),
        status: 'EXPIRED',
        lines: { create: [{ tierId: tierAId, buyPrice: '500.0000' }] },
      },
      select: { lines: { select: { id: true } } },
    });

    const response = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [
        { rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '888.0000' },
        { rateLineId: expired.lines[0]!.id.toString(), profitType: 'FLAT', profitValue: '1.0000' },
      ],
    });
    expect(response.status).toBe(409);

    const line = await lineState(lineAId);
    expect(line.profitValue.toFixed(4)).toBe('0.0000');
    expect(line.sellPrice?.toFixed(4)).toBe('1000.0000');

    // And no log entry survived either.
    expect(await owner.rateProfitLog.count({ where: { rateLineId: lineAId } })).toBe(0);
  });

  it('rolls the whole save back when one line is unknown', async () => {
    const response = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [
        { rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '777.0000' },
        { rateLineId: '99999999', profitType: 'FLAT', profitValue: '1.0000' },
      ],
    });
    expect(response.status).toBe(404);

    // The good line must not have been applied on its own.
    const line = await lineState(lineAId);
    expect(line.profitValue.toFixed(4)).toBe('0.0000');
    expect(line.sellPrice?.toFixed(4)).toBe('1000.0000');
  });

  it('refuses a payload naming the same line twice', async () => {
    const response = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [
        { rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '10.0000' },
        { rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '20.0000' },
      ],
    });
    expect(response.status).toBe(400);
  });

  it('will not re-price a line belonging to another mode screen', async () => {
    const response = await saveMargins(tokenAll, {
      mode: 'AIR',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '10.0000' }],
    });
    // The SEA_FCL line is invisible to an AIR save, so it reads as missing.
    expect(response.status).toBe(404);
  });
});

describe('§4 rule 6 — every margin change is logged, and only real ones', () => {
  it('writes a log entry naming the old value, the new value and the user', async () => {
    await saveMargins(tokenBlindPricer, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'PERCENT', profitValue: '15.0000' }],
      reason: 'Q1 repricing',
    });

    const entries = await owner.rateProfitLog.findMany({ where: { rateLineId: lineAId } });
    expect(entries).toHaveLength(1);

    const entry = entries[0]!;
    expect(entry.oldProfitType).toBe('FLAT');
    expect(entry.oldProfitValue?.toFixed(4)).toBe('0.0000');
    expect(entry.newProfitType).toBe('PERCENT');
    expect(entry.newProfitValue.toFixed(4)).toBe('15.0000');
    expect(entry.reason).toBe('Q1 repricing');
    expect(entry.changedBy).toBe(blindPricerId);
  });

  it('logs nothing for a row that was submitted unchanged', async () => {
    await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '50.0000' }],
    });

    // Submit both lines, but only line B is actually different.
    const second = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [
        { rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '50.0000' },
        { rateLineId: lineBId.toString(), profitType: 'FLAT', profitValue: '75.0000' },
      ],
    });
    expect(second.body.data.changed).toBe(1);

    expect(await owner.rateProfitLog.count({ where: { rateLineId: lineAId } })).toBe(1);
    expect(await owner.rateProfitLog.count({ where: { rateLineId: lineBId } })).toBe(1);
  });

  it('serves the history newest first', async () => {
    for (const value of ['10.0000', '20.0000', '30.0000']) {
      await saveMargins(tokenAll, {
        mode: 'SEA_FCL',
        edits: [{ rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: value }],
      });
    }

    const response = await as(tokenAll).get(
      `/api/tenant/purchase/addon/margins/${lineAId}/history?mode=SEA_FCL`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(3);
    expect(response.body.data[0].newProfitValue).toBe('30.0000');
    expect(response.body.data[0].oldProfitValue).toBe('20.0000');
    expect(response.body.data[2].oldProfitValue).toBe('0.0000');
  });
});

describe('§5.2 — the screen is gated behind MANAGE_PROFIT', () => {
  it('refuses the search to a user without it', async () => {
    const response = await as(tokenNoProfit).get(
      '/api/tenant/purchase/addon/rates?mode=SEA_FCL',
    );
    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/pricing team/i);
  });

  it('refuses the save to a user without it', async () => {
    const response = await saveMargins(tokenNoProfit, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '10.0000' }],
    });
    expect(response.status).toBe(403);

    expect((await lineState(lineAId)).profitValue.toFixed(4)).toBe('0.0000');
  });

  it('refuses a user holding MANAGE_PROFIT but not the add-on screen', async () => {
    const { token } = await makeUser(`profitonly-${SLUG}`, false, [
      'PURCHASE.RATE.MANAGE_PROFIT',
    ]);
    const response = await as(token).get('/api/tenant/purchase/addon/rates?mode=SEA_FCL');
    expect(response.status).toBe(403);
  });
});

describe('§4 rule 5 — MANAGE_PROFIT does not imply seeing what was paid', () => {
  it('lets a pricer set a margin without the buy price in the response', async () => {
    const response = await as(tokenBlindPricer).get(
      '/api/tenant/purchase/addon/rates?mode=SEA_FCL&limit=100',
    );
    expect(response.status).toBe(200);

    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain('buyPrice');
    expect(response.body.data[0].lines[0].sellPrice).toBeDefined();

    // And they can still price it — the two permissions are independent.
    const saved = await saveMargins(tokenBlindPricer, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '60.0000' }],
    });
    expect(saved.status).toBe(200);
    expect((await lineState(lineAId)).sellPrice?.toFixed(4)).toBe('1060.0000');
  });

  it('shows the buy price to a superadmin on the same screen', async () => {
    const response = await as(tokenAll).get(
      '/api/tenant/purchase/addon/rates?mode=SEA_FCL&limit=100',
    );
    expect(response.body.data[0].lines[0].buyPrice).toBe('1000.0000');
  });
});

describe('an expired rate cannot be re-priced', () => {
  it('refuses the save and leaves the margin alone', async () => {
    await owner.freightRate.update({
      where: { id: rateId },
      data: { status: 'EXPIRED' },
    });

    const response = await saveMargins(tokenAll, {
      mode: 'SEA_FCL',
      edits: [{ rateLineId: lineAId.toString(), profitType: 'FLAT', profitValue: '10.0000' }],
    });
    expect(response.status).toBe(409);

    expect((await lineState(lineAId)).profitValue.toFixed(4)).toBe('0.0000');
  });
});
