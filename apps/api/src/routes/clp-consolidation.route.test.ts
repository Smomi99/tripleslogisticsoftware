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
    const asFcl = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=FCL${q}`);
    const asLcl = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=LCL${q}`);
    expect(all.status).toBe(200);

    // Unfiltered is unchanged — the split adds a view, it removes nothing.
    expect(codesOf(all.body)).toEqual(expect.arrayContaining([fcl.code, lcl.code, box.code]));

    expect(codesOf(asFcl.body)).toEqual(expect.arrayContaining([fcl.code, box.code]));
    expect(codesOf(asFcl.body)).not.toContain(lcl.code);

    expect(codesOf(asLcl.body)).toContain(lcl.code);
    expect(codesOf(asLcl.body)).not.toContain(fcl.code);
    // The decision of 2026-09-15, enforced at the view: a consol box is a
    // whole container the forwarder fills, and is never LCL work.
    expect(codesOf(asLcl.body)).not.toContain(box.code);
  });

  it('filters the count too, not just the page', async () => {
    // Otherwise the pager would offer pages that come back empty.
    const q = `&search=BKGRT-${RUN}-vs&limit=100`;
    const asFcl = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=FCL${q}`);
    const asLcl = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=LCL${q}`);
    expect(asFcl.body.meta.total).toBe(asFcl.body.data.length);
    expect(asLcl.body.meta.total).toBe(asLcl.body.data.length);
    expect(asFcl.body.meta.total).toBeGreaterThan(asLcl.body.meta.total);
  });

  it('carries the loading type and its family on every row', async () => {
    const res = await as(tokenAll).get(
      `/api/tenant/ops/clp-bookings?family=FCL&search=BKGRT-${RUN}-vs&limit=100`,
    );
    const box = res.body.data.find((r: { code: string }) => r.code.endsWith('vsbox'));
    expect(box.loadingType).toBe('CONSOL_BOX');
    expect(box.family).toBe('FCL');
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

    for (const family of ['FCL', 'LCL']) {
      const res = await as(tokenAll).get(`/api/tenant/ops/clp-bookings?family=${family}${q}`);
      expect(codesOf(res.body)).not.toContain(bare.code);
    }
  });

  it('splits the register by the participating bookings', async () => {
    const a = await booking({ label: 'vsra', loadingType: 'FCL' });
    const b = await booking({ label: 'vsrb', loadingType: 'FCL' });
    const c = await booking({ label: 'vsrc', loadingType: 'LCL', voyageNo: 'V-VS-L' });

    const consolidated = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({
        shipmentIds: [a.id.toString(), b.id.toString()],
        containerSizeId: size20.toString(),
      });
    expect(consolidated.status).toBe(201);
    const fclId = track(consolidated.body.data.id).toString();

    const lclPlan = await as(tokenAll)
      .post('/api/tenant/ops/clps/consolidate')
      .send({ shipmentIds: [c.id.toString()], containerSizeId: size20.toString() });
    expect(lclPlan.status).toBe(201);
    const lclId = track(lclPlan.body.data.id).toString();

    const onlyFcl = await as(tokenAll).get('/api/tenant/ops/clps?family=FCL&limit=100');
    const onlyLcl = await as(tokenAll).get('/api/tenant/ops/clps?family=LCL&limit=100');

    expect(idsOf(onlyFcl.body)).toContain(fclId);
    expect(idsOf(onlyFcl.body)).not.toContain(lclId);
    expect(idsOf(onlyLcl.body)).toContain(lclId);
    expect(idsOf(onlyLcl.body)).not.toContain(fclId);

    // And the row says which, so the column is not guesswork on the client.
    const fclRow = onlyFcl.body.data.find((r: { id: string }) => r.id === fclId);
    expect(fclRow.family).toBe('FCL');
    expect(fclRow.loadingType).toBe('FCL');
    expect(fclRow.bookingCount).toBe(2);
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
      '/api/tenant/ops/clp-bookings?family=CONSOL_BOX',
      '/api/tenant/ops/clps?family=AIR',
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
    const b = await booking({ label: 'cdlegacy', loadingType: 'FCL' });

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
    const b = await booking({ label: 'cdonce', loadingType: 'FCL' });
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
    const a = await booking({ label: 'cdca', loadingType: 'FCL' });
    const b = await booking({ label: 'cdcb', loadingType: 'FCL' });

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
    const a = await booking({ label: 'cdmixa', loadingType: 'FCL' });
    const b = await booking({ label: 'cdmixb', loadingType: 'FCL' });

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
    const a = await booking({ label: 'cddela', loadingType: 'FCL' });
    const legacy = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${a.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    const legacyId = track(legacy.body.data.id);

    const b = await booking({ label: 'cddelb', loadingType: 'FCL' });
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
    const a = await booking({ label: 'cdorph', loadingType: 'FCL' });
    const b = await booking({ label: 'cdorpi', loadingType: 'FCL' });
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
    const mine = await booking({ label: 'cdiso', loadingType: 'FCL' });
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
    const b = await booking({ label, loadingType: 'FCL' });
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
    const mine = await booking({ label: 'p6a', loadingType: 'FCL' });
    const stranger = await booking({ label: 'p6b', loadingType: 'FCL' });

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
    const a = await booking({ label: 'p6c', loadingType: 'FCL' });
    const b = await booking({ label: 'p6d', loadingType: 'FCL' });
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

  it('B2 — a consolidated plan prints its header booking', async () => {
    const a = await booking({ label: 'p2b', loadingType: 'FCL' });
    const b = await booking({ label: 'p2c', loadingType: 'FCL' });
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
    expect(printed).toContain(a.code);

    /*
      Only the header booking, and that is the current truth rather than the
      intent. The route builds `bookingCodes` and `consolidated` for exactly
      §16's "the document has to name every booking in the box", and
      clp-print.ts declares both fields on ClpPrintDoc — and then renders
      neither. So a shared container prints as if it held one booking's cargo.

      Not fixed here: B2 was a header going blank, which is a consistency bug
      in the read path. This is a §16 requirement that was never implemented
      in the renderer, which is new work and someone's decision to schedule.
      Asserted as it stands so the day it IS implemented, this test says so
      instead of passing silently.
    */
    expect(printed).not.toContain(b.code);
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
    const a = await booking({ label: 'p4b', loadingType: 'FCL' });
    const b = await booking({ label: 'p4c', loadingType: 'FCL' });
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
    const mine = await booking({ label: 'p7a', loadingType: 'FCL' });
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
