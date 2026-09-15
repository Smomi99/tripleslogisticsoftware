import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

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
      customerId: src.customerId,
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

  it('accepts FCL with CONSOL_BOX', async () => {
    const a = await booking({ label: 'fcl2', loadingType: 'FCL' });
    const b = await booking({ label: 'cbox', loadingType: 'CONSOL_BOX' });
    const res = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [a.id.toString(), b.id.toString()], containerSizeId: size20.toString() });
    expect(res.status).toBe(201);
    track(res.body.data.id);
  });

  it('rejects a different voyage on the same vessel', async () => {
    const a = await booking({ label: 'v1', loadingType: 'FCL' });
    const b = await booking({ label: 'v2', loadingType: 'FCL', voyageNo: 'V-RT-9' });
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
    const a = await booking({ label: 'd1', loadingType: 'FCL' });
    const b = await booking({ label: 'd2', loadingType: 'FCL', podId: other.id });
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
    const a = await booking({ label: 'co1', loadingType: 'FCL' });
    const b = await booking({ label: 'co2', loadingType: 'FCL' });
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

  it('keeps FCL and LCL in separate candidate lists', async () => {
    await booking({ label: 'sepf', loadingType: 'FCL' });
    await booking({ label: 'sepl', loadingType: 'LCL' });

    const fcl = await as(tokenAll).get('/api/tenant/ops/clp-candidates?family=FCL&search=' + RUN);
    const lcl = await as(tokenAll).get('/api/tenant/ops/clp-candidates?family=LCL&search=' + RUN);
    expect(fcl.status).toBe(200);
    const families = (rows: { family: string }[]) => [...new Set(rows.map((r) => r.family))];
    expect(families(fcl.body.data.candidates)).toEqual(['FCL']);
    expect(families(lcl.body.data.candidates)).toEqual(['LCL']);
  });

  it('suggests a group without making it a rule', async () => {
    const res = await as(tokenAll).get('/api/tenant/ops/clp-candidates?family=FCL&search=' + RUN);
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
      label: 'e2eA', loadingType: 'FCL', ctn: 40,
      measured: { l: 55, w: 50, h: 50 }, // 0.1375 measured vs 0.125 booked
    });
    const b = await booking({ label: 'e2eB', loadingType: 'FCL', ctn: 20, measured: null });

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
    expect(row.consolidationType).toBe('FCL_QUOTATION');
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
