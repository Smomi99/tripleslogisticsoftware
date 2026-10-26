import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * The Price drawer's charges and price history (client, 2026-10-26).
 *
 * Charges: ticking a container offers the purchase rate's local charges for
 * that box; the user keeps the ones they want and may add extras, and the
 * quoted price is freight plus all of them — converted where they differ in
 * currency.
 *
 * Price history: the lane's sell price for that carrier and size, across every
 * rate keyed for it, read back from the audit trail.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'inqchg';
const PREFIX = 'ICHG-';
const FEATURE = 'SALES.INQUIRY';

let tenantId: bigint;
let tokenAdmin: string;
let tokenViewer: string;
let tokenSales: string;

let sourceId: bigint;
let customerId: bigint;
let polId: bigint;
let podId: bigint;
/** The rate's currency. */
let currencyA: bigint;
/** Any other currency, for the conversion cases. */
let currencyB: bigint;
let truckingHeadId: bigint;
let line20: bigint;
let line40: bigint;
let foreignLineId: bigint;
/** THC on a 20ft box, 65 in A. */
let thc20: bigint;
/** THC on a 40ft box, 90 in A. */
let thc40: bigint;
/** Documentation, any size, 40 in A. */
let docs: bigint;
/** Seal, any size, 100 in B. */
let sealB: bigint;

function as(token: string) {
  const headers = (r: request.Test) =>
    r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG);
  return {
    get: (p: string) => headers(request(app).get(p)),
    post: (p: string) => headers(request(app).post(p)),
    put: (p: string) => headers(request(app).put(p)),
  };
}

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  for (const table of [
    'email_log',
    'inquiry_rate_charge',
    'inquiry_rate',
    'inquiry_volume',
    'inquiry',
    'currency_rate_history',
    'rate_local_charge',
    'freight_rate_line',
    'freight_rate',
    'cost_head',
    '"user"',
    'customer',
    'industry_sector',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN (${t})`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_source WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM goods_type WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM rate_tier WHERE code LIKE '${PREFIX}%'`);
}

async function makeUser(suffix: string, permissions: string[], isSuperadmin = false) {
  const user = await owner.user.create({
    data: {
      tenantId,
      code: `USR-${suffix}`,
      username: `${suffix}-${SLUG}`,
      email: `${suffix}@${SLUG}.test`,
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

beforeAll(async () => {
  await cleanup();

  tenantId = (
    await owner.tenant.create({
      data: { name: 'Rate Charges', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  tokenAdmin = await makeUser('admin', [], true);
  tokenViewer = await makeUser('viewer', [`${FEATURE}.VIEW`, `${FEATURE}.VIEW_ALL`]);
  tokenSales = await makeUser('sales', [
    `${FEATURE}.VIEW`,
    `${FEATURE}.VIEW_ALL`,
    `${FEATURE}.ATTACH_PRICE`,
  ]);

  sourceId = (
    await owner.inquirySource.create({
      data: { code: `${PREFIX}SRC`, name: 'Charges Source' },
      select: { id: true },
    })
  ).id;
  const sector = await owner.industrySector.create({
    data: { tenantId, code: `${PREFIX}SEC`, name: 'Charges Sector' },
    select: { id: true },
  });
  customerId = (
    await owner.customer.create({
      data: {
        tenantId,
        code: `${PREFIX}CUS`,
        name: 'Charges Customer',
        country: 'Bangladesh',
        customerType: 'EXPORTER',
        businessArea: 'OUTBOUND',
        industrySectorId: sector.id,
      },
      select: { id: true },
    })
  ).id;

  const port = async (suffix: string, name: string) =>
    (
      await owner.port.create({
        data: {
          code: `${PREFIX}${suffix}`,
          name,
          portCode: `${PREFIX}${suffix}`.slice(0, 20),
          country: 'Bangladesh',
          type: 'SEAPORT',
        },
        select: { id: true },
      })
    ).id;
  polId = await port('POL', 'Charges Loading');
  podId = await port('POD', 'Charges Discharge');
  const otherPodId = await port('POD2', 'Charges Elsewhere');

  const carrierType = await owner.carrierType.findFirstOrThrow({
    where: { tenantId: null, name: 'MLO' },
  });
  const carrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}CAR`, name: 'Charges Line', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
  const goodsTypeId = (
    await owner.goodsType.create({
      data: { code: `${PREFIX}GT`, name: 'Charges Goods' },
      select: { id: true },
    })
  ).id;
  const [size20, size40] = await owner.containerSize.findMany({
    where: { tenantId: null, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
    take: 2,
    select: { id: true },
  });
  const tier = async (suffix: string, label: string, containerSizeId: bigint) =>
    (
      await owner.rateTier.create({
        data: {
          code: `${PREFIX}${suffix}`,
          mode: 'SEA_FCL',
          label,
          unit: 'CONTAINER',
          containerSizeId,
        },
        select: { id: true },
      })
    ).id;
  const tier20 = await tier('T20', '20FT', size20!.id);
  const tier40 = await tier('T40', '40FT', size40!.id);

  const shared = await owner.currency.findMany({
    where: { tenantId: null, deletedAt: null },
    orderBy: { id: 'asc' },
    take: 2,
    select: { id: true },
  });
  currencyA = shared[0]!.id;
  currencyB = shared[1]!.id;

  const unit = await owner.costUnit.findFirstOrThrow({ where: { tenantId: null } });
  const head = async (suffix: string, name: string) =>
    (
      await owner.costHead.create({
        data: { tenantId, code: `${PREFIX}${suffix}`, category: 'SERVICE', name, unitId: unit.id },
        select: { id: true },
      })
    ).id;
  const thcHead = await head('THC', 'Terminal Handling');
  const docsHead = await head('DOC', 'Documentation');
  const sealHead = await head('SEAL', 'Seal');
  truckingHeadId = await head('TRK', 'Trucking');

  /** A FCL rate on a lane; returns its id and its lines' ids by tier. */
  const rate = async (
    code: string,
    pod: bigint,
    validity: [string, string],
    status: 'PUBLISHED' | 'EXPIRED',
    lines: [bigint, string][],
  ) =>
    owner.freightRate.create({
      data: {
        tenantId,
        code,
        mode: 'SEA_FCL',
        polId,
        podId: pod,
        carrierId,
        goodsTypeId,
        purchaseSourceType: 'CARRIER',
        purchaseCarrierId: carrierId,
        currencyId: currencyA,
        validFrom: new Date(validity[0]),
        validTo: new Date(validity[1]),
        status,
        lines: {
          create: lines.map(([tierId, buyPrice]) => ({
            tierId,
            buyPrice,
            profitType: 'FLAT' as const,
            profitValue: '100.0000',
          })),
        },
      },
      select: { id: true, lines: { select: { id: true }, orderBy: { id: 'asc' } } },
    });

  // Last year's buy on the same lane, keyed first: the start of the history.
  await rate(`RATE-${PREFIX}0`, podId, ['2019-01-01', '2019-12-31'], 'EXPIRED', [
    [tier20, '900.0000'],
  ]);
  const live = await rate(`RATE-${PREFIX}1`, podId, ['2020-01-01', '2099-12-31'], 'PUBLISHED', [
    [tier20, '1000.0000'],
    [tier40, '2000.0000'],
  ]);
  line20 = live.lines[0]!.id;
  line40 = live.lines[1]!.id;
  foreignLineId = (
    await rate(`RATE-${PREFIX}2`, otherPodId, ['2020-01-01', '2099-12-31'], 'PUBLISHED', [
      [tier20, '500.0000'],
    ])
  ).lines[0]!.id;

  const charge = async (
    costHeadId: bigint,
    side: 'POL' | 'POD',
    amount: string,
    currencyId: bigint,
    containerSizeId: bigint | null,
  ) =>
    (
      await owner.rateLocalCharge.create({
        data: { tenantId, rateId: live.id, costHeadId, side, amount, currencyId, containerSizeId },
        select: { id: true },
      })
    ).id;
  thc20 = await charge(thcHead, 'POL', '65.0000', currencyA, size20!.id);
  thc40 = await charge(thcHead, 'POL', '90.0000', currencyA, size40!.id);
  docs = await charge(docsHead, 'POD', '40.0000', currencyA, null);
  sealB = await charge(sealHead, 'POL', '100.0000', currencyB, null);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

let inquiryId = '';

beforeEach(async () => {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  for (const table of ['inquiry_rate_charge', 'inquiry_rate', 'inquiry_volume', 'inquiry']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN (${t})`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM currency_rate_history WHERE tenant_id IN (${t})`);
  await owner.tenant.update({ where: { id: tenantId }, data: { currencyId: null } });

  const created = await as(tokenAdmin).post('/api/tenant/sales/inquiries').send({
    inquiryDate: '2026-10-26',
    sourceId: sourceId.toString(),
    shipmentType: 'SEA',
    loadingType: 'FCL',
    customerId: customerId.toString(),
    movementType: 'OUTBOUND',
    polId: polId.toString(),
    podId: podId.toString(),
    volumes: [],
  });
  expect(created.status, JSON.stringify(created.body.error ?? {})).toBe(201);
  inquiryId = created.body.data.id;
});

const path = (suffix = ''): string => `/api/tenant/sales/inquiries/${inquiryId}${suffix}`;
const ids = (...values: bigint[]): string[] => values.map((v) => v.toString());
const extra = (amount: string, currencyId = currencyA, id?: string) => ({
  ...(id === undefined ? {} : { id }),
  costHeadId: truckingHeadId.toString(),
  currencyId: currencyId.toString(),
  amount,
});

interface AttachedRow {
  id: string;
  rateLineId: string;
  freightPrice: string;
  quotedPrice: string;
  charges: { id: string; localChargeId: string | null; amount: string; side: string | null }[];
  availableCharges: { id: string }[];
}

async function attach(body: object): Promise<AttachedRow[]> {
  const res = await as(tokenSales).post(path('/rates')).send(body);
  expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
  return res.body.data as AttachedRow[];
}

describe('Charges — permissions', () => {
  it('refuses a VIEW-only user, as every other Price action does', async () => {
    const viewer = as(tokenViewer);
    expect((await viewer.get(path('/charge-options'))).status).toBe(403);
    expect((await viewer.put(path('/rates/1/charges')).send({})).status).toBe(403);
    expect((await viewer.get(path(`/rate-lines/${line20}/price-history`))).status).toBe(403);
  });
});

describe('Charges — offered with each container', () => {
  it('offers the charges for that box and the ones for any box, not another box’s', async () => {
    const res = await as(tokenSales).get(path('/matching-rates'));
    expect(res.status).toBe(200);
    const live = res.body.data.find((r: { rateCode: string }) => r.rateCode === `RATE-${PREFIX}1`);
    const offered = (lineId: bigint): string[] =>
      live.lines
        .find((l: { id: string }) => l.id === lineId.toString())
        .charges.map((c: { id: string }) => c.id)
        .sort();
    expect(offered(line20)).toEqual(ids(thc20, docs, sealB).sort());
    expect(offered(line40)).toEqual(ids(thc40, docs, sealB).sort());
  });
});

describe('Charges — the quoted price includes them', () => {
  it('quotes freight alone when nothing is ticked', async () => {
    const [row] = await attach({ lines: [{ rateLineId: line20.toString() }] });
    expect(row!.freightPrice).toBe('1100.0000');
    expect(row!.quotedPrice).toBe('1100.0000');
    expect(row!.charges).toEqual([]);
  });

  it('adds the ticked charges and the extras, and writes it onto the inquiry', async () => {
    const [row] = await attach({
      lines: [
        {
          rateLineId: line20.toString(),
          localChargeIds: ids(thc20, docs),
          extras: [extra('25.5')],
        },
      ],
    });
    // 1100 freight + 65 THC + 40 docs + 25.50 trucking.
    expect(row!.quotedPrice).toBe('1230.5000');
    expect(row!.freightPrice).toBe('1100.0000');
    expect(row!.charges).toHaveLength(3);
    expect(row!.charges.find((c) => c.localChargeId === thc20.toString())!.side).toBe('POL');
    expect(row!.charges.find((c) => c.localChargeId === null)!.side).toBeNull();

    const inquiry = await as(tokenSales).get(path());
    expect(inquiry.body.data.quotedPrice).toBe('1230.5000');
  });

  it('refuses a charge that belongs to another box', async () => {
    const res = await as(tokenSales)
      .post(path('/rates'))
      .send({ lines: [{ rateLineId: line20.toString(), localChargeIds: ids(thc40) }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That charge is not on this rate for this container.');
  });

  it('refuses an extra with an unknown cost head or a price that is not a price', async () => {
    const unknown = await as(tokenSales)
      .post(path('/rates'))
      .send({
        lines: [
          { rateLineId: line20.toString(), extras: [{ ...extra('5'), costHeadId: '999999999' }] },
        ],
      });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toBe('That cost head is not available. Choose another.');

    for (const bad of ['-5', 'abc', '1.23456']) {
      const res = await as(tokenSales)
        .post(path('/rates'))
        .send({ lines: [{ rateLineId: line20.toString(), extras: [extra(bad)] }] });
      expect(res.status, bad).toBe(400);
    }
  });
});

describe('Charges — changed after attaching', () => {
  it('re-prices the line and the inquiry, removing softly', async () => {
    const [row] = await attach({
      lines: [{ rateLineId: line20.toString(), localChargeIds: ids(thc20, docs) }],
    });
    const docsRow = row!.charges.find((c) => c.localChargeId === docs.toString())!;

    const res = await as(tokenSales)
      .put(path(`/rates/${row!.id}/charges`))
      .send({ localChargeIds: ids(thc20), extras: [extra('10')] });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data[0].quotedPrice).toBe('1175.0000');

    const inquiry = await as(tokenSales).get(path());
    expect(inquiry.body.data.quotedPrice).toBe('1175.0000');

    const removed = await owner.inquiryRateCharge.findUniqueOrThrow({
      where: { id: BigInt(docsRow.id) },
    });
    expect(removed.deletedAt).not.toBeNull();
  });

  it('keeps a charge at the figure it was quoted at when the rate is re-keyed', async () => {
    const [row] = await attach({ lines: [{ rateLineId: line20.toString(), localChargeIds: ids(thc20) }] });
    await owner.rateLocalCharge.update({ where: { id: thc20 }, data: { amount: '70.0000' } });
    try {
      const res = await as(tokenSales)
        .put(path(`/rates/${row!.id}/charges`))
        .send({ localChargeIds: ids(thc20, docs) });
      // THC stays at 65; docs is newly ticked at today's 40.
      expect(res.body.data[0].quotedPrice).toBe('1205.0000');
    } finally {
      await owner.rateLocalCharge.update({ where: { id: thc20 }, data: { amount: '65.0000' } });
    }
  });

  it('edits an extra in place', async () => {
    const [row] = await attach({ lines: [{ rateLineId: line20.toString(), extras: [extra('10')] }] });
    const saved = row!.charges[0]!;
    const res = await as(tokenSales)
      .put(path(`/rates/${row!.id}/charges`))
      .send({ extras: [extra('12', currencyA, saved.id)] });
    expect(res.body.data[0].charges).toHaveLength(1);
    expect(res.body.data[0].charges[0].id).toBe(saved.id);
    expect(res.body.data[0].quotedPrice).toBe('1112.0000');
  });

  it('refuses once the inquiry is WON', async () => {
    const [row] = await attach({ lines: [{ rateLineId: line20.toString() }] });
    await owner.inquiry.update({ where: { id: BigInt(inquiryId) }, data: { status: 'WON' } });
    const res = await as(tokenSales).put(path(`/rates/${row!.id}/charges`)).send({});
    expect(res.status).toBe(409);
  });
});

describe('Quoted Price breakdown on the list', () => {
  it('is readable with VIEW alone, and shows freight and each charge', async () => {
    await attach({
      lines: [
        { rateLineId: line20.toString(), localChargeIds: ids(thc20), extras: [extra('10')] },
      ],
    });
    const res = await as(tokenViewer).get(path('/quote-breakdown'));
    expect(res.status).toBe(200);
    expect(res.body.data.freightPrice).toBe('1100.0000');
    expect(res.body.data.quotedPrice).toBe('1175.0000');
    expect(res.body.data.matchesInquiry).toBe(true);
    expect(
      res.body.data.charges.map((c: { costHeadName: string; side: string | null }) => [
        c.costHeadName,
        c.side,
      ]),
    ).toEqual([
      ['Terminal Handling', 'POL'],
      ['Trucking', null],
    ]);
    // Explains a figure; carries no margin.
    expect(JSON.stringify(res.body.data)).not.toContain('buy');
  });

  it('is empty when nothing is attached', async () => {
    const res = await as(tokenViewer).get(path('/quote-breakdown'));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

describe('Charges — in another currency', () => {
  it('refuses rather than quoting short when no rate converts it', async () => {
    const res = await as(tokenSales)
      .post(path('/rates'))
      .send({ lines: [{ rateLineId: line20.toString(), localChargeIds: ids(sealB) }] });
    expect(res.status).toBe(409);
    // Nothing half-written: the whole attach rolled back.
    const attached = await as(tokenSales).get(path('/rates'));
    expect(attached.body.data).toEqual([]);
  });

  it('converts through the workspace base', async () => {
    // Base = the rate's currency; one unit of B is worth half a unit of A.
    await owner.tenant.update({ where: { id: tenantId }, data: { currencyId: currencyA } });
    await owner.currencyRateHistory.create({
      data: {
        tenantId,
        currencyId: currencyB,
        rate: '0.5000000000',
        effectiveFrom: new Date('2020-01-01'),
      },
    });
    const [row] = await attach({
      lines: [{ rateLineId: line20.toString(), localChargeIds: ids(sealB) }],
    });
    // 1100 + 100 B × 0.5.
    expect(row!.quotedPrice).toBe('1150.0000');
  });
});

describe('Price history on hover', () => {
  it('tells the lane story across rates, newest first', async () => {
    // The pricing team re-prices the live rate: buy 1000 → 1200, sell 1100 → 1300.
    await owner.freightRateLine.update({ where: { id: line20 }, data: { buyPrice: '1200.0000' } });
    try {
      const res = await as(tokenSales).get(path(`/rate-lines/${line20}/price-history`));
      expect(res.status).toBe(200);
      const entries = res.body.data as {
        sellPrice: string;
        change: string | null;
        rateCode: string;
      }[];
      expect(entries.map((e) => [e.rateCode, e.sellPrice, e.change])).toEqual([
        [`RATE-${PREFIX}1`, '1300.0000', '200.0000'],
        [`RATE-${PREFIX}1`, '1100.0000', '100.0000'],
        [`RATE-${PREFIX}0`, '1000.0000', null],
      ]);
    } finally {
      await owner.freightRateLine.update({
        where: { id: line20 },
        data: { buyPrice: '1000.0000' },
      });
    }
  });

  it('never shows the buy price', async () => {
    const res = await as(tokenSales).get(path(`/rate-lines/${line20}/price-history`));
    expect(JSON.stringify(res.body.data)).not.toContain('buy');
  });

  it('will not answer for a rate on another lane', async () => {
    const res = await as(tokenSales).get(path(`/rate-lines/${foreignLineId}/price-history`));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That rate is for a different lane.');
  });
});
