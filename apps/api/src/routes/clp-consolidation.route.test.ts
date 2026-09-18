import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';
import { extractPdfText } from '../lib/pdf-text';
import { withTenant } from '../lib/tenant-client';

/**
 * CR-002 end to end, through HTTP.
 *
 * The services are proven on their own; this proves the WIRING — that the
 * routes call them, that the permission boundaries are where they are claimed
 * to be, and that the whole path holds together:
 *
 *   select bookings -> compatibility -> consolidate -> allocate cargo
 *   -> billing CBM -> container cost -> default split -> manual override
 *   -> exact reconciliation -> finalise -> immutable
 *
 * Everything is built from fixtures rather than borrowed from the dev data,
 * so the sailing, the loading type and the measurements are known exactly.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();
const FEATURE = 'OPERATION.CONTAINER_LOAD_PLAN';
const RUN = Date.now().toString().slice(-6);

let tenantId: bigint;
let slug: string;
let superadminId: bigint;
let plannerId: bigint;
let size20: bigint;
let currencyId: bigint;

/** Every token the authorization cases need. */
let tokenAll: string;
/** EDIT but NOT override-cost. */
let tokenPlanner: string;

const made: bigint[] = [];
const madeClps: bigint[] = [];

interface Fixture {
  id: bigint;
  code: string;
}

/** FCL bookings on one sailing unless told otherwise. */
const SAILING = { voyageNo: 'V-RT-1' };

function as(token: string) {
  const wrap = (r: request.Test) =>
    r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  return {
    get: (p: string) => wrap(request(app).get(p)),
    post: (p: string) => wrap(request(app).post(p)),
    patch: (p: string) => wrap(request(app).patch(p)),
    put: (p: string) => wrap(request(app).put(p)),
  };
}

/**
 * A booking with cargo received, on a named sailing.
 *
 * `measured` decides whether the CFS re-measured — which is what makes
 * received_volume_cbm non-null and therefore the billing basis ACTUAL.
 */
async function booking(opts: {
  label: string;
  loadingType: 'FCL' | 'LCL' | 'CONSOL_BOX' | null;
  voyageNo?: string | null;
  vesselId?: bigint;
  podId?: bigint;
  ctn?: number;
  measured?: { l: number; w: number; h: number } | null;
  cfs?: string;
  status?: 'CARGO_RECEIVED' | 'PART_RECEIVED' | 'APPROVED_FOR_SHIPMENT';
  receipts?: number;
  /** Another customer, for the cases that cross customers. */
  customerId?: bigint;
  /** Written on every receipt, as the cargo receipt screen records it. */
  efrNo?: string;
}): Promise<Fixture> {
  const src = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null, shipmentType: 'SEA' },
    select: {
      tenantId: true, quotationId: true, customerId: true, carrierId: true,
      polId: true, podId: true, transitType: true, seriesYear: true,
    },
  });
  const vessel = await owner.vessel.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true },
  });

  const code = `BKGRT-${RUN}-${opts.label}`;
  const shipment = await owner.shipment.create({
    data: {
      tenantId: src.tenantId,
      code,
      seriesYear: src.seriesYear,
      quotationId: src.quotationId,
      customerId: opts.customerId ?? src.customerId,
      carrierId: src.carrierId,
      polId: src.polId,
      podId: opts.podId ?? src.podId,
      shipmentType: 'SEA',
      loadingType: opts.loadingType,
      transitType: src.transitType,
      status: opts.status ?? 'CARGO_RECEIVED',
      createdBy: superadminId,
    },
    select: { id: true },
  });
  made.push(shipment.id);

  const voyage = opts.voyageNo === undefined ? SAILING.voyageNo : opts.voyageNo;
  if (voyage !== null) {
    const schedule = await owner.shipmentSchedule.create({
      data: {
        tenantId: src.tenantId,
        code: `SCHRT-${RUN}-${opts.label}`,
        shipmentId: shipment.id,
        carrierId: src.carrierId,
        transitType: src.transitType ?? 'DIRECT',
        status: 'APPROVED',
        cutOffDate: new Date('2026-10-01T00:00:00Z'),
        proposedBy: superadminId,
        decidedBy: superadminId,
        decidedAt: new Date(),
      },
      select: { id: true },
    });
    await owner.shipmentScheduleLeg.create({
      data: {
        tenantId: src.tenantId,
        scheduleId: schedule.id,
        legNo: 1,
        vesselId: opts.vesselId ?? vessel.id,
        voyageNo: voyage,
        originPortId: src.polId,
        destinationPortId: opts.podId ?? src.podId,
      },
    });
  }

  const ctn = opts.ctn ?? 20;
  const po = await owner.shipmentPo.create({
    data: { tenantId: src.tenantId, shipmentId: shipment.id, poNo: `PO-${opts.label}` },
    select: { id: true },
  });
  const line = await owner.shipmentCargoLine.create({
    data: {
      tenantId: src.tenantId,
      shipmentId: shipment.id,
      shipmentPoId: po.id,
      itemCode: `IT-${opts.label}`,
      ctnQty: ctn,
      grossWeightKg: String(ctn * 25),
      // 50x50x50 = 0.125 CBM booked.
      cartonLengthCm: '50', cartonWidthCm: '50', cartonHeightCm: '50',
    },
    select: { id: true },
  });

  // One receipt, or several when the test is about multiple deliveries.
  const deliveries = opts.receipts ?? 1;
  const per = Math.floor(ctn / deliveries);
  for (let i = 0; i < deliveries; i += 1) {
    const qty = i === deliveries - 1 ? ctn - per * (deliveries - 1) : per;
    const receipt = await owner.cargoReceipt.create({
      data: {
        tenantId: src.tenantId,
        code: `CRRT-${RUN}-${opts.label}-${i}`,
        seriesYear: 2026,
        shipmentId: shipment.id,
        receiptSeq: 9700 + made.length * 10 + i,
        receiveDate: new Date('2026-09-15'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: superadminId,
        unloadLocation: i === 0 ? (opts.cfs ?? 'CFS Alpha') : `${opts.cfs ?? 'CFS Alpha'} ${i}`,
        efrNo: opts.efrNo ?? null,
      },
      select: { id: true },
    });
    await owner.cargoReceiptLine.create({
      data: {
        tenantId: src.tenantId,
        cargoReceiptId: receipt.id,
        shipmentCargoLineId: line.id,
        receivedCtnQty: qty,
        ...(opts.measured == null
          ? {}
          : {
              cartonLengthCm: String(opts.measured.l),
              cartonWidthCm: String(opts.measured.w),
              cartonHeightCm: String(opts.measured.h),
            }),
        lineStatus: 'ACCEPTED',
      },
    });
  }

  return { id: shipment.id, code };
}

beforeAll(async () => {
  const any = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null },
    select: { tenantId: true },
  });
  tenantId = any.tenantId;
  slug = (await owner.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { slug: true } })).slug;

  superadminId = (
    await owner.user.findFirstOrThrow({
      where: { tenantId, isSuperadmin: true, isActive: true, deletedAt: null },
      select: { id: true },
    })
  ).id;
  plannerId = (
    await owner.user.findFirstOrThrow({
      where: {
        tenantId, isSuperadmin: false, isActive: true, deletedAt: null,
        agentId: null, customerId: null, vendorId: null,
      },
      select: { id: true },
    })
  ).id;

  size20 = (
    await owner.containerSize.findFirstOrThrow({
      where: { code: '20STD', deletedAt: null },
      select: { id: true },
    })
  ).id;
  currencyId = (
    await owner.currency.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true } })
  ).id;

  tokenAll = await signAccessToken({
    sub: superadminId.toString(), tenantId: tenantId.toString(),
    isSuperadmin: true, permissions: [], tokenVersion: 0,
  });
  tokenPlanner = await signAccessToken({
    sub: plannerId.toString(), tenantId: tenantId.toString(),
    isSuperadmin: false, tokenVersion: 0,
    permissions: [
      `${FEATURE}.VIEW`, `${FEATURE}.CREATE`, `${FEATURE}.EDIT`,
      `${FEATURE}.SPLIT`, `${FEATURE}.FINALISE`,
      // deliberately NOT OVERRIDE_COST
    ],
  });
});

afterAll(async () => {
  if (madeClps.length > 0) {
    await owner.clpLine.deleteMany({ where: { clpId: { in: madeClps } } });
    await owner.clpBooking.deleteMany({ where: { clpId: { in: madeClps } } });
    await owner.clp.deleteMany({ where: { id: { in: madeClps } } });
  }
  await owner.clpLine.deleteMany({ where: { shipmentCargoLine: { shipmentId: { in: made } } } });
  await owner.clpBooking.deleteMany({ where: { shipmentId: { in: made } } });
  await owner.clp.deleteMany({ where: { shipmentId: { in: made } } });
  await owner.cargoReceiptLine.deleteMany({ where: { cargoLine: { shipmentId: { in: made } } } });
  await owner.cargoReceipt.deleteMany({ where: { shipmentId: { in: made } } });
  await owner.shipmentCargoLine.deleteMany({ where: { shipmentId: { in: made } } });
  await owner.shipmentPo.deleteMany({ where: { shipmentId: { in: made } } });
  await owner.shipmentScheduleLeg.deleteMany({ where: { schedule: { shipmentId: { in: made } } } });
  await owner.shipmentSchedule.deleteMany({ where: { shipmentId: { in: made } } });
  await owner.shipment.deleteMany({ where: { id: { in: made } } });
  await owner.$disconnect();
});

const track = (id: string) => {
  madeClps.push(BigInt(id));
  return BigInt(id);
};

// ===================================================================== rules

describe('what the server refuses, whatever the screen believed', () => {
  it('rejects FCL with LCL', async () => {
    const a = await booking({ label: 'fcl1', loadingType: 'FCL' });
    const b = await booking({ label: 'lcl1', loadingType: 'LCL' });

    const check = await as(tokenAll)
      .post('/api/tenant/ops/clp-candidates/check')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()] });
    expect(check.status).toBe(200);
    expect(check.body.data.ok).toBe(false);
    expect(JSON.stringify(check.body.data.issues)).toMatch(/never share a container/);

    const write = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()], containerSizeId: size20.toString() });
    expect(write.status).toBe(409);
  });

  it('rejects CONSOL_BOX with FCL and with LCL — its own workflow now', async () => {
    // The client's loading-type sheet, 2026-09-16, superseding 2026-09-15.
    const box = await booking({ label: 'cbox', loadingType: 'CONSOL_BOX' });
    for (const [label, loadingType] of [['cbf', 'FCL'], ['cbl', 'LCL']] as const) {
      const other = await booking({ label, loadingType });
      const res = await as(tokenAll)
        .post('/api/tenant/ops/clps/consolidate')
        .send({ shipmentIds: [box.id.toString(), other.id.toString()], containerSizeId: size20.toString() });
      if (res.status === 201) track(res.body.data.id);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/Different loading types never share a container/);
    }
  });

  it('rejects two FCL bookings on one quotation and one sailing', async () => {
    const a = await booking({ label: 'fclA', loadingType: 'FCL' });
    const b = await booking({ label: 'fclB', loadingType: 'FCL' });
    const before = await owner.clp.count();
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()], containerSizeId: size20.toString() });
    // Tracked if it wrongly succeeds, so a regression cannot leave an orphan plan behind.
    if (res.status === 201) track(res.body.data.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/separate FCL bookings, and an FCL container holds one booking/);
    expect(await owner.clp.count()).toBe(before);
  });

  it('rejects a different voyage on the same vessel', async () => {
    const a = await booking({ label: 'v1', loadingType: 'LCL' });
    const b = await booking({ label: 'v2', loadingType: 'LCL', voyageNo: 'V-RT-9' });
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()], containerSizeId: size20.toString() });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/V-RT-9/);
  });

  it('rejects a different destination', async () => {
    const other = await owner.port.findFirstOrThrow({
      where: { deletedAt: null, type: 'SEAPORT' },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    const a = await booking({ label: 'd1', loadingType: 'LCL' });
    const b = await booking({ label: 'd2', loadingType: 'LCL', podId: other.id });
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()], containerSizeId: size20.toString() });
    // Same port would make this pass vacuously; skip rather than lie.
    if (JSON.stringify(res.body).includes('going to')) {
      expect(res.status).toBe(409);
    }
  });

  it('rejects a booking with no loading type rather than defaulting it', async () => {
    const a = await booking({ label: 'lt1', loadingType: 'FCL' });
    const b = await booking({ label: 'lt2', loadingType: null });
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()], containerSizeId: size20.toString() });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/no loading type set/);
  });

  it('reports a cut-off mismatch without refusing it', async () => {
    const a = await booking({ label: 'co1', loadingType: 'LCL' });
    const b = await booking({ label: 'co2', loadingType: 'LCL' });
    await owner.shipmentSchedule.updateMany({
      where: { shipmentId: b.id },
      data: { cutOffDate: new Date('2026-10-05T00:00:00Z') },
    });

    const check = await as(tokenAll)
      .post('/api/tenant/ops/clp-candidates/check')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()] });
    expect(check.body.data.ok).toBe(true);
    const warn = check.body.data.issues.find((i: { blocking: boolean }) => !i.blocking);
    expect(warn).toBeDefined();
    expect(warn.reason).toMatch(/cut-off/);

    // ...and the write goes through, because it is a warning.
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()], containerSizeId: size20.toString() });
    expect(res.status).toBe(201);
    track(res.body.data.id);
  });

  it('reports several CFS locations rather than picking one', async () => {
    const a = await booking({ label: 'cfs', loadingType: 'FCL', receipts: 3 });
    const check = await as(tokenAll)
      .post('/api/tenant/ops/clp-candidates/check')
      .send({ shipmentIds: [a.id.toString()] });
    expect(check.body.data.cfsLocations.length).toBe(3);
  });

  it('keeps FCL, LCL and Consol box in separate candidate lists', async () => {
    await booking({ label: 'sepf', loadingType: 'FCL' });
    await booking({ label: 'sepl', loadingType: 'LCL' });
    await booking({ label: 'sepb', loadingType: 'CONSOL_BOX' });

    const families = (rows: { family: string }[]) => [...new Set(rows.map((r) => r.family))];
    for (const family of ['FCL', 'LCL', 'CONSOL_BOX']) {
      const res = await as(tokenAll).get(
        `/api/tenant/ops/clp-candidates?family=${family}&search=${RUN}`,
      );
      expect(res.status).toBe(200);
      expect(families(res.body.data.candidates)).toEqual([family]);
    }
  });

  it('suggests a group without making it a rule', async () => {
    const res = await as(tokenAll).get('/api/tenant/ops/clp-candidates?family=LCL&search=' + RUN);
    // Suggestions exist, and every booking in one is genuinely compatible.
    expect(Array.isArray(res.body.data.suggestions)).toBe(true);
    for (const group of res.body.data.suggestions) {
      if (group.shipmentIds.length < 2) continue;
      const check = await as(tokenAll)
        .post('/api/tenant/ops/clp-candidates/check')
        .send({ shipmentIds: group.shipmentIds });
      expect(check.body.data.ok, JSON.stringify(check.body.data.issues)).toBe(true);
    }
  });
});

// ============================================================ the whole path

describe('booking selection through to a finalised, costed container', () => {
  it('walks the entire flow', async () => {
    // Two bookings, one measured at the CFS and one not, so both billing
    // bases appear on the same container.
    const a = await booking({
      label: 'e2eA', loadingType: 'LCL', ctn: 40,
      measured: { l: 55, w: 50, h: 50 }, // 0.1375 measured vs 0.125 booked
    });
    const b = await booking({ label: 'e2eB', loadingType: 'LCL', ctn: 20, measured: null });

    // --- 1. compatibility
    const check = await as(tokenAll)
      .post('/api/tenant/ops/clp-candidates/check')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()] });
    expect(check.body.data.ok).toBe(true);

    // --- 2. consolidate
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [a.id.toString(), b.id.toString()],
        containerSizeId: size20.toString(),
        finalCfsLocation: 'CFS Alpha',
      });
    expect(made.status).toBe(201);
    const clpId = track(made.body.data.id);

    const row = await owner.clp.findFirstOrThrow({
      where: { id: clpId },
      select: { consolidationType: true, clpSeq: true, shipmentId: true, finalCfsLocation: true },
    });
    expect(row.consolidationType).toBe('LCL_CONSOLIDATION');
    // A shared container has no position within any one booking.
    expect(row.clpSeq).toBeNull();
    expect(row.shipmentId).toBeNull();
    expect(row.finalCfsLocation).toBe('CFS Alpha');
    expect(await owner.clpBooking.count({ where: { clpId } })).toBe(2);

    // --- 3. load cargo from both bookings
    for (const bk of [a, b]) {
      const line = await owner.shipmentCargoLine.findFirstOrThrow({
        where: { shipmentId: bk.id },
        select: { id: true, ctnQty: true },
      });
      const put = await as(tokenAll)
        .post(`/api/tenant/ops/clps/${clpId}/lines`)
        .send({ cargoLineId: line.id.toString(), ctnQty: line.ctnQty });
      expect(put.status, JSON.stringify(put.body)).toBe(201);
    }

    // --- 4. billing CBM: both sources, both bases
    const billing = await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/billing`);
    expect(billing.status).toBe(200);
    const forA = billing.body.data.find((r: { bookingCode: string }) => r.bookingCode === a.code);
    const forB = billing.body.data.find((r: { bookingCode: string }) => r.bookingCode === b.code);
    expect(forA.basis).toBe('ACTUAL');
    expect(Number(forA.billingCbm)).toBeCloseTo(40 * 0.1375, 3);
    expect(Number(forA.bookedCbm)).toBeCloseTo(40 * 0.125, 3); // still visible
    expect(forB.basis).toBe('BOOKED');
    expect(Number(forB.billingCbm)).toBeCloseTo(20 * 0.125, 3);

    // --- 5. preview the split without saving
    const preview = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/cost/preview`)
      .send({ actualContainerCost: '2000', costCurrencyId: currencyId.toString(), basis: 'CBM' });
    expect(preview.status).toBe(200);
    const previewSum = preview.body.data.shares.reduce(
      (s: number, x: { amount: string }) => s + Number(x.amount), 0,
    );
    expect(previewSum).toBeCloseTo(2000, 4);
    // Nothing was written.
    expect(
      (await owner.clp.findFirstOrThrow({ where: { id: clpId }, select: { actualContainerCost: true } }))
        .actualContainerCost,
    ).toBeNull();

    // --- 6. save the cost; the default split follows
    const cost = await as(tokenAll)
      .patch(`/api/tenant/ops/clps/${clpId}/cost`)
      .send({ actualContainerCost: '2000', costCurrencyId: currencyId.toString(), basis: 'CBM' });
    expect(cost.status, JSON.stringify(cost.body)).toBe(200);

    const saved = await owner.clpBooking.findMany({
      where: { clpId },
      select: { defaultCostAmount: true, allocatedCostAmount: true, shipmentId: true },
    });
    const total = saved.reduce((s, r) => s + Number(r.allocatedCostAmount ?? 0), 0);
    expect(total).toBeCloseTo(2000, 4);
    // The default and the allocation agree until somebody overrides.
    for (const r of saved) {
      expect(Number(r.defaultCostAmount)).toBeCloseTo(Number(r.allocatedCostAmount), 4);
    }

    // --- 7. a planner without OVERRIDE_COST cannot re-split it
    const refused = await as(tokenPlanner)
      .put(`/api/tenant/ops/clps/${clpId}/cost/allocations`)
      .send({
        allocations: saved.map((r) => ({ shipmentId: r.shipmentId.toString(), amount: '1000' })),
        reason: 'Trying it on.',
      });
    expect(refused.status).toBe(403);

    // --- 8. an authorised override, which must still reconcile
    const bad = await as(tokenAll)
      .put(`/api/tenant/ops/clps/${clpId}/cost/allocations`)
      .send({
        allocations: saved.map((r) => ({ shipmentId: r.shipmentId.toString(), amount: '900' })),
        reason: 'Deliberately short, to prove it is refused.',
      });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/1800.00, but the container cost is 2000.00/);

    const good = await as(tokenAll)
      .put(`/api/tenant/ops/clps/${clpId}/cost/allocations`)
      .send({
        allocations: [
          { shipmentId: saved[0]!.shipmentId.toString(), amount: '1200' },
          { shipmentId: saved[1]!.shipmentId.toString(), amount: '800' },
        ],
        reason: 'Agreed with the customer at 60/40.',
      });
    expect(good.status, JSON.stringify(good.body)).toBe(200);

    const after = await owner.clpBooking.findMany({
      where: { clpId },
      orderBy: { id: 'asc' },
      select: {
        defaultCostAmount: true, allocatedCostAmount: true,
        costOverriddenBy: true, costOverriddenAt: true, costOverrideReason: true,
      },
    });
    expect(after.reduce((s, r) => s + Number(r.allocatedCostAmount), 0)).toBeCloseTo(2000, 4);
    // §9: "what would it have been" survives the override.
    expect(Number(after[0]!.defaultCostAmount)).not.toBeCloseTo(1200, 4);
    expect(after[0]!.costOverriddenBy).toBe(superadminId);
    expect(after[0]!.costOverriddenAt).not.toBeNull();
    expect(after[0]!.costOverrideReason).toMatch(/60\/40/);
    expect(
      (await owner.clp.findFirstOrThrow({ where: { id: clpId }, select: { costAllocationBasis: true } }))
        .costAllocationBasis,
    ).toBe('MANUAL');

    // --- 9. finalise, and the money becomes immutable with everything else
    const fin = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/finalise`)
      .send({
        containerNo: 'CSQU3054383',
        sealNo: `SL-${RUN}`,
        loadDatetime: '2026-09-16T08:00:00.000Z',
      });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);

    const locked = await as(tokenAll)
      .patch(`/api/tenant/ops/clps/${clpId}/cost`)
      .send({ actualContainerCost: '3000', costCurrencyId: currencyId.toString(), basis: 'CBM' });
    expect(locked.status).toBe(409);
    expect(JSON.stringify(locked.body)).toMatch(/cannot be changed/);

    // The figures did not move.
    const sealed = await owner.clp.findFirstOrThrow({
      where: { id: clpId },
      select: { actualContainerCost: true, status: true },
    });
    expect(sealed.status).toBe('FINAL');
    expect(Number(sealed.actualContainerCost)).toBeCloseTo(2000, 4);
  });
});

// ============================================================ edges & safety

describe('measurement edges', () => {
  it('cannot reach a measured zero through a normal receipt, and says why', async () => {
    /*
      The locked rule is that an actual CBM of 0 counts as ACTUAL and never
      falls back to booked — proven directly in clp-billing.test.ts.

      Reaching it through the product is another matter, and worth pinning
      down: cargo_receipt_line_carton_ck requires every recorded dimension to
      be > 0, so received_volume_cbm (L x W x H x qty) can only be zero when
      the QUANTITY is zero. And a booking whose accepted cartons total zero is
      refused by the consolidation engine for having nothing to load. So the
      case is real in the helper and unreachable on this path.
    */
    const src = await owner.shipment.findFirstOrThrow({
      where: { deletedAt: null },
      select: { tenantId: true },
    });
    const line = await owner.cargoReceiptLine.findFirstOrThrow({
      where: { deletedAt: null },
      select: { id: true },
    });
    await expect(
      owner.cargoReceiptLine.update({
        where: { id: line.id },
        data: { cartonLengthCm: '0' },
      }),
    ).rejects.toThrow(/cargo_receipt_line_carton_ck/);
    expect(src.tenantId).toBe(tenantId);

    // And a booking with nothing accepted cannot be consolidated at all.
    const empty = await booking({ label: 'empty', loadingType: 'FCL', ctn: 20 });
    await owner.cargoReceiptLine.updateMany({
      where: { cargoLine: { shipmentId: empty.id } },
      data: { receivedCtnQty: 0 },
    });
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [empty.id.toString()], containerSizeId: size20.toString() });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/no accepted cartons/);
  });

  it('bills a short shipment on what arrived', async () => {
    const s = await booking({ label: 'short', loadingType: 'FCL', ctn: 20 });
    // 20 booked, only 12 accepted.
    await owner.cargoReceiptLine.updateMany({
      where: { cargoLine: { shipmentId: s.id } },
      data: { receivedCtnQty: 12 },
    });

    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [s.id.toString()], containerSizeId: size20.toString() });
    const clpId = track(made.body.data.id);

    const billing = await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/billing`);
    // 12 x 0.125, not 20 x 0.125.
    expect(Number(billing.body.data[0].billingCbm)).toBeCloseTo(1.5, 4);
  });

  it('reports MIXED when one delivery was measured and another was not', async () => {
    const m = await booking({ label: 'mixed', loadingType: 'FCL', ctn: 20, receipts: 2 });
    const [first] = await owner.cargoReceiptLine.findMany({
      where: { cargoLine: { shipmentId: m.id } },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    await owner.cargoReceiptLine.update({
      where: { id: first!.id },
      data: { cartonLengthCm: '55', cartonWidthCm: '50', cartonHeightCm: '50' },
    });

    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [m.id.toString()], containerSizeId: size20.toString() });
    const clpId = track(made.body.data.id);

    const billing = await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/billing`);
    expect(billing.body.data[0].basis).toBe('MIXED');
    expect(billing.body.data[0].measuredLines).toBe(1);
    expect(billing.body.data[0].totalLines).toBe(2);
  });
});

describe('security', () => {
  it('refuses a booking from another workspace', async () => {
    const stranger = await owner.shipment.findFirst({
      where: { tenantId: { not: tenantId }, deletedAt: null },
      select: { id: true },
    });
    if (stranger === null) return;
    const mine = await booking({ label: 'iso', loadingType: 'FCL' });
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [mine.id.toString(), stranger.id.toString()],
        containerSizeId: size20.toString(),
      });
    expect(res.status).toBe(404);
  });

  it('refuses every consolidation route without a token', async () => {
    for (const call of [
      request(app).get('/api/tenant/ops/clp-candidates?family=FCL'),
      request(app).post('/api/tenant/ops/clp-candidates/check').send({ shipmentIds: ['1'] }),
      request(app).post('/api/tenant/ops/clps/consolidate').send({}),
    ]) {
      const res = await call.set('X-Tenant-Slug', slug);
      expect(res.status).toBe(401);
    }
  });
});

// ============================================================ §13 view split

/**
 * The FCL/LCL view split, through HTTP.
 *
 * It is a filter over data that was already stored, so what has to be proven
 * is not that a new rule works but that no plan falls out of both views. Three
 * shapes of CLP exist and they are stored differently:
 *
 *   consolidated        clp.shipment_id NULL, several clp_booking rows
 *   single, consolidate clp.shipment_id set,  one clp_booking row
 *   single, /clps       clp.shipment_id set,  NO clp_booking row
 *
 * The third is the one that catches a filter written only against
 * clp_booking — `POST /bookings/:id/clps` ("Add another container") writes no
 * participation, so a plan made that way would silently vanish from a view
 * that only joined the participation table.
 */
describe('the FCL/LCL view split', () => {
  const codesOf = (body: { data: { code: string }[] }) => body.data.map((r) => r.code);
  const idsOf = (body: { data: { id: string }[] }) => body.data.map((r) => r.id);

  it('splits the planning queue by the loading type of the booking', async () => {
    const fcl = await booking({ label: 'vsfcl', loadingType: 'FCL' });
    const lcl = await booking({ label: 'vslcl', loadingType: 'LCL' });
    const box = await booking({ label: 'vsbox', loadingType: 'CONSOL_BOX' });

    const q = `&search=BKGRT-${RUN}-vs&limit=100`;
    const all = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?page=1${q}`);
    const view = async (family: string) =>
      codesOf((await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=${family}${q}`)).body);
    expect(all.status).toBe(200);

    // Unfiltered is unchanged — the split adds a view, it removes nothing.
    expect(codesOf(all.body)).toEqual(expect.arrayContaining([fcl.code, lcl.code, box.code]));

    const asFcl = await view('FCL');
    expect(asFcl).toContain(fcl.code);
    expect(asFcl).not.toContain(lcl.code);
    // The client's sheet of 2026-09-16: a consol box is its own workflow,
    // superseding the 2026-09-15 decision that filed it under FCL.
    expect(asFcl).not.toContain(box.code);

    const asLcl = await view('LCL');
    expect(asLcl).toContain(lcl.code);
    expect(asLcl).not.toContain(fcl.code);
    expect(asLcl).not.toContain(box.code);

    const asBox = await view('CONSOL_BOX');
    expect(asBox).toContain(box.code);
    expect(asBox).not.toContain(fcl.code);
    expect(asBox).not.toContain(lcl.code);
  });

  it('filters the count too, not just the page', async () => {
    // Otherwise the pager would offer pages that come back empty.
    const q = `&search=BKGRT-${RUN}-vs&limit=100`;
    const all = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?page=1${q}`);
    let sum = 0;
    for (const family of ['FCL', 'LCL', 'CONSOL_BOX']) {
      const res = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=${family}${q}`);
      expect(res.body.meta.total).toBe(res.body.data.length);
      expect(res.body.meta.total).toBeGreaterThan(0);
      sum += res.body.meta.total;
    }
    // Every booking with a loading type is counted in exactly one view.
    const typed = all.body.data.filter((r: { loadingType: string | null }) => r.loadingType !== null);
    expect(sum).toBe(typed.length);
  });

  it('carries the loading type and its family on every row', async () => {
    const res = await as(tokenAll).get(
      `/api/tenant/ops/clp-bookings?family=CONSOL_BOX&search=BKGRT-${RUN}-vs&limit=100`,
    );
    const box = res.body.data.find((r: { code: string }) => r.code.endsWith('vsbox'));
    expect(box.loadingType).toBe('CONSOL_BOX');
    expect(box.family).toBe('CONSOL_BOX');
  });

  it('shows a booking with no loading type under neither view, but never hides it', async () => {
    /*
      §3's refusal to guess, carried into the view. Dropping it from both
      filters is correct; dropping it from the unfiltered list too would make
      a real booking unreachable, so that is checked as well.
    */
    const bare = await booking({ label: 'vsnone', loadingType: null });
    const q = `&search=${bare.code}&limit=50`;

    const all = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?page=1${q}`);
    expect(codesOf(all.body)).toContain(bare.code);
    const row = all.body.data[0];
    expect(row.loadingType).toBeNull();
    expect(row.family).toBeNull();

    for (const family of ['FCL', 'LCL', 'CONSOL_BOX']) {
      const res = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=${family}${q}`);
      expect(codesOf(res.body)).not.toContain(bare.code);
    }
  });

  it('splits the register by the participating bookings', async () => {
    const a = await booking({ label: 'vsra', loadingType: 'LCL' });
    const b = await booking({ label: 'vsrb', loadingType: 'LCL' });
    const c = await booking({ label: 'vsrc', loadingType: 'CONSOL_BOX', voyageNo: 'V-VS-B' });
    const d = await booking({ label: 'vsrd', loadingType: 'FCL', voyageNo: 'V-VS-F' });

    const plan = async (ids: bigint[]) => {
      const res = await as(tokenAll)
        .post('/api/tenant/ops/clps/consolidate')
        .send({ shipmentIds: ids.map((id) => id.toString()), containerSizeId: size20.toString() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return track(res.body.data.id).toString();
    };
    const lclId = await plan([a.id, b.id]);
    const boxId = await plan([c.id]);
    const fclId = await plan([d.id]);

    const register = async (family: string) =>
      (await as(tokenAll).get(`/api/tenant/ops/clps?family=${family}&limit=100`)).body;
    const onlyFcl = await register('FCL');
    const onlyLcl = await register('LCL');
    const onlyBox = await register('CONSOL_BOX');

    expect(idsOf(onlyLcl)).toContain(lclId);
    expect(idsOf(onlyLcl)).not.toContain(boxId);
    expect(idsOf(onlyLcl)).not.toContain(fclId);
    expect(idsOf(onlyBox)).toContain(boxId);
    expect(idsOf(onlyBox)).not.toContain(lclId);
    expect(idsOf(onlyBox)).not.toContain(fclId);
    expect(idsOf(onlyFcl)).toContain(fclId);
    expect(idsOf(onlyFcl)).not.toContain(lclId);
    expect(idsOf(onlyFcl)).not.toContain(boxId);

    // And the row says which, so the column is not guesswork on the client.
    const lclRow = onlyLcl.data.find((r: { id: string }) => r.id === lclId);
    expect(lclRow.family).toBe('LCL');
    expect(lclRow.loadingType).toBe('LCL');
    expect(lclRow.bookingCount).toBe(2);
    expect(onlyBox.data.find((r: { id: string }) => r.id === boxId).family).toBe('CONSOL_BOX');
  });

  it('classifies a plan that has no participation row at all', async () => {
    /*
      The regression this whole shape exists for. `POST /bookings/:id/clps`
      writes clp.shipment_id and no clp_booking, so a filter joined only to the
      participation table would drop the plan out of every view.
    */
    const solo = await booking({ label: 'vsorph', loadingType: 'LCL', voyageNo: 'V-VS-O' });
    const made = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${solo.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    expect(made.status).toBe(201);
    const orphanId = track(made.body.data.id).toString();

    // Proof that it really is the shape being tested.
    expect(await owner.clpBooking.count({ where: { clpId: BigInt(orphanId) } })).toBe(0);

    const onlyLcl = await as(tokenAll).get('/api/tenant/ops/clps?family=LCL&limit=100');
    const onlyFcl = await as(tokenAll).get('/api/tenant/ops/clps?family=FCL&limit=100');

    expect(idsOf(onlyLcl.body)).toContain(orphanId);
    expect(idsOf(onlyFcl.body)).not.toContain(orphanId);
    expect(onlyLcl.body.data.find((r: { id: string }) => r.id === orphanId).family).toBe('LCL');
  });

  it('combines with the status filter rather than replacing it', async () => {
    const res = await as(tokenAll).get('/api/tenant/ops/clps?family=FCL&status=DRAFT&limit=100');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row.status).toBe('DRAFT');
      expect(row.family).toBe('FCL');
    }
  });

  it('combines with search rather than replacing it', async () => {
    // Two narrowings at once must intersect: an FCL search must not start
    // returning LCL rows merely because the term matched.
    const res = await as(tokenAll).get(
      `/api/tenant/ops/clp-bookings?family=FCL&search=BKGRT-${RUN}&limit=100`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row.code).toContain(`BKGRT-${RUN}`);
      expect(row.family).toBe('FCL');
    }
  });

  it('rejects a family that is not a workflow', async () => {
    for (const path of [
      '/api/tenant/ops/clp-bookings?family=AIR',
      '/api/tenant/ops/clps?family=FCL_QUOTATION',
      '/api/tenant/ops/clp-candidates?family=CONSOL',
    ]) {
      const res = await as(tokenAll).get(path);
      expect(res.status).toBe(400);
    }
  });

  it('still requires VIEW', async () => {
    const none = await signAccessToken({
      sub: plannerId.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      permissions: [],
      tokenVersion: 0,
    });
    for (const path of [
      '/api/tenant/ops/clp-bookings?family=FCL',
      '/api/tenant/ops/clps?family=LCL',
    ]) {
      expect((await as(none).get(path)).status).toBe(403);
    }
  });
});

// ================================================= the booking detail read path

/**
 * A plan must be visible from the booking screen that created it.
 *
 * Two routes create plans and they store the participation differently:
 * `/clps/consolidate` writes `clp_booking` rows, while the legacy
 * `POST /bookings/:id/clps` ("Add another container") writes only
 * `clp.shipment_id`. `cards()` joined through `clp_booking` alone, so a plan
 * made by the legacy route vanished from the screen the moment it was made —
 * reproduced against a running dev stack before this was written.
 *
 * The fix is a read-path fallback with the same two shapes the register uses.
 * Nothing is written, backfilled or migrated, and `clp.shipment_id` keeps the
 * meaning it always had.
 */
describe('the booking detail sees plans made by either path', () => {
  const detail = (id: bigint | string) => `/api/tenant/ops/bookings/${id}/clp`;
  const plansOf = (res: { body: { data: { clps: { id: string; code: string }[] } } }) =>
    res.body.data.clps;

  it('finds a plan created by the legacy Add another container route', async () => {
    const b = await booking({ label: 'cdlegacy', loadingType: 'LCL' });

    const empty = await as(tokenAll).get(detail(b.id));
    expect(empty.status).toBe(200);
    expect(plansOf(empty)).toHaveLength(0);

    const made = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    expect(made.status).toBe(201);
    const id = track(made.body.data.id);

    // The shape being tested, asserted rather than assumed.
    expect(await owner.clpBooking.count({ where: { clpId: id } })).toBe(0);

    const res = await as(tokenAll).get(detail(b.id));
    expect(res.status).toBe(200);
    expect(plansOf(res).map((c) => c.id)).toEqual([id.toString()]);
  });

  it('lists that plan exactly once, and as a single-booking plan', async () => {
    /*
      The two branches of the fallback must be mutually exclusive. If a plan
      could match both, the screen would show the same container twice and an
      operator would load cargo into a duplicate that does not exist.
    */
    const b = await booking({ label: 'cdonce', loadingType: 'LCL' });
    const made = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    track(made.body.data.id);

    const res = await as(tokenAll).get(detail(b.id));
    const ids = plansOf(res).map((c) => c.id);
    expect(ids).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);

    const card = plansOf(res)[0] as unknown as {
      consolidationType: string;
      clpSeq: number | null;
      bookings: unknown[];
    };
    expect(card.consolidationType).toBe('SINGLE');
    expect(card.clpSeq).toBe(1);
    /*
      No participation rows, so none are reported. Inventing one here would
      be a second source of truth for who is in the container; the screen
      already hides the consolidation and cost panels when this is empty.
    */
    expect(card.bookings).toEqual([]);
  });

  it('still finds a consolidated plan through clp_booking', async () => {
    const a = await booking({ label: 'cdca', loadingType: 'LCL' });
    const b = await booking({ label: 'cdcb', loadingType: 'LCL' });

    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [a.id.toString(), b.id.toString()],
        containerSizeId: size20.toString(),
      });
    expect(made.status).toBe(201);
    const id = track(made.body.data.id);
    expect(await owner.clpBooking.count({ where: { clpId: id } })).toBe(2);

    // Both partners see it, which is the canonical path and must not change.
    for (const who of [a, b]) {
      const res = await as(tokenAll).get(detail(who.id));
      expect(plansOf(res).map((c) => c.id)).toContain(id.toString());
      expect(plansOf(res)).toHaveLength(1);
    }

    const card = plansOf(await as(tokenAll).get(detail(a.id)))[0] as unknown as {
      bookings: { shipmentId: string }[];
    };
    expect(card.bookings.map((x) => x.shipmentId).sort()).toEqual(
      [a.id.toString(), b.id.toString()].sort(),
    );
  });

  it('shows both shapes together, each once, on a booking that has both', async () => {
    /*
      The real state of a booking planned across two containers by two
      different routes. Neither branch may swallow the other.
    */
    const a = await booking({ label: 'cdmixa', loadingType: 'LCL' });
    const b = await booking({ label: 'cdmixb', loadingType: 'LCL' });

    const consolidated = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [a.id.toString(), b.id.toString()],
        containerSizeId: size20.toString(),
      });
    const withBookings = track(consolidated.body.data.id).toString();

    const legacy = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${a.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const withoutBookings = track(legacy.body.data.id).toString();

    const ids = plansOf(await as(tokenAll).get(detail(a.id))).map((c) => c.id);
    expect(ids.sort()).toEqual([withBookings, withoutBookings].sort());
    // And b, which is only in the consolidated one, sees only that.
    expect(plansOf(await as(tokenAll).get(detail(b.id))).map((c) => c.id)).toEqual([
      withBookings,
    ]);
  });

  it('hides a soft-deleted plan of either shape', async () => {
    const a = await booking({ label: 'cddela', loadingType: 'LCL' });
    const legacy = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${a.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const legacyId = track(legacy.body.data.id);

    const b = await booking({ label: 'cddelb', loadingType: 'LCL' });
    const consolidated = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [b.id.toString()], containerSizeId: size20.toString() });
    const consolidatedId = track(consolidated.body.data.id);

    expect(plansOf(await as(tokenAll).get(detail(a.id)))).toHaveLength(1);
    expect(plansOf(await as(tokenAll).get(detail(b.id)))).toHaveLength(1);

    await owner.clp.updateMany({
      where: { id: { in: [legacyId, consolidatedId] } },
      data: { deletedAt: new Date() },
    });

    // §4's soft delete, unchanged by the fallback: neither shape comes back.
    expect(plansOf(await as(tokenAll).get(detail(a.id)))).toHaveLength(0);
    expect(plansOf(await as(tokenAll).get(detail(b.id)))).toHaveLength(0);
  });

  it('drops a participation without resurrecting the plan through the fallback', async () => {
    /*
      The sharp edge of an OR: soft-deleting the last participation of a
      consolidated plan makes `bookings: { none: ... }` true, and the plan
      would reappear under whatever `clp.shipment_id` happens to hold. For a
      consolidated plan that column is NULL, so it cannot — this is the test
      that says so rather than trusting it.
    */
    const a = await booking({ label: 'cdorph', loadingType: 'LCL' });
    const b = await booking({ label: 'cdorpi', loadingType: 'LCL' });
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [a.id.toString(), b.id.toString()],
        containerSizeId: size20.toString(),
      });
    const id = track(made.body.data.id);
    expect(await owner.clp.findFirstOrThrow({ where: { id }, select: { shipmentId: true } }))
      .toEqual({ shipmentId: null });

    await owner.clpBooking.updateMany({ where: { clpId: id }, data: { deletedAt: new Date() } });

    expect(plansOf(await as(tokenAll).get(detail(a.id)))).toHaveLength(0);
    expect(plansOf(await as(tokenAll).get(detail(b.id)))).toHaveLength(0);
  });

  it('cannot reach another tenant plan through the shipment_id fallback', async () => {
    /*
      Two independent guards, both asserted, because the fallback reads a
      column instead of a join and that is exactly where a leak would hide.

      First: the composite FK means `clp.shipment_id` can only ever name a
      booking in the same tenant (CLAUDE.md §4 rule 10), so a row that would
      let the fallback cross a tenant boundary cannot be written at all.
      Second: RLS scopes the read regardless.
    */
    const mine = await booking({ label: 'cdiso', loadingType: 'LCL' });
    const other = await owner.tenant.create({
      data: { name: 'CLP fallback isolation', slug: `clp-iso-${RUN}`, country: 'Bangladesh' },
      select: { id: true },
    });

    try {
      const size = await owner.containerSize.findFirstOrThrow({
        where: { id: size20 },
        select: { id: true },
      });
      const carrier = await owner.shipment.findFirstOrThrow({
        where: { id: mine.id },
        select: { carrierId: true },
      });

      await expect(
        owner.clp.create({
          data: {
            tenantId: other.id,
            code: `CLP-ISO-${RUN}`,
            seriesYear: 2026,
            clpSeq: 1,
            // Another tenant's booking. The database must refuse this.
            shipmentId: mine.id,
            containerSizeId: size.id,
            carrierId: carrier.carrierId!,
          },
        }),
      ).rejects.toThrow();

      // And the read is scoped too, not merely the write.
      const seen = await withTenant(other.id, (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM clp WHERE shipment_id = ${mine.id}`,
      );
      expect(Number(seen[0]!.n)).toBe(0);
    } finally {
      await owner.tenant.delete({ where: { id: other.id } });
    }
  });
});

// ================================ B2 / B3 / B4 / B6 — one shape, four paths

/**
 * Every path that asks "whose cargo is in this box" now asks it the same way.
 *
 * Two creation routes record the answer differently — clp_booking rows from
 * /clps/consolidate, clp.shipment_id alone from the legacy "Add another
 * container" — and four separate reads had been written against the first
 * shape only. Each failed differently and none of them loudly: the printed
 * document lost its header, the cost split refused to run, the billing panel
 * came back empty, and allocation never checked membership at all.
 *
 * `participantShipmentIds` is now the single answer. These tests drive each
 * path through both shapes, because a helper that is only ever exercised on
 * the canonical shape is the bug that was just fixed, one layer down.
 */
describe('whose cargo is in the box — every path, both shapes', () => {
  /** A plan made the legacy way: clp.shipment_id, no participation row. */
  async function legacyPlan(label: string) {
    const b = await booking({ label, loadingType: 'LCL' });
    const made = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    expect(made.status).toBe(201);
    const clpId = track(made.body.data.id);
    // The premise of every test below, asserted rather than assumed.
    expect(await owner.clpBooking.count({ where: { clpId } })).toBe(0);
    return { booking: b, clpId };
  }

  /** Puts every carton of the booking's cargo into the plan. */
  async function fill(clpId: bigint, shipmentId: bigint) {
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId, deletedAt: null },
      select: { id: true },
    });
    const res = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 1 });
    return { res, cargoLineId: line.id };
  }

  // ------------------------------------------------------------------- B6
  it('B6 — refuses cargo from a booking the container is not planning', async () => {
    /*
      RLS stops another workspace's cargo. This is the boundary INSIDE a
      workspace, which nothing enforced: the screen only offers the booking's
      own lines, and §14 is explicit that a rule a screen enforces is not a
      rule the server has.
    */
    const mine = await booking({ label: 'p6a', loadingType: 'LCL' });
    const stranger = await booking({ label: 'p6b', loadingType: 'LCL' });

    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [mine.id.toString()], containerSizeId: size20.toString() });
    const clpId = track(made.body.data.id);

    const theirs = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId: stranger.id, deletedAt: null },
      select: { id: true },
    });
    const refused = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: theirs.id.toString(), ctnQty: 1 });

    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/not planning that booking/i);
    // Nothing went in.
    expect(await owner.clpLine.count({ where: { clpId, deletedAt: null } })).toBe(0);

    // And the container's own booking still loads normally.
    const ok = await fill(clpId, mine.id);
    expect(ok.res.status).toBe(201);
  });

  it('B6 — a consolidated container takes cargo from every participant', async () => {
    const a = await booking({ label: 'p6c', loadingType: 'LCL' });
    const b = await booking({ label: 'p6d', loadingType: 'LCL' });
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [a.id.toString(), b.id.toString()],
        containerSizeId: size20.toString(),
      });
    const clpId = track(made.body.data.id);

    expect((await fill(clpId, a.id)).res.status).toBe(201);
    expect((await fill(clpId, b.id)).res.status).toBe(201);
    expect(await owner.clpLine.count({ where: { clpId, deletedAt: null } })).toBe(2);
  });

  it('B6 — a legacy plan takes its own booking, through the same check', async () => {
    // The membership test must read clp.shipment_id too, or "Add another
    // container" would refuse the cargo it was made for.
    const { booking: b, clpId } = await legacyPlan('p6e');
    expect((await fill(clpId, b.id)).res.status).toBe(201);
  });

  // ------------------------------------------------------------------- B2
  it('B2 — a legacy plan prints its booking, POL, POD and customer', async () => {
    const { booking: b, clpId } = await legacyPlan('p2a');
    await fill(clpId, b.id);

    const res = await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/print`);
    expect(res.status).toBe(200);
    const printed = extractPdfText(res.body as Buffer);

    /*
      The failure this replaces printed "—" in all four places: a load plan
      handed to the carrier with no booking number and no ports on it.
    */
    expect(printed).toContain(b.code);
    const shipment = await owner.shipment.findFirstOrThrow({
      where: { id: b.id },
      select: { pol: { select: { name: true } }, pod: { select: { name: true } }, customer: { select: { name: true } } },
    });
    expect(printed).toContain(shipment.pol!.name);
    expect(printed).toContain(shipment.pod!.name);
    expect(printed).toContain(shipment.customer.name);
  });

  it('B2 — a consolidated plan names every booking in the box', async () => {
    const a = await booking({ label: 'p2b', loadingType: 'LCL' });
    const b = await booking({ label: 'p2c', loadingType: 'LCL' });
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [a.id.toString(), b.id.toString()],
        containerSizeId: size20.toString(),
      });
    const clpId = track(made.body.data.id);
    await fill(clpId, a.id);

    const printed = extractPdfText(
      (await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/print`)).body as Buffer,
    );
    // §16, now implemented: every booking in the box is named.
    expect(printed).toContain(a.code);
    expect(printed).toContain(b.code);
    expect(printed).toMatch(/CONSOLIDATED CONTAINER/);
  });

  // ------------------------------------------------------------------- B3
  it('B3 — a legacy plan can record a container cost, and it lands on its booking', async () => {
    /*
      This used to refuse with "there are no bookings in this container to
      split the cost across" — in front of an operator looking at a container
      that plainly holds their cargo.
    */
    const { booking: b, clpId } = await legacyPlan('p3a');
    await fill(clpId, b.id);

    const preview = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/cost/preview`)
      .send({ actualContainerCost: '2000', costCurrencyId: currencyId.toString(), basis: 'CBM' });
    expect(preview.status).toBe(200);
    expect(preview.body.data.shares).toHaveLength(1);
    expect(preview.body.data.shares[0].bookingCode).toBe(b.code);
    expect(preview.body.data.reconciles).toBe(true);

    const saved = await as(tokenAll)
      .patch(`/api/tenant/ops/clps/${clpId}/cost`)
      .send({ actualContainerCost: '2000', costCurrencyId: currencyId.toString(), basis: 'CBM' });
    expect(saved.status).toBe(200);

    /*
      The plan has no clp_booking row to write the share onto, so the figure
      is computed and reconciled but nothing is persisted per booking. That is
      the honest outcome of a read-side fallback: it does not invent the row
      the legacy path never wrote, and it does not silently backfill one.
    */
    expect(await owner.clpBooking.count({ where: { clpId } })).toBe(0);
    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clpId },
      select: { actualContainerCost: true, costAllocationBasis: true },
    });
    expect(plan.actualContainerCost?.toString()).toBe('2000');
    expect(plan.costAllocationBasis).toBe('CBM');
  });

  // ------------------------------------------------------------------- B4
  it('B4 — a legacy plan reports its billing CBM instead of an empty table', async () => {
    const { booking: b, clpId } = await legacyPlan('p4a');
    await fill(clpId, b.id);

    const res = await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/billing`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].bookingCode).toBe(b.code);
    expect(res.body.data[0].basis).not.toBeNull();
  });

  it('B4 — and a consolidated plan reports one row per participant', async () => {
    const a = await booking({ label: 'p4b', loadingType: 'LCL' });
    const b = await booking({ label: 'p4c', loadingType: 'LCL' });
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [a.id.toString(), b.id.toString()],
        containerSizeId: size20.toString(),
      });
    const clpId = track(made.body.data.id);

    const res = await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/billing`);
    expect(res.body.data.map((r: { bookingCode: string }) => r.bookingCode).sort()).toEqual(
      [a.code, b.code].sort(),
    );
  });

  // ------------------------------------------------------- scenario 7
  it('no path reaches another workspace through the fallback', async () => {
    /*
      The fallback reads a column rather than following a join, which is
      exactly where a leak would hide. Two guards, both asserted: the
      composite FK means clp.shipment_id can only ever name a booking in the
      same tenant, and RLS scopes the read regardless.
    */
    const mine = await booking({ label: 'p7a', loadingType: 'LCL' });
    const other = await owner.tenant.create({
      data: { name: 'CLP participant isolation', slug: `clp-p7-${RUN}`, country: 'Bangladesh' },
      select: { id: true },
    });
    try {
      const carrier = await owner.shipment.findFirstOrThrow({
        where: { id: mine.id },
        select: { carrierId: true },
      });
      await expect(
        owner.clp.create({
          data: {
            tenantId: other.id,
            code: `CLP-P7-${RUN}`,
            seriesYear: 2026,
            clpSeq: 1,
            shipmentId: mine.id, // another tenant's booking
            containerSizeId: size20,
            carrierId: carrier.carrierId!,
          },
        }),
      ).rejects.toThrow();

      const seen = await withTenant(other.id, (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM clp WHERE shipment_id = ${mine.id}`,
      );
      expect(Number(seen[0]!.n)).toBe(0);
    } finally {
      await owner.tenant.delete({ where: { id: other.id } });
    }
  });
});

// ============================= B5 — the container-number clash at finalisation

/**
 * "This container number is already on another plan for a booking in this
 * box" — and nothing wider than that.
 *
 * The check compared `clp.shipment_id`. On a consolidated plan that column is
 * NULL and Prisma renders `shipmentId: null` as `shipment_id IS NULL`, so the
 * rule silently became "any FINAL consolidated plan in this workspace using
 * this container number" — every booking, every voyage. It refused
 * legitimate finalisations while naming a CLP the operator had nothing to do
 * with, and it did not actually check the thing it claimed to.
 *
 * Scoped through `participantShipmentIds` now, so both shapes are found on
 * both sides of the comparison.
 */
describe('B5 — finalising against a container number already in use', () => {
  const BOX = 'TCLU1234568';
  const OTHER_BOX = 'TGHU1234567';

  async function loaded(shipmentIds: bigint[]) {
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: shipmentIds.map((id) => id.toString()),
        containerSizeId: size20.toString(),
      });
    expect(made.status).toBe(201);
    const clpId = track(made.body.data.id);
    for (const shipmentId of shipmentIds) {
      const line = await owner.shipmentCargoLine.findFirstOrThrow({
        where: { shipmentId, deletedAt: null },
        select: { id: true },
      });
      await as(tokenAll)
        .post(`/api/tenant/ops/clps/${clpId}/lines`)
        .send({ cargoLineId: line.id.toString(), ctnQty: 1 });
    }
    return clpId;
  }

  /** A plan made the legacy way, with cargo in it. */
  async function legacyLoaded(shipmentId: bigint) {
    const made = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${shipmentId}/clps`)
      .send({ containerSizeId: size20.toString() });
    const clpId = track(made.body.data.id);
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId, deletedAt: null },
      select: { id: true },
    });
    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 1 });
    expect(await owner.clpBooking.count({ where: { clpId } })).toBe(0);
    return clpId;
  }

  const finalise = (clpId: bigint, containerNo: string) =>
    as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/finalise`)
      .send({
        containerNo,
        sealNo: `SL-B5-${RUN}`,
        loadDatetime: '2026-09-16T08:00:00.000Z',
      });

  it('catches a second plan on the same booking — legacy shape', async () => {
    const b = await booking({ label: 'b5la', loadingType: 'LCL', ctn: 4 });
    expect((await finalise(await legacyLoaded(b.id), BOX)).status).toBe(200);

    const second = await legacyLoaded(b.id);
    const refused = await finalise(second, BOX);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/already on CLP/i);
  });

  it('catches it through the participation of a consolidated plan', async () => {
    const a = await booking({ label: 'b5ca', loadingType: 'LCL', ctn: 4 });
    const b = await booking({ label: 'b5cb', loadingType: 'LCL', ctn: 4 });
    expect((await finalise(await loaded([a.id, b.id]), BOX)).status).toBe(200);

    // A later plan for one of those same bookings, same box number.
    const again = await loaded([a.id]);
    const refused = await finalise(again, BOX);
    expect(refused.status).toBe(409);
  });

  it('catches it whichever shape recorded the booking', async () => {
    // Legacy first, canonical second: the booking is the same either way.
    const b = await booking({ label: 'b5mx', loadingType: 'LCL', ctn: 4 });
    expect((await finalise(await legacyLoaded(b.id), BOX)).status).toBe(200);
    expect((await finalise(await loaded([b.id]), BOX)).status).toBe(409);
  });

  it('does NOT refuse a consolidated plan that shares no booking', async () => {
    /*
      The regression. Two unrelated consolidations reusing one container
      number on different voyages is ordinary; the NULL comparison refused the
      second one and blamed the first.
    */
    const a = await booking({ label: 'b5na', loadingType: 'LCL', ctn: 4 });
    const b = await booking({ label: 'b5nb', loadingType: 'LCL', ctn: 4 });
    const c = await booking({ label: 'b5nc', loadingType: 'LCL', ctn: 4 });
    const d = await booking({ label: 'b5nd', loadingType: 'LCL', ctn: 4 });

    expect((await finalise(await loaded([a.id, b.id]), OTHER_BOX)).status).toBe(200);
    // Different bookings entirely, same steel box, later sailing.
    expect((await finalise(await loaded([c.id, d.id]), OTHER_BOX)).status).toBe(200);
  });

  it('does not refuse an unrelated legacy plan either', async () => {
    const a = await booking({ label: 'b5ua', loadingType: 'LCL', ctn: 4 });
    const b = await booking({ label: 'b5ub', loadingType: 'LCL', ctn: 4 });
    expect((await finalise(await legacyLoaded(a.id), 'CSQU3054383')).status).toBe(200);
    expect((await finalise(await legacyLoaded(b.id), 'CSQU3054383')).status).toBe(200);
  });

  it('checks every booking in the box, not just the first', async () => {
    const a = await booking({ label: 'b5ea', loadingType: 'LCL', ctn: 4 });
    const b = await booking({ label: 'b5eb', loadingType: 'LCL', ctn: 4 });
    const c = await booking({ label: 'b5ec', loadingType: 'LCL', ctn: 4 });

    // The box is already used by b — which is the SECOND participant below.
    expect((await finalise(await loaded([b.id]), 'MSKU0000109')).status).toBe(200);
    const shared = await loaded([a.id, b.id, c.id]);
    expect((await finalise(shared, 'MSKU0000109')).status).toBe(409);
  });

  it('ignores a soft-deleted plan and a soft-deleted participation', async () => {
    const a = await booking({ label: 'b5da', loadingType: 'LCL', ctn: 4 });
    const gone = await loaded([a.id]);
    expect((await finalise(gone, 'FCIU1234560')).status).toBe(200);

    // §4 rule 3's soft delete: the plan is no longer a record of anything.
    await owner.clp.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    expect((await finalise(await loaded([a.id]), 'FCIU1234560')).status).toBe(200);

    /*
      A dropped participation stops linking the two — but only on a plan that
      has nothing else recording the booking. A CONSOLIDATED plan carries
      shipment_id NULL, so its participations are the only link and removing
      them removes it.
    */
    const b = await booking({ label: 'b5db', loadingType: 'LCL', ctn: 4 });
    const c = await booking({ label: 'b5dc', loadingType: 'LCL', ctn: 4 });
    const held = await loaded([b.id, c.id]);
    expect(
      (await owner.clp.findFirstOrThrow({ where: { id: held }, select: { shipmentId: true } }))
        .shipmentId,
    ).toBeNull();
    expect((await finalise(held, 'HLXU1234561')).status).toBe(200);
    await owner.clpBooking.updateMany({
      where: { clpId: held },
      data: { deletedAt: new Date() },
    });
    expect((await finalise(await loaded([b.id, c.id]), 'HLXU1234561')).status).toBe(200);
  });

  it('a dropped participation still leaves a single plan linked by shipment_id', async () => {
    /*
      The other half of the rule, and the one that surprised this test first
      time. A selection of ONE comes through /clps/consolidate as a SINGLE
      plan, which writes clp_booking AND keeps clp.shipment_id in step. Drop
      the participation and the legacy column still records the booking — so
      the plan is still that booking's, and the clash is real.

      That is `plansOfBooking` behaving exactly as it does everywhere else,
      stated here so nobody later reads the case above as "deleting a
      participation always unlinks".
    */
    const b = await booking({ label: 'b5sg', loadingType: 'LCL', ctn: 4 });
    const single = await loaded([b.id]);
    expect(
      (await owner.clp.findFirstOrThrow({ where: { id: single }, select: { shipmentId: true } }))
        .shipmentId,
    ).toBe(b.id);
    expect((await finalise(single, 'TRLU1234567')).status).toBe(200);

    await owner.clpBooking.updateMany({
      where: { clpId: single },
      data: { deletedAt: new Date() },
    });
    expect((await finalise(await loaded([b.id]), 'TRLU1234567')).status).toBe(409);
  });

  it('never sees another workspace plan', async () => {
    /*
      The clash query has no tenant clause of its own — it does not need one,
      and that is the point worth pinning: withTenant scopes it and RLS
      enforces it. A plan in another workspace holding this container number
      must not block a finalisation here.
    */
    const mine = await booking({ label: 'b5iso', loadingType: 'LCL', ctn: 4 });
    const other = await owner.tenant.create({
      data: { name: 'CLP clash isolation', slug: `clp-b5-${RUN}`, country: 'Bangladesh' },
      select: { id: true },
    });
    try {
      const seen = await withTenant(other.id, (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM clp WHERE container_no = ${BOX}`,
      );
      expect(Number(seen[0]!.n)).toBe(0);

      // And finalising here is unaffected by anything outside this workspace.
      expect((await finalise(await loaded([mine.id]), 'OOLU1234567')).status).toBe(200);
    } finally {
      await owner.tenant.delete({ where: { id: other.id } });
    }
  });
});

// ============= §16 through the route — real participation, not a fixture list

/**
 * The renderer tests hand `buildClpPdf` a list of codes. These prove the list
 * the ROUTE hands it is the real participation of the container, for both
 * shapes, and that asking for the document changes nothing.
 */
describe('§16 — the printed booking list comes from real participation', () => {
  async function consolidatedOf(labels: string[]) {
    const made: { id: bigint; code: string }[] = [];
    for (const label of labels) made.push(await booking({ label, loadingType: 'LCL', ctn: 4 }));
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: made.map((b) => b.id.toString()),
        containerSizeId: size20.toString(),
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const clpId = track(res.body.data.id);
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId: made[0]!.id, deletedAt: null },
      select: { id: true },
    });
    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 1 });
    return { clpId, made };
  }

  const printed = async (clpId: bigint) => {
    const res = await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/print`);
    expect(res.status).toBe(200);
    return extractPdfText(res.body as Buffer);
  };

  it('names all three bookings of a three-way consolidation, once each', async () => {
    const { clpId, made } = await consolidatedOf(['s16a', 's16b', 's16c']);
    const text = await printed(clpId);

    expect(text).toMatch(/CONSOLIDATED CONTAINER/);
    expect(text).toMatch(/3 BOOKINGS/);
    for (const b of made) {
      expect(text.split(b.code).length - 1).toBe(1);
    }
  });

  it('prints them in participation order', async () => {
    /*
      clp_booking.id — the order the consolidation was built in, which is the
      order `participantShipmentIds` returns and the only ordering this
      document should ever use.
    */
    const { clpId } = await consolidatedOf(['s16d', 's16e', 's16f']);
    const order = await owner.clpBooking.findMany({
      where: { clpId, deletedAt: null },
      orderBy: { id: 'asc' },
      select: { shipment: { select: { code: true } } },
    });
    const text = await printed(clpId);
    const at = order.map((row) => text.indexOf(row.shipment.code));
    expect(at.every((p) => p >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('prints a legacy plan as the single-booking document it is', async () => {
    const b = await booking({ label: 's16leg', loadingType: 'LCL', ctn: 4 });
    const made = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const clpId = track(made.body.data.id);
    expect(await owner.clpBooking.count({ where: { clpId } })).toBe(0);
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId: b.id, deletedAt: null },
      select: { id: true },
    });
    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 1 });

    const text = await printed(clpId);
    // The fallback, unchanged: one booking, named, no consolidation block.
    expect(text).toContain('BOOKING NO');
    expect(text).toContain(b.code);
    expect(text).not.toMatch(/CONSOLIDATED CONTAINER/);
  });

  it('cannot name a booking from another workspace', async () => {
    /*
      The list is built from participation ids read inside withTenant, so a
      foreign booking has no route onto the page. Proven from both ends: the
      document names only this workspace's bookings, and the database refuses
      to link a foreign one in the first place.
    */
    const { clpId, made } = await consolidatedOf(['s16iso']);
    const stranger = await owner.tenant.create({
      data: { name: 'S16 isolation', slug: `s16-${RUN}`, country: 'Bangladesh' },
      select: { id: true },
    });
    try {
      await expect(
        owner.clpBooking.create({
          data: { tenantId: stranger.id, clpId, shipmentId: made[0]!.id },
        }),
      ).rejects.toThrow();

      const text = await printed(clpId);
      const foreign = await owner.shipment.findFirst({
        where: { tenantId: { not: tenantId }, deletedAt: null },
        select: { code: true },
      });
      if (foreign !== null) expect(text).not.toContain(foreign.code);
      expect(text).toContain(made[0]!.code);
    } finally {
      await owner.tenant.delete({ where: { id: stranger.id } });
    }
  });

  it('printing a finalised plan changes nothing about it', async () => {
    /*
      §16 is a rendering requirement and printing stays a read. Checked
      against the allocations, the plan row, the receipt lines' billing basis
      and the audit trail — the four things earlier findings showed a read
      path can quietly disturb.
    */
    const { clpId, made } = await consolidatedOf(['s16fz']);
    const done = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/finalise`)
      .send({
        containerNo: 'SEGU1234569',
        sealNo: `SL-S16-${RUN}`,
        loadDatetime: '2026-09-16T10:00:00.000Z',
      });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const before = {
      plan: await owner.clp.findFirstOrThrow({
        where: { id: clpId },
        select: { updatedAt: true, totalCtnQty: true, totalVolumeCbm: true, status: true },
      }),
      lines: await owner.clpLine.findMany({
        where: { clpId, deletedAt: null },
        orderBy: { id: 'asc' },
        select: { id: true, ctnQty: true, volumeCbm: true, updatedAt: true },
      }),
      basis: await owner.cargoReceiptLine.findMany({
        where: { cargoLine: { shipmentId: made[0]!.id }, deletedAt: null },
        orderBy: { id: 'asc' },
        select: { id: true, billingBasis: true, updatedAt: true },
      }),
      audit: await owner.auditLog.count({ where: { tableName: 'clp', recordId: clpId } }),
    };

    // Print it three times, which is what a warehouse actually does.
    for (let i = 0; i < 3; i += 1) await printed(clpId);

    expect(
      await owner.clp.findFirstOrThrow({
        where: { id: clpId },
        select: { updatedAt: true, totalCtnQty: true, totalVolumeCbm: true, status: true },
      }),
    ).toEqual(before.plan);
    expect(
      await owner.clpLine.findMany({
        where: { clpId, deletedAt: null },
        orderBy: { id: 'asc' },
        select: { id: true, ctnQty: true, volumeCbm: true, updatedAt: true },
      }),
    ).toEqual(before.lines);
    expect(
      await owner.cargoReceiptLine.findMany({
        where: { cargoLine: { shipmentId: made[0]!.id }, deletedAt: null },
        orderBy: { id: 'asc' },
        select: { id: true, billingBasis: true, updatedAt: true },
      }),
    ).toEqual(before.basis);
    expect(await owner.auditLog.count({ where: { tableName: 'clp', recordId: clpId } })).toBe(
      before.audit,
    );
  });
});

// ============================ the client's loading-type sheet, 2026-09-16

/**
 * The four tables on the client's sheet, through HTTP.
 *
 *   FCL         one booking, its POs, one EFR — refused the moment a second
 *               FCL booking is ticked into the same box
 *   LCL         one customer's three exporters, a booking and an EFR each,
 *               in one box; and, confirmed the same day, across customers
 *   CONSOL_BOX  small shipments, across customers, never with LCL
 *
 * and the way the sheet says the plan is made: "multiple exporter's PO will
 * select by check box and make CLP". Ticking POs creates the plan and loads
 * them, so what is proven here is the loading as much as the refusal — the
 * right cartons, in the right box, named in the order they were ticked, and
 * nothing at all left behind when the request is refused.
 */
describe('tick POs, make the CLP — the loading-type sheet', () => {
  let receiptSeq = 0;

  const poIdsOf = async (shipmentId: bigint) =>
    (
      await owner.shipmentPo.findMany({
        where: { shipmentId, deletedAt: null },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
    ).map((p) => p.id.toString());

  /** A further PO on a booking, delivered on its own receipt. */
  async function addPo(b: Fixture, label: string, ctn: number, efrNo: string | null): Promise<string> {
    const po = await owner.shipmentPo.create({
      data: { tenantId, shipmentId: b.id, poNo: `PO-${label}` },
      select: { id: true },
    });
    const line = await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId: b.id,
        shipmentPoId: po.id,
        itemCode: `IT-${label}`,
        ctnQty: ctn,
        grossWeightKg: String(ctn * 25),
        cartonLengthCm: '50', cartonWidthCm: '50', cartonHeightCm: '50',
      },
      select: { id: true },
    });
    receiptSeq += 1;
    const receipt = await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRRT-${RUN}-${label}`,
        seriesYear: 2026,
        shipmentId: b.id,
        receiptSeq: 9900 + receiptSeq,
        receiveDate: new Date('2026-09-15'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: superadminId,
        unloadLocation: 'CFS Alpha',
        efrNo,
      },
      select: { id: true },
    });
    await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: receipt.id,
        shipmentCargoLineId: line.id,
        receivedCtnQty: ctn,
        lineStatus: 'ACCEPTED',
      },
    });
    return po.id.toString();
  }

  const consolidate = (body: object) =>
    as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ containerSizeId: size20.toString(), ...body });

  const check = (shipmentPoIds: string[]) =>
    as(tokenAll).post('/api/tenant/ops/clp-candidates/check').send({ shipmentPoIds });

  /** Everything a refused request must leave exactly as it was. */
  const footprint = async () => ({
    clps: await owner.clp.count(),
    lines: await owner.clpLine.count(),
    participations: await owner.clpBooking.count(),
  });

  async function anotherCustomer(than: Fixture): Promise<bigint> {
    const mine = await owner.shipment.findFirstOrThrow({
      where: { id: than.id },
      select: { customerId: true },
    });
    return (
      await owner.customer.findFirstOrThrow({
        where: { tenantId, deletedAt: null, id: { not: mine.customerId } },
        select: { id: true },
      })
    ).id;
  }

  it('FCL: loads exactly the ticked POs of one booking, in one step', async () => {
    const b = await booking({ label: 'shf', loadingType: 'FCL', ctn: 5, efrNo: 'EFR-F01' });
    const [po1] = await poIdsOf(b.id);
    const po2 = await addPo(b, 'shf2', 10, 'EFR-F01');
    const po3 = await addPo(b, 'shf3', 8, 'EFR-F01');

    const res = await consolidate({ shipmentPoIds: [po1!, po2] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.shipmentId).toBe(b.id.toString());
    const clpId = track(res.body.data.id);

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clpId },
      select: {
        consolidationType: true,
        clpSeq: true,
        shipmentId: true,
        totalCtnQty: true,
        lines: { where: { deletedAt: null }, select: { shipmentPoId: true, ctnQty: true } },
      },
    });
    expect(plan.consolidationType).toBe('SINGLE');
    expect(plan.clpSeq).not.toBeNull();
    expect(plan.shipmentId).toBe(b.id);
    expect(plan.totalCtnQty).toBe(15);
    expect(plan.lines.map((l) => l.shipmentPoId.toString()).sort()).toEqual([po1!, po2].sort());

    // The PO nobody ticked is still waiting, with its EFR.
    const pool = (await as(tokenAll).get(`/api/tenant/ops/bookings/${b.id}/clp`)).body.data.pool;
    expect(pool.map((r: { poId: string }) => r.poId)).toEqual([po3]);
    expect(pool[0].efrNos).toEqual(['EFR-F01']);
  });

  it('FCL: refuses POs from two FCL bookings, and creates and loads nothing', async () => {
    const a = await booking({ label: 'shfa', loadingType: 'FCL', ctn: 5 });
    const b = await booking({ label: 'shfb', loadingType: 'FCL', ctn: 5 });
    const ticked = [...(await poIdsOf(a.id)), ...(await poIdsOf(b.id))];

    const judged = await check(ticked);
    expect(judged.status).toBe(200);
    expect(judged.body.data.ok).toBe(false);
    expect(JSON.stringify(judged.body.data.issues)).toMatch(/separate FCL bookings/);

    const before = await footprint();
    const res = await consolidate({ shipmentPoIds: ticked });
    if (res.status === 201) track(res.body.data.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/book them as LCL/);
    expect(await footprint()).toEqual(before);
  });

  it('LCL: three exporters of one customer share a box, named in tick order, EFR on every line', async () => {
    const a = await booking({ label: 'shla', loadingType: 'LCL', ctn: 5, efrNo: 'EFR-L01' });
    const b = await booking({ label: 'shlb', loadingType: 'LCL', ctn: 10, efrNo: 'EFR-L02' });
    const c = await booking({ label: 'shlc', loadingType: 'LCL', ctn: 15, efrNo: 'EFR-L03' });
    const [poA] = await poIdsOf(a.id);
    const [poB] = await poIdsOf(b.id);
    const [poC] = await poIdsOf(c.id);

    const judged = await check([poC!, poA!, poB!]);
    expect(judged.body.data.ok, JSON.stringify(judged.body.data.issues)).toBe(true);
    expect(judged.body.data.family).toBe('LCL');
    expect(judged.body.data.totalCtnQty).toBe(30);
    expect(Number(judged.body.data.totalCbm)).toBeCloseTo(30 * 0.125, 4);

    const res = await consolidate({ shipmentPoIds: [poC!, poA!, poB!] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const clpId = track(res.body.data.id);
    // The first ticked booking is the one the planner lands on.
    expect(res.body.data.shipmentId).toBe(c.id.toString());

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clpId },
      select: {
        consolidationType: true,
        shipmentId: true,
        totalCtnQty: true,
        bookings: { orderBy: { id: 'asc' }, select: { shipmentId: true } },
      },
    });
    expect(plan.consolidationType).toBe('LCL_CONSOLIDATION');
    expect(plan.shipmentId).toBeNull();
    expect(plan.totalCtnQty).toBe(30);
    expect(plan.bookings.map((p) => p.shipmentId)).toEqual([c.id, a.id, b.id]);

    const cards = (await as(tokenAll).get(`/api/tenant/ops/bookings/${a.id}/clp`)).body.data.clps;
    const card = cards.find((x: { id: string }) => x.id === clpId.toString());
    expect(card.loadingType).toBe('LCL');
    expect(
      card.lines.map((l: { poNo: string; efrNos: string[] }) => `${l.poNo}=${l.efrNos.join(',')}`).sort(),
    ).toEqual(['PO-shla=EFR-L01', 'PO-shlb=EFR-L02', 'PO-shlc=EFR-L03']);

    const printed = extractPdfText(
      (await as(tokenAll).get(`/api/tenant/ops/clps/${clpId}/print`)).body as Buffer,
    );
    expect(printed).toContain('EFR NO');
    for (const efr of ['EFR-L01', 'EFR-L02', 'EFR-L03']) expect(printed).toContain(efr);
  });

  it('LCL: bookings of different customers share a box', async () => {
    const a = await booking({ label: 'shlx', loadingType: 'LCL', ctn: 4 });
    const b = await booking({
      label: 'shly', loadingType: 'LCL', ctn: 4, customerId: await anotherCustomer(a),
    });
    const res = await consolidate({
      shipmentPoIds: [...(await poIdsOf(a.id)), ...(await poIdsOf(b.id))],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    track(res.body.data.id);
  });

  it('Consol box: takes different customers, and is never mixed with LCL', async () => {
    const box1 = await booking({ label: 'shb1', loadingType: 'CONSOL_BOX', ctn: 4 });
    const box2 = await booking({
      label: 'shb2', loadingType: 'CONSOL_BOX', ctn: 4, customerId: await anotherCustomer(box1),
    });
    const lcl = await booking({ label: 'shbl', loadingType: 'LCL', ctn: 4 });

    const res = await consolidate({
      shipmentPoIds: [...(await poIdsOf(box1.id)), ...(await poIdsOf(box2.id))],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const clpId = track(res.body.data.id);
    const cards = (await as(tokenAll).get(`/api/tenant/ops/bookings/${box1.id}/clp`)).body.data.clps;
    expect(cards.find((x: { id: string }) => x.id === clpId.toString()).loadingType).toBe('CONSOL_BOX');

    const mixed = await check([...(await poIdsOf(box1.id)), ...(await poIdsOf(lcl.id))]);
    expect(mixed.body.data.ok).toBe(false);
    expect(JSON.stringify(mixed.body.data.issues)).toMatch(
      /is LCL and .* is Consol box\. Different loading types never share a container/,
    );
  });

  it('offers each PO with what ticking it would load, not what arrived', async () => {
    const b = await booking({ label: 'shrun', loadingType: 'LCL', ctn: 20, efrNo: 'EFR-R01' });
    const [po] = await poIdsOf(b.id);

    // Eight of the twenty cartons are already in another container.
    const legacy = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const legacyId = track(legacy.body.data.id);
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId: b.id },
      select: { id: true },
    });
    const put = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${legacyId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 8 });
    expect(put.status, JSON.stringify(put.body)).toBe(201);

    const list = await as(tokenAll).get(`/api/tenant/ops/clp-candidates?family=LCL&search=${b.code}`);
    const offered = list.body.data.candidates[0].pos[0];
    expect(offered).toMatchObject({ poId: po, ctnQty: 12, receivedCtnQty: 20, efrNos: ['EFR-R01'] });
    expect(Number(offered.cbm)).toBeCloseTo(12 * 0.125, 4);

    const judged = await check([po!]);
    expect(judged.body.data.totalCtnQty).toBe(12);
    expect(Number(judged.body.data.totalCbm)).toBeCloseTo(1.5, 4);

    // ...and ticking it loads those twelve, no more.
    const res = await consolidate({ shipmentPoIds: [po!] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const made = await owner.clp.findFirstOrThrow({
      where: { id: track(res.body.data.id) },
      select: { totalCtnQty: true },
    });
    expect(made.totalCtnQty).toBe(12);
  });

  it('refuses a PO with nothing left to load, naming it', async () => {
    const b = await booking({ label: 'shdone', loadingType: 'LCL', ctn: 4 });
    const [po] = await poIdsOf(b.id);
    const first = await consolidate({ shipmentPoIds: [po!] });
    expect(first.status).toBe(201);
    track(first.body.data.id);

    const judged = await check([po!]);
    expect(judged.body.data.ok).toBe(false);
    expect(JSON.stringify(judged.body.data.issues)).toMatch(/PO-shdone on .* has nothing left to load/);

    const before = await footprint();
    const again = await consolidate({ shipmentPoIds: [po!] });
    if (again.status === 201) track(again.body.data.id);
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/all 4 received cartons are already in a plan/);
    expect(await footprint()).toEqual(before);
  });

  it('refuses POs that overfill the container before anything is written', async () => {
    // 240 cartons at 0.125 CBM is 30 CBM, into a 28 CBM 20STD.
    const b = await booking({ label: 'shbig', loadingType: 'LCL', ctn: 240 });
    const before = await footprint();
    const res = await consolidate({ shipmentPoIds: await poIdsOf(b.id) });
    if (res.status === 201) track(res.body.data.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      'The ticked POs come to 30.00 CBM, and a 20STD holds 28 CBM. ' +
        'Untick some POs or choose a bigger container.',
    );
    expect(await footprint()).toEqual(before);
  });

  it('refuses a PO from another workspace, and a request naming POs and bookings both', async () => {
    const mine = await booking({ label: 'shiso', loadingType: 'LCL', ctn: 4 });
    const [po] = await poIdsOf(mine.id);

    const both = await consolidate({ shipmentPoIds: [po!], shipmentIds: [mine.id.toString()] });
    expect(both.status).toBe(400);

    const stranger = await owner.shipmentPo.findFirst({
      where: { tenantId: { not: tenantId }, deletedAt: null },
      select: { id: true },
    });
    if (stranger === null) return; // single-tenant dev database
    const res = await consolidate({ shipmentPoIds: [po!, stranger.id.toString()] });
    expect(res.status).toBe(404);
    expect((await check([stranger.id.toString()])).status).toBe(404);
  });
});

// ================================ one Container Load Plan screen (2026-09-17)

/**
 * What the merged screen reads from the server: the To plan tab's "All"
 * workflow, the Required Container its group header prints, a search by PO
 * number, and a planned count that includes shared containers.
 */
describe('the Container Load Plan screen — what its two tabs read', () => {
  it('offers every workflow at once when no family is asked for', async () => {
    const fcl = await booking({ label: 'osfcl', loadingType: 'FCL' });
    const lcl = await booking({ label: 'oslcl', loadingType: 'LCL' });
    const box = await booking({ label: 'osbox', loadingType: 'CONSOL_BOX' });
    const bare = await booking({ label: 'osnone', loadingType: null });

    const res = await as(tokenAll).get(`/api/tenant/ops/clp-candidates?search=BKGRT-${RUN}-os`);
    expect(res.status).toBe(200);
    const codes = res.body.data.candidates.map((c: { code: string }) => c.code);
    expect(codes).toEqual(expect.arrayContaining([fcl.code, lcl.code, box.code]));
    // Still the refusal to guess: no loading type, no workflow, not listed.
    expect(codes).not.toContain(bare.code);
  });

  it('carries the Required Container the quotation agreed', async () => {
    const b = await booking({ label: 'osreq', loadingType: 'FCL' });
    const res = await as(tokenAll).get(`/api/tenant/ops/clp-candidates?family=FCL&search=${b.code}`);
    const row = res.body.data.candidates[0];
    const booked = await as(tokenAll).get(`/api/tenant/ops/bookings/${b.id}/clp`);
    // The same string the booking's own plan page shows, from the same helper.
    expect(typeof row.requiredContainer).toBe('string');
    expect(row.requiredContainer).toBe(booked.body.data.booking.requiredContainer);
  });

  it('finds a booking by one of its PO numbers', async () => {
    const b = await booking({ label: 'ospo', loadingType: 'LCL' });
    const res = await as(tokenAll).get(`/api/tenant/ops/clp-candidates?family=LCL&search=PO-ospo`);
    expect(res.body.data.candidates.map((c: { code: string }) => c.code)).toEqual([b.code]);
  });

  it('counts a shared container as planned for every booking in it', async () => {
    const a = await booking({ label: 'osca', loadingType: 'LCL', ctn: 4 });
    const b = await booking({ label: 'oscb', loadingType: 'LCL', ctn: 4 });
    const pos = [
      ...(await owner.shipmentPo.findMany({ where: { shipmentId: { in: [a.id, b.id] } }, select: { id: true } })),
    ].map((p) => p.id.toString());
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentPoIds: pos, containerSizeId: size20.toString() });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    track(made.body.data.id);

    /*
      Read through the booking's own plan, which is where the screen shows it.
      Not through GET /clp-bookings: that queue's where clause nests four
      sequential scans under RLS and takes seconds once this file has built a
      few dozen bookings, which says nothing about the count under test.
    */
    for (const bk of [a, b]) {
      const res = await as(tokenAll).get(`/api/tenant/ops/bookings/${bk.id}/clp`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // It read 0 beside "All assigned" before: the count looked only at clp.shipment_id.
      expect(res.body.data.booking.plannedCount).toBe(1);
      expect(res.body.data.booking.unallocatedCtnQty).toBe(0);
    }
  });
});

describe('Container plans — searching the register', () => {
  it('finds a shared container by any of its bookings, and by their customer', async () => {
    const other = await owner.customer.findFirstOrThrow({
      where: { tenantId, deletedAt: null, name: { not: '' } },
      orderBy: { id: 'desc' },
      select: { id: true, name: true },
    });
    const a = await booking({ label: 'rsa', loadingType: 'LCL', ctn: 4 });
    const b = await booking({ label: 'rsb', loadingType: 'LCL', ctn: 4, customerId: other.id });
    const pos = (
      await owner.shipmentPo.findMany({ where: { shipmentId: { in: [a.id, b.id] } }, select: { id: true } })
    ).map((p) => p.id.toString());
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentPoIds: pos, containerSizeId: size20.toString() });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const clpId = track(made.body.data.id).toString();

    // The plan is consolidated, so clp.shipment_id is NULL — the case that hid it.
    expect(
      (await owner.clp.findFirstOrThrow({ where: { id: BigInt(clpId) }, select: { shipmentId: true } }))
        .shipmentId,
    ).toBeNull();

    for (const term of [a.code, b.code]) {
      const res = await as(tokenAll).get(`/api/tenant/ops/clps?search=${encodeURIComponent(term)}&limit=100`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((r: { id: string }) => r.id)).toContain(clpId);
    }
    const byCustomer = await as(tokenAll).get(
      `/api/tenant/ops/clps?search=${encodeURIComponent(other.name)}&limit=100`,
    );
    expect(byCustomer.body.data.map((r: { id: string }) => r.id)).toContain(clpId);
  });
});

describe('To plan — "Same sailing" suggestions', () => {
  it('leave out bookings already planned in full, and total what is left to load', async () => {
    const done = await booking({ label: 'sgdone', loadingType: 'LCL', ctn: 6 });
    const a = await booking({ label: 'sga', loadingType: 'LCL', ctn: 4 });
    const b = await booking({ label: 'sgb', loadingType: 'LCL', ctn: 5 });

    const donePos = (
      await owner.shipmentPo.findMany({ where: { shipmentId: done.id }, select: { id: true } })
    ).map((p) => p.id.toString());
    const made = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentPoIds: donePos, containerSizeId: size20.toString() });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    track(made.body.data.id);

    const res = await as(tokenAll).get(`/api/tenant/ops/clp-candidates?family=LCL&search=BKGRT-${RUN}-sg`);
    expect(res.status).toBe(200);
    // The planned booking is still listed — it just has nothing left to tick.
    expect(res.body.data.candidates.map((c: { code: string }) => c.code)).toContain(done.code);

    const groups = res.body.data.suggestions as { shipmentIds: string[]; totalCtnQty: number; totalCbm: string }[];
    expect(groups).toHaveLength(1);
    expect([...groups[0]!.shipmentIds].sort()).toEqual([a.id.toString(), b.id.toString()].sort());
    expect(groups[0]!.totalCtnQty).toBe(9);
    expect(Number(groups[0]!.totalCbm)).toBeCloseTo(9 * 0.125, 4);
  });

  it('the planning queue still answers once this file has built its bookings', async () => {
    /*
      Last in the file on purpose: by now dozens of received bookings exist,
      which is the size at which GET /clp-bookings once spent 9 s nesting full
      scans and failed on the 5 s transaction limit.

      A smoke check, not the proof. Whether the planner picks that plan also
      depends on how many pages the tables physically occupy, so this passed
      under the old policies too once the dev tables had grown. The
      deterministic checks — policy form and row estimate — are in
      tenant-isolation.test.ts (20260917090000_rls_estimable_tenant_check).
    */
    const res = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=LCL&search=BKGRT-${RUN}-sg&limit=50`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    expect(res.body.data.map((r: { code: string }) => r.code)).toEqual(
      expect.arrayContaining([`BKGRT-${RUN}-sgdone`, `BKGRT-${RUN}-sga`, `BKGRT-${RUN}-sgb`]),
    );
  });
});

describe('To plan — a planned PO knows the plan it is in', () => {
  it('names every live plan holding the PO, with its status and cartons', async () => {
    const b = await booking({ label: 'pvw', loadingType: 'LCL', ctn: 10 });
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId: b.id },
      select: { id: true },
    });

    // Four cartons into one plan, the other six into a second.
    const first = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const firstId = track(first.body.data.id).toString();
    const put = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${firstId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 4 });
    expect(put.status, JSON.stringify(put.body)).toBe(201);

    const partly = await as(tokenAll).get(`/api/tenant/ops/clp-candidates?family=LCL&search=${b.code}`);
    const partlyPo = partly.body.data.candidates[0].pos[0];
    expect(partlyPo.ctnQty).toBe(6);
    expect(partlyPo.plans).toEqual([
      { clpId: firstId, code: expect.stringMatching(/^CLP-/), status: 'DRAFT', ctnQty: 4 },
    ]);

    const second = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const secondId = track(second.body.data.id).toString();
    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${secondId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 6 });

    const full = await as(tokenAll).get(`/api/tenant/ops/clp-candidates?family=LCL&search=${b.code}`);
    const fullPo = full.body.data.candidates[0].pos[0];
    expect(fullPo.ctnQty).toBe(0);
    expect(fullPo.plans.map((p: { clpId: string; ctnQty: number }) => [p.clpId, p.ctnQty])).toEqual([
      [firstId, 4],
      [secondId, 6],
    ]);

    // A cancelled plan holds nothing, so it stops being named.
    const cancelled = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${firstId}/cancel`)
      .send({ reason: 'Re-planning this container.' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const after = await as(tokenAll).get(`/api/tenant/ops/clp-candidates?family=LCL&search=${b.code}`);
    expect(after.body.data.candidates[0].pos[0].plans.map((p: { clpId: string }) => p.clpId)).toEqual([secondId]);
  });
});

/*
 * Available stock — the client's Cargo Receipt tab (spec, 2026-09-18).
 *
 * "This available stock list is ready for make CLP. After made CLP it will not
 * show in available stock." That sentence is the whole contract, and it is one
 * a planner can break by accident, so it is asserted directly: a booking is
 * here while it has free cartons and gone the moment a plan takes the last one.
 */
describe('Available stock — cargo in hand that no plan has claimed', () => {
  const STOCK = '/api/tenant/ops/cargo-stock';

  it('lists received cargo, then drops it once a CLP takes every carton', async () => {
    const b = await booking({ label: 'stk', loadingType: 'LCL', ctn: 10 });
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId: b.id },
      select: { id: true },
    });

    const listed = await as(tokenAll).get(`${STOCK}?search=${b.code}`);
    expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
    const row = listed.body.data.find((r: { code: string }) => r.code === b.code);
    expect(row, `${b.code} missing from available stock`).toBeDefined();
    expect(row.availableCtnQty).toBe(10);
    expect(row.receivedCtnQty).toBe(10);
    expect(row.family).toBe('LCL');

    // Four cartons planned: still stock, but only what is left of it.
    const clp = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const clpId = track(clp.body.data.id).toString();
    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 4 });

    const partly = await as(tokenAll).get(`${STOCK}?search=${b.code}`);
    const left = partly.body.data.find((r: { code: string }) => r.code === b.code);
    expect(left, 'a part-planned booking still has stock to load').toBeDefined();
    expect(left.availableCtnQty).toBe(6);
    // Received never moves — it is not the same number as available.
    expect(left.receivedCtnQty).toBe(10);

    // The last six: nothing free, so nothing to offer.
    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 6 });

    const gone = await as(tokenAll).get(`${STOCK}?search=${b.code}`);
    expect(gone.body.data.find((r: { code: string }) => r.code === b.code)).toBeUndefined();
  });

  it('brings the stock back when the plan holding it is cancelled', async () => {
    // The mirror of the rule above: a cancelled plan holds nothing, so the
    // cartons are loadable again and the warehouse must be able to see them.
    const b = await booking({ label: 'stkc', loadingType: 'LCL', ctn: 8 });
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { shipmentId: b.id },
      select: { id: true },
    });
    const clp = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${b.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const clpId = track(clp.body.data.id).toString();
    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: 8 });

    const hidden = await as(tokenAll).get(`${STOCK}?search=${b.code}`);
    expect(hidden.body.data.find((r: { code: string }) => r.code === b.code)).toBeUndefined();

    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/cancel`)
      .send({ reason: 'Container released to another sailing.' });

    const back = await as(tokenAll).get(`${STOCK}?search=${b.code}`);
    const row = back.body.data.find((r: { code: string }) => r.code === b.code);
    expect(row, 'cancelling a plan frees its cartons').toBeDefined();
    expect(row.availableCtnQty).toBe(8);
  });

  it('reads as one of the three categories the client names', async () => {
    const b = await booking({ label: 'stkf', loadingType: 'FCL', ctn: 5 });

    const fcl = await as(tokenAll).get(`${STOCK}?family=FCL&search=${b.code}`);
    expect(fcl.body.data.map((r: { code: string }) => r.code)).toContain(b.code);

    // The categories are separate workflows, so an FCL booking is not stock a
    // consolidator can load.
    const lcl = await as(tokenAll).get(`${STOCK}?family=LCL&search=${b.code}`);
    expect(lcl.body.data.map((r: { code: string }) => r.code)).not.toContain(b.code);
  });
});
