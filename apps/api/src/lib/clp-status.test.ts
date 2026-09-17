import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { allocate, availableCartons, cancelClp } from './clp-allocate';
import { signAccessToken } from './jwt';
import { withTenant } from './tenant-client';

/**
 * CLP Phase H — the status machine (MODULE_CLP.md §4.3).
 *
 *     DRAFT → FINAL       needs container_no, seal_no, load_datetime, >= 1 line
 *     DRAFT → CANCELLED   any time, with EDIT
 *     FINAL → CANCELLED   privileged, reason mandatory, blocked once stuffing started
 *     FINAL → (no edit path exists)
 *
 * Two levels on purpose. The HTTP tests prove the rules hold at the boundary
 * — a screen that hides a button proves nothing about a request that does not
 * come from that screen. The service tests prove conservation and locking,
 * which HTTP cannot observe closely enough.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const RUN = Date.now().toString().slice(-6);

let tenantId: bigint;
let slug: string;
let shipmentId: bigint;
let carrierId: bigint;
let userId: bigint;
/** A staff account that is NOT a superadmin — see the planner token below. */
let plannerUserId: bigint;
let poId: bigint;
let receiptId: bigint;
let size20: bigint;
let cargoLineId: bigint;

/** A superadmin, and a planner who holds EDIT but not CANCEL. */
let tokenAll: string;
let tokenPlanner: string;

const FEATURE = 'OPERATION.CONTAINER_LOAD_PLAN';
const CARTONS = 40;

let seq = 0;
const madeClps: bigint[] = [];

function as(token: string) {
  const wrap = (r: request.Test) =>
    r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  return {
    post: (path: string) => wrap(request(app).post(path)),
    patch: (path: string) => wrap(request(app).patch(path)),
    get: (path: string) => wrap(request(app).get(path)),
  };
}

/** A draft plan straight in the database — the transitions are what is under test. */
async function makeClp(): Promise<bigint> {
  seq += 1;
  const row = await owner.clp.create({
    data: {
      tenantId,
      code: `CLPST-${RUN}-${seq}`,
      seriesYear: 2026,
      clpSeq: 7000 + seq,
      shipmentId,
      containerSizeId: size20,
      carrierId,
      createdBy: userId,
    },
    select: { id: true },
  });
  madeClps.push(row.id);
  return row.id;
}

const put = (clpId: bigint, ctnQty: number) =>
  withTenant(tenantId, (db) =>
    allocate(db, { tenantId, userId }, { cargoLineId, clpId, ctnQty }),
  );

const cancel = (clpId: bigint, reason: string, mayCancelFinal = true) =>
  withTenant(tenantId, (db) =>
    cancelClp(db, { tenantId, userId }, { clpId, reason, mayCancelFinal }),
  );

const free = () => withTenant(tenantId, (db) => availableCartons(db, cargoLineId));

/** The §4.3 preconditions, as the finalise endpoint wants them. */
const FINALISE_BODY = {
  containerNo: 'CSQU3054383',
  sealNo: `SL-${RUN}`,
  loadDatetime: '2026-09-14T08:30:00.000Z',
};

beforeAll(async () => {
  const shipment = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true, tenantId: true, carrierId: true },
  });
  shipmentId = shipment.id;
  tenantId = shipment.tenantId;
  carrierId = shipment.carrierId;

  slug = (
    await owner.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { slug: true } })
  ).slug;

  /*
    The superadmin specifically. findFirst on the tenant alone picks up agent
    and customer logins too, and a STAFF router refuses those — which reads as
    a 401 that looks like a broken token rather than the wrong account.
  */
  userId = (
    await owner.user.findFirstOrThrow({
      where: { tenantId, isSuperadmin: true, isActive: true, deletedAt: null },
      select: { id: true },
    })
  ).id;

  /*
    is_superadmin is read from the DATABASE on every request, never from the
    token — so a "planner" token signed for the superadmin would still bypass
    every permission. The planner has to be a different account.
  */
  plannerUserId = (
    await owner.user.findFirstOrThrow({
      where: {
        tenantId,
        isSuperadmin: false,
        isActive: true,
        deletedAt: null,
        agentId: null,
        customerId: null,
        vendorId: null,
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

  tokenAll = await signAccessToken({
    sub: userId.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  /*
    The planner is the point of several tests below: EDIT but NOT CANCEL, so
    "privileged" in §4.3 means something a request can be refused for.
  */
  tokenPlanner = await signAccessToken({
    sub: plannerUserId.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: [
      `${FEATURE}.VIEW`,
      `${FEATURE}.CREATE`,
      `${FEATURE}.EDIT`,
      `${FEATURE}.SPLIT`,
      `${FEATURE}.FINALISE`,
    ],
    tokenVersion: 0,
  });

  poId = (
    await owner.shipmentPo.create({
      data: { tenantId, shipmentId, poNo: `PO-ST-${RUN}` },
      select: { id: true },
    })
  ).id;

  cargoLineId = (
    await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId,
        shipmentPoId: poId,
        itemCode: `ST-${RUN}`,
        ctnQty: CARTONS,
        pcsQty: CARTONS * 10,
        grossWeightKg: String(CARTONS * 10),
        netWeightKg: String(CARTONS * 9),
        // 0.25 CBM a carton: 40 cartons is 10 CBM, comfortably inside a 20STD.
        cartonLengthCm: '100',
        cartonWidthCm: '50',
        cartonHeightCm: '50',
      },
      select: { id: true },
    })
  ).id;

  receiptId = (
    await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRST-${RUN}`,
        seriesYear: 2026,
        shipmentId,
        receiptSeq: 9300,
        receiveDate: new Date('2026-09-13'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: userId,
      },
      select: { id: true },
    })
  ).id;

  await owner.cargoReceiptLine.create({
    data: {
      tenantId,
      cargoReceiptId: receiptId,
      shipmentCargoLineId: cargoLineId,
      receivedCtnQty: CARTONS,
      lineStatus: 'ACCEPTED',
    },
  });
});

beforeEach(async () => {
  if (madeClps.length > 0) {
    await owner.clpLine.deleteMany({ where: { clpId: { in: madeClps } } });
    await owner.clp.deleteMany({ where: { id: { in: madeClps } } });
    madeClps.length = 0;
  }
});

afterAll(async () => {
  await owner.clpLine.deleteMany({ where: { clp: { code: { startsWith: `CLPST-${RUN}` } } } });
  await owner.clp.deleteMany({ where: { code: { startsWith: `CLPST-${RUN}` } } });
  await owner.clpLine.deleteMany({ where: { shipmentCargoLineId: cargoLineId } });
  await owner.clp.deleteMany({ where: { shipmentId, clpSeq: { gte: 7000 } } });
  await owner.cargoReceiptLine.deleteMany({ where: { shipmentCargoLineId: cargoLineId } });
  await owner.cargoReceipt.deleteMany({ where: { id: receiptId } });
  await owner.shipmentCargoLine.deleteMany({ where: { id: cargoLineId } });
  await owner.shipmentPo.deleteMany({ where: { id: poId } });
  await owner.$disconnect();
});

// ------------------------------------------------------------- transitions

describe('DRAFT -> FINAL -> CANCELLED', () => {
  it('walks the whole path', async () => {
    const clp = await makeClp();
    await put(clp, CARTONS);

    const finalised = await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/finalise`).send(FINALISE_BODY);
    expect(finalised.status).toBe(200);

    const mid = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { status: true, finalisedAt: true, finalisedBy: true, containerNo: true },
    });
    expect(mid.status).toBe('FINAL');
    expect(mid.finalisedAt).not.toBeNull();
    expect(mid.finalisedBy).toBe(userId);
    expect(mid.containerNo).toBe('CSQU3054383');

    const cancelled = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clp}/cancel`)
      .send({ reason: 'Carrier swapped the box at the gate.' });
    expect(cancelled.status).toBe(200);

    const end = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { status: true, cancelledAt: true, cancelledBy: true, cancelReason: true },
    });
    expect(end.status).toBe('CANCELLED');
    expect(end.cancelledAt).not.toBeNull();
    expect(end.cancelledBy).toBe(userId);
    expect(end.cancelReason).toMatch(/Carrier swapped/);
  });

  it('refuses to finalise a plan with nothing in it', async () => {
    // §4.3 lists ">= 1 line". An empty container is not a load plan.
    const clp = await makeClp();
    const res = await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/finalise`).send(FINALISE_BODY);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/no cargo in it/);
  });

  it('refuses to finalise without a valid container number, at the boundary', async () => {
    // The screen checks this too, but the screen is not the control.
    const clp = await makeClp();
    await put(clp, 1);
    const res = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clp}/finalise`)
      .send({ ...FINALISE_BODY, containerNo: 'CSQU3054387' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Check digit should be 3, not 7/);

    const after = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { status: true },
    });
    expect(after.status).toBe('DRAFT');
  });

  it('refuses a second finalise — FINAL has no edit path', async () => {
    const clp = await makeClp();
    await put(clp, 1);
    await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/finalise`).send(FINALISE_BODY);

    const again = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clp}/finalise`)
      .send({ ...FINALISE_BODY, sealNo: 'SL-DIFFERENT' });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/already final/);

    const after = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { sealNo: true },
    });
    expect(after.sealNo).toBe(FINALISE_BODY.sealNo);
  });

  it('refuses to edit a finalised plan through the details endpoint', async () => {
    // The other door into the same fields. §4.3 says there is no edit path,
    // so this one has to be shut as well.
    const clp = await makeClp();
    await put(clp, 1);
    await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/finalise`).send(FINALISE_BODY);

    const res = await as(tokenAll)
      .patch(`/api/tenant/ops/clps/${clp}`)
      .send({ sealNo: 'SL-SNEAKY' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/cannot be edited/);
  });

  it('refuses to finalise something already cancelled', async () => {
    const clp = await makeClp();
    await put(clp, 1);
    await cancel(clp, 'Wrong container size chosen.');

    const res = await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/finalise`).send(FINALISE_BODY);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/cancelled/);
  });

  it('refuses to cancel twice', async () => {
    const clp = await makeClp();
    await put(clp, 1);
    await cancel(clp, 'First cancellation.');
    await expect(cancel(clp, 'Second cancellation.')).rejects.toThrow(/already cancelled/);
  });
});

// ------------------------------------------------ who may cancel what (§4.3)

describe('FINAL -> CANCELLED is privileged, and the server is what enforces it', () => {
  it('refuses a planner who holds EDIT but not CANCEL', async () => {
    const clp = await makeClp();
    await put(clp, 1);
    await as(tokenPlanner).post(`/api/tenant/ops/clps/${clp}/finalise`).send(FINALISE_BODY);

    const res = await as(tokenPlanner)
      .post(`/api/tenant/ops/clps/${clp}/cancel`)
      .send({ reason: 'I would like this one back please.' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/needs a supervisor/);

    const after = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { status: true },
    });
    expect(after.status).toBe('FINAL');
  });

  it('lets that same planner cancel a DRAFT', async () => {
    // §4.3: "DRAFT -> CANCELLED any time, by anyone with EDIT".
    const clp = await makeClp();
    await put(clp, 1);

    const res = await as(tokenPlanner)
      .post(`/api/tenant/ops/clps/${clp}/cancel`)
      .send({ reason: 'Added the wrong container size.' });
    expect(res.status).toBe(200);

    const after = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { status: true },
    });
    expect(after.status).toBe('CANCELLED');
  });

  it('requires a reason for every cancellation', async () => {
    const clp = await makeClp();
    await put(clp, 1);

    const empty = await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/cancel`).send({ reason: '' });
    expect(empty.status).toBe(400);

    const thin = await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/cancel`).send({ reason: 'no' });
    expect(thin.status).toBe(400);

    const after = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { status: true },
    });
    expect(after.status).toBe('DRAFT');
  });
});

// --------------------------------------------------------- stuffing has begun

describe('once stuffing has started', () => {
  it('refuses to cancel a FINAL plan', async () => {
    const clp = await makeClp();
    await put(clp, CARTONS);
    await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/finalise`).send(FINALISE_BODY);
    await owner.clp.update({
      where: { id: clp },
      data: { stuffingStartedAt: new Date() },
    });

    const res = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clp}/cancel`)
      .send({ reason: 'Customer changed their mind.' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/Stuffing has already started/);

    // And nothing was released: the cartons are physically going in.
    expect(await free()).toBe(0);
  });

  it('refuses to cancel a DRAFT plan too', async () => {
    // The cartons are in the box either way. The document's status does not
    // change what the warehouse has already done.
    const clp = await makeClp();
    await put(clp, 1);
    await owner.clp.update({ where: { id: clp }, data: { stuffingStartedAt: new Date() } });

    await expect(cancel(clp, 'Changed my mind about this plan.')).rejects.toThrow(
      /Stuffing has already started/,
    );
  });
});

// ------------------------------------------------------- cancel and release

describe('cancelling releases the cargo', () => {
  it('gives back every carton a FINAL plan held', async () => {
    const clp = await makeClp();
    await put(clp, CARTONS);
    await as(tokenAll).post(`/api/tenant/ops/clps/${clp}/finalise`).send(FINALISE_BODY);
    expect(await free()).toBe(0);

    await cancel(clp, 'Box rejected at the terminal for damage.');
    expect(await free()).toBe(CARTONS);
  });

  it('keeps the cancelled record and its lines, for audit', async () => {
    // §4.3 — released is not deleted. Somebody has to be able to reconstruct
    // what was in that container.
    const clp = await makeClp();
    await put(clp, CARTONS);
    await cancel(clp, 'Box rejected at the terminal for damage.');

    const kept = await owner.clp.findFirstOrThrow({
      where: { id: clp },
      select: { totalCtnQty: true, totalVolumeCbm: true, lines: { select: { ctnQty: true } } },
    });
    expect(kept.lines).toHaveLength(1);
    expect(kept.lines[0]!.ctnQty).toBe(CARTONS);
    expect(kept.totalCtnQty).toBe(CARTONS);
    expect(Number(kept.totalVolumeCbm)).toBeCloseTo(10, 4);
  });

  it('releases only its own cargo, not another plan', async () => {
    const a = await makeClp();
    const b = await makeClp();
    await put(a, 25);
    await put(b, 15);
    expect(await free()).toBe(0);

    await cancel(a, 'Wrong container booked for this half.');
    expect(await free()).toBe(25);

    const other = await owner.clp.findFirstOrThrow({
      where: { id: b },
      select: { status: true, totalCtnQty: true },
    });
    expect(other.status).toBe('DRAFT');
    expect(other.totalCtnQty).toBe(15);
  });

  it('lets the released cartons be planned again', async () => {
    const a = await makeClp();
    await put(a, CARTONS);
    await cancel(a, 'Carrier swapped the box at the gate.');

    const b = await makeClp();
    await put(b, CARTONS);

    const replan = await owner.clp.findFirstOrThrow({
      where: { id: b },
      select: { totalCtnQty: true },
    });
    expect(replan.totalCtnQty).toBe(CARTONS);
    expect(await free()).toBe(0);
  });
});

// ----------------------------------------------------------- conservation

describe('conservation holds across a cancel', () => {
  /** received === (everything live plans hold) + (everything still free). */
  async function books(): Promise<{ received: number; allocated: number; free: number }> {
    const received = await owner.cargoReceiptLine.aggregate({
      where: {
        shipmentCargoLineId: cargoLineId,
        deletedAt: null,
        lineStatus: 'ACCEPTED',
        receipt: { status: 'CONFIRMED', deletedAt: null },
      },
      _sum: { receivedCtnQty: true },
    });
    const allocated = await owner.clpLine.aggregate({
      where: {
        shipmentCargoLineId: cargoLineId,
        deletedAt: null,
        clp: { status: { not: 'CANCELLED' }, deletedAt: null },
      },
      _sum: { ctnQty: true },
    });
    return {
      received: received._sum.receivedCtnQty ?? 0,
      allocated: allocated._sum.ctnQty ?? 0,
      free: await free(),
    };
  }

  it('balances at every step of split, cancel and re-plan', async () => {
    const check = async (where: string) => {
      const b = await books();
      expect(b.allocated + b.free, `conservation broken ${where}`).toBe(b.received);
      return b;
    };

    await check('at the start');

    const a = await makeClp();
    const b = await makeClp();
    await put(a, 18);
    await check('after the first allocation');

    await put(b, 22);
    const full = await check('after the split');
    expect(full.free).toBe(0);

    await cancel(a, 'Re-planning the first half into a bigger box.');
    const released = await check('after the cancel');
    expect(released.free).toBe(18);
    expect(released.allocated).toBe(22);

    const c = await makeClp();
    await put(c, 18);
    const done = await check('after re-planning');
    expect(done.free).toBe(0);
    expect(done.allocated).toBe(CARTONS);
  });

  it('moves the remainder to whichever allocation is now last', async () => {
    /*
      §2.3 — the rounding remainder belongs to the allocation that completes
      the line. Cancelling the plan that held it must hand it on, or the
      per-line weights stop summing to the line's own total.
    */
    const a = await makeClp();
    const b = await makeClp();
    await put(a, 13);
    await put(b, 27);

    await cancel(b, 'Second box no longer needed.');
    await put(await makeClp(), 27);

    const live = await owner.clpLine.findMany({
      where: {
        shipmentCargoLineId: cargoLineId,
        deletedAt: null,
        clp: { status: { not: 'CANCELLED' }, deletedAt: null },
      },
      select: { ctnQty: true, grossWeightKg: true, volumeCbm: true },
    });
    const line = await owner.shipmentCargoLine.findFirstOrThrow({
      where: { id: cargoLineId },
      select: { grossWeightKg: true, volumeCbm: true },
    });

    expect(live.reduce((s, l) => s + l.ctnQty, 0)).toBe(CARTONS);
    const gross = live.reduce((s, l) => s + Number(l.grossWeightKg ?? 0), 0);
    const cbm = live.reduce((s, l) => s + Number(l.volumeCbm ?? 0), 0);
    expect(gross).toBeCloseTo(Number(line.grossWeightKg), 3);
    expect(cbm).toBeCloseTo(Number(line.volumeCbm), 4);
  });
});

// --------------------------------------------------------------- numbering

describe('clp_seq after a cancellation', () => {
  it('does not hand the cancelled number to the next plan', async () => {
    /*
      §4.3 — "creates a fresh clp_seq". The cancelled record keeps its number
      so the audit trail and any printed copy still line up; the replacement
      gets the next one.
    */
    const first = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${shipmentId}/clps`)
      .send({ containerSizeId: size20.toString() });
    expect(first.status).toBe(201);
    const firstId = BigInt(first.body.data.id);
    madeClps.push(firstId);

    const before = await owner.clp.findFirstOrThrow({
      where: { id: firstId },
      select: { clpSeq: true },
    });

    await cancel(firstId, 'Wrong size, re-planning with a 40HC.');

    const second = await as(tokenAll)
      .post(`/api/tenant/ops/bookings/${shipmentId}/clps`)
      .send({ containerSizeId: size20.toString() });
    const secondId = BigInt(second.body.data.id);
    madeClps.push(secondId);

    const after = await owner.clp.findFirstOrThrow({
      where: { id: secondId },
      select: { clpSeq: true },
    });

    expect(after.clpSeq!).toBeGreaterThan(before.clpSeq!);
    // And the cancelled one still carries its own.
    const cancelled = await owner.clp.findFirstOrThrow({
      where: { id: firstId },
      select: { clpSeq: true, status: true },
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.clpSeq).toBe(before.clpSeq);
  });
});

// -------------------------------------------------------------- concurrency

describe('a cancel racing an allocation', () => {
  it('waits for a transaction that already holds the cargo line', async () => {
    /*
      This is the test that actually proves the lock, and it exists because
      the conservation check below does NOT: `recomputeCargoLine` is a full
      re-derivation, so whichever side runs last computes a correct answer
      from the committed rows and the books balance either way. Removing the
      lock left that check green.

      So the mechanism is measured directly. Another connection holds the
      cargo line in a mode that conflicts with FOR UPDATE, and the cancel has
      to be still waiting while it does. With the lock removed, the cancel
      sails past and finishes first.

      FOR NO KEY UPDATE is the holder's mode on purpose: FOR UPDATE would also
      conflict with the KEY SHARE lock a foreign key takes, so a pass would not
      tell us whether it was our lock or the FK doing the blocking.
    */
    const clp = await makeClp();
    await put(clp, CARTONS);

    const HOLD_MS = 1500;
    let cancelFinished = false;

    const holder = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM shipment_cargo_line WHERE id = ${cargoLineId} FOR NO KEY UPDATE`;
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      },
      { timeout: 30_000 },
    );

    // Let the holder take it first.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const cancelling = cancel(clp, 'Cancelling while the line is held elsewhere.').then(() => {
      cancelFinished = true;
    });

    // Still inside the hold: the cancel must not have got through.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(cancelFinished, 'the cancel did not wait for the cargo line lock').toBe(false);

    await holder;
    await cancelling;
    expect(cancelFinished).toBe(true);

    // And having waited, it still did the job.
    expect(await free()).toBe(CARTONS);
  });

  it('leaves the books balanced whichever side lands first', async () => {
    /*
      Weaker than it looks, and kept for what it does cover: whatever order a
      cancel and an allocation commit in, the cartons still add up. It does
      NOT prove the lock — see the test above for that.
    */
    const a = await makeClp();
    const b = await makeClp();
    await put(a, CARTONS);

    const results = await Promise.allSettled([
      cancel(a, 'Cancelling while somebody else is loading.'),
      put(b, CARTONS),
    ]);

    // Whatever order they land in, the books must balance afterwards.
    const allocated = await owner.clpLine.aggregate({
      where: {
        shipmentCargoLineId: cargoLineId,
        deletedAt: null,
        clp: { status: { not: 'CANCELLED' }, deletedAt: null },
      },
      _sum: { ctnQty: true },
    });
    const held = allocated._sum.ctnQty ?? 0;
    expect(held).toBeLessThanOrEqual(CARTONS);
    expect(held + (await free())).toBe(CARTONS);

    // At least one has to have succeeded; a deadlock failing both would be a
    // bug of its own.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('refuses the second of two racing allocations of the same cartons', async () => {
    const a = await makeClp();
    const b = await makeClp();

    const results = await Promise.allSettled([put(a, CARTONS), put(b, CARTONS)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);

    expect(await free()).toBe(0);
  });
});

// -------------------------------------------------------------------- audit

describe('the audit trail', () => {
  /*
    Everything here goes through HTTP on purpose. `changed_by` comes from the
    actor context the authenticate middleware establishes, so a service call
    made straight from a test would record a null actor and prove nothing
    about what the product writes.
  */
  /** JSON.stringify refuses BigInt, and changed_by is one. */
  const json = (value: unknown): string =>
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  const trailFor = async (clpId: bigint) =>
    owner.auditLog.findMany({
      where: { tableName: 'clp', recordId: clpId },
      orderBy: { id: 'asc' },
      select: { action: true, newValues: true, oldValues: true, changedBy: true },
    });

  it('records the finalisation, with who did it and what they set', async () => {
    const clp = await makeClp();
    await put(clp, CARTONS);
    const res = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clp}/finalise`)
      .send(FINALISE_BODY);
    expect(res.status).toBe(200);

    const trail = await trailFor(clp);
    const finalising = trail.filter(
      (e) => json(e.newValues).includes('"status":"FINAL"'),
    );
    expect(finalising.length).toBeGreaterThan(0);

    const said = json(finalising);
    expect(said).toMatch(/CSQU3054383/);
    expect(said).toMatch(new RegExp(FINALISE_BODY.sealNo));
    // Who, by name of the acting user — not a null actor.
    expect(finalising.every((e) => e.changedBy === userId)).toBe(true);
    // And the entry says what it moved away from.
    expect(json(finalising[0]!.oldValues)).toMatch(/"status":"DRAFT"/);
  });

  it('records the cancellation, its reason and who allowed it', async () => {
    const clp = await makeClp();
    await put(clp, CARTONS);
    const res = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clp}/cancel`)
      .send({ reason: 'Terminal refused the box for a damaged door seal.' });
    expect(res.status).toBe(200);

    const cancelling = (await trailFor(clp)).filter(
      (e) => json(e.newValues).includes('"status":"CANCELLED"'),
    );
    expect(cancelling.length).toBeGreaterThan(0);
    const said = json(cancelling);
    expect(said).toMatch(/damaged door seal/);
    expect(cancelling.every((e) => e.changedBy === userId)).toBe(true);
  });

  it('records a capacity override with its reason', async () => {
    /*
      §4.2's override is the third thing that has to be reconstructable: a
      container was knowingly loaded past its limit, and the trail is where
      the "knowingly" lives.
    */
    const clp = await makeClp();
    const bulky = await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId,
        shipmentPoId: poId,
        itemCode: `STBULK-${RUN}`,
        ctnQty: 60,
        pcsQty: 60,
        grossWeightKg: '6000',
        netWeightKg: '5800',
        cartonLengthCm: '100',
        cartonWidthCm: '100',
        cartonHeightCm: '50', // 0.5 CBM each: 60 cartons is 30 CBM in a 28 CBM box
      },
      select: { id: true },
    });
    await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: receiptId,
        shipmentCargoLineId: bulky.id,
        receivedCtnQty: 60,
        lineStatus: 'ACCEPTED',
      },
    });

    try {
      const res = await as(tokenAll)
        .post(`/api/tenant/ops/clps/${clp}/lines`)
        .send({
          cargoLineId: bulky.id.toString(),
          ctnQty: 60,
          overrideReason: 'Cartons compress; supervisor present at stuffing.',
        });
      expect(res.status).toBe(201);

      const overriding = (await trailFor(clp)).filter((e) =>
        json(e.newValues).includes('Cartons compress'),
      );
      expect(overriding.length).toBeGreaterThan(0);
      expect(overriding.every((e) => e.changedBy === userId)).toBe(true);
    } finally {
      await owner.clpLine.deleteMany({ where: { shipmentCargoLineId: bulky.id } });
      await owner.cargoReceiptLine.deleteMany({ where: { shipmentCargoLineId: bulky.id } });
      await owner.shipmentCargoLine.deleteMany({ where: { id: bulky.id } });
    }
  });

  it('never records a password or a hash alongside any of it', async () => {
    // The standing rule for this project: the audit trail carries what
    // changed on the row, and credentials are never part of that.
    const clp = await makeClp();
    await put(clp, 1);
    await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clp}/cancel`)
      .send({ reason: 'Checking what the trail carries.' });

    const said = json(await trailFor(clp));
    expect(said).not.toMatch(/password/i);
    expect(said).not.toMatch(/[$]2[aby][$]/); // a bcrypt hash
  });
});

// ==================================== a finalised plan's figures never move

/**
 * §4.3's "FINAL has no edit path", applied to the numbers as well as the
 * columns.
 *
 * The allocation engine re-derives a whole cargo line whenever any part of it
 * moves (§2.3), because the remainder belongs to whichever allocation
 * completes the line. That re-derivation used to rewrite EVERY live
 * allocation of the line — including rows on a plan that had already been
 * finalised and printed. So a second delivery that measured differently
 * changed the per-carton rate, and the next allocation into any draft
 * container silently re-priced cartons on a document somebody had signed.
 *
 * The fixture below is the shape that makes it visible: two deliveries with
 * DIFFERENT carton sizes. A second delivery at the same size cannot show it,
 * because the rate does not move and every figure recomputes to what it
 * already was.
 */
describe('a finalised plan keeps the figures it was closed with', () => {
  /** Its own cargo line and receipts, so the shared fixture is untouched. */
  async function twoDeliveries() {
    const line = await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId,
        shipmentPoId: poId,
        itemCode: `STFRZ-${RUN}`,
        ctnQty: 60,
        pcsQty: 600,
        grossWeightKg: '600',
        netWeightKg: '540',
        cartonLengthCm: '100',
        cartonWidthCm: '50',
        cartonHeightCm: '50',
      },
      select: { id: true },
    });

    // First delivery: 40 cartons, measured at 0.25 CBM each — 10.0000 CBM.
    await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: receiptId,
        shipmentCargoLineId: line.id,
        receivedCtnQty: 40,
        receivedGrossWeightKg: '400',
        cartonLengthCm: '100',
        cartonWidthCm: '50',
        cartonHeightCm: '50',
        lineStatus: 'ACCEPTED',
      },
    });

    return line.id;
  }

  /**
   * The second delivery, measured BIGGER, which is what moves the rate.
   *
   * Its own receipt, because one receipt carries one line per cargo line —
   * a second truck on a later day is a second receipt, which is exactly the
   * situation §7 describes.
   */
  let deliveries = 0;
  async function secondDelivery(lineId: bigint) {
    deliveries += 1;
    const later = await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRFRZ-${RUN}-${deliveries}`,
        seriesYear: 2026,
        shipmentId,
        receiptSeq: 9400 + deliveries,
        receiveDate: new Date('2026-09-15'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: userId,
      },
      select: { id: true },
    });
    await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: later.id,
        shipmentCargoLineId: lineId,
        receivedCtnQty: 20,
        receivedGrossWeightKg: '400',
        cartonLengthCm: '100',
        cartonWidthCm: '80',
        cartonHeightCm: '50', // 0.40 CBM each — 8.0000 CBM
        lineStatus: 'ACCEPTED',
      },
    });
  }

  async function cleanup(lineId: bigint) {
    await owner.clpLine.deleteMany({ where: { shipmentCargoLineId: lineId } });
    await owner.cargoReceiptLine.deleteMany({ where: { shipmentCargoLineId: lineId } });
    await owner.shipmentCargoLine.deleteMany({ where: { id: lineId } });
    await owner.cargoReceipt.deleteMany({ where: { code: { startsWith: `CRFRZ-${RUN}` } } });
  }

  const lineOn = (clpId: bigint, cargoId: bigint) =>
    owner.clpLine.findFirstOrThrow({
      where: { clpId, shipmentCargoLineId: cargoId, deletedAt: null },
      select: { ctnQty: true, pcsQty: true, volumeCbm: true, grossWeightKg: true, netWeightKg: true, isFinalAllocation: true },
    });

  const totalsOf = (clpId: bigint) =>
    owner.clp.findFirstOrThrow({
      where: { id: clpId },
      select: {
        totalCtnQty: true,
        totalPcsQty: true,
        totalVolumeCbm: true,
        totalGrossWeightKg: true,
        volumeUtilisation: true,
      },
    });

  it('does not re-price a finalised plan when a later delivery changes the rate', async () => {
    const cargoId = await twoDeliveries();
    try {
      const first = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: first, ctnQty: 40 }),
      );

      // 40 of 40 received, so this row completes the line and carries the
      // remainder: the whole 10 CBM the CFS measured.
      const before = await lineOn(first, cargoId);
      const beforeTotals = await totalsOf(first);
      expect(before.volumeCbm?.toString()).toBe('10');

      const finalised = await as(tokenAll)
        .post(`/api/tenant/ops/clps/${first}/finalise`)
        .send({ ...FINALISE_BODY, containerNo: 'MSKU0000011' });
      expect(finalised.status).toBe(200);

      // The delivery that moves the rate from 0.25 to 0.30 a carton.
      await secondDelivery(cargoId);

      const second = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: second, ctnQty: 20 }),
      );

      /*
        The whole point. Before this was fixed the finalised row became
        0.30 x 40 = 12 CBM, and the plan's rollups moved with it.
      */
      const after = await lineOn(first, cargoId);
      expect(after.volumeCbm?.toString()).toBe(before.volumeCbm?.toString());
      expect(after.grossWeightKg?.toString()).toBe(before.grossWeightKg?.toString());
      expect(after.netWeightKg?.toString()).toBe(before.netWeightKg?.toString());
      expect(after.pcsQty).toBe(before.pcsQty);
      expect(after.ctnQty).toBe(before.ctnQty);

      const afterTotals = await totalsOf(first);
      expect(afterTotals).toEqual(beforeTotals);
    } finally {
      await cleanup(cargoId);
    }
  });

  it('gives the balance to the draft container instead, so the parts still sum', async () => {
    /*
      Freezing one row must not lose the remainder. 18 CBM arrived across the
      two deliveries; the finalised plan keeps the 10 it was signed for, so
      the draft has to carry 8 — not the 6 it would get if the frozen row had
      been re-priced to 12 first.
    */
    const cargoId = await twoDeliveries();
    try {
      const first = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: first, ctnQty: 40 }),
      );
      // Asserted, not assumed: a refused finalise would leave a DRAFT behind
      // and this whole test would quietly prove nothing.
      expect(
        (
          await as(tokenAll)
            .post(`/api/tenant/ops/clps/${first}/finalise`)
            .send({ ...FINALISE_BODY, containerNo: 'MSKU0000027' })
        ).status,
      ).toBe(200);

      await secondDelivery(cargoId);

      const second = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: second, ctnQty: 20 }),
      );

      const draft = await lineOn(second, cargoId);
      expect(draft.volumeCbm?.toString()).toBe('8');
      expect(draft.isFinalAllocation).toBe(true);

      // Conservation, stated as the sum rather than as two separate figures.
      const all = await owner.clpLine.findMany({
        where: { shipmentCargoLineId: cargoId, deletedAt: null },
        select: { volumeCbm: true, grossWeightKg: true, ctnQty: true },
      });
      const sum = all.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0);
      expect(sum).toBeCloseTo(18, 4);
      expect(all.reduce((s, r) => s + r.ctnQty, 0)).toBe(60);
      expect(all.reduce((s, r) => s + Number(r.grossWeightKg ?? 0), 0)).toBeCloseTo(800, 3);
    } finally {
      await cleanup(cargoId);
    }
  });

  it('leaves the figures on a cancelled plan alone too', async () => {
    /*
      Cancelling already says the totals are "the record of what it held".
      The same re-derivation used to walk over them from the other direction:
      a cancelled plan's rows leave `liveAllocations`, but a plan cancelled
      AFTER being finalised keeps its own rollups either way.
    */
    const cargoId = await twoDeliveries();
    try {
      const first = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: first, ctnQty: 40 }),
      );
      expect(
        (
          await as(tokenAll)
            .post(`/api/tenant/ops/clps/${first}/finalise`)
            .send({ ...FINALISE_BODY, containerNo: 'MSKU0000032' })
        ).status,
      ).toBe(200);
      const held = await totalsOf(first);

      await as(tokenAll)
        .post(`/api/tenant/ops/clps/${first}/cancel`)
        .send({ reason: 'Box swapped at the yard; re-planning.' });

      await secondDelivery(cargoId);
      const second = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: second, ctnQty: 60 }),
      );

      expect(await totalsOf(first)).toEqual(held);
    } finally {
      await cleanup(cargoId);
    }
  });

  it('writes nothing at all to a finalised plan, so its trail stays closed', async () => {
    /*
      The rollups are a pure function of the lines, so re-running them on a
      frozen plan would land on the same numbers — which is exactly why this
      needs its own test. The damage is not a wrong figure, it is the write:
      Prisma issues the UPDATE regardless, `updated_at` moves, and the audit
      trigger files an entry against a document that was closed. Somebody
      reading the history of a signed CLP would find modifications nobody made.
    */
    const cargoId = await twoDeliveries();
    try {
      const first = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: first, ctnQty: 40 }),
      );
      expect(
        (
          await as(tokenAll)
            .post(`/api/tenant/ops/clps/${first}/finalise`)
            .send({ ...FINALISE_BODY, containerNo: 'MSKU0000053' })
        ).status,
      ).toBe(200);

      const trailBefore = (await owner.auditLog.count({
        where: { tableName: 'clp', recordId: first },
      })) as number;
      const stamp = await owner.clp.findFirstOrThrow({
        where: { id: first },
        select: { updatedAt: true },
      });

      await secondDelivery(cargoId);
      const second = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: second, ctnQty: 20 }),
      );

      expect(
        await owner.auditLog.count({ where: { tableName: 'clp', recordId: first } }),
      ).toBe(trailBefore);
      expect(
        (await owner.clp.findFirstOrThrow({ where: { id: first }, select: { updatedAt: true } }))
          .updatedAt.getTime(),
      ).toBe(stamp.updatedAt.getTime());
    } finally {
      await cleanup(cargoId);
    }
  });

  it('still recomputes an ordinary draft alongside a frozen one', async () => {
    /*
      The freeze must not turn into "stop recomputing". Two drafts and one
      finalised plan on one line: the drafts still re-derive normally.
    */
    const cargoId = await twoDeliveries();
    try {
      // 10 cartons at the first delivery's 0.25 a carton — 2.5 CBM, frozen.
      const frozen = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: frozen, ctnQty: 10 }),
      );
      expect(
        (
          await as(tokenAll)
            .post(`/api/tenant/ops/clps/${frozen}/finalise`)
            .send({ ...FINALISE_BODY, containerNo: 'MSKU0000048' })
        ).status,
      ).toBe(200);
      const held = await lineOn(frozen, cargoId);
      expect(held.volumeCbm?.toString()).toBe('2.5');

      // 60 cartons arrived in total, 18 CBM, so the rate is now 0.30.
      await secondDelivery(cargoId);

      const a = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: a, ctnQty: 20 }),
      );
      // 30 of 60 allocated: an intermediate split, so it multiplies out.
      expect((await lineOn(a, cargoId)).volumeCbm?.toString()).toBe('6');
      expect((await lineOn(a, cargoId)).isFinalAllocation).toBe(false);

      const b = await makeClp();
      await withTenant(tenantId, (db) =>
        allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId: b, ctnQty: 30 }),
      );

      // Now the line is complete, so b carries the balance — 18 - 2.5 - 6.
      const bRow = await lineOn(b, cargoId);
      expect(bRow.volumeCbm?.toString()).toBe('9.5');
      expect(bRow.isFinalAllocation).toBe(true);
      // a re-derived normally alongside the frozen row, and the frozen row
      // did not move.
      expect((await lineOn(a, cargoId)).volumeCbm?.toString()).toBe('6');
      expect((await lineOn(frozen, cargoId)).volumeCbm?.toString()).toBe('2.5');

      const all = await owner.clpLine.findMany({
        where: { shipmentCargoLineId: cargoId, deletedAt: null },
        select: { volumeCbm: true },
      });
      expect(all.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0)).toBeCloseTo(18, 4);
    } finally {
      await cleanup(cargoId);
    }
  });
});

// ============================ frozen allocations, the cases B1 did not cover

/**
 * The invariant, pushed at the three shapes B1's own tests did not reach:
 * several frozen plans at once, a frozen plan sharing a line with a draft,
 * and a receipt edited downward under a plan that was already signed.
 *
 * Same fixture idea as above — two deliveries measured differently, because
 * that is the only thing that moves the per-carton rate and therefore the only
 * thing that can expose a row being rewritten.
 */
describe('frozen allocations hold their ground', () => {
  let n = 0;

  /** A cargo line with one delivery of `ctn` cartons at 0.25 CBM each. */
  async function lineWithFirstDelivery(ctn: number) {
    n += 1;
    const line = await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId,
        shipmentPoId: poId,
        itemCode: `STFZ2-${RUN}-${n}`,
        ctnQty: 100,
        pcsQty: 1000,
        grossWeightKg: '1000',
        netWeightKg: '900',
        cartonLengthCm: '100',
        cartonWidthCm: '50',
        cartonHeightCm: '50',
      },
      select: { id: true },
    });
    const receipt = await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRFZ2-${RUN}-${n}-a`,
        seriesYear: 2026,
        shipmentId,
        receiptSeq: 9500 + n * 2,
        receiveDate: new Date('2026-09-13'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: userId,
      },
      select: { id: true },
    });
    const rl = await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: receipt.id,
        shipmentCargoLineId: line.id,
        receivedCtnQty: ctn,
        cartonLengthCm: '100',
        cartonWidthCm: '50',
        cartonHeightCm: '50',
        lineStatus: 'ACCEPTED',
      },
      select: { id: true },
    });
    return { cargoId: line.id, firstReceiptLineId: rl.id };
  }

  /** A second delivery of `ctn` cartons measured at 0.40 CBM each. */
  async function laterDelivery(cargoId: bigint, ctn: number) {
    n += 1;
    const receipt = await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRFZ2-${RUN}-${n}-b`,
        seriesYear: 2026,
        shipmentId,
        receiptSeq: 9600 + n * 2,
        receiveDate: new Date('2026-09-15'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: userId,
      },
      select: { id: true },
    });
    await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: receipt.id,
        shipmentCargoLineId: cargoId,
        receivedCtnQty: ctn,
        cartonLengthCm: '100',
        cartonWidthCm: '80',
        cartonHeightCm: '50',
        lineStatus: 'ACCEPTED',
      },
    });
  }

  async function scrub(cargoId: bigint) {
    await owner.clpLine.deleteMany({ where: { shipmentCargoLineId: cargoId } });
    await owner.cargoReceiptLine.deleteMany({ where: { shipmentCargoLineId: cargoId } });
    await owner.shipmentCargoLine.deleteMany({ where: { id: cargoId } });
    await owner.cargoReceipt.deleteMany({ where: { code: { startsWith: `CRFZ2-${RUN}` } } });
  }

  const cbmOn = async (clpId: bigint, cargoId: bigint) =>
    (
      await owner.clpLine.findFirstOrThrow({
        where: { clpId, shipmentCargoLineId: cargoId, deletedAt: null },
        select: { volumeCbm: true },
      })
    ).volumeCbm?.toString();

  const load = (clpId: bigint, cargoId: bigint, ctnQty: number) =>
    withTenant(tenantId, (db) =>
      allocate(db, { tenantId, userId }, { cargoLineId: cargoId, clpId, ctnQty }),
    );

  const freeOn = (cargoId: bigint) =>
    withTenant(tenantId, (db) => availableCartons(db, cargoId));

  const seal = async (clpId: bigint, containerNo: string) => {
    const res = await as(tokenAll)
      .post(`/api/tenant/ops/clps/${clpId}/finalise`)
      .send({ ...FINALISE_BODY, containerNo });
    expect(res.status).toBe(200);
  };

  it('scenario 2 — a frozen plan and a draft share one line without double-counting', async () => {
    const { cargoId } = await lineWithFirstDelivery(40);
    try {
      const frozen = await makeClp();
      await load(frozen, cargoId, 25);
      await seal(frozen, 'MSKU0000069');

      // The frozen plan still OWNS its cartons: they are not offered again.
      expect(await freeOn(cargoId)).toBe(15);

      const draft = await makeClp();
      await load(draft, cargoId, 15);
      expect(await freeOn(cargoId)).toBe(0);

      // And there is nothing left to give, stated as a refusal rather than a
      // negative balance.
      await expect(load(draft, cargoId, 1)).rejects.toThrow(/0 cartons left/i);
      expect(await freeOn(cargoId)).toBe(0);
      expect(await freeOn(cargoId)).toBeGreaterThanOrEqual(0);

      // 25 at 0.25 apiece, untouched; the draft completes the line.
      expect(await cbmOn(frozen, cargoId)).toBe('6.25');
      expect(await cbmOn(draft, cargoId)).toBe('3.75');
    } finally {
      await scrub(cargoId);
    }
  });

  it('scenario 3 — several frozen plans, one draft, conservation exact', async () => {
    const { cargoId } = await lineWithFirstDelivery(40);
    try {
      const a = await makeClp();
      await load(a, cargoId, 20);
      await seal(a, 'MSKU0000074');

      const b = await makeClp();
      await load(b, cargoId, 10);
      await seal(b, 'MSKU0000080');

      expect(await cbmOn(a, cargoId)).toBe('5');
      expect(await cbmOn(b, cargoId)).toBe('2.5');

      // 20 more cartons at 0.40 — the whole line is now 10 + 8 = 18 CBM.
      await laterDelivery(cargoId, 20);

      const draft = await makeClp();
      await load(draft, cargoId, 30);

      // Both frozen plans unmoved, and the draft absorbs the whole balance.
      expect(await cbmOn(a, cargoId)).toBe('5');
      expect(await cbmOn(b, cargoId)).toBe('2.5');
      expect(await cbmOn(draft, cargoId)).toBe('10.5');

      const all = await owner.clpLine.findMany({
        where: { shipmentCargoLineId: cargoId, deletedAt: null },
        select: { volumeCbm: true, ctnQty: true },
      });
      expect(all.reduce((s, r) => s + Number(r.volumeCbm ?? 0), 0)).toBeCloseTo(18, 4);
      expect(all.reduce((s, r) => s + r.ctnQty, 0)).toBe(60);
      expect(await freeOn(cargoId)).toBe(0);
    } finally {
      await scrub(cargoId);
    }
  });

  it('scenario 4 — a receipt edited below what frozen plans hold fails as a domain error', async () => {
    /*
      The contradiction: a plan was finalised on 10 CBM, and the delivery it
      was measured from is afterwards corrected down to 0.32. The balance the
      draft would carry goes negative, which is not a rounding artefact — it
      means the paperwork and the receipts disagree.

      The check constraint on clp_line would refuse the write either way. What
      is being proven here is that the operator gets a sentence about their
      cargo instead of a database error, and that nothing is written.
    */
    const { cargoId, firstReceiptLineId } = await lineWithFirstDelivery(40);
    try {
      const frozen = await makeClp();
      await load(frozen, cargoId, 40);
      await seal(frozen, 'MSKU0000095');
      expect(await cbmOn(frozen, cargoId)).toBe('10');

      await laterDelivery(cargoId, 20); // 8 CBM

      // The correction: the first delivery was not 0.25 a carton after all.
      await owner.cargoReceiptLine.update({
        where: { id: firstReceiptLineId },
        data: { cartonLengthCm: '20', cartonWidthCm: '20', cartonHeightCm: '20' },
      });

      const draft = await makeClp();
      await expect(load(draft, cargoId, 20)).rejects.toThrow(
        /already hold more than the receipts now say arrived/i,
      );

      // Not a raw constraint violation surfacing as a 500.
      await expect(load(draft, cargoId, 20)).rejects.not.toThrow(/violates check constraint/i);

      // And the transaction unwound: the frozen plan is untouched and the
      // draft holds nothing.
      expect(await cbmOn(frozen, cargoId)).toBe('10');
      expect(
        await owner.clpLine.count({ where: { clpId: draft, deletedAt: null } }),
      ).toBe(0);
    } finally {
      await scrub(cargoId);
    }
  });

  it('scenario 5 — reading a finalised plan writes nothing to it', async () => {
    /*
      Every GET a planner can reach for a closed container. A read that
      repaired what it noticed would move updated_at and file audit entries
      against a signed document — so this asserts the absence of writes, not
      the correctness of the figures.
    */
    const { cargoId } = await lineWithFirstDelivery(40);
    try {
      const frozen = await makeClp();
      await load(frozen, cargoId, 40);
      await seal(frozen, 'MSKU0000109');

      const before = await owner.clp.findFirstOrThrow({
        where: { id: frozen },
        select: { updatedAt: true },
      });
      const auditBefore = await owner.auditLog.count({
        where: { tableName: 'clp', recordId: frozen },
      });

      for (const path of [
        `/api/tenant/ops/bookings/${shipmentId}/clp`,
        `/api/tenant/ops/clps/${frozen}/billing`,
        `/api/tenant/ops/clps/${frozen}/print`,
        `/api/tenant/ops/clps?limit=50`,
        `/api/tenant/ops/clp-bookings?limit=50`,
      ]) {
        expect((await as(tokenAll).get(path)).status).toBe(200);
      }
      // The cost preview is a POST, but it is a read in every sense that
      // matters here: §9 gives it VIEW precisely because it saves nothing.
      await as(tokenAll)
        .post(`/api/tenant/ops/clps/${frozen}/cost/preview`)
        .send({ actualContainerCost: '1000', costCurrencyId: '1', basis: 'CBM' });

      expect(
        (await owner.clp.findFirstOrThrow({ where: { id: frozen }, select: { updatedAt: true } }))
          .updatedAt.getTime(),
      ).toBe(before.updatedAt.getTime());
      expect(await owner.auditLog.count({ where: { tableName: 'clp', recordId: frozen } })).toBe(
        auditBefore,
      );
    } finally {
      await scrub(cargoId);
    }
  });
});
