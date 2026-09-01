import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { withTenant } from '../lib/tenant-client';

/**
 * Phase A of docs/MODULE_BOOKING_CARGO.md — the measurement arithmetic.
 *
 * §8 asks for tests here by name, and gives the reason: chargeable weight is
 * what the airline bills, so a silent error becomes a billing dispute rather
 * than a visible bug. §2.3 puts the maths in Postgres precisely so that sales,
 * operations and accounts cannot each arrive at a different number.
 *
 * The unit is the thing most worth pinning. Carton dimensions are entered in
 * CENTIMETRES (confirmed 2026-09-02, §9 Q2). Read as metres, every CBM in the
 * product would be wrong by a factor of a million — and wrong in the direction
 * that looks plausible on a single row.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const SLUG_A = 'cargo-alpha';
const SLUG_B = 'cargo-beta';

let tenantA: bigint;
let tenantB: bigint;
let shipmentA: bigint;
let poA: bigint;
let shipmentB: bigint;
let poB: bigint;

interface CargoInput {
  itemCode: string;
  ctnQty: number;
  grossWeightKg?: string | null;
  l?: number | null;
  w?: number | null;
  h?: number | null;
}

/** A cargo line, and the two figures Postgres computed for it. */
async function addLine(
  tenantId: bigint,
  shipmentId: bigint,
  poId: bigint,
  input: CargoInput,
): Promise<{ volumeCbm: string | null; chargeableWtKg: string | null }> {
  const row = await owner.shipmentCargoLine.create({
    data: {
      tenantId,
      shipmentId,
      shipmentPoId: poId,
      itemCode: input.itemCode,
      ctnQty: input.ctnQty,
      grossWeightKg: input.grossWeightKg ?? null,
      cartonLengthCm: input.l ?? null,
      cartonWidthCm: input.w ?? null,
      cartonHeightCm: input.h ?? null,
    },
    select: { volumeCbm: true, chargeableWtKg: true },
  });
  return {
    volumeCbm: row.volumeCbm === null ? null : row.volumeCbm.toString(),
    chargeableWtKg: row.chargeableWtKg === null ? null : row.chargeableWtKg.toString(),
  };
}

/** Tenant, customer, quotation and a booking to hang cargo off. */
async function makeWorkspace(name: string, slug: string, tag: string) {
  const tenant = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh' },
    select: { id: true },
  });
  const tenantId = tenant.id;

  const sector = await owner.industrySector.create({
    data: { tenantId, code: `CG-SEC-${tag}`, name: 'Cargo Sector' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: `CG-CUS-${tag}`,
      name: 'Cargo Customer',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: `CG-CAR-${tag}`, name: 'Cargo Line', typeId: carrierType.id },
    select: { id: true },
  });
  const port = await owner.port.create({
    data: {
      tenantId,
      code: `CG-PORT-${tag}`,
      name: 'Cargo Port',
      portCode: `ZZC${tag}`,
      country: 'Bangladesh',
      type: 'SEAPORT',
    },
    select: { id: true },
  });
  const source = await owner.inquirySource.findFirstOrThrow({ select: { id: true } });
  const currency = await owner.currency.findFirstOrThrow({ select: { id: true } });

  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: `CG-INQ-${tag}`,
      seriesYear: 2026,
      inquiryDate: new Date('2026-09-02'),
      sourceId: source.id,
      shipmentType: 'AIR',
      customerId: customer.id,
      movementType: 'OUTBOUND',
      polId: port.id,
      podId: port.id,
      status: 'OPEN',
    },
    select: { id: true },
  });
  const quotation = await owner.quotation.create({
    data: {
      tenantId,
      code: `CG-QTN-${tag}`,
      seriesYear: 2026,
      inquiryId: inquiry.id,
      quotationDate: new Date('2026-09-02'),
      customerId: customer.id,
      shipmentType: 'AIR',
      movementType: 'OUTBOUND',
      polId: port.id,
      podId: port.id,
      carrierId: carrier.id,
      localCurrencyId: currency.id,
      conversionRate: '122.0000',
    },
    select: { id: true },
  });

  const shipment = await owner.shipment.create({
    data: {
      tenantId,
      code: `BKG-2026-${tag}`,
      seriesYear: 2026,
      quotationId: quotation.id,
      shipmentType: 'AIR',
      customerId: customer.id,
      exporterName: 'Cargo Exporter Ltd',
      carrierId: carrier.id,
      polId: port.id,
      podId: port.id,
    },
    select: { id: true },
  });
  const po = await owner.shipmentPo.create({
    data: { tenantId, shipmentId: shipment.id, poNo: `PO-${tag}-001` },
    select: { id: true },
  });

  return { tenantId, shipmentId: shipment.id, poId: po.id };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'shipment_cargo_line',
    'shipment_commodity',
    'shipment_po',
    'shipment',
    'quotation',
    'inquiry',
    'customer',
    'industry_sector',
    'carrier',
    'port',
    '"user"',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();
  const a = await makeWorkspace('Cargo Alpha', SLUG_A, 'A');
  const b = await makeWorkspace('Cargo Beta', SLUG_B, 'B');
  tenantA = a.tenantId;
  shipmentA = a.shipmentId;
  poA = a.poId;
  tenantB = b.tenantId;
  shipmentB = b.shipmentId;
  poB = b.poId;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('volume_cbm', () => {
  it('reads carton dimensions as centimetres, not metres', async () => {
    /*
     * The single most consequential line in this module. A normal export
     * carton is 60 x 40 x 30 cm; a hundred of them are 7.2 CBM. Read the same
     * three numbers as metres and the answer is 7,200,000 — the factor of a
     * million that §9 Q2 exists to settle.
     */
    const line = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CBM-CM',
      ctnQty: 100,
      grossWeightKg: '900.000',
      l: 60,
      w: 40,
      h: 30,
    });
    expect(line.volumeCbm).toBe('7.2');
  });

  it('scales with the carton count', async () => {
    const one = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CBM-ONE',
      ctnQty: 1,
      grossWeightKg: '9.000',
      l: 60,
      w: 40,
      h: 30,
    });
    expect(one.volumeCbm).toBe('0.072');
  });

  it('is null while the cartons are unmeasured', async () => {
    const line = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CBM-NONE',
      ctnQty: 50,
      grossWeightKg: '500.000',
    });
    expect(line.volumeCbm).toBeNull();
  });

  it('cannot be written by hand', async () => {
    // The whole point of a generated column (§2.3): no code path, present or
    // future, can put an inconsistent number in this row.
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO shipment_cargo_line
           (tenant_id, shipment_id, shipment_po_id, item_code, ctn_qty, volume_cbm, updated_at)
         VALUES ($1, $2, $3, 'CBM-FORCED', 1, 99, now())`,
        tenantA,
        shipmentA,
        poA,
      ),
    ).rejects.toThrow();
  });
});

describe('chargeable_wt_kg', () => {
  it('bills the volume when the cargo is light and bulky', async () => {
    // 7.2 CBM x 167 = 1202.4 kg volumetric, against 900 kg actual. The airline
    // charges for the space, which is the case the formula exists for.
    const line = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CW-LIGHT',
      ctnQty: 100,
      grossWeightKg: '900.000',
      l: 60,
      w: 40,
      h: 30,
    });
    expect(line.chargeableWtKg).toBe('1202.4');
  });

  it('bills the weight when the cargo is dense', async () => {
    const line = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CW-DENSE',
      ctnQty: 100,
      grossWeightKg: '1500.000',
      l: 60,
      w: 40,
      h: 30,
    });
    expect(line.chargeableWtKg).toBe('1500');
  });

  it('agrees with the CBM on its own row, to the last decimal', async () => {
    /*
     * A fractional carton is where this used to break. Computed at full
     * precision the chargeable weight came out 70.452 while the stored CBM
     * times 167 gives 70.457 — five grams, and an operator who checks the
     * arithmetic on screen finds a number that does not reconcile. The
     * expression rounds to the stored CBM for exactly this reason.
     */
    const line = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CW-FRACTION',
      ctnQty: 10,
      grossWeightKg: '50.000',
      l: 45.5,
      w: 32.25,
      h: 28.75,
    });

    const cbm = Number(line.volumeCbm);
    expect(Number(line.chargeableWtKg)).toBeCloseTo(cbm * 167, 3);
  });

  it('still bills the weight of cargo nobody measured', async () => {
    // GREATEST ignores nulls in Postgres, so an unmeasured line keeps its
    // actual weight rather than collapsing to null.
    const line = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CW-NODIM',
      ctnQty: 50,
      grossWeightKg: '500.000',
    });
    expect(line.chargeableWtKg).toBe('500');
  });

  it('still bills the volume of cargo nobody weighed', async () => {
    const line = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CW-NOWT',
      ctnQty: 100,
      grossWeightKg: null,
      l: 60,
      w: 40,
      h: 30,
    });
    expect(line.chargeableWtKg).toBe('1202.4');
  });

  it('is computed on sea lines too, and simply not shown', async () => {
    // §2.3 says the column appears only on Air screens. That is a screen rule;
    // the database has no reason to hold a different number for a sea line.
    const line = await addLine(tenantA, shipmentA, poA, {
      itemCode: 'CW-SEA',
      ctnQty: 2000,
      grossWeightKg: '18000.000',
      l: 60,
      w: 40,
      h: 30,
    });
    expect(line.volumeCbm).toBe('144');
    expect(line.chargeableWtKg).toBe('24048');
  });
});

describe('the guards on a cargo line', () => {
  it('refuses a zero carton dimension', async () => {
    // A zero silently zeroes the CBM and therefore the chargeable weight —
    // the quiet version of the error §2.3 is written against.
    await expect(
      addLine(tenantA, shipmentA, poA, {
        itemCode: 'BAD-DIM',
        ctnQty: 10,
        grossWeightKg: '100.000',
        l: 60,
        w: 0,
        h: 30,
      }),
    ).rejects.toThrow();
  });

  it('refuses a line with no cartons on it', async () => {
    await expect(
      addLine(tenantA, shipmentA, poA, { itemCode: 'BAD-QTY', ctnQty: 0 }),
    ).rejects.toThrow();
  });
});

describe('the guards on a PO', () => {
  it('refuses a rejection with no comment (§5.3)', async () => {
    const po = await owner.shipmentPo.create({
      data: { tenantId: tenantA, shipmentId: shipmentA, poNo: 'PO-REJECT-1' },
      select: { id: true },
    });
    await expect(
      owner.shipmentPo.update({
        where: { id: po.id },
        data: { approvalStatus: 'REJECTED', approvedBy: null, approvedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('refuses a decision with nobody attached to it', async () => {
    const po = await owner.shipmentPo.create({
      data: { tenantId: tenantA, shipmentId: shipmentA, poNo: 'PO-DECIDE-1' },
      select: { id: true },
    });
    await expect(
      owner.shipmentPo.update({
        where: { id: po.id },
        data: { approvalStatus: 'APPROVED' },
      }),
    ).rejects.toThrow();
  });

  it('lets the same PO number come back after the first was removed', async () => {
    /*
     * §4.1 asks for UNIQUE(tenant_id, shipment_id, po_no). Declared partial on
     * deleted_at, because with soft delete a plain unique lets a PO removed by
     * mistake hold its own number hostage — the bug
     * 20260830090000_local_charge_ignores_retired had to undo.
     */
    const first = await owner.shipmentPo.create({
      data: { tenantId: tenantA, shipmentId: shipmentA, poNo: 'PO-REUSE-1' },
      select: { id: true },
    });
    await owner.shipmentPo.update({
      where: { id: first.id },
      data: { deletedAt: new Date(), isActive: false },
    });

    const second = await owner.shipmentPo.create({
      data: { tenantId: tenantA, shipmentId: shipmentA, poNo: 'PO-REUSE-1' },
      select: { id: true },
    });
    expect(second.id).not.toBe(first.id);
  });

  it('still refuses two live POs with the same number', async () => {
    await owner.shipmentPo.create({
      data: { tenantId: tenantA, shipmentId: shipmentA, poNo: 'PO-DUP-1' },
    });
    await expect(
      owner.shipmentPo.create({
        data: { tenantId: tenantA, shipmentId: shipmentA, poNo: 'PO-DUP-1' },
      }),
    ).rejects.toThrow();
  });
});

describe('workspace isolation (§7A rule 4)', () => {
  it('shows one workspace none of the other’s shipments', async () => {
    await addLine(tenantB, shipmentB, poB, {
      itemCode: 'B-ONLY',
      ctnQty: 5,
      grossWeightKg: '50.000',
      l: 60,
      w: 40,
      h: 30,
    });

    await withTenant(tenantA, async (db) => {
      expect(await db.shipment.count({ where: { id: shipmentB } })).toBe(0);
      expect(await db.shipmentPo.count({ where: { id: poB } })).toBe(0);
      expect(await db.shipmentCargoLine.count({ where: { itemCode: 'B-ONLY' } })).toBe(0);
    });

    await withTenant(tenantB, async (db) => {
      expect(await db.shipment.count({ where: { id: shipmentA } })).toBe(0);
      expect(await db.shipmentCargoLine.count({ where: { itemCode: 'CW-LIGHT' } })).toBe(0);
      // ...and its own row is right there, so the count above is isolation
      // rather than an empty table.
      expect(await db.shipmentCargoLine.count({ where: { itemCode: 'B-ONLY' } })).toBe(1);
    });
  });

  it('refuses a booking that reaches for another workspace’s port', async () => {
    // §4 rule 10's safety net: port is system-capable, so the foreign key is
    // single-column and the trigger is what makes the tenant claim true.
    const theirPort = await owner.port.findFirstOrThrow({
      where: { tenantId: tenantB },
      select: { id: true },
    });
    await expect(
      withTenant(tenantA, async (db) => {
        await db.shipment.update({
          where: { id: shipmentA },
          data: { polId: theirPort.id },
        });
      }),
    ).rejects.toThrow();
  });
});
