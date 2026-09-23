import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * CLP Phase A — the numbers the load plan is built on.
 *
 * MODULE_CLP.md §2.3 makes the carton the only quantity a user types; pieces,
 * weights and volume are derived from it. That only holds if the per-carton
 * values are exact enough for the parts to sum back to the whole, so this
 * pins the arithmetic before Phase C builds allocation on top of it.
 *
 * Against the real database rather than in JavaScript, because these are
 * generated columns — what Postgres computes is the only answer that matters.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

let tenantId: bigint;
let shipmentId: bigint;
let poId: bigint;
const made: bigint[] = [];

beforeAll(async () => {
  // Any tenant with a shipment and a PO will do — this asserts arithmetic, not
  // tenancy, and the rows are removed again below.
  const po = await owner.shipmentPo.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true, tenantId: true, shipmentId: true },
  });
  poId = po.id;
  tenantId = po.tenantId;
  shipmentId = po.shipmentId;
});

afterAll(async () => {
  if (made.length > 0) {
    await owner.shipmentCargoLine.deleteMany({ where: { id: { in: made } } });
  }
  await owner.$disconnect();
});

/** A cargo line with the measurements this module divides by. */
async function cargoLine(fields: {
  ctnQty: number;
  pcsQty?: number;
  netWeightKg?: string;
  grossWeightKg?: string;
  cm?: [string, string, string];
}) {
  const [l, w, h] = fields.cm ?? ['100', '50', '40'];
  const row = await owner.shipmentCargoLine.create({
    data: {
      tenantId,
      shipmentId,
      shipmentPoId: poId,
      itemCode: 'CLP-PHASE-A',
      ctnQty: fields.ctnQty,
      pcsQty: fields.pcsQty ?? null,
      netWeightKg: fields.netWeightKg ?? null,
      grossWeightKg: fields.grossWeightKg ?? null,
      cartonLengthCm: l,
      cartonWidthCm: w,
      cartonHeightCm: h,
    },
    select: {
      id: true,
      ctnQty: true,
      pcsQty: true,
      volumeCbm: true,
      pcsPerCarton: true,
      netWeightPerCarton: true,
      grossWeightPerCarton: true,
      cbmPerCarton: true,
    },
  });
  made.push(row.id);
  return row;
}

describe('per-carton values, computed by the database', () => {
  it("divides the client's own PO-003 to six places", async () => {
    // 5,000 pieces across 300 cartons — the example the spec names, and the
    // reason four decimals is not enough.
    const line = await cargoLine({ ctnQty: 300, pcsQty: 5000 });
    expect(line.pcsPerCarton?.toString()).toBe('16.666667');
  });

  it('divides weights the same way', async () => {
    const line = await cargoLine({
      ctnQty: 300,
      netWeightKg: '3520.500',
      grossWeightKg: '3620.250',
    });
    expect(line.netWeightPerCarton?.toString()).toBe('11.735');
    expect(line.grossWeightPerCarton?.toString()).toBe('12.0675');
  });

  it("carries one carton's own volume, which rebuilds the line total", async () => {
    // The spec writes volume_cbm / ctn_qty, which Postgres refuses — a
    // generated column cannot read another. This is the same number.
    const line = await cargoLine({ ctnQty: 7, cm: ['120', '80', '105'] });
    const perCarton = Number(line.cbmPerCarton);
    expect(perCarton).toBeCloseTo((120 * 80 * 105) / 1_000_000, 9);
    expect(perCarton * line.ctnQty).toBeCloseTo(Number(line.volumeCbm), 6);
  });

  it('leaves per-carton null where the total it divides is null', async () => {
    // A line booked without a piece count is ordinary; inventing 0 per carton
    // would make an allocation claim pieces that were never declared.
    const line = await cargoLine({ ctnQty: 10 });
    expect(line.pcsPerCarton).toBeNull();
    expect(line.netWeightPerCarton).toBeNull();
  });

  it('never has to divide by zero, because the row cannot exist', async () => {
    // shipment_cargo_line_ctn_qty_ck already forbids it, so the NULLIF in the
    // generated expressions is defence in depth rather than the only guard.
    // Worth pinning: drop that constraint and the division silently starts
    // producing nulls on rows that used to be impossible.
    await expect(cargoLine({ ctnQty: 0, pcsQty: 100 })).rejects.toThrow(/ctn_qty/);
  });

  it('reconciles an uneven three-way split exactly — §2.3', async () => {
    /*
      The rule Phase C implements, asserted on the arithmetic Phase A provides:
      intermediate splits round, and the last one takes the remainder. Written
      here because the columns are what make it possible, and a change to their
      precision should fail this rather than surface as a lost piece later.
    */
    const line = await cargoLine({ ctnQty: 300, pcsQty: 5000 });
    const perCarton = Number(line.pcsPerCarton);

    const first = Math.round(perCarton * 100);
    const second = Math.round(perCarton * 120);
    const last = (line.pcsQty ?? 0) - first - second; // 80 cartons, the remainder

    expect(first + second + last).toBe(5000);
    // And the remainder is a believable figure for 80 cartons, not a dumping
    // ground — within one piece of the rounded share.
    expect(Math.abs(last - Math.round(perCarton * 80))).toBeLessThanOrEqual(1);
  });
});

describe('container capacity — MODULE_CLP.md §3.1', () => {
  it("seeds the client's four sizes with their limits", async () => {
    const sizes = await owner.containerSize.findMany({
      where: { code: { in: ['20STD', '40STD', '40HC', '45FT'] }, deletedAt: null },
      select: { code: true, maxVolumeCbm: true, maxWeightKg: true },
    });
    const byCode = new Map(sizes.map((s) => [s.code, s]));

    // 20STD, 40STD and 40HC took 26,000 kg until 20260924090000.
    expect(byCode.get('20STD')?.maxVolumeCbm?.toString()).toBe('28');
    expect(byCode.get('20STD')?.maxWeightKg?.toString()).toBe('30000');
    expect(byCode.get('40STD')?.maxVolumeCbm?.toString()).toBe('65');
    expect(byCode.get('40STD')?.maxWeightKg?.toString()).toBe('30000');
    expect(byCode.get('40HC')?.maxVolumeCbm?.toString()).toBe('72');
    expect(byCode.get('40HC')?.maxWeightKg?.toString()).toBe('30000');
    expect(byCode.get('45FT')?.maxVolumeCbm?.toString()).toBe('80');
    expect(byCode.get('45FT')?.maxWeightKg?.toString()).toBe('30000');
  });

  it('allows a size with no capacity recorded, rather than assuming one', async () => {
    // §4.2 has to tell a planner the limit is unknown. It cannot do that if the
    // column refuses to be empty, and it must never read empty as unlimited.
    const size = await owner.containerSize.create({
      data: { tenantId, code: 'CLPTEST-NC', name: 'No capacity recorded' },
      select: { id: true, maxVolumeCbm: true, maxWeightKg: true },
    });
    expect(size.maxVolumeCbm).toBeNull();
    expect(size.maxWeightKg).toBeNull();
    await owner.containerSize.delete({ where: { id: size.id } });
  });
});
