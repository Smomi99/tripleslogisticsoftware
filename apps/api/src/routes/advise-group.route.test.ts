import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { loadLiveBlDraft } from '../lib/bl-draft-view';
import { signAccessToken } from '../lib/jwt';
import { extractPdfText } from '../lib/pdf-text';
import { withCustomer } from '../lib/tenant-client';

/**
 * CR-005 — bookings of one quotation that share an EFR get one Shipment Advise
 * and one BL. End to end through HTTP, from real receipts and finalised CLPs,
 * like the seam test beside it (shipment-advise.route.test.ts).
 *
 * Every scenario has its own EFR, so the bookings of one cannot drift into
 * another's group: a group is the same quotation AND the same EFR.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();
const RUN = Date.now().toString().slice(-6);

let tenantId: bigint;
let slug: string;
let customerId: bigint;
let superadminId: bigint;
let size20: bigint;
let modeId: bigint;
let token: string;

const madeShipments: bigint[] = [];
const madeClps: bigint[] = [];
let serial = Number(RUN) % 900000;

function as(t: string) {
  const wrap = (r: request.Test) =>
    r.set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', slug);
  return {
    get: (p: string) => wrap(request(app).get(p)),
    post: (p: string) => wrap(request(app).post(p)),
  };
}

const API = '/api/tenant/documentation';

/** ISO 6346: the CLP refuses a container number whose check digit is wrong. */
function containerNo(): string {
  serial = (serial + 1) % 1000000;
  const body = `TGHU${String(serial).padStart(6, '0')}`;
  const value: Record<string, number> = {};
  let n = 10;
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (n % 11 === 0) n += 1;
    value[c] = n;
    n += 1;
  }
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = body[i]!;
    sum += (/\d/.test(ch) ? Number(ch) : value[ch]!) * 2 ** i;
  }
  return `${body}${(sum % 11) % 10}`;
}

interface BookingOpts {
  /** One receipt per EFR; the second EFR's receipt carries the second PO. */
  efrs: string[];
  exporterName?: string;
  voyage?: string;
}

/** A booking on the shared quotation, received, with an approved sailing. */
async function booking(label: string, opts: BookingOpts): Promise<{ id: bigint; code: string }> {
  const src = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null, shipmentType: 'SEA' },
    orderBy: { id: 'asc' },
    select: { quotationId: true, customerId: true, carrierId: true, polId: true, podId: true, seriesYear: true },
  });
  const vessel = await owner.vessel.findFirstOrThrow({
    where: { deletedAt: null },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  const code = `BKGGR-${RUN}-${label}`;
  const shipment = await owner.shipment.create({
    data: {
      tenantId,
      code,
      seriesYear: src.seriesYear,
      quotationId: src.quotationId,
      customerId: src.customerId,
      carrierId: src.carrierId,
      polId: src.polId,
      podId: src.podId,
      shipmentType: 'SEA',
      loadingType: 'LCL',
      transitType: 'DIRECT',
      exporterName: opts.exporterName ?? 'Shafidi Exports',
      exporterAddress: '12 Jute Road, Dhaka',
      importerName: 'Hamburg Import GmbH',
      importerAddress: '4 Hafenstrasse, Hamburg',
      status: 'CARGO_RECEIVED',
      createdBy: superadminId,
    },
    select: { id: true },
  });
  madeShipments.push(shipment.id);

  const schedule = await owner.shipmentSchedule.create({
    data: {
      tenantId,
      code: `SCHGR-${RUN}-${label}`,
      shipmentId: shipment.id,
      carrierId: src.carrierId,
      transitType: 'DIRECT',
      status: 'APPROVED',
      proposedBy: superadminId,
      decidedBy: superadminId,
      decidedAt: new Date(),
    },
    select: { id: true },
  });
  await owner.shipmentScheduleLeg.create({
    data: {
      tenantId,
      scheduleId: schedule.id,
      legNo: 1,
      vesselId: vessel.id,
      voyageNo: opts.voyage ?? `V-GR-${RUN}`,
      originPortId: src.polId,
      destinationPortId: src.podId,
      etd: new Date('2026-10-10T06:00:00Z'),
      eta: new Date('2026-11-05T06:00:00Z'),
    },
  });

  // No EFR still means a receipt — one with the box left empty.
  const receipts: bigint[] = [];
  for (const [i, efr] of (opts.efrs.length === 0 ? [null] : opts.efrs).entries()) {
    const receipt = await owner.cargoReceipt.create({
      data: {
        tenantId,
        code: `CRGR-${RUN}-${label}-${i}`,
        seriesYear: 2026,
        shipmentId: shipment.id,
        receiptSeq: i + 1,
        receiveDate: new Date('2026-10-01'),
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        receivedBy: superadminId,
        efrNo: efr,
      },
      select: { id: true },
    });
    receipts.push(receipt.id);
  }

  for (const [i, poLabel] of (['A', 'B'] as const).entries()) {
    const po = await owner.shipmentPo.create({
      data: { tenantId, shipmentId: shipment.id, poNo: `PO-${RUN}-${label}${poLabel}` },
      select: { id: true },
    });
    const line = await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId: shipment.id,
        shipmentPoId: po.id,
        itemCode: `IT-${poLabel}`,
        ctnQty: 4,
        pcsQty: 40,
        grossWeightKg: '100',
        netWeightKg: '80',
        cartonLengthCm: '50',
        cartonWidthCm: '50',
        cartonHeightCm: '50',
      },
      select: { id: true },
    });
    await owner.cargoReceiptLine.create({
      data: {
        tenantId,
        cargoReceiptId: receipts[Math.min(i, receipts.length - 1)]!,
        shipmentCargoLineId: line.id,
        receivedCtnQty: 4,
        lineStatus: 'ACCEPTED',
      },
    });
  }
  return { id: shipment.id, code };
}

/**
 * Consolidate, load every line, finalise — the advise pulls its grid from this.
 * Several bookings make one shared LCL box.
 */
async function finalisedClp(...shipmentIds: bigint[]): Promise<void> {
  const made = await as(token)
    .post('/api/tenant/ops/clps/consolidate')
    .send({ shipmentIds: shipmentIds.map(String), containerSizeId: size20.toString() });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const clpId = BigInt(made.body.data.id as string);
  madeClps.push(clpId);

  const lines = await owner.shipmentCargoLine.findMany({
    where: { shipmentId: { in: shipmentIds }, deletedAt: null },
    select: { id: true, ctnQty: true },
  });
  for (const line of lines) {
    const put = await as(token)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: line.ctnQty });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
  }
  const done = await as(token).post(`/api/tenant/ops/clps/${clpId}/finalise`).send({
    containerNo: containerNo(),
    sealNo: `SL-GR-${RUN}`,
    loadDatetime: '2026-10-08T09:00:00.000Z',
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
}

async function ready(label: string, opts: BookingOpts) {
  const b = await booking(label, opts);
  await finalisedClp(b.id);
  return b;
}

async function statusOf(id: bigint): Promise<string> {
  return (await owner.shipment.findFirstOrThrow({ where: { id }, select: { status: true } })).status;
}

async function header(shipmentId: bigint, include: bigint[] = []) {
  const q = include.length === 0 ? '' : `?include=${include.join(',')}`;
  const pre = await as(token).get(`${API}/bookings/${shipmentId}/advise/prefill${q}`);
  expect(pre.status, JSON.stringify(pre.body)).toBe(200);
  return pre.body.data;
}

async function makeAdvise(shipmentId: bigint, shipmentIds: bigint[] = []) {
  const pre = await header(shipmentId);
  return as(token)
    .post(`${API}/bookings/${shipmentId}/advise`)
    .send({
      carrierId: pre.carrierId,
      transitType: pre.transitType,
      firstVesselId: pre.firstVesselId,
      voyageNo: pre.voyageNo,
      polId: pre.polId,
      podId: pre.podId,
      shipmentIds: shipmentIds.map(String),
    });
}

const recipients = { to: [{ email: 'cs@customer.test' }] };

beforeAll(async () => {
  const src = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null, shipmentType: 'SEA' },
    orderBy: { id: 'asc' },
    select: { tenantId: true, customerId: true },
  });
  tenantId = src.tenantId;
  customerId = src.customerId;
  slug = (await owner.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { slug: true } })).slug;
  superadminId = (
    await owner.user.findFirstOrThrow({
      where: { tenantId, isSuperadmin: true, isActive: true, deletedAt: null },
      select: { id: true },
    })
  ).id;
  size20 = (
    await owner.containerSize.findFirstOrThrow({
      where: { code: '20STD', deletedAt: null },
      select: { id: true },
    })
  ).id;
  modeId = (await owner.mode.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true } })).id;
  token = await signAccessToken({
    sub: superadminId.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
});

afterAll(async () => {
  const advises = [
    ...new Set(
      (
        await owner.shipmentAdviseBooking.findMany({
          where: { shipmentId: { in: madeShipments } },
          select: { adviseId: true },
        })
      ).map((m) => m.adviseId.toString()),
    ),
  ].join(',');
  if (advises !== '') {
    await owner.$executeRawUnsafe(`DELETE FROM bl_draft_container WHERE bl_draft_id IN
      (SELECT id FROM bl_draft WHERE advise_id IN (${advises}))`);
    await owner.$executeRawUnsafe(`DELETE FROM bl_draft WHERE advise_id IN (${advises})`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_advise_line WHERE advise_id IN (${advises})`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_advise_booking WHERE advise_id IN (${advises})`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_advise WHERE id IN (${advises})`);
  }
  for (const id of madeClps) {
    await owner.$executeRawUnsafe(`DELETE FROM clp_line WHERE clp_id = ${id}`);
    await owner.$executeRawUnsafe(`DELETE FROM clp_booking WHERE clp_id = ${id}`);
    await owner.$executeRawUnsafe(`DELETE FROM clp WHERE id = ${id}`);
  }
  for (const id of madeShipments) {
    await owner.$executeRawUnsafe(`DELETE FROM cargo_receipt_line WHERE cargo_receipt_id IN
      (SELECT id FROM cargo_receipt WHERE shipment_id = ${id})`);
    await owner.$executeRawUnsafe(`DELETE FROM cargo_receipt WHERE shipment_id = ${id}`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_cargo_line WHERE shipment_id = ${id}`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_po WHERE shipment_id = ${id}`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_schedule_leg WHERE schedule_id IN
      (SELECT id FROM shipment_schedule WHERE shipment_id = ${id})`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_schedule WHERE shipment_id = ${id}`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment WHERE id = ${id}`);
  }
  await owner.$disconnect();
});

describe('one EFR, one advise, one BL (CR-005)', () => {
  it('groups the bookings that share an EFR, end to end', async () => {
    const efr = `EFR-G1-${RUN}`;
    const a = await ready('a', { efrs: [efr] });
    const b = await ready('b', { efrs: [` ${efr.toLowerCase()} `] }); // case and spaces do not matter
    const d = await ready('d', { efrs: [efr], exporterName: 'Another Exporter Ltd' });
    const e = await ready('e', { efrs: [efr], voyage: `V-OTHER-${RUN}` });
    const f = await ready('f', { efrs: [efr, `EFR-G1X-${RUN}`] });
    const other = await ready('o', { efrs: [`EFR-G1O-${RUN}`] });

    // --- 1. the prefill finds the group and says how each booking stands
    const pre = await header(a.id);
    expect(pre.blockedReason).toBeNull();
    expect(pre.existingAdvise).toBeNull();
    expect(pre.group.efrNo).toBe(efr);
    const stand = (id: bigint) =>
      pre.group.bookings.find((x: { shipmentId: string }) => x.shipmentId === id.toString());
    expect(stand(a.id)).toMatchObject({ match: 'LEAD', included: true });
    expect(stand(b.id)).toMatchObject({ match: 'FULL', included: true, blockedReason: null });
    expect(stand(d.id)).toMatchObject({ match: 'WARN', included: false });
    expect(stand(d.id).reason).toMatch(/shipper/i);
    expect(stand(e.id)).toMatchObject({ match: 'REFUSED', included: false });
    expect(stand(e.id).reason).toMatch(/one BL cannot cover two sailings/i);
    expect(stand(f.id)).toMatchObject({ match: 'REFUSED' });
    expect(stand(f.id).reason).toMatch(/more than one EFR/i);
    expect(stand(other.id)).toBeUndefined();
    // The grid already covers both bookings it will hold.
    expect(pre.bookingNos).toEqual([a.code, b.code]);
    expect(pre.lines).toHaveLength(4);
    expect(pre.totals.poCount).toBe(4);
    expect(new Set(pre.lines.map((l: { bookingNo: string }) => l.bookingNo))).toEqual(new Set([a.code, b.code]));

    // A ticked warning joins the preview.
    expect((await header(a.id, [d.id])).bookingNos).toEqual([a.code, b.code, d.code]);

    // --- 2. a refused booking cannot be ticked in
    const refused = await makeAdvise(a.id, [e.id]);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(/cannot share/i);

    // --- 3. make it, with the warned booking the user decided belongs
    const made = await makeAdvise(a.id, [d.id]);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const advise = made.body.data;
    expect(advise.bookingNos).toEqual([a.code, b.code, d.code]);
    expect(advise.lines).toHaveLength(6);
    expect(
      await owner.shipmentAdviseBooking.count({ where: { adviseId: BigInt(advise.id), releasedAt: null } }),
    ).toBe(3);

    // Every booking on it finds it — one advise, not three.
    for (const x of [b, d]) {
      const got = await as(token).get(`${API}/bookings/${x.id}/advise`);
      expect(got.body.data.id).toBe(advise.id);
    }
    const again = await makeAdvise(b.id);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/already has/i);

    // The worklist row says who the advise is shared with.
    const list = await as(token).get(`${API}/shipment-advise?search=${b.code}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const row = list.body.data.find((r: { code: string }) => r.code === b.code);
    expect(row.detail).toContain(advise.code);
    expect(row.detail).toContain(a.code);

    // --- 4. a booking on another sailing keeps an advise of its own
    const own = await makeAdvise(e.id);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.data.bookingNos).toEqual([e.code]);
    const intrude = await as(token)
      .post(`${API}/shipment-advise/${advise.id}/bookings`)
      .send({ shipmentId: e.id.toString() });
    expect(intrude.status).toBe(409);

    // --- 5. send: every booking moves, and the letter names them all
    const sent = await as(token).post(`${API}/shipment-advise/${advise.id}/send`).send(recipients);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    for (const x of [a, b, d]) expect(await statusOf(x.id)).toBe('ADVISED');
    const mail = await owner.emailLog.findFirstOrThrow({
      where: { relatedType: 'shipment_advise', relatedId: BigInt(advise.id) },
      select: { subject: true },
    });
    expect(mail.subject).toContain(a.code);
    expect(mail.subject).toContain(b.code);
    expect(mail.subject).toContain(d.code);

    const pdf = await as(token)
      .get(`${API}/shipment-advise/${advise.id}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(pdf.status).toBe(200);
    const text = await extractPdfText(pdf.body as Buffer);
    expect(text).toContain('Booking');
    expect(text).toContain(d.code);

    // --- 6. sent closes the group: a late booking of the EFR cannot slip in
    const late = await ready('g', { efrs: [efr] });
    const latePre = await header(late.id);
    expect(latePre.existingAdvise).toMatchObject({ id: advise.id, status: 'SENT' });
    expect(latePre.blockedReason).toMatch(/new House BL number/i);
    expect((await makeAdvise(late.id)).status).toBe(409);
    const add = await as(token)
      .post(`${API}/shipment-advise/${advise.id}/bookings`)
      .send({ shipmentId: late.id.toString() });
    expect(add.status).toBe(409);
    expect(JSON.stringify(add.body)).toMatch(/new House BL number/i);

    // --- 7. one BL, reached from any booking on the advise
    const blPre = await as(token).get(`${API}/bookings/${d.id}/bl-draft/prefill`);
    expect(blPre.status, JSON.stringify(blPre.body)).toBe(200);
    expect(blPre.body.data.blockedReason).toBeNull();
    expect(blPre.body.data.blNo).toBe(advise.houseBlNo);
    expect(blPre.body.data.bookingNos).toEqual([a.code, b.code, d.code]);
    expect(blPre.body.data.containers).toHaveLength(3);
    // The party blocks are the lead booking's, not the warned one's.
    expect(blPre.body.data.shipperText).toContain('Shafidi Exports');

    const bl = await as(token)
      .post(`${API}/bookings/${b.id}/bl-draft`)
      .send({
        shipperText: blPre.body.data.shipperText,
        consigneeText: blPre.body.data.consigneeText,
        notifyText: blPre.body.data.consigneeText,
        preCarriageByModeId: modeId.toString(),
        placeOfReceipt: 'Dhaka CFS',
        polId: blPre.body.data.polId,
        podId: blPre.body.data.podId,
        originalBlCount: 3,
      });
    expect(bl.status, JSON.stringify(bl.body)).toBe(201);
    expect(bl.body.data.shipmentId).toBe(a.id.toString());
    expect(bl.body.data.containers).toHaveLength(3);
    for (const x of [a, d]) {
      const got = await as(token).get(`${API}/bookings/${x.id}/bl-draft`);
      expect(got.body.data.id).toBe(bl.body.data.id);
    }
    const second = await as(token)
      .post(`${API}/bookings/${d.id}/bl-draft`)
      .send({
        shipperText: 'x',
        consigneeText: 'y',
        notifyText: 'z',
        preCarriageByModeId: modeId.toString(),
        placeOfReceipt: 'Dhaka',
        polId: blPre.body.data.polId,
        podId: blPre.body.data.podId,
      });
    expect(second.status).toBe(409);

    // The customer's portal finds the same bill from any of their bookings.
    const portal = await withCustomer(tenantId, customerId, (db) => loadLiveBlDraft(db, d.id));
    expect(portal?.id).toBe(bl.body.data.id);
    expect(portal?.bookingNos).toEqual([a.code, b.code, d.code]);

    // --- 8. approve, issue: every booking moves with the bill
    const approved = await as(token).post(`${API}/bl-drafts/${bl.body.data.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    for (const x of [a, b, d]) expect(await statusOf(x.id)).toBe('BL_DRAFTED');

    const print = await as(token).get(`${API}/bookings/${b.id}/bl`);
    expect(print.status, JSON.stringify(print.body)).toBe(200);
    expect(print.body.data.bookingNos).toEqual([a.code, b.code, d.code]);
    const issued = await as(token).post(`${API}/bookings/${d.id}/bl/issue`).send({});
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    for (const x of [a, b, d]) expect(await statusOf(x.id)).toBe('BL_ISSUED');

    // --- 9. unwinding moves them all back, and frees them
    const voided = await as(token)
      .post(`${API}/bl-drafts/${bl.body.data.id}/cancel`)
      .send({ reason: 'Wrong consignee' });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    for (const x of [a, b, d]) expect(await statusOf(x.id)).toBe('ADVISED');

    const cancelled = await as(token)
      .post(`${API}/shipment-advise/${advise.id}/cancel`)
      .send({ reason: 'Reissuing with the late booking' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    for (const x of [a, b, d]) expect(await statusOf(x.id)).toBe('CARGO_RECEIVED');
    expect(
      await owner.shipmentAdviseBooking.count({ where: { adviseId: BigInt(advise.id), releasedAt: null } }),
    ).toBe(0);

    // Reissued from another booking: the full matches, the late one included,
    // come back by themselves; the warned one waits to be ticked again.
    const reissued = await makeAdvise(b.id);
    expect(reissued.status, JSON.stringify(reissued.body)).toBe(201);
    expect(reissued.body.data.bookingNos).toEqual([b.code, a.code, late.code]);
    expect(reissued.body.data.houseBlNo).not.toBe(advise.houseBlNo);
  });

  it('lets a draft grow, and refuses a send any booking on it cannot make', async () => {
    const efr = `EFR-G2-${RUN}`;
    const p = await ready('p', { efrs: [efr] });
    const q = await booking('q', { efrs: [efr] }); // received, but no load plan yet
    const r = await booking('r', { efrs: [efr] });

    // Q and R are not ready, so the advise starts with P alone.
    const made = await makeAdvise(p.id);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const advise = made.body.data;
    expect(advise.bookingNos).toEqual([p.code]);
    const waiting = advise.group.bookings.find((x: { shipmentId: string }) => x.shipmentId === q.id.toString());
    expect(waiting).toMatchObject({ match: 'FULL', included: false });
    expect(waiting.blockedReason).toMatch(/load plan/i);

    // Once Q is planned, it joins P's draft rather than starting another advise.
    await finalisedClp(q.id);
    const qPre = await header(q.id);
    expect(qPre.existingAdvise).toMatchObject({ id: advise.id, status: 'DRAFT' });
    expect(qPre.blockedReason).toMatch(/Add .* to it/);
    const second = await makeAdvise(q.id);
    expect(second.status).toBe(409);

    const added = await as(token)
      .post(`${API}/shipment-advise/${advise.id}/bookings`)
      .send({ shipmentId: q.id.toString() });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.data.bookingNos).toEqual([p.code, q.code]);
    expect(added.body.data.lines).toHaveLength(4);

    // Build picks up a full match that became ready on its own.
    await finalisedClp(r.id);
    const built = await as(token).post(`${API}/shipment-advise/${advise.id}/build`).send({});
    expect(built.status, JSON.stringify(built.body)).toBe(200);
    expect(built.body.data.bookingNos).toEqual([p.code, q.code, r.code]);
    expect(built.body.data.lines).toHaveLength(6);

    // A booking that has moved on cannot be advised: the send refuses as a
    // whole, names it, and nothing moves.
    await owner.shipment.update({ where: { id: r.id }, data: { status: 'PART_RECEIVED' } });
    const sent = await as(token).post(`${API}/shipment-advise/${advise.id}/send`).send(recipients);
    expect(sent.status).toBe(409);
    expect(JSON.stringify(sent.body)).toContain(r.code);
    expect(await statusOf(p.id)).toBe('CARGO_RECEIVED');
    expect(
      (await owner.shipmentAdvise.findFirstOrThrow({ where: { id: BigInt(advise.id) }, select: { status: true } }))
        .status,
    ).toBe('DRAFT');
  });

  it('says on the To advise list which bookings share an EFR, and counts a shared box as planned', async () => {
    const efr = `EFR-G4-${RUN}`;
    const x = await booking('x', { efrs: [efr] });
    const y = await booking('y', { efrs: [efr] });
    // One consolidated LCL box: clp.shipment_id is empty, the bookings are in
    // clp_booking. The list once read the column and called both unplanned.
    await finalisedClp(x.id, y.id);

    for (const [me, other] of [[x, y], [y, x]] as const) {
      const list = await as(token).get(`${API}/shipment-advise?search=${me.code}`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const row = list.body.data.find((r: { code: string }) => r.code === me.code);
      expect(row.detail).toMatch(/1 container planned/);
      expect(row.detail).toContain(`Shares ${efr} with ${other.code}`);
    }
  });

  it('shows the EFR No on the booking, cargo receipt and container plan lists', async () => {
    const efr = `EFR-G5-${RUN}`;
    const z = await booking('z', { efrs: [efr] });
    const pending = await booking('w', { efrs: [] });
    await finalisedClp(z.id);

    // Shipment Booking: the booking list.
    const bookings = await as(token).get(`/api/tenant/cs/bookings?search=${z.code}`);
    expect(bookings.status, JSON.stringify(bookings.body)).toBe(200);
    expect(bookings.body.data.find((r: { code: string }) => r.code === z.code).efrNos).toEqual([efr]);
    // No EFR typed on the receipt: an empty list, which the screen shows as —.
    const none = await as(token).get(`/api/tenant/cs/bookings?search=${pending.code}`);
    expect(none.body.data.find((r: { code: string }) => r.code === pending.code).efrNos).toEqual([]);

    // Cargo Receipt — the same worklist row Approval and Shipping Order use.
    const receipts = await as(token).get(`/api/tenant/ops/cargo-receipts?view=RECEIVED&search=${z.code}`);
    expect(receipts.status, JSON.stringify(receipts.body)).toBe(200);
    expect(receipts.body.data.find((r: { code: string }) => r.code === z.code).efrNos).toEqual([efr]);

    // Container Load Plan: the register, from the cartons loaded in the box.
    const plans = await as(token).get(`/api/tenant/ops/clps?search=${z.code}`);
    expect(plans.status, JSON.stringify(plans.body)).toBe(200);
    const plan = plans.body.data.find((r: { bookingCode: string }) => r.bookingCode === z.code);
    expect(plan.efrNos).toEqual([efr]);
  });

  it('tags each list row with the advise it will share', async () => {
    const efr = `EFR-G6-${RUN}`;
    const t1 = await ready('t1', { efrs: [efr] });
    const t2 = await ready('t2', { efrs: [efr] });
    const t3 = await ready('t3', { efrs: [efr], exporterName: 'Another Exporter Ltd' });
    const t4 = await ready('t4', { efrs: [efr], voyage: `V-T4-${RUN}` });
    const t5 = await ready('t5', { efrs: [efr, `EFR-G6X-${RUN}`] });
    const t6 = await booking('t6', { efrs: [efr] }); // received, no load plan yet

    const tags = async () => {
      const list = await as(token).get(`/api/tenant/cs/bookings?search=BKGGR-${RUN}-t&limit=50`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const byCode = new Map<string, { kind: string; withBookings: string[]; reason: string | null; adviseCode: string | null; groupKey: string | null }>();
      for (const row of list.body.data) byCode.set(row.code, row.efrGroup);
      return byCode;
    };

    // Before any advise: who will share one, who is offered, who stays apart.
    const before = await tags();
    expect(before.get(t1.code)).toMatchObject({ kind: 'SHARED', withBookings: [t2.code, t6.code] });
    expect(before.get(t2.code)).toMatchObject({ kind: 'SHARED', withBookings: [t1.code, t6.code] });
    expect(before.get(t3.code)).toMatchObject({ kind: 'CHECK', reason: 'shipper' });
    expect(before.get(t4.code)).toMatchObject({ kind: 'OWN', reason: 'other voyage', groupKey: null });
    expect(before.get(t5.code)).toMatchObject({ kind: 'OWN', reason: 'two EFRs' });
    // One colour for the group, and the offered booking points at the same one.
    expect(before.get(t2.code)!.groupKey).toBe(before.get(t1.code)!.groupKey);
    expect(before.get(t3.code)!.groupKey).toBe(before.get(t1.code)!.groupKey);

    // Made: the two ready ones are on it; the unplanned one goes on it later.
    const made = await makeAdvise(t1.id);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const code = made.body.data.code as string;
    const after = await tags();
    expect(after.get(t1.code)).toMatchObject({ kind: 'ON_ADVISE', adviseCode: code, withBookings: [t2.code] });
    expect(after.get(t2.code)).toMatchObject({ kind: 'ON_ADVISE', adviseCode: code, withBookings: [t1.code] });
    expect(after.get(t6.code)).toMatchObject({ kind: 'JOINS', adviseCode: code });
    expect(after.get(t3.code)).toMatchObject({ kind: 'CHECK', adviseCode: code });
    expect(after.get(t6.code)!.groupKey).toBe(after.get(t1.code)!.groupKey);

    // Sent: the latecomer can only join by a reissue.
    const sent = await as(token).post(`${API}/shipment-advise/${made.body.data.id}/send`).send(recipients);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect((await tags()).get(t6.code)).toMatchObject({ kind: 'LATE', adviseCode: code });
  });

  it('advises a booking without an EFR, or with two, on its own', async () => {
    const none = await ready('n', { efrs: [] });
    const pre = await header(none.id);
    expect(pre.group.efrNo).toBeNull();
    expect(pre.group.note).toMatch(/no EFR/i);
    expect(pre.group.bookings).toHaveLength(1);

    const two = await ready('t', { efrs: [`EFR-G3A-${RUN}`, `EFR-G3B-${RUN}`] });
    const twoPre = await header(two.id);
    expect(twoPre.group.efrNo).toBeNull();
    expect(twoPre.group.note).toMatch(/more than one EFR/i);
    const made = await makeAdvise(two.id);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.data.bookingNos).toEqual([two.code]);
  });
});
