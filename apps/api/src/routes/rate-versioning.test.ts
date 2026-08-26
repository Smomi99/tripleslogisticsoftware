import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';
import { expireLapsedRates, ratesExpiringSoon } from '../lib/rate-expiry';

/**
 * Editing a rate, and the expiry job (docs/MODULE_PURCHASE_SALES.md §4).
 *
 * Rule 1 used to say a published rate was superseded rather than edited, on the
 * grounds that a quotation issued last month must still resolve to the rate
 * that was live when it was issued. Editing now edits, because that grounds is
 * covered twice over and the versioning was buying nothing but clutter:
 *
 *   audit_log        carries a trigger on freight_rate, freight_rate_line and
 *                    rate_local_charge, so every change is recorded with its
 *                    old and new values. That is a better history than a
 *                    duplicate row — it says what changed.
 *   quotation_line   snapshots its own cost head, price, currency and
 *                    conversion rate (§2.2), so an issued quotation never reads
 *                    the rate table and cannot move when a rate does.
 *
 * So the assertions here are the mirror of what they were: one row, updated,
 * with the audit trail holding what it used to say.
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
  // The local charge tests give this workspace cost heads of its own.
  await owner.$executeRawUnsafe(`DELETE FROM cost_head WHERE tenant_id IN (${t})`);
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


describe('editing a rate that carries local charges', () => {
  /*
   * Reported from use: "edit purchase price and add local charge and update"
   * came back 400, "Some fields need attention."
   *
   * Three things had to line up for that, and all three were wrong.
   */
  let costHeadA: bigint;
  let costHeadB: bigint;
  let sizeA: bigint;
  let sizeB: bigint;

  beforeAll(async () => {
    const unit = await owner.costUnit.findFirstOrThrow({ select: { id: true } });
    costHeadA = (
      await owner.costHead.create({
        data: { tenantId, code: 'VCH-A', name: 'THC', category: 'SERVICE', unitId: unit.id },
        select: { id: true },
      })
    ).id;
    costHeadB = (
      await owner.costHead.create({
        data: { tenantId, code: 'VCH-B', name: 'Seal Charge', category: 'SERVICE', unitId: unit.id },
        select: { id: true },
      })
    ).id;
    const sizes = await owner.containerSize.findMany({ select: { id: true }, take: 2 });
    sizeA = sizes[0]!.id;
    sizeB = sizes[1]!.id;
  });

  const charge = (over: Record<string, unknown> = {}) => ({
    costHeadId: costHeadA.toString(),
    side: 'POL',
    containerSizeId: sizeA.toString(),
    amount: '13.0000',
    currencyId: currencyId.toString(),
    ...over,
  });

  it('accepts two charges that differ only by container size', async () => {
    // THC on a 20ft and THC on a 40ft are two lines, not a duplicate.
    const rateId = await createRate({
      localCharges: [charge(), charge({ containerSizeId: sizeB.toString(), amount: '26.0000' })],
    });
    const res = await api.get(`/api/tenant/purchase/rates/${rateId}?mode=SEA_FCL`).expect(200);
    expect(res.body.data.localCharges).toHaveLength(2);
  });

  it('takes its own answer back unchanged', async () => {
    /*
     * The screen loads a rate and sends it back. The DTO returns null for a
     * charge with no size and null for empty remarks, and the schema refused
     * both — so a form that had touched nothing was rejected for echoing what
     * the API had just said.
     */
    const rateId = await createRate({
      localCharges: [charge({ containerSizeId: null, remarks: null })],
    });
    const loaded = await api.get(`/api/tenant/purchase/rates/${rateId}?mode=SEA_FCL`).expect(200);

    const echoed = await api.patch(`/api/tenant/purchase/rates/${rateId}`).send(
      rateBody({
        localCharges: loaded.body.data.localCharges.map(
          (c: Record<string, unknown>) => ({
            costHeadId: c['costHeadId'],
            side: c['side'],
            containerSizeId: c['containerSizeId'],
            amount: c['amount'],
            currencyId: c['currencyId'],
            remarks: c['remarks'],
          }),
        ),
      }),
    );
    expect(echoed.status, JSON.stringify(echoed.body.error ?? {})).toBe(200);
  });

  it('adds a charge to a rate that already has two sized ones', async () => {
    // The reported case, end to end.
    const rateId = await createRate({
      localCharges: [charge(), charge({ containerSizeId: sizeB.toString(), amount: '26.0000' })],
    });

    const res = await api.patch(`/api/tenant/purchase/rates/${rateId}`).send(
      rateBody({
        localCharges: [
          charge(),
          charge({ containerSizeId: sizeB.toString(), amount: '26.0000' }),
          charge({ costHeadId: costHeadB.toString(), containerSizeId: '', amount: '30.0000' }),
        ],
      }),
    );
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data.localCharges).toHaveLength(3);
  });

  it('keeps both sizes rather than folding one onto the other', async () => {
    /*
     * The API matched existing charges on cost head and side alone, while the
     * table's key includes the size. Editing a rate with THC-20 and THC-40
     * therefore overwrote one with the other and retired whichever lost.
     */
    const rateId = await createRate({
      localCharges: [charge({ amount: '13.0000' }), charge({ containerSizeId: sizeB.toString(), amount: '26.0000' })],
    });

    await api
      .patch(`/api/tenant/purchase/rates/${rateId}`)
      .send(
        rateBody({
          localCharges: [
            charge({ amount: '15.0000' }),
            charge({ containerSizeId: sizeB.toString(), amount: '26.0000' }),
          ],
        }),
      )
      .expect(200);

    const res = await api.get(`/api/tenant/purchase/rates/${rateId}?mode=SEA_FCL`).expect(200);
    const amounts = res.body.data.localCharges
      .map((c: { amount: string }) => c.amount)
      .sort();
    expect(amounts).toEqual(['15.0000', '26.0000']);
  });

  it('lets a removed charge be added back', async () => {
    /*
     * Soft delete leaves the row, and both unique indexes counted the retired
     * ones — so a cost head taken off a rate could never go back on it, and the
     * second attempt surfaced as a 500 nobody could act on.
     */
    const rateId = await createRate({ localCharges: [charge()] });

    await api
      .patch(`/api/tenant/purchase/rates/${rateId}`)
      .send(rateBody({ localCharges: [] }))
      .expect(200);

    const back = await api
      .patch(`/api/tenant/purchase/rates/${rateId}`)
      .send(rateBody({ localCharges: [charge()] }));
    expect(back.status, JSON.stringify(back.body.error ?? {})).toBe(200);
    expect(back.body.data.localCharges).toHaveLength(1);
  });

  it('still refuses a real duplicate', async () => {
    const res = await api.post('/api/tenant/purchase/rates').send(
      rateBody({ localCharges: [charge({ containerSizeId: '' }), charge({ containerSizeId: '' })] }),
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.fields)).toContain('once per side');
  });
});

describe('editing a published rate', () => {
  it('updates the row rather than producing a second one', async () => {
    const originalId = await createRate();
    const before = await owner.freightRate.count({ where: { tenantId, deletedAt: null } });

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

    // The same rate, not a replacement. This is the whole point of the change:
    // correcting a rate used to leave a duplicate and an expired row behind.
    expect(response.body.data.id).toBe(originalId);
    expect(await owner.freightRate.count({ where: { tenantId, deletedAt: null } })).toBe(before);

    const after = await owner.freightRate.findFirstOrThrow({
      where: { id: BigInt(originalId) },
      include: { lines: { where: { deletedAt: null } } },
    });
    expect(after.status).toBe('PUBLISHED');
    expect(after.supersededById).toBeNull();
    expect(after.lines[0]!.buyPrice.toFixed(4)).toBe('1500.0000');
    expect(after.lines[0]!.sellPrice!.toFixed(4)).toBe('1800.0000');
    expect(after.validTo.toISOString().slice(0, 10)).toBe('2034-12-31');
  });

  it('keeps its code, because it is the same rate', async () => {
    const originalId = await createRate();
    const originalCode = (
      await owner.freightRate.findFirstOrThrow({ where: { id: BigInt(originalId) } })
    ).code;

    const response = await api
      .patch(`/api/tenant/purchase/rates/${originalId}`)
      .send(rateBody({ validFrom: '2034-01-01', validTo: '2034-12-31' }));
    expect(response.status).toBe(200);
    expect(response.body.data.code).toBe(originalCode);
  });

  it('keeps the line ids, which rate_profit_log points at', async () => {
    // Matched to the submitted tiers rather than cleared and rebuilt, so the
    // margin history stays attached to the line it describes.
    const originalId = await createRate();
    const before = await owner.freightRateLine.findFirstOrThrow({
      where: { rateId: BigInt(originalId), deletedAt: null },
      select: { id: true },
    });

    await api
      .patch(`/api/tenant/purchase/rates/${originalId}`)
      .send(
        rateBody({
          lines: [
            { tierId: tierId.toString(), buyPrice: '1111.0000', profitType: 'FLAT', profitValue: '0' },
          ],
        }),
      )
      .expect(200);

    const after = await owner.freightRateLine.findFirstOrThrow({
      where: { rateId: BigInt(originalId), deletedAt: null },
      select: { id: true, buyPrice: true },
    });
    expect(after.id).toBe(before.id);
    expect(after.buyPrice.toFixed(4)).toBe('1111.0000');
  });

  it('records what it used to say, in the audit trail', async () => {
    /*
     * The reason editing in place is safe. The old figure is not lost — it is
     * in audit_log with who changed it and when, which answers "what did we
     * buy this at in March" better than a second row ever did.
     */
    const originalId = await createRate();
    await api
      .patch(`/api/tenant/purchase/rates/${originalId}`)
      .send(
        rateBody({
          lines: [
            { tierId: tierId.toString(), buyPrice: '1750.0000', profitType: 'FLAT', profitValue: '0' },
          ],
        }),
      )
      .expect(200);

    const entries = await owner.auditLog.findMany({
      where: { tenantId, tableName: 'freight_rate_line', action: 'UPDATE' },
      select: { oldValues: true, newValues: true },
      orderBy: { id: 'desc' },
      take: 1,
    });
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]!.oldValues)).toContain('1000');
    expect(JSON.stringify(entries[0]!.newValues)).toContain('1750');
  });

  it('does not trip the one-published-rate-per-lane constraint on itself', async () => {
    // §4 rule 8's exclusion constraint sees the row it is already looking at.
    // Editing in place has to be allowed to leave it exactly where it was.
    const originalId = await createRate();
    await api
      .patch(`/api/tenant/purchase/rates/${originalId}`)
      .send(rateBody({ remarks: 'corrected a typo' }))
      .expect(200);
  });

  it('still edits a DRAFT in place, as it always did', async () => {
    const draftId = await createRate({ status: 'DRAFT' });
    const response = await api
      .patch(`/api/tenant/purchase/rates/${draftId}`)
      .send(rateBody({ status: 'DRAFT', remarks: 'still a draft' }));
    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(draftId);
  });

  it('refuses to edit an expired rate at all', async () => {
    // Unchanged, and for the reason it always held: an expired rate describes a
    // period that has closed, and editing one rewrites history rather than
    // correcting a mistake.
    const rateId = await createRate();
    await owner.freightRate.update({
      where: { id: BigInt(rateId) },
      data: { status: 'EXPIRED' },
    });
    const response = await api
      .patch(`/api/tenant/purchase/rates/${rateId}`)
      .send(rateBody({ remarks: 'too late' }));
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('expired rate cannot be edited');
  });

  it('refuses to edit a row superseded before the rule changed', async () => {
    /*
     * Rates versioned by the old behaviour are still in the database, on the
     * VPS as much as here. The successor carries the live figures, so editing
     * the retired row would put two answers on one lane.
     */
    const oldId = await createRate();
    const newId = await createRate({ status: 'DRAFT' });
    await owner.freightRate.update({
      where: { id: BigInt(oldId) },
      data: { status: 'EXPIRED', supersededById: BigInt(newId) },
    });
    const response = await api
      .patch(`/api/tenant/purchase/rates/${oldId}`)
      .send(rateBody({ remarks: 'no' }));
    expect(response.status).toBe(409);
  });
});

describe('§4 rule 2 — the price list shows one rate per lane', () => {
  it('shows the edited rate once, not twice', async () => {
    /*
     * This is what the change is for. Editing used to leave the original on
     * the list as an expired row beside its replacement, so a price list grew
     * a duplicate every time somebody corrected a validity date.
     */
    const originalId = await createRate();
    const originalCode = (
      await owner.freightRate.findFirstOrThrow({ where: { id: BigInt(originalId) } })
    ).code;

    await api
      .patch(`/api/tenant/purchase/rates/${originalId}`)
      .send(rateBody({ validFrom: '2026-01-01', validTo: '2033-12-31' }))
      .expect(200);

    const list = await api.get('/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100');
    const codes: string[] = list.body.data.map((r: { code: string }) => r.code);
    expect(codes.filter((code) => code === originalCode)).toHaveLength(1);
  });

  it('still hides a rate expired the old way', async () => {
    // Rows versioned before the rule changed stay hidden, on the VPS as here.
    const rateId = await createRate();
    const code = (await owner.freightRate.findFirstOrThrow({ where: { id: BigInt(rateId) } })).code;
    await owner.freightRate.update({
      where: { id: BigInt(rateId) },
      data: { status: 'EXPIRED' },
    });

    const list = await api.get('/api/tenant/purchase/price-list?mode=SEA_FCL&limit=100');
    const codes: string[] = list.body.data.map((r: { code: string }) => r.code);
    expect(codes).not.toContain(code);
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
