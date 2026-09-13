import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { allocate, availableCartons, deallocate } from './clp-allocate';
import { withTenant } from './tenant-client';

/**
 * CLP Phase C — the arithmetic that decides what goes into a steel box.
 *
 * MODULE_CLP.md names this as the phase that carries the risk: "everything
 * else is screens; that one is arithmetic ... and the rounding rule is where
 * it will fail quietly if it fails." So these were written before the service
 * and they describe the contract rather than the implementation.
 *
 * Two rules run through all of it:
 *
 *   §2.4 — the pool is what was RECEIVED and accepted, never what was booked.
 *   §2.3 — the carton is the only quantity anyone types; pieces and weights
 *          follow, and the last allocation of a line carries the remainder so
 *          the parts sum back to the whole exactly.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

let tenantId: bigint;
let shipmentId: bigint;
let containerSizeId: bigint;
let carrierId: bigint;

let poId: bigint;
let cargoLineId: bigint;
let receiptId: bigint;
let declinedReceiptId: bigint;
let clpA: bigint;
let clpB: bigint;
let userId: bigint;

/** The client's own PO-003: 5,000 pieces and 300 cartons. */
const BOOKED_CTN = 300;
const BOOKED_PCS = 5000;
const BOOKED_NWT = '3520.500';
const BOOKED_GWT = '3620.250';

/** Unique per run: a crashed run must not block the next one. */
const RUN = Date.now().toString().slice(-6);
let seq = Number(RUN.slice(-4)) + 7000;

async function makeClp(): Promise<bigint> {
  seq += 1;
  const row = await owner.clp.create({
    data: {
      tenantId,
      code: `CLPALLOC-${RUN}-${seq}`,
      seriesYear: 2026,
      clpSeq: seq,
      shipmentId,
      containerSizeId,
      carrierId,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Wipes every allocation and receipt line, leaving the booked line in place.
 *
 * Also puts the plans back to DRAFT. One case cancels clpA to prove the
 * cartons come back, and without this every case after it would fail on a
 * plan somebody else retired.
 */
async function reset(received: number, declined = 0): Promise<void> {
  await owner.clpLine.deleteMany({ where: { shipmentCargoLineId: cargoLineId } });
  await owner.cargoReceiptLine.deleteMany({
    where: { cargoReceiptId: { in: [receiptId, declinedReceiptId] } },
  });

  const plans = [clpA, clpB].filter((id): id is bigint => id !== undefined);
  if (plans.length > 0) {
    await owner.clp.updateMany({
      where: { id: { in: plans } },
      data: {
        status: 'DRAFT',
        cancelledAt: null,
        cancelledBy: null,
        cancelReason: null,
        totalCtnQty: 0,
        totalPcsQty: null,
        totalNetWeightKg: null,
        totalGrossWeightKg: null,
        totalVolumeCbm: null,
        volumeUtilisation: null,
        weightUtilisation: null,
      },
    });
  }

  await owner.cargoReceiptLine.create({
    data: {
      tenantId,
      cargoReceiptId: receiptId,
      shipmentCargoLineId: cargoLineId,
      receivedCtnQty: received,
      lineStatus: 'ACCEPTED',
    },
  });
  if (declined > 0) {
    // A second delivery, refused. One receipt holds one line per cargo line,
    // which is also how it happens: goods turn up twice and only one lot is
    // taken in.
    await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: declinedReceiptId,
        shipmentCargoLineId: cargoLineId,
        receivedCtnQty: declined,
        lineStatus: 'DECLINED',
        // cargo_receipt_line_decline_ck — a refusal says why, as it should.
        declineReason: 'Wet cartons.',
      },
    });
  }
}

const run = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(tenantId, fn);

const put = (clpId: bigint, ctnQty: number) =>
  run((db) => allocate(db, { tenantId, userId: null }, { cargoLineId, clpId, ctnQty }));

/** Every allocation of the line, oldest first. */
async function lines() {
  return owner.clpLine.findMany({
    where: { shipmentCargoLineId: cargoLineId, deletedAt: null },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      clpId: true,
      ctnQty: true,
      pcsQty: true,
      netWeightKg: true,
      grossWeightKg: true,
      volumeCbm: true,
      isSplit: true,
      isFinalAllocation: true,
    },
  });
}

beforeAll(async () => {
  const shipment = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true, tenantId: true, carrierId: true },
  });
  shipmentId = shipment.id;
  tenantId = shipment.tenantId;
  carrierId = shipment.carrierId;

  userId = (
    await owner.user.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true } })
  ).id;

  containerSizeId = (
    await owner.containerSize.findFirstOrThrow({
      where: { code: '20STD', deletedAt: null },
      select: { id: true },
    })
  ).id;

  poId = (
    await owner.shipmentPo.create({
      data: { tenantId, shipmentId, poNo: `PO-CLP-${RUN}` },
      select: { id: true },
    })
  ).id;

  cargoLineId = (
    await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId,
        shipmentPoId: poId,
        itemCode: 'CLP-ALLOC',
        sku: 'SKU-1',
        ctnQty: BOOKED_CTN,
        pcsQty: BOOKED_PCS,
        netWeightKg: BOOKED_NWT,
        grossWeightKg: BOOKED_GWT,
        cartonLengthCm: '60',
        cartonWidthCm: '40',
        cartonHeightCm: '30',
      },
      select: { id: true },
    })
  ).id;

  receiptId = (
    await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRALLOC-${RUN}`,
        seriesYear: 2026,
        shipmentId,
        receiptSeq: 9001,
        receiveDate: new Date('2026-09-13'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: userId,
      },
      select: { id: true },
    })
  ).id;

  declinedReceiptId = (
    await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRALLOC-${RUN}-D`,
        seriesYear: 2026,
        shipmentId,
        receiptSeq: 9002,
        receiveDate: new Date('2026-09-13'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: userId,
      },
      select: { id: true },
    })
  ).id;

  clpA = await makeClp();
  clpB = await makeClp();
});

beforeEach(async () => {
  await reset(BOOKED_CTN);
});

afterAll(async () => {
  // Guarded: if setup failed these are undefined, and a cleanup that throws
  // buries the error that actually mattered.
  if (cargoLineId !== undefined) {
    await owner.clpLine.deleteMany({ where: { shipmentCargoLineId: cargoLineId } });
  }
  const plans = [clpA, clpB].filter((id): id is bigint => id !== undefined);
  if (plans.length > 0) await owner.clp.deleteMany({ where: { id: { in: plans } } });
  const receipts = [receiptId, declinedReceiptId].filter(
    (id): id is bigint => id !== undefined,
  );
  if (receipts.length > 0) {
    await owner.cargoReceiptLine.deleteMany({ where: { cargoReceiptId: { in: receipts } } });
    await owner.cargoReceipt.deleteMany({ where: { id: { in: receipts } } });
  }
  if (cargoLineId !== undefined) {
    await owner.shipmentCargoLine.deleteMany({ where: { id: cargoLineId } });
  }
  if (poId !== undefined) await owner.shipmentPo.deleteMany({ where: { id: poId } });
  await owner.$disconnect();
});

// ===========================================================================
describe('the pool is what arrived — §2.4', () => {
  it('offers the received quantity, not the booked one', async () => {
    await reset(280);
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(280);
  });

  it('ignores a declined receipt line', async () => {
    await reset(200, 80);
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(200);
  });

  it('ignores a receipt that is still a draft', async () => {
    await reset(300);
    await owner.cargoReceipt.update({ where: { id: receiptId }, data: { status: 'DRAFT' } });
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(0);
    await owner.cargoReceipt.update({ where: { id: receiptId }, data: { status: 'CONFIRMED' } });
  });

  it('shrinks as cartons are allocated', async () => {
    await put(clpA, 120);
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(180);
  });
});

// ===========================================================================
describe('conservation — §4.1', () => {
  it('refuses more cartons than are left, and says how many that is', async () => {
    await reset(280);
    await put(clpA, 240);

    await expect(put(clpB, 80)).rejects.toThrow(
      new RegExp(`PO-CLP-${RUN} has 40 cartons left to allocate\. You entered 80\.`),
    );
  });

  it('refuses the very first allocation if it exceeds the pool', async () => {
    await reset(280);
    await expect(put(clpA, 300)).rejects.toThrow(/280 cartons left/);
  });

  it('allows allocating exactly the balance', async () => {
    await reset(280);
    await put(clpA, 280);
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(0);
  });

  it('lets a cancelled plan give its cartons back', async () => {
    await put(clpA, 300);
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(0);

    await owner.clp.update({
      where: { id: clpA },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: userId,
        cancelReason: 'Vessel rolled.',
      },
    });
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(300);
  });

  it('waits for another planner already holding the line', async () => {
    /*
      §4.1: "two planners on the same booking in two tabs is the realistic
      case, and last-write-wins means cartons loaded twice on paper and a
      container that will not close."

      Racing two calls and hoping they collide proves nothing: written that
      way, this passed with the service's lock removed, because the two never
      actually overlapped.

      Holding the row FOR UPDATE proved nothing either — that mode conflicts
      with the KEY SHARE lock the foreign key takes when clp_line inserts, so
      the test was measuring the FK rather than the service.

      FOR NO KEY UPDATE is the discriminator: it conflicts with the service's
      FOR UPDATE and with nothing else in this path. Take that line out of
      allocate() and this test fails, which is the only reason to trust it.
    */
    await reset(100);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM shipment_cargo_line WHERE id = ${cargoLineId} FOR NO KEY UPDATE`;
        await held;
      },
      { timeout: 30_000 },
    );

    // Let the holding transaction actually take the lock before we contend.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const attempt = put(clpA, 100);
    const outcome = await Promise.race([
      attempt.then(() => 'allocated' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 1500)),
    ]);
    expect(outcome).toBe('blocked');

    release();
    await holder;
    await attempt;

    // And having waited, it sees the true balance rather than a stale one.
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(0);
  });

  it('never lets two allocations exceed what arrived', async () => {
    await reset(100);
    const results = await Promise.allSettled([put(clpA, 100), put(clpB, 100)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await lines()).reduce((sum, l) => sum + l.ctnQty, 0)).toBe(100);
  });
});

// ===========================================================================
describe('the carton decides everything else — §2.3', () => {
  it('derives pieces and weights for an intermediate split', async () => {
    await put(clpA, 100);
    const [first] = await lines();

    // 5,000 / 300 = 16.666667 per carton; 100 cartons rounds to 1,667.
    expect(first?.pcsQty).toBe(1667);
    expect(first?.isSplit).toBe(true);
    expect(first?.isFinalAllocation).toBe(false);
  });

  it('marks a whole-line allocation as final and not a split', async () => {
    await put(clpA, 300);
    const [only] = await lines();
    expect(only?.isSplit).toBe(false);
    expect(only?.isFinalAllocation).toBe(true);
    expect(only?.pcsQty).toBe(BOOKED_PCS);
  });

  it('reconciles three uneven splits exactly — the headline rule', async () => {
    const clpC = await makeClp();
    try {
      await put(clpA, 100);
      await put(clpB, 120);
      await put(clpC, 80); // completes the line

      const rows = await lines();
      expect(rows.map((r) => r.ctnQty)).toEqual([100, 120, 80]);

      expect(rows.reduce((s, r) => s + (r.pcsQty ?? 0), 0)).toBe(BOOKED_PCS);
      expect(
        rows.reduce((s, r) => s + Number(r.netWeightKg ?? 0), 0).toFixed(3),
      ).toBe(Number(BOOKED_NWT).toFixed(3));
      expect(
        rows.reduce((s, r) => s + Number(r.grossWeightKg ?? 0), 0).toFixed(3),
      ).toBe(Number(BOOKED_GWT).toFixed(3));

      const booked = await owner.shipmentCargoLine.findFirstOrThrow({
        where: { id: cargoLineId },
        select: { volumeCbm: true },
      });
      expect(
        rows.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0).toFixed(4),
      ).toBe(Number(booked.volumeCbm).toFixed(4));

      // Only the one that completed the line carries the remainder.
      expect(rows.map((r) => r.isFinalAllocation)).toEqual([false, false, true]);
    } finally {
      await owner.clpLine.deleteMany({ where: { clpId: clpC } });
      await owner.clp.deleteMany({ where: { id: clpC } });
    }
  });

  it('does not hand the remainder to a part-allocated line', async () => {
    // 220 of 300 allocated: nothing is final yet, so nobody absorbs a remainder.
    await put(clpA, 100);
    await put(clpB, 120);

    const rows = await lines();
    expect(rows.every((r) => !r.isFinalAllocation)).toBe(true);
    expect(rows.reduce((s, r) => s + (r.pcsQty ?? 0), 0)).toBeLessThan(BOOKED_PCS);
  });

  it('merges a second allocation into the same container', async () => {
    // One row per cargo line per container: two allocations into one box is
    // one allocation with a bigger number.
    await put(clpA, 100);
    await put(clpA, 50);

    const rows = await lines();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ctnQty).toBe(150);
  });

  it('snapshots the PO and carton size for the printed document', async () => {
    await put(clpA, 100);
    const row = await owner.clpLine.findFirstOrThrow({
      where: { shipmentCargoLineId: cargoLineId },
      select: { poNo: true, itemCode: true, sku: true, cartonLengthCm: true },
    });
    expect(row.poNo).toBe(`PO-CLP-${RUN}`);
    expect(row.itemCode).toBe('CLP-ALLOC');
    expect(row.sku).toBe('SKU-1');
    expect(Number(row.cartonLengthCm)).toBe(60);
  });
});

// ===========================================================================
describe('removing an allocation recomputes the rest — §2.3', () => {
  it('moves the remainder to whichever allocation is last now', async () => {
    const clpC = await makeClp();
    try {
      await put(clpA, 100);
      await put(clpB, 120);
      await put(clpC, 80);

      const before = await lines();
      expect(before[2]?.isFinalAllocation).toBe(true);

      // Take out the middle one. The line is no longer fully allocated, so
      // nothing should be carrying a remainder at all.
      await run((db) => deallocate(db, { tenantId, userId: null }, before[1]!.id));

      const after = await lines();
      expect(after.map((r) => r.ctnQty)).toEqual([100, 80]);
      expect(after.every((r) => !r.isFinalAllocation)).toBe(true);
      expect(after.reduce((s, r) => s + (r.pcsQty ?? 0), 0)).toBeLessThan(BOOKED_PCS);

      // Put the balance back and the parts reconcile again.
      await put(clpB, 120);
      const healed = await lines();
      expect(healed.reduce((s, r) => s + (r.pcsQty ?? 0), 0)).toBe(BOOKED_PCS);
      expect(healed.filter((r) => r.isFinalAllocation)).toHaveLength(1);
    } finally {
      await owner.clpLine.deleteMany({ where: { clpId: clpC } });
      await owner.clp.deleteMany({ where: { id: clpC } });
    }
  });

  it('releases the cartons back to the pool', async () => {
    await put(clpA, 120);
    const [row] = await lines();
    await run((db) => deallocate(db, { tenantId, userId: null }, row!.id));
    expect(await run((db) => availableCartons(db, cargoLineId))).toBe(300);
  });
});

// ===========================================================================
describe('the plan keeps its own totals — §3.2', () => {
  it('rolls up cartons, pieces and volume onto the CLP', async () => {
    await put(clpA, 150);
    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clpA },
      select: { totalCtnQty: true, totalPcsQty: true, totalVolumeCbm: true },
    });
    expect(plan.totalCtnQty).toBe(150);
    expect(plan.totalPcsQty).toBe(2500);
    // 150 cartons of 60x40x30cm = 0.072 CBM each.
    expect(Number(plan.totalVolumeCbm)).toBeCloseTo(10.8, 4);
  });

  it('reports utilisation against the container it is planned into', async () => {
    // A 20STD holds 28 CBM. 150 cartons is 10.8, so a little under 39%.
    await put(clpA, 150);
    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clpA },
      select: { volumeUtilisation: true },
    });
    expect(Number(plan.volumeUtilisation)).toBeCloseTo(10.8 / 28, 4);
  });

  it('empties the rollups again when the allocation is removed', async () => {
    await put(clpA, 150);
    const [row] = await lines();
    await run((db) => deallocate(db, { tenantId, userId: null }, row!.id));

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clpA },
      select: { totalCtnQty: true, totalVolumeCbm: true },
    });
    expect(plan.totalCtnQty).toBe(0);
    expect(Number(plan.totalVolumeCbm ?? 0)).toBe(0);
  });
});
