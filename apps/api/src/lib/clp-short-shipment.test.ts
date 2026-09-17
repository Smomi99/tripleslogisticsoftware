import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { allocate } from './clp-allocate';
import { withTenant } from './tenant-client';

/**
 * A short shipment — reported from the product, 2026-09-14.
 *
 * 200 cartons booked at 33.00 CBM; 180 arrived; split 169 + 11 across two
 * containers. The first took 169 x 0.165 = 27.885 CBM correctly. The second
 * was handed 5.115 CBM for 11 cartons that measure 1.815, because the
 * "whatever is left" remainder was computed against the BOOKED total while
 * the line was judged complete against what was RECEIVED. The 3.30 CBM
 * belonging to the 20 undelivered cartons landed on the last container.
 *
 * That figure is declared to the carrier, so this is the exact scenario.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const RUN = Date.now().toString().slice(-6);

let tenantId: bigint;
let shipmentId: bigint;
let carrierId: bigint;
let userId: bigint;
let poId: bigint;
let receiptId: bigint;
let size20: bigint;
let size40: bigint;

const BOOKED = 200;
const RECEIVED = 180;
/** 55 x 50 x 60 cm = 0.165 CBM, the rate the reported figures imply. */
const PER_CARTON = 0.165;

let seq = 0;
const madeClps: bigint[] = [];
const madeLines: bigint[] = [];

async function makeClp(sizeId: bigint): Promise<bigint> {
  seq += 1;
  const row = await owner.clp.create({
    data: {
      tenantId,
      code: `CLPSHORT-${RUN}-${seq}`,
      seriesYear: 2026,
      clpSeq: 7500 + seq,
      shipmentId,
      containerSizeId: sizeId,
      carrierId,
      createdBy: userId,
    },
    select: { id: true },
  });
  madeClps.push(row.id);
  return row.id;
}

/**
 * A booked line of BOOKED cartons of which RECEIVED arrived.
 *
 * `measured` mirrors whether the CFS re-measured the cartons on arrival.
 * received_volume_cbm is a GENERATED column — L x W x H x received_ctn — so
 * the way to record a measurement is to record the carton, which is also how
 * the product works. The reported case did not measure, which is why the
 * booked total got reached for.
 */
async function shortLine(measured: { l: number; w: number; h: number } | null): Promise<bigint> {
  const line = await owner.shipmentCargoLine.create({
    data: {
      tenantId,
      shipmentId,
      shipmentPoId: poId,
      itemCode: `SHORT-${RUN}-${madeLines.length}`,
      ctnQty: BOOKED,
      pcsQty: BOOKED * 5,
      grossWeightKg: String(BOOKED * 27.5),
      netWeightKg: String(BOOKED * 25),
      cartonLengthCm: '55',
      cartonWidthCm: '50',
      cartonHeightCm: '60',
    },
    select: { id: true },
  });
  madeLines.push(line.id);

  await owner.cargoReceiptLine.create({
    data: {
      tenantId,
      cargoReceiptId: receiptId,
      shipmentCargoLineId: line.id,
      receivedCtnQty: RECEIVED,
      ...(measured === null
        ? {}
        : {
            cartonLengthCm: String(measured.l),
            cartonWidthCm: String(measured.w),
            cartonHeightCm: String(measured.h),
          }),
      lineStatus: 'ACCEPTED',
    },
  });
  return line.id;
}

const put = (clpId: bigint, cargoLineId: bigint, ctnQty: number) =>
  withTenant(tenantId, (db) => allocate(db, { tenantId, userId }, { cargoLineId, clpId, ctnQty }));

beforeAll(async () => {
  const shipment = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true, tenantId: true, carrierId: true },
  });
  shipmentId = shipment.id;
  tenantId = shipment.tenantId;
  carrierId = shipment.carrierId;

  userId = (
    await owner.user.findFirstOrThrow({
      where: { tenantId, isSuperadmin: true, deletedAt: null },
      select: { id: true },
    })
  ).id;

  size20 = (
    await owner.containerSize.findFirstOrThrow({
      where: { code: '20STD', deletedAt: null },
      select: { id: true },
    })
  ).id;
  size40 = (
    await owner.containerSize.findFirstOrThrow({
      where: { code: '40STD', deletedAt: null },
      select: { id: true },
    })
  ).id;

  poId = (
    await owner.shipmentPo.create({
      data: { tenantId, shipmentId, poNo: `PO-SHORT-${RUN}` },
      select: { id: true },
    })
  ).id;

  receiptId = (
    await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRSHORT-${RUN}`,
        seriesYear: 2026,
        shipmentId,
        receiptSeq: 9400,
        receiveDate: new Date('2026-09-14'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: userId,
      },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  if (madeClps.length > 0) {
    await owner.clpLine.deleteMany({ where: { clpId: { in: madeClps } } });
    await owner.clp.deleteMany({ where: { id: { in: madeClps } } });
    madeClps.length = 0;
  }
});

afterAll(async () => {
  await owner.clpLine.deleteMany({ where: { shipmentCargoLineId: { in: madeLines } } });
  await owner.clp.deleteMany({ where: { code: { startsWith: `CLPSHORT-${RUN}` } } });
  await owner.cargoReceiptLine.deleteMany({ where: { shipmentCargoLineId: { in: madeLines } } });
  await owner.shipmentCargoLine.deleteMany({ where: { id: { in: madeLines } } });
  await owner.cargoReceipt.deleteMany({ where: { id: receiptId } });
  await owner.shipmentPo.deleteMany({ where: { id: poId } });
  await owner.$disconnect();
});

describe('when less arrives than was booked', () => {
  it('does not put the undelivered cartons on the last container', async () => {
    // The reported case, to the carton.
    const line = await shortLine(null);
    const first = await makeClp(size20);
    const second = await makeClp(size40);

    await put(first, line, 169);
    await put(second, line, 11);

    const rows = await owner.clpLine.findMany({
      where: { shipmentCargoLineId: line, deletedAt: null },
      orderBy: { id: 'asc' },
      select: { ctnQty: true, volumeCbm: true, isFinalAllocation: true },
    });

    expect(rows).toHaveLength(2);
    expect(Number(rows[0]!.volumeCbm)).toBeCloseTo(169 * PER_CARTON, 4); // 27.8850
    // The bug put 5.1150 here.
    expect(Number(rows[1]!.volumeCbm)).toBeCloseTo(11 * PER_CARTON, 4); // 1.8150
    expect(rows[1]!.isFinalAllocation).toBe(true);
  });

  it('adds up to what arrived, not to what was ordered', async () => {
    const line = await shortLine(null);
    await put(await makeClp(size20), line, 169);
    await put(await makeClp(size40), line, 11);

    const rows = await owner.clpLine.findMany({
      where: { shipmentCargoLineId: line, deletedAt: null },
      select: { volumeCbm: true, grossWeightKg: true, pcsQty: true },
    });

    const cbm = rows.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0);
    const gwt = rows.reduce((s, r) => s + Number(r.grossWeightKg ?? 0), 0);
    const pcs = rows.reduce((s, r) => s + (r.pcsQty ?? 0), 0);

    expect(cbm).toBeCloseTo(RECEIVED * PER_CARTON, 4); // 29.70, not 33.00
    expect(gwt).toBeCloseTo(RECEIVED * 27.5, 3); // 4,950, not 5,500
    expect(pcs).toBe(RECEIVED * 5); // 900, not 1,000
  });

  it('still reconciles exactly when the whole line arrives', async () => {
    // The case that always worked has to keep working: nothing short, so the
    // basis and the booked total are the same number.
    const line = await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId,
        shipmentPoId: poId,
        itemCode: `FULL-${RUN}`,
        ctnQty: 100,
        pcsQty: 500,
        grossWeightKg: '2750',
        netWeightKg: '2500',
        cartonLengthCm: '55',
        cartonWidthCm: '50',
        cartonHeightCm: '60',
      },
      select: { id: true },
    });
    madeLines.push(line.id);
    await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: receiptId,
        shipmentCargoLineId: line.id,
        receivedCtnQty: 100,
        lineStatus: 'ACCEPTED',
      },
    });

    await put(await makeClp(size20), line.id, 70);
    await put(await makeClp(size40), line.id, 30);

    const rows = await owner.clpLine.findMany({
      where: { shipmentCargoLineId: line.id, deletedAt: null },
      select: { volumeCbm: true, grossWeightKg: true },
    });
    const cbm = rows.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0);
    const gwt = rows.reduce((s, r) => s + Number(r.grossWeightKg ?? 0), 0);
    expect(cbm).toBeCloseTo(100 * PER_CARTON, 4);
    expect(gwt).toBeCloseTo(2750, 3);
  });

  it('prefers what the CFS measured over any calculation', async () => {
    /*
      A re-measured carton is what was actually on the tape, so the plan
      reconciles to it rather than to cartons x a booked rate. Here the goods
      arrived slightly smaller than ordered: 54 x 49 x 59 rather than
      55 x 50 x 60.
    */
    const line = await shortLine({ l: 54, w: 49, h: 59 });
    await put(await makeClp(size20), line, 169);
    await put(await makeClp(size40), line, 11);

    const receipt = await owner.cargoReceiptLine.findFirstOrThrow({
      where: { shipmentCargoLineId: line, deletedAt: null },
      select: { receivedVolumeCbm: true },
    });
    const measured = Number(receipt.receivedVolumeCbm);
    // Sanity: the measurement really is different from the booked rate.
    expect(measured).not.toBeCloseTo(RECEIVED * PER_CARTON, 3);

    const rows = await owner.clpLine.findMany({
      where: { shipmentCargoLineId: line, deletedAt: null },
      orderBy: { id: 'asc' },
      select: { volumeCbm: true },
    });
    const cbm = rows.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0);
    expect(cbm).toBeCloseTo(measured, 4);
    // And it is shared out by carton, not dumped on the last one.
    expect(Number(rows[0]!.volumeCbm)).toBeCloseTo((measured / RECEIVED) * 169, 3);
    expect(Number(rows[1]!.volumeCbm)).toBeCloseTo((measured / RECEIVED) * 11, 3);
  });

  it('gives the rounding remainder to the completing allocation, and only that', async () => {
    /*
      §2.3's rule still holds — the parts must sum exactly — but what it hands
      over is now pennies of rounding rather than the difference between an
      order and a delivery.
    */
    // 53 x 49 x 61 is 0.158417 CBM a carton — deliberately not a round number.
    const line = await shortLine({ l: 53, w: 49, h: 61 });
    await put(await makeClp(size20), line, 60);
    await put(await makeClp(size40), line, 60);
    await put(await makeClp(size40), line, 60);

    const receipt = await owner.cargoReceiptLine.findFirstOrThrow({
      where: { shipmentCargoLineId: line, deletedAt: null },
      select: { receivedVolumeCbm: true },
    });
    const measured = Number(receipt.receivedVolumeCbm);

    const rows = await owner.clpLine.findMany({
      where: { shipmentCargoLineId: line, deletedAt: null },
      orderBy: { id: 'asc' },
      select: { volumeCbm: true, isFinalAllocation: true },
    });
    const cbm = rows.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0);
    expect(cbm).toBeCloseTo(measured, 4);

    const even = (measured / RECEIVED) * 60;
    for (const row of rows) {
      // Every share, the last included, is within a rounding step of even.
      expect(Math.abs(Number(row.volumeCbm) - even)).toBeLessThan(0.001);
    }
    expect(rows.filter((r) => r.isFinalAllocation)).toHaveLength(1);
  });
});
