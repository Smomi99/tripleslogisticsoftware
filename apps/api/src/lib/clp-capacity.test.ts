import { CLP_OVER_VOLUME } from '@ff/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { allocate, deallocate } from './clp-allocate';
import { withTenant } from './tenant-client';

/**
 * CLP Phase F — what a container will not take (MODULE_CLP.md §4.2).
 *
 * Both limits block. The difference is what can be done about it: volume
 * yields to a supervisor with a reason, weight never does. Exactly 100% is
 * allowed and only above it is an exception, because the client plans a 20STD
 * to exactly 28.0 CBM and a rule that tripped on that would trip on every plan
 * they make.
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

/*
  0.5 CBM a carton throughout, so 56 cartons is exactly a 20STD's 28 CBM.

  Weight per carton varies by what is being tested, and it has to: at 600 kg a
  carton the box is overweight at 51 cartons — 25.5 CBM — so every "volume"
  case would really have been the weight rule firing in disguise. Light
  cartons isolate volume; heavy ones isolate weight.
*/
const LIGHT_KG = 100;
const HEAVY_KG = 600;

let seq = 8000;
const madeLines: bigint[] = [];
const madeClps: bigint[] = [];

async function cargo(cartons: number, kgPerCtn = LIGHT_KG): Promise<bigint> {
  const line = await owner.shipmentCargoLine.create({
    data: {
      tenantId,
      shipmentId,
      shipmentPoId: poId,
      itemCode: `CAP-${RUN}-${cartons}-${kgPerCtn}`,
      ctnQty: cartons,
      pcsQty: cartons,
      grossWeightKg: String(cartons * kgPerCtn),
      netWeightKg: String(cartons * kgPerCtn),
      // 100 x 100 x 50 cm = 0.5 CBM
      cartonLengthCm: '100',
      cartonWidthCm: '100',
      cartonHeightCm: '50',
    },
    select: { id: true },
  });
  madeLines.push(line.id);

  await owner.cargoReceiptLine.create({
    data: {
      tenantId,
      cargoReceiptId: receiptId,
      shipmentCargoLineId: line.id,
      receivedCtnQty: cartons,
      lineStatus: 'ACCEPTED',
    },
  });
  return line.id;
}

async function makeClp(containerSizeId = size20): Promise<bigint> {
  seq += 1;
  const row = await owner.clp.create({
    data: {
      tenantId,
      code: `CLPCAP-${RUN}-${seq}`,
      seriesYear: 2026,
      clpSeq: seq,
      shipmentId,
      containerSizeId,
      carrierId,
    },
    select: { id: true },
  });
  madeClps.push(row.id);
  return row.id;
}

const put = (clpId: bigint, cargoLineId: bigint, ctnQty: number, reason?: string) =>
  withTenant(tenantId, (db) =>
    allocate(
      db,
      { tenantId, userId },
      {
        cargoLineId,
        clpId,
        ctnQty,
        override: reason === undefined ? null : { reason },
      },
    ),
  );

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

  size20 = (
    await owner.containerSize.findFirstOrThrow({
      where: { code: '20STD', deletedAt: null },
      select: { id: true },
    })
  ).id;

  poId = (
    await owner.shipmentPo.create({
      data: { tenantId, shipmentId, poNo: `PO-CAP-${RUN}` },
      select: { id: true },
    })
  ).id;

  receiptId = (
    await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRCAP-${RUN}`,
        seriesYear: 2026,
        shipmentId,
        receiptSeq: 9100,
        receiveDate: new Date('2026-09-13'),
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
    await owner.clp.updateMany({
      where: { id: { in: madeClps } },
      data: { capacityOverrideBy: null, capacityOverrideReason: null },
    });
  }
});

afterAll(async () => {
  if (madeClps.length > 0) {
    await owner.clpLine.deleteMany({ where: { clpId: { in: madeClps } } });
    await owner.clp.deleteMany({ where: { id: { in: madeClps } } });
  }
  if (madeLines.length > 0) {
    await owner.cargoReceiptLine.deleteMany({
      where: { shipmentCargoLineId: { in: madeLines } },
    });
    await owner.shipmentCargoLine.deleteMany({ where: { id: { in: madeLines } } });
  }
  await owner.cargoReceiptLine.deleteMany({ where: { cargoReceiptId: receiptId } });
  await owner.cargoReceipt.deleteMany({ where: { id: receiptId } });
  await owner.shipmentPo.deleteMany({ where: { id: poId } });
  await owner.$disconnect();
});

describe('volume — blocked, but a supervisor may say otherwise', () => {
  it('takes a load that fits', async () => {
    const line = await cargo(40); // 20.0 CBM into a 28 CBM box
    const clp = await makeClp();
    await put(clp, line, 40);

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { totalVolumeCbm: true },
    });
    expect(Number(plan.totalVolumeCbm)).toBeCloseTo(20, 4);
  });

  it('takes a load that fills it exactly — §4.2 allows 100%', async () => {
    // The client plans a 20STD to exactly 28.0 CBM. Treating full as over
    // would trip on every plan they make.
    const line = await cargo(56); // 56 x 0.5 = 28.00 CBM
    const clp = await makeClp();
    await put(clp, line, 56);

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { totalVolumeCbm: true, volumeUtilisation: true },
    });
    expect(Number(plan.totalVolumeCbm)).toBeCloseTo(28, 4);
    expect(Number(plan.volumeUtilisation)).toBeCloseTo(1, 4);
  });

  it('refuses one carton past it, and says by how much', async () => {
    const line = await cargo(57); // 28.5 CBM
    const clp = await makeClp();

    await expect(put(clp, line, 57)).rejects.toThrow(
      /28\.50 CBM in a 28 CBM 20STD — 0\.50 CBM over/,
    );
  });

  it('points at the way out rather than just refusing', async () => {
    const line = await cargo(57);
    const clp = await makeClp();
    await expect(put(clp, line, 57)).rejects.toThrow(/supervisor can override this with a reason/);
  });

  it('names the refusal, so the screen does not have to read the prose', async () => {
    // The override dialog is offered on this code. Matching the wording
    // instead would remove that path the first time somebody improved the
    // sentence, and nothing would fail.
    const line = await cargo(57);
    const clp = await makeClp();
    await expect(put(clp, line, 57)).rejects.toMatchObject({
      code: CLP_OVER_VOLUME,
      status: 409,
    });
  });

  it('does not use that code for weight, which has no way through', async () => {
    const line = await cargo(51, HEAVY_KG);
    const clp = await makeClp();
    await expect(put(clp, line, 51)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('leaves nothing behind when it refuses', async () => {
    // The check runs after the write, inside the transaction — so a refusal
    // has to unwind the allocation and the rollups with it.
    const line = await cargo(57);
    const clp = await makeClp();
    await expect(put(clp, line, 57)).rejects.toThrow();

    const lines = await owner.clpLine.count({ where: { clpId: clp, deletedAt: null } });
    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { totalCtnQty: true, totalVolumeCbm: true },
    });
    expect(lines).toBe(0);
    expect(plan.totalCtnQty).toBe(0);
    expect(Number(plan.totalVolumeCbm ?? 0)).toBe(0);
  });

  it('goes through with an override, and records who and why', async () => {
    const line = await cargo(57);
    const clp = await makeClp();
    await put(clp, line, 57, 'Cartons compress; supervisor present at stuffing.');

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: {
        totalVolumeCbm: true,
        capacityOverrideBy: true,
        capacityOverrideReason: true,
      },
    });
    expect(Number(plan.totalVolumeCbm)).toBeCloseTo(28.5, 4);
    expect(plan.capacityOverrideBy).toBe(userId);
    expect(plan.capacityOverrideReason).toMatch(/Cartons compress/);
  });

  it('does not brand a container that fits, even if a reason is sent', async () => {
    // The dialog only opens after a refusal, but the endpoint is reachable
    // without it. A reason on a load that fits must not leave the card saying
    // "loaded over capacity" about a perfectly legal container.
    const line = await cargo(40); // 20 CBM into 28
    const clp = await makeClp();
    await put(clp, line, 40, 'Sent for no reason at all.');

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { capacityOverrideBy: true, capacityOverrideReason: true },
    });
    expect(plan.capacityOverrideBy).toBeNull();
    expect(plan.capacityOverrideReason).toBeNull();
  });

  it('clears the override once the cargo comes back out', async () => {
    // The excuse should not outlive the reason for it.
    const over = await cargo(57);
    const fits = await cargo(40);
    const clp = await makeClp();
    await put(clp, over, 57, 'Cartons compress; agreed with the carrier.');

    const line = await owner.clpLine.findFirstOrThrow({
      where: { clpId: clp, deletedAt: null },
      select: { id: true },
    });
    await withTenant(tenantId, (db) => deallocate(db, { tenantId, userId }, line.id));

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { capacityOverrideBy: true, capacityOverrideReason: true },
    });
    expect(plan.capacityOverrideBy).toBeNull();
    expect(plan.capacityOverrideReason).toBeNull();

    // And the container is usable again without one.
    await put(clp, fits, 40);
  });

  it('writes the override to the audit trail', async () => {
    // §4.2 asks for it on the CLP *and* in audit_log. The row trigger does the
    // second part, which is why it cannot be skipped by a code path.
    const line = await cargo(57);
    const clp = await makeClp();
    await put(clp, line, 57, 'Deliberate over-stuff, agreed with the carrier.');

    const trail = await owner.auditLog.findMany({
      where: { tableName: 'clp', recordId: clp },
      select: { newValues: true },
    });
    const said = JSON.stringify(trail);
    expect(said).toMatch(/Deliberate over-stuff/);
  });
});

describe('weight — blocked, and not negotiable', () => {
  it('refuses an overweight container even with a reason', async () => {
    // 51 heavy cartons is 30,600 kg in a 30,000 kg box, and only 25.5 CBM —
    // so this is the weight rule firing on its own, not volume in disguise.
    const line = await cargo(51, HEAVY_KG);
    const clp = await makeClp();

    await expect(
      put(clp, line, 51, 'Supervisor says it is fine.'),
    ).rejects.toThrow(/cannot be overridden/);
  });

  it('names the figures rather than saying "too heavy"', async () => {
    const line = await cargo(51, HEAVY_KG);
    const clp = await makeClp();
    await expect(put(clp, line, 51)).rejects.toThrow(
      /30,600 kg in a 30,000 kg 20STD — 600 kg over/,
    );
  });

  it('takes a container loaded to exactly its payload', async () => {
    const line = await cargo(50, HEAVY_KG); // 30,000 kg exactly, 25 CBM
    const clp = await makeClp();
    await put(clp, line, 50);

    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { weightUtilisation: true },
    });
    expect(Number(plan.weightUtilisation)).toBeCloseTo(1, 4);
  });
});

describe('a size with no capacity recorded', () => {
  it('is allowed through rather than assumed empty or assumed full', async () => {
    // §4.2 cannot check what nobody recorded. The screen says "capacity not
    // set"; the service does not invent a limit to enforce.
    const size = await owner.containerSize.create({
      data: { tenantId, code: `CAPTEST-${RUN}`, name: 'Unmeasured box' },
      select: { id: true },
    });
    const line = await cargo(80); // 40 CBM, 40,000 kg — over any real box
    const clp = await makeClp(size.id);

    await put(clp, line, 80);
    const plan = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { volumeUtilisation: true, weightUtilisation: true },
    });
    expect(plan.volumeUtilisation).toBeNull();
    expect(plan.weightUtilisation).toBeNull();

    await owner.clpLine.deleteMany({ where: { clpId: clp } });
    await owner.clp.deleteMany({ where: { id: clp } });
    await owner.containerSize.delete({ where: { id: size.id } });
  });
});
