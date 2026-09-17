import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PERMISSIONS } from '@ff/shared';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * CLP Phase B — what the database refuses.
 *
 * MODULE_CLP.md §4.3 makes FINAL immutable: there is no edit path, only cancel
 * and recreate. A rule that final belongs in the database rather than only in
 * a route, so this pins the constraints themselves — the route can be rewritten
 * and these still hold.
 *
 * §2.1's conservation rule is deliberately absent: it spans rows, no CHECK can
 * express it, and it belongs in Phase C's allocate() under FOR UPDATE.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

let tenantId: bigint;
let shipmentId: bigint;
let containerSizeId: bigint;
let carrierId: bigint;
const made: bigint[] = [];

beforeAll(async () => {
  const shipment = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true, tenantId: true, carrierId: true },
  });
  shipmentId = shipment.id;
  tenantId = shipment.tenantId;
  carrierId = shipment.carrierId;

  const size = await owner.containerSize.findFirstOrThrow({
    where: { code: '20STD', deletedAt: null },
    select: { id: true },
  });
  containerSizeId = size.id;
});

afterAll(async () => {
  if (made.length > 0) await owner.clp.deleteMany({ where: { id: { in: made } } });
  await owner.$disconnect();
});

let seq = 9000;

/** A draft plan. `over` pushes it into whatever state the case is about. */
async function clp(over: Record<string, unknown> = {}) {
  seq += 1;
  const row = await owner.clp.create({
    data: {
      tenantId,
      code: `CLPTEST-${seq}`,
      seriesYear: 2026,
      clpSeq: seq,
      shipmentId,
      containerSizeId,
      carrierId,
      ...over,
    },
    select: { id: true, status: true, clpSeq: true },
  });
  made.push(row.id);
  return row;
}

describe('a finalised plan cannot be half-finalised — §4.3', () => {
  it('takes a draft with nothing filled in', async () => {
    const row = await clp();
    expect(row.status).toBe('DRAFT');
  });

  it('refuses FINAL without a container number', async () => {
    await expect(
      clp({
        status: 'FINAL',
        sealNo: 'SEAL-1',
        loadDatetime: new Date(),
        finalisedAt: new Date(),
        finalisedBy: 1n,
      }),
    ).rejects.toThrow(/clp_final_ck/);
  });

  it('refuses FINAL with a blank container number, not merely a null one', async () => {
    // btrim is the half that matters: '   ' satisfies NOT NULL and is not a
    // container number anybody can find on a quay.
    await expect(
      clp({
        status: 'FINAL',
        containerNo: '   ',
        sealNo: 'SEAL-1',
        loadDatetime: new Date(),
        finalisedAt: new Date(),
        finalisedBy: 1n,
      }),
    ).rejects.toThrow(/clp_final_ck/);
  });

  it('refuses FINAL with no record of who finalised it', async () => {
    await expect(
      clp({
        status: 'FINAL',
        containerNo: 'MSKU1234565',
        sealNo: 'SEAL-1',
        loadDatetime: new Date(),
      }),
    ).rejects.toThrow(/clp_final_ck/);
  });

  it('accepts FINAL once the document is actually complete', async () => {
    const row = await clp({
      status: 'FINAL',
      containerNo: 'MSKU1234565',
      sealNo: 'SEAL-1',
      loadDatetime: new Date(),
      finalisedAt: new Date(),
      finalisedBy: 1n,
    });
    expect(row.status).toBe('FINAL');
  });
});

describe('a cancellation always says why — confirmed 2026-09-13', () => {
  it('refuses CANCELLED with no reason', async () => {
    await expect(
      clp({ status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 1n }),
    ).rejects.toThrow(/clp_cancel_ck/);
  });

  it('refuses a whitespace reason', async () => {
    await expect(
      clp({
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: 1n,
        cancelReason: '  ',
      }),
    ).rejects.toThrow(/clp_cancel_ck/);
  });

  it('accepts one that does', async () => {
    const row = await clp({
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy: 1n,
      cancelReason: 'Vessel rolled to next week.',
    });
    expect(row.status).toBe('CANCELLED');
  });
});

describe('a capacity override is a person and a reason, or neither — §4.2', () => {
  it('refuses a reason with nobody behind it', async () => {
    await expect(clp({ capacityOverrideReason: 'Cartons compress.' })).rejects.toThrow(
      /clp_override_ck/,
    );
  });

  it('refuses somebody overriding without saying why', async () => {
    await expect(clp({ capacityOverrideBy: 1n })).rejects.toThrow(/clp_override_ck/);
  });

  it('accepts both together', async () => {
    const row = await clp({
      capacityOverrideBy: 1n,
      capacityOverrideReason: 'Cartons compress; supervisor present.',
    });
    expect(row.status).toBe('DRAFT');
  });
});

describe('numbering — §4.5', () => {
  it('refuses a zeroth container', async () => {
    await expect(clp({ clpSeq: 0 })).rejects.toThrow(/clp_seq_ck/);
  });

  it('refuses two plans sharing a sequence number on one shipment', async () => {
    const first = await clp();
    await expect(
      owner.clp.create({
        data: {
          tenantId,
          code: `CLPTEST-dup-${first.clpSeq}`,
          seriesYear: 2026,
          clpSeq: first.clpSeq,
          shipmentId,
          containerSizeId,
          carrierId,
        },
      }),
    ).rejects.toThrow(/clp_tenant_id_shipment_id_clp_seq_key|Unique constraint/);
  });
});

describe('an allocation of nothing is not an allocation — §3.2', () => {
  it('refuses a line of zero cartons', async () => {
    const plan = await clp();
    const cargo = await owner.shipmentCargoLine.findFirst({
      where: { tenantId, deletedAt: null },
      select: { id: true, shipmentPoId: true },
    });
    if (cargo === null) return; // nothing to allocate against in this database

    await expect(
      owner.clpLine.create({
        data: {
          tenantId,
          clpId: plan.id,
          shipmentCargoLineId: cargo.id,
          shipmentPoId: cargo.shipmentPoId,
          poNo: 'PO-TEST',
          itemCode: 'ITEM',
          ctnQty: 0,
        },
      }),
    ).rejects.toThrow(/clp_line_ctn_qty_ck/);
  });
});

describe('§6 — the actions the module asks for', () => {
  it('registers split, finalise, cancel and the capacity override', async () => {
    const wanted = ['SPLIT', 'FINALISE', 'CANCEL', 'OVERRIDE_CAPACITY', 'EXPORT'];
    const rows = await owner.permission.findMany({
      where: { feature: 'OPERATION.CONTAINER_LOAD_PLAN' },
      select: { action: true },
    });
    const have = new Set(rows.map((r) => r.action));
    for (const action of wanted) expect([...have]).toContain(action);
  });

  it('keeps the code registry and the database in step', async () => {
    // The registry is the source; the database is seeded from it. A feature
    // added to one and not the other is a permission nobody can grant.
    const inCode = PERMISSIONS.filter(
      (p) => p.feature === 'OPERATION.CONTAINER_LOAD_PLAN',
    ).map((p) => p.action);
    const inDb = (
      await owner.permission.findMany({
        where: { feature: 'OPERATION.CONTAINER_LOAD_PLAN' },
        select: { action: true },
      })
    ).map((r) => r.action);
    expect([...inDb].sort()).toEqual([...inCode].sort());
  });
});
