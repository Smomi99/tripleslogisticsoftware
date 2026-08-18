import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Sales — the §5.5 row actions (phase I).
 *
 * The spec is emphatic that each action is a distinct permission, so most of
 * what is worth testing is who is refused rather than what the happy path
 * returns. Price also crosses into §4 rule 5: an inquiry is the last place a
 * buy price should leak, because it is where sales are looking at a customer.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'inqact';
const PREFIX = 'IACT-';
const FEATURE = 'SALES.INQUIRY';

let tenantId: bigint;
/** Superadmin: bypasses every permission check (§7 rule 1). */
let tokenAdmin: string;
/** VIEW only — must be refused by all five actions. */
let tokenViewer: string;
/** Every action, but not VIEW_BUY_PRICE. */
let tokenSales: string;
/** Sales plus PURCHASE.RATE.VIEW_BUY_PRICE. */
let tokenPricer: string;

let sourceId: bigint;
let customerId: bigint;
let polId: bigint;
let podId: bigint;
let otherPodId: bigint;
let rateLineCheapId: bigint;
let rateLineDearId: bigint;
/** A line on a lane this inquiry is not for. */
let foreignLineId: bigint;

function as(token: string) {
  const headers = (r: request.Test) =>
    r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG);
  return {
    get: (p: string) => headers(request(app).get(p)),
    post: (p: string) => headers(request(app).post(p)),
    patch: (p: string) => headers(request(app).patch(p)),
  };
}

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  for (const table of [
    'inquiry_rate',
    'inquiry_followup',
    'inquiry_volume',
    'inquiry',
    'rate_local_charge',
    'freight_rate_line',
    'freight_rate',
    '"user"',
    'employee',
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
      data: { name: 'Inquiry Actions', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  // VIEW_ALL throughout: none of these users has an employee record, and §4
  // rule 10 fails closed for anyone who does not — so without it every request
  // below would 404 on scope rather than exercising the action under test.
  // The scope rule itself is covered in inquiry.test.ts.
  const everyAction = [
    `${FEATURE}.VIEW`,
    `${FEATURE}.VIEW_ALL`,
    `${FEATURE}.CREATE`,
    `${FEATURE}.EDIT`,
    `${FEATURE}.FOLLOWUP`,
    `${FEATURE}.ATTACH_PRICE`,
    `${FEATURE}.CONVERT_QUOTE`,
    `${FEATURE}.SET_OUTCOME`,
  ];
  tokenAdmin = await makeUser('admin', [], true);
  tokenViewer = await makeUser('viewer', [`${FEATURE}.VIEW`, `${FEATURE}.VIEW_ALL`]);
  tokenSales = await makeUser('sales', everyAction);
  tokenPricer = await makeUser('pricer', [...everyAction, 'PURCHASE.RATE.VIEW_BUY_PRICE']);

  sourceId = (
    await owner.inquirySource.create({
      data: { code: `${PREFIX}SRC`, name: 'Actions Source' },
      select: { id: true },
    })
  ).id;
  const sector = await owner.industrySector.create({
    data: { tenantId, code: `${PREFIX}SEC`, name: 'Actions Sector' },
    select: { id: true },
  });
  customerId = (
    await owner.customer.create({
      data: {
        tenantId,
        code: `${PREFIX}CUS`,
        name: 'Actions Customer',
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
  polId = await port('POL', 'Actions Loading');
  podId = await port('POD', 'Actions Discharge');
  otherPodId = await port('POD2', 'Actions Elsewhere');

  const carrierType = await owner.carrierType.findFirstOrThrow({
    where: { tenantId: null, name: 'MLO' },
  });
  const carrierId = (
    await owner.carrier.create({
      data: { code: `${PREFIX}CAR`, name: 'Actions Line', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
  const goodsTypeId = (
    await owner.goodsType.create({
      data: { code: `${PREFIX}GT`, name: 'Actions Goods' },
      select: { id: true },
    })
  ).id;
  // One line per tier per rate (UNIQUE tenant_id, rate_id, tier_id), so a rate
  // with two prices means two container sizes — which is the real shape anyway.
  const tier20 = (
    await owner.rateTier.create({
      data: { code: `${PREFIX}T20`, mode: 'SEA_FCL', label: '20FT', unit: 'CONTAINER' },
      select: { id: true },
    })
  ).id;
  const tier40 = (
    await owner.rateTier.create({
      data: { code: `${PREFIX}T40`, mode: 'SEA_FCL', label: '40FT', unit: 'CONTAINER' },
      select: { id: true },
    })
  ).id;
  const currencyId = (await owner.currency.findFirstOrThrow({ where: { tenantId: null } })).id;

  const rate = await owner.freightRate.create({
    data: {
      tenantId,
      code: `RATE-${PREFIX}1`,
      mode: 'SEA_FCL',
      polId,
      podId,
      carrierId,
      goodsTypeId,
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: carrierId,
      currencyId,
      validFrom: new Date('2020-01-01'),
      validTo: new Date('2099-12-31'),
      status: 'PUBLISHED',
      lines: {
        create: [
          { tierId: tier20, buyPrice: '1000.0000', profitType: 'FLAT', profitValue: '100.0000' },
          { tierId: tier40, buyPrice: '2000.0000', profitType: 'FLAT', profitValue: '200.0000' },
        ],
      },
    },
    select: { lines: { select: { id: true, sellPrice: true }, orderBy: { id: 'asc' } } },
  });
  rateLineCheapId = rate.lines[0]!.id;
  rateLineDearId = rate.lines[1]!.id;

  const foreign = await owner.freightRate.create({
    data: {
      tenantId,
      code: `RATE-${PREFIX}2`,
      mode: 'SEA_FCL',
      polId,
      podId: otherPodId,
      carrierId,
      goodsTypeId,
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: carrierId,
      currencyId,
      validFrom: new Date('2020-01-01'),
      validTo: new Date('2099-12-31'),
      status: 'PUBLISHED',
      lines: { create: [{ tierId: tier20, buyPrice: '500.0000' }] },
    },
    select: { lines: { select: { id: true } } },
  });
  foreignLineId = foreign.lines[0]!.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

let inquiryId = '';

/** A fresh OPEN inquiry on the priced lane, for each test to work on. */
beforeEach(async () => {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG}'`;
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_rate WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_followup WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_volume WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry WHERE tenant_id IN (${t})`);

  const created = await as(tokenAdmin).post('/api/tenant/sales/inquiries').send({
    inquiryDate: '2026-03-15',
    sourceId: sourceId.toString(),
    shipmentType: 'SEA',
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

describe('§5.5 — each row action is its own permission', () => {
  it('refuses a VIEW-only user every one of them', async () => {
    const viewer = as(tokenViewer);
    expect((await viewer.get(path('/followups'))).status).toBe(403);
    expect((await viewer.post(path('/followups')).send({})).status).toBe(403);
    expect((await viewer.get(path('/matching-rates'))).status).toBe(403);
    expect((await viewer.get(path('/rates'))).status).toBe(403);
    expect((await viewer.post(path('/rates')).send({})).status).toBe(403);
    expect((await viewer.post(path('/quote'))).status).toBe(403);
    expect((await viewer.patch(path()).send({})).status).toBe(403);
  });

  it('lets a VIEW-only user still read the inquiry', async () => {
    expect((await as(tokenViewer).get(path())).status).toBe(200);
  });
});

describe('§5.5 Price — matching rates', () => {
  it('offers only rates live on this inquiry lane', async () => {
    const res = await as(tokenSales).get(path('/matching-rates'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].lines).toHaveLength(2);
  });

  it('strips buy price and margin without VIEW_BUY_PRICE (§4 rule 5)', async () => {
    const res = await as(tokenSales).get(path('/matching-rates'));
    const line = res.body.data[0].lines[0];
    // The whole point of rule 5: not hidden in React, absent from the JSON.
    expect(line.buyPrice).toBeUndefined();
    expect(line.profitType).toBeUndefined();
    expect(line.profitValue).toBeUndefined();
    expect(line.sellPrice).toBe('1100.0000');
  });

  it('includes them with the permission', async () => {
    const res = await as(tokenPricer).get(path('/matching-rates'));
    const line = res.body.data[0].lines[0];
    expect(line.buyPrice).toBe('1000.0000');
    expect(line.profitValue).toBe('100.0000');
  });

  it('refuses a rate from another lane even though the picker filtered it out', async () => {
    const res = await as(tokenSales)
      .post(path('/rates'))
      .send({ rateLineIds: [foreignLineId.toString()] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('That rate is for a different lane.');
  });
});

describe('§5.5 Price — attaching writes back the quoted price', () => {
  it('selects the cheapest attached line and copies its price onto the inquiry', async () => {
    const res = await as(tokenSales)
      .post(path('/rates'))
      .send({ rateLineIds: [rateLineDearId.toString(), rateLineCheapId.toString()] });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);

    const selected = res.body.data.filter((r: { isSelected: boolean }) => r.isSelected);
    expect(selected).toHaveLength(1);
    expect(selected[0].quotedPrice).toBe('1100.0000');

    const inquiry = await as(tokenSales).get(path());
    expect(inquiry.body.data.quotedPrice).toBe('1100.0000');
  });

  it('moves the quote when a different line is selected', async () => {
    await as(tokenSales)
      .post(path('/rates'))
      .send({ rateLineIds: [rateLineCheapId.toString(), rateLineDearId.toString()] });
    const attached = await as(tokenSales).get(path('/rates'));
    const dear = attached.body.data.find(
      (r: { rateLineId: string }) => r.rateLineId === rateLineDearId.toString(),
    );

    const res = await as(tokenSales).post(path('/rates/select')).send({ inquiryRateId: dear.id });
    expect(res.status).toBe(200);

    const inquiry = await as(tokenSales).get(path());
    expect(inquiry.body.data.quotedPrice).toBe('2200.0000');
  });

  it('snapshots the price rather than joining it (§4 rule 1)', async () => {
    await as(tokenSales).post(path('/rates')).send({ rateLineIds: [rateLineCheapId.toString()] });
    // The pricing team re-buys the lane; the attached figure must not follow.
    await owner.freightRateLine.update({
      where: { id: rateLineCheapId },
      data: { buyPrice: '9999.0000' },
    });

    const attached = await as(tokenSales).get(path('/rates'));
    expect(attached.body.data[0].quotedPrice).toBe('1100.0000');

    await owner.freightRateLine.update({
      where: { id: rateLineCheapId },
      data: { buyPrice: '1000.0000' },
    });
  });
});

describe('§5.5 Quote', () => {
  it('refuses to quote an inquiry with no price attached', async () => {
    const res = await as(tokenSales).post(path('/quote'));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Attach a rate');
  });

  it('sets QUOTED once a rate is attached', async () => {
    await as(tokenSales).post(path('/rates')).send({ rateLineIds: [rateLineCheapId.toString()] });
    const res = await as(tokenSales).post(path('/quote'));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('QUOTED');
  });
});

describe('§5.5 Edit — blocked once WON', () => {
  const body = () => ({
    inquiryDate: '2026-03-16',
    sourceId: sourceId.toString(),
    shipmentType: 'SEA',
    customerId: customerId.toString(),
    movementType: 'OUTBOUND',
    polId: polId.toString(),
    podId: podId.toString(),
    volumes: [],
  });

  it('edits an open inquiry in place, without raising a second one', async () => {
    const before = await as(tokenSales).get(path());
    const res = await as(tokenSales).patch(path()).send(body());
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data.inquiryDate).toBe('2026-03-16');

    // The bug this guards: Edit linked at the capture screen, which only ever
    // POSTed, so editing silently raised a duplicate with a fresh number.
    expect(res.body.data.id).toBe(before.body.data.id);
    expect(res.body.data.code).toBe(before.body.data.code);
    expect(await owner.inquiry.count({ where: { tenantId, deletedAt: null } })).toBe(1);
  });

  it('rewrites the volume grid rather than stacking rows onto it', async () => {
    await as(tokenSales)
      .patch(path())
      .send({ ...body(), volumes: [{ volumeKind: 'LCL', cbm: '12.5' }] });
    const first = await as(tokenSales).get(path());
    expect(first.body.data.volumes).toHaveLength(1);

    await as(tokenSales)
      .patch(path())
      .send({ ...body(), volumes: [{ volumeKind: 'LCL', cbm: '20' }] });
    const second = await as(tokenSales).get(path());
    // §4 rule 3 forbids deleting the old row, so the risk is duplication.
    expect(second.body.data.volumes).toHaveLength(1);
    expect(second.body.data.volumes[0].cbm).toBe('20.000');
  });

  it('refuses once the inquiry is WON', async () => {
    await as(tokenSales).post(path('/status')).send({ status: 'WON' });
    const res = await as(tokenSales).patch(path()).send(body());
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('WON');
  });
});

describe('§9 Q10 — WON and LOST need SET_OUTCOME', () => {
  /** Every action except the outcome one. */
  let tokenNoOutcome: string;

  beforeAll(async () => {
    tokenNoOutcome = await makeUser('nooutcome', [
      `${FEATURE}.VIEW`,
      `${FEATURE}.VIEW_ALL`,
      `${FEATURE}.EDIT`,
      `${FEATURE}.FOLLOWUP`,
      `${FEATURE}.ATTACH_PRICE`,
      `${FEATURE}.CONVERT_QUOTE`,
    ]);
  });

  it('lets that user set an ordinary status', async () => {
    const res = await as(tokenNoOutcome).post(path('/status')).send({ status: 'CANCELLED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
  });

  it('refuses WON and LOST', async () => {
    for (const status of ['WON', 'LOST']) {
      const res = await as(tokenNoOutcome).post(path('/status')).send({ status });
      expect(res.status, status).toBe(403);
    }
  });

  it('records the reason on the follow-up trail', async () => {
    await as(tokenSales)
      .post(path('/status'))
      .send({ status: 'LOST', reason: 'Customer went with the incumbent' });

    const followups = await as(tokenSales).get(path('/followups'));
    expect(followups.body.data).toHaveLength(1);
    expect(followups.body.data[0].notes).toContain('Customer went with the incumbent');
  });
});

describe('§5.5 Follow Up(n)', () => {
  it('records one and moves the counter the list button shows', async () => {
    const before = await as(tokenSales).get(path());
    expect(before.body.data.followupCount).toBe(0);

    const res = await as(tokenSales).post(path('/followups')).send({
      followupDate: '2026-03-16',
      contactMode: 'CALL',
      contactPerson: 'Mr Rahman',
      notes: 'Asked for a Rotterdam indication',
      nextFollowupDate: '2026-03-23',
    });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);

    const after = await as(tokenSales).get(path());
    expect(after.body.data.followupCount).toBe(1);

    const list = await as(tokenSales).get(path('/followups'));
    expect(list.body.data[0].contactPerson).toBe('Mr Rahman');
    expect(list.body.data[0].nextFollowupDate).toBe('2026-03-23');
  });
});
