import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import {
  assertConsolidatable,
  checkCompatibility,
  isCompatible,
  loadCandidates,
} from './clp-consolidation';
import { withTenant } from './tenant-client';

/**
 * The half the unit tests cannot reach: that `loadCandidates` actually reads
 * the sailing out of the database correctly.
 *
 * `clp-consolidation.test.ts` proves the rules against hand-built candidates.
 * If the QUERY behind them were wrong — joining the proposed schedule instead
 * of the approved one, or taking the last leg instead of the first — every one
 * of those tests would still pass while the product refused legitimate merges
 * and permitted impossible ones. So this file goes through Prisma, against
 * real rows.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const RUN = Date.now().toString().slice(-6);

let tenantId: bigint;
let userId: bigint;
/** Two bookings put deliberately onto one sailing. */
let twinA: bigint;
let twinB: bigint;
/** A third, identical but for its voyage. */
let otherVoyage: bigint;
const made: bigint[] = [];

/** Clones an existing booking, then gives it the sailing we want to test. */
async function twin(
  source: { id: bigint },
  code: string,
  sailing: { vesselId: bigint; voyageNo: string },
): Promise<bigint> {
  const src = await owner.shipment.findFirstOrThrow({
    where: { id: source.id },
    select: {
      tenantId: true, quotationId: true, customerId: true, carrierId: true,
      polId: true, podId: true, shipmentType: true, loadingType: true,
      transitType: true, seriesYear: true,
    },
  });

  const shipment = await owner.shipment.create({
    data: {
      tenantId: src.tenantId,
      code,
      seriesYear: src.seriesYear,
      quotationId: src.quotationId,
      customerId: src.customerId,
      carrierId: src.carrierId,
      polId: src.polId,
      podId: src.podId,
      shipmentType: src.shipmentType,
      loadingType: src.loadingType,
      transitType: src.transitType,
      status: 'CARGO_RECEIVED',
      createdBy: userId,
    },
    select: { id: true },
  });
  made.push(shipment.id);

  const schedule = await owner.shipmentSchedule.create({
    data: {
      tenantId: src.tenantId,
      code: `SCH-${RUN}-${made.length}`,
      shipmentId: shipment.id,
      carrierId: src.carrierId,
      // shipment_schedule.transit_type is NOT NULL; the booking's may not be.
      transitType: src.transitType ?? 'DIRECT',
      status: 'APPROVED',
      cutOffDate: new Date('2026-10-01T00:00:00Z'),
      proposedBy: userId,
      // shipment_schedule_decision_ck: an approved schedule says who approved it.
      decidedBy: userId,
      decidedAt: new Date(),
    },
    select: { id: true },
  });

  await owner.shipmentScheduleLeg.create({
    data: {
      tenantId: src.tenantId,
      scheduleId: schedule.id,
      legNo: 1,
      vesselId: sailing.vesselId,
      voyageNo: sailing.voyageNo,
      originPortId: src.polId,
      destinationPortId: src.podId,
    },
  });

  // Received cargo, so rule 7 is satisfied.
  const po = await owner.shipmentPo.create({
    data: { tenantId: src.tenantId, shipmentId: shipment.id, poNo: `PO-${RUN}-${made.length}` },
    select: { id: true },
  });
  const line = await owner.shipmentCargoLine.create({
    data: {
      tenantId: src.tenantId,
      shipmentId: shipment.id,
      shipmentPoId: po.id,
      itemCode: `CONS-${RUN}-${made.length}`,
      ctnQty: 20,
      grossWeightKg: '500',
      cartonLengthCm: '50', cartonWidthCm: '50', cartonHeightCm: '50',
    },
    select: { id: true },
  });
  const receipt = await owner.cargoReceipt.create({
    data: {
      tenantId: src.tenantId,
      code: `CRC-${RUN}-${made.length}`,
      seriesYear: 2026,
      shipmentId: shipment.id,
      receiptSeq: 9500 + made.length,
      receiveDate: new Date('2026-09-15'),
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      receivedBy: userId,
      unloadLocation: 'CFS Alpha',
    },
    select: { id: true },
  });
  await owner.cargoReceiptLine.create({
    data: {
      tenantId: src.tenantId,
      cargoReceiptId: receipt.id,
      shipmentCargoLineId: line.id,
      receivedCtnQty: 20,
      lineStatus: 'ACCEPTED',
    },
  });

  return shipment.id;
}

beforeAll(async () => {
  const source = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null, loadingType: 'FCL', shipmentType: 'SEA' },
    select: { id: true, tenantId: true },
  });
  tenantId = source.tenantId;
  userId = (
    await owner.user.findFirstOrThrow({
      where: { tenantId, isSuperadmin: true, deletedAt: null },
      select: { id: true },
    })
  ).id;

  const vessel = await owner.vessel.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true },
  });

  twinA = await twin(source, `BKGX-${RUN}-A`, { vesselId: vessel.id, voyageNo: 'V-CONS-1' });
  twinB = await twin(source, `BKGX-${RUN}-B`, { vesselId: vessel.id, voyageNo: 'V-CONS-1' });
  otherVoyage = await twin(source, `BKGX-${RUN}-C`, { vesselId: vessel.id, voyageNo: 'V-CONS-2' });
});

afterAll(async () => {
  if (made.length > 0) {
    await owner.cargoReceiptLine.deleteMany({ where: { cargoLine: { shipmentId: { in: made } } } });
    await owner.cargoReceipt.deleteMany({ where: { shipmentId: { in: made } } });
    await owner.shipmentCargoLine.deleteMany({ where: { shipmentId: { in: made } } });
    await owner.shipmentPo.deleteMany({ where: { shipmentId: { in: made } } });
    await owner.shipmentScheduleLeg.deleteMany({
      where: { schedule: { shipmentId: { in: made } } },
    });
    await owner.shipmentSchedule.deleteMany({ where: { shipmentId: { in: made } } });
    await owner.shipment.deleteMany({ where: { id: { in: made } } });
  }
  await owner.$disconnect();
});

describe('reading the sailing out of the database', () => {
  it('finds vessel and voyage on the approved schedule', async () => {
    const [a] = await withTenant(tenantId, (db) => loadCandidates(db, [twinA]));
    expect(a).toBeDefined();
    expect(a!.vesselId).not.toBeNull();
    expect(a!.voyageNo).toBe('V-CONS-1');
    expect(a!.vesselName).not.toBeNull();
    expect(a!.cutOffDate).not.toBeNull();
  });

  it('carries the lane, carrier and loading type through', async () => {
    const [a] = await withTenant(tenantId, (db) => loadCandidates(db, [twinA]));
    expect(a!.polId).toBeTypeOf('bigint');
    expect(a!.podId).toBeTypeOf('bigint');
    expect(a!.carrierId).toBeTypeOf('bigint');
    expect(a!.family).toBe('FCL');
    expect(a!.polName.length).toBeGreaterThan(0);
  });

  it('counts only accepted cargo from confirmed receipts', async () => {
    const [a] = await withTenant(tenantId, (db) => loadCandidates(db, [twinA]));
    expect(a!.receivedCtnQty).toBe(20);
    // 50x50x50cm = 0.125 CBM a carton.
    expect(a!.receivedCbm).toBeCloseTo(20 * 0.125, 3);
  });

  it('reads the CFS location off the receipt', async () => {
    const [a] = await withTenant(tenantId, (db) => loadCandidates(db, [twinA]));
    expect(a!.cfsLocations).toEqual(['CFS Alpha']);
  });
});

describe('the rules, against real rows', () => {
  it('lets two bookings on one sailing consolidate', async () => {
    const candidates = await withTenant(tenantId, (db) => loadCandidates(db, [twinA, twinB]));
    expect(candidates).toHaveLength(2);
    const problems = checkCompatibility(candidates);
    expect(isCompatible(problems), JSON.stringify(problems)).toBe(true);
  });

  it('refuses the same vessel on a different voyage', async () => {
    const candidates = await withTenant(tenantId, (db) => loadCandidates(db, [twinA, otherVoyage]));
    const problems = checkCompatibility(candidates).filter((p) => p.blocking);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toMatch(/V-CONS-2/);
  });

  it('is what the write gate enforces, not just the read', async () => {
    // §14: the API validates at save time whatever the screen did.
    await expect(
      withTenant(tenantId, (db) => assertConsolidatable(db, [twinA, otherVoyage])),
    ).rejects.toThrow(/V-CONS-2/);

    const ok = await withTenant(tenantId, (db) => assertConsolidatable(db, [twinA, twinB]));
    expect(ok).toHaveLength(2);
  });

  it('refuses a booking that is not ours', async () => {
    // RLS has already hidden it, so it reads as missing rather than denied —
    // which is the right answer either way.
    const stranger = await owner.shipment.findFirst({
      where: { tenantId: { not: tenantId }, deletedAt: null },
      select: { id: true },
    });
    if (stranger === null) return; // single-tenant dev database
    await expect(
      withTenant(tenantId, (db) => assertConsolidatable(db, [twinA, stranger.id])),
    ).rejects.toThrow(/no longer available/);
  });
});
