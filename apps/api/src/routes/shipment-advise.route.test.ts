import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';
import { extractPdfText } from '../lib/pdf-text';

/**
 * Documentation, end to end through HTTP — docs/MODULE_DOCUMENTATION.md §10.
 *
 * This is a **seam test**, and it exists because fixtures in this repo build
 * their own state, which is exactly where the joins between modules have hidden
 * bugs before. So nothing here inserts an advise line by hand: the container
 * plan is consolidated, loaded and finalised through the CLP routes, the cargo
 * is received through real cargo_receipt rows, and the advise is then asked to
 * pull its own PO grid out of all that.
 *
 *   booking + receipt -> CLP -> finalise -> advise -> send -> BL draft -> approve
 *
 * If the grid, the EFR, the stuffing date or the BL number comes back wrong,
 * the two modules disagree about what happened to the cargo, and no amount of
 * correct code inside either one makes the document true.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();
const RUN = Date.now().toString().slice(-6);

let tenantId: bigint;
let slug: string;
let superadminId: bigint;
/** A plain staff account: a superadmin bypasses §7 and proves nothing here. */
let staffId: bigint;
let size20: bigint;
/** B34 is starred on the client's sheet, so the form always sends one. */
let modeId: bigint;
let token: string;

const madeShipments: bigint[] = [];
const madeClps: bigint[] = [];

function as(t: string) {
  const wrap = (r: request.Test) =>
    r.set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', slug);
  return {
    get: (p: string) => wrap(request(app).get(p)),
    post: (p: string) => wrap(request(app).post(p)),
    patch: (p: string) => wrap(request(app).patch(p)),
  };
}

/** A booking with two POs, cargo received on one EFR, and an approved sailing. */
async function booking(label: string): Promise<{ id: bigint; code: string }> {
  const src = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null, shipmentType: 'SEA' },
    select: {
      tenantId: true,
      quotationId: true,
      customerId: true,
      carrierId: true,
      polId: true,
      podId: true,
      transitType: true,
      seriesYear: true,
    },
  });
  const vessel = await owner.vessel.findFirstOrThrow({
    where: { deletedAt: null },
    select: { id: true, name: true },
  });

  const code = `BKGAD-${RUN}-${label}`;
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
      shipmentType: 'SEA',
      loadingType: 'FCL',
      transitType: src.transitType,
      exporterName: 'Shafidi Exports',
      exporterAddress: '12 Jute Road, Dhaka',
      importerName: 'Hamburg Import GmbH',
      importerAddress: '4 Hafenstrasse, Hamburg',
      status: 'CARGO_RECEIVED',
      createdBy: superadminId,
    },
    select: { id: true },
  });
  madeShipments.push(shipment.id);

  // The approved schedule the advise header is prefilled from (§2.1, M14).
  const schedule = await owner.shipmentSchedule.create({
    data: {
      tenantId: src.tenantId,
      code: `SCHAD-${RUN}-${label}`,
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
      tenantId: src.tenantId,
      scheduleId: schedule.id,
      legNo: 1,
      vesselId: vessel.id,
      voyageNo: `V-AD-${RUN}`,
      originPortId: src.polId,
      destinationPortId: src.podId,
      etd: new Date('2026-10-02T06:00:00Z'),
      eta: new Date('2026-10-28T06:00:00Z'),
    },
  });

  // Two POs, so the totals row has something to add up (sheet row 21).
  const receipt = await owner.cargoReceipt.create({
    data: {
      tenantId: src.tenantId,
      code: `CRAD-${RUN}-${label}`,
      seriesYear: 2026,
      shipmentId: shipment.id,
      receiptSeq: 9800 + madeShipments.length,
      receiveDate: new Date('2026-09-15'),
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      receivedBy: superadminId,
      efrNo: `EFR-${RUN}`,
    },
    select: { id: true },
  });

  for (const [poLabel, ctn] of [
    ['A', 12],
    ['B', 8],
  ] as const) {
    const po = await owner.shipmentPo.create({
      data: {
        tenantId: src.tenantId,
        shipmentId: shipment.id,
        poNo: `PO-${RUN}-${label}${poLabel}`,
      },
      select: { id: true },
    });
    const line = await owner.shipmentCargoLine.create({
      data: {
        tenantId: src.tenantId,
        shipmentId: shipment.id,
        shipmentPoId: po.id,
        itemCode: `IT-${poLabel}`,
        ctnQty: ctn,
        pcsQty: ctn * 10,
        grossWeightKg: String(ctn * 25),
        netWeightKg: String(ctn * 20),
        cartonLengthCm: '50',
        cartonWidthCm: '50',
        cartonHeightCm: '50',
      },
      select: { id: true },
    });
    await owner.cargoReceiptLine.create({
      data: {
        tenantId: src.tenantId,
        cargoReceiptId: receipt.id,
        shipmentCargoLineId: line.id,
        receivedCtnQty: ctn,
        lineStatus: 'ACCEPTED',
      },
    });
  }

  return { id: shipment.id, code };
}

/** The real thing: consolidate, load every line, finalise. */
async function finalisedClp(shipmentId: bigint, containerNo: string): Promise<bigint> {
  const made = await as(token)
    .post('/api/tenant/ops/clps/consolidate')
    .send({ shipmentIds: [shipmentId.toString()], containerSizeId: size20.toString() });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const clpId = BigInt(made.body.data.id as string);
  madeClps.push(clpId);

  const lines = await owner.shipmentCargoLine.findMany({
    where: { shipmentId, deletedAt: null },
    select: { id: true, ctnQty: true },
  });
  for (const line of lines) {
    const put = await as(token)
      .post(`/api/tenant/ops/clps/${clpId}/lines`)
      .send({ cargoLineId: line.id.toString(), ctnQty: line.ctnQty });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
  }

  const done = await as(token).post(`/api/tenant/ops/clps/${clpId}/finalise`).send({
    containerNo,
    sealNo: `SL-AD-${RUN}`,
    loadDatetime: '2026-09-18T09:00:00.000Z',
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return clpId;
}

beforeAll(async () => {
  const any = await owner.shipment.findFirstOrThrow({
    where: { deletedAt: null },
    select: { tenantId: true },
  });
  tenantId = any.tenantId;
  slug = (
    await owner.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { slug: true } })
  ).slug;
  superadminId = (
    await owner.user.findFirstOrThrow({
      where: { tenantId, isSuperadmin: true, isActive: true, deletedAt: null },
      select: { id: true },
    })
  ).id;
  staffId = (
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
  modeId = (
    await owner.mode.findFirstOrThrow({ where: { deletedAt: null }, select: { id: true } })
  ).id;

  token = await signAccessToken({
    sub: superadminId.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
});

afterAll(async () => {
  for (const id of madeShipments) {
    await owner.$executeRawUnsafe(`DELETE FROM bl_draft_container WHERE bl_draft_id IN
      (SELECT id FROM bl_draft WHERE shipment_id = ${id})`);
    await owner.$executeRawUnsafe(`DELETE FROM bl_draft WHERE shipment_id = ${id}`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_advise_line WHERE advise_id IN
      (SELECT id FROM shipment_advise WHERE shipment_id = ${id})`);
    await owner.$executeRawUnsafe(`DELETE FROM shipment_advise WHERE shipment_id = ${id}`);
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

describe('the advise is built from what the operation actually did', () => {
  it('refuses to advise a booking with no finalised load plan', async () => {
    const bk = await booking('noplan');
    const pre = await as(token).get(`/api/tenant/documentation/bookings/${bk.id}/advise/prefill`);
    expect(pre.status).toBe(200);
    expect(pre.body.data.blockedReason).toMatch(/finalised container load plan/i);

    const made = await as(token)
      .post(`/api/tenant/documentation/bookings/${bk.id}/advise`)
      .send({ carrierId: '1', transitType: 'DIRECT', polId: '1', podId: '1' });
    expect(made.status).toBe(409);
    expect(JSON.stringify(made.body)).toMatch(/no finalised container load plan/i);
  });

  it('walks booking -> CLP -> advise -> BL draft', async () => {
    const bk = await booking('full');
    const containerNo = 'TCLU1234568';
    await finalisedClp(bk.id, containerNo);

    // --- 1. the prefill reads the approved schedule and the finalised plan
    const pre = await as(token).get(`/api/tenant/documentation/bookings/${bk.id}/advise/prefill`);
    expect(pre.status, JSON.stringify(pre.body)).toBe(200);
    const draft = pre.body.data;
    expect(draft.blockedReason).toBeNull();
    expect(draft.voyageNo).toBe(`V-AD-${RUN}`);
    expect(draft.etd).toBe('2026-10-02T06:00:00.000Z');

    // Row 21 of the sheet: two POs, twenty cartons, from the CLP not the booking.
    expect(draft.totals.poCount).toBe(2);
    expect(draft.totals.ctnQty).toBe(20);
    expect(draft.lines).toHaveLength(2);

    // The three columns the client merges down the grid, each from its own
    // source: the receipt, the container plan, and the receipt again.
    for (const line of draft.lines) {
      expect(line.efrNo).toBe(`EFR-${RUN}`);
      expect(line.stuffingDate).toBe('2026-09-18');
      expect(line.cargoReceiptDate).toBe('2026-09-15');
      expect(line.containerNo).toBe(containerNo);
    }

    // --- 2. create it. The House BL number is allocated here (§3.3).
    const made = await as(token)
      .post(`/api/tenant/documentation/bookings/${bk.id}/advise`)
      .send({
        carrierId: draft.carrierId,
        transitType: draft.transitType,
        firstVesselId: draft.firstVesselId,
        voyageNo: draft.voyageNo,
        polId: draft.polId,
        podId: draft.podId,
        etd: draft.etd,
        eta: draft.eta,
        mblNo: 'MBL-999',
      });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const advise = made.body.data;
    expect(advise.code).toMatch(/^SA-\d{4}-\d{6}$/);
    // Q14 on the client's sheet: prefix + YY + MM + serial.
    expect(advise.houseBlNo).toMatch(/^[A-Z]{3}\d{4}\d{3,}$/);
    expect(advise.status).toBe('DRAFT');
    expect(advise.lines).toHaveLength(2);

    // A draft advise does not move the booking — nobody has seen it.
    expect(
      (
        await owner.shipment.findFirstOrThrow({
          where: { id: bk.id },
          select: { status: true },
        })
      ).status,
    ).toBe('CARGO_RECEIVED');

    // --- 3. a second advise on the same booking is refused
    const again = await as(token)
      .post(`/api/tenant/documentation/bookings/${bk.id}/advise`)
      .send({
        carrierId: draft.carrierId,
        transitType: 'DIRECT',
        polId: draft.polId,
        podId: draft.podId,
      });
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toMatch(/already has/i);

    // --- 4. a BL draft cannot start before the advise has gone
    const early = await as(token)
      .post(`/api/tenant/documentation/bookings/${bk.id}/bl-draft`)
      .send({
        shipperText: 'x',
        consigneeText: 'y',
        notifyText: 'z',
        preCarriageByModeId: modeId.toString(),
        placeOfReceipt: 'Dhaka',
        polId: draft.polId,
        podId: draft.podId,
      });
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toMatch(/no sent shipment advise/i);

    // --- 5. send it: the booking moves, and the document freezes
    const sent = await as(token)
      .post(`/api/tenant/documentation/shipment-advise/${advise.id}/send`)
      .send({ to: [{ email: 'ops@customer.test' }] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data.status).toBe('SENT');
    expect(
      (
        await owner.shipment.findFirstOrThrow({
          where: { id: bk.id },
          select: { status: true },
        })
      ).status,
    ).toBe('ADVISED');

    const edit = await as(token)
      .patch(`/api/tenant/documentation/shipment-advise/${advise.id}`)
      .send({
        carrierId: draft.carrierId,
        transitType: 'INDIRECT',
        polId: draft.polId,
        podId: draft.podId,
      });
    expect(edit.status).toBe(409);
    expect(JSON.stringify(edit.body)).toMatch(/already gone to the customer/i);

    // --- 5b. the document, and what travelled with the letter
    const pdf = await as(token)
      .get(`/api/tenant/documentation/shipment-advise/${advise.id}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    const text = await extractPdfText(pdf.body as Buffer);
    expect(text).toContain(advise.houseBlNo);
    expect(text).toContain(bk.code);
    // Row 21: the totals line prints as the client draws it.
    expect(text).toContain('2 PO');

    const stored = await owner.shipmentAdvise.findFirstOrThrow({
      where: { id: BigInt(advise.id as string) },
      select: { pdfFile: true },
    });
    expect(stored.pdfFile).not.toBeNull();

    const letter = await owner.emailLog.findFirstOrThrow({
      where: { relatedType: 'shipment_advise', relatedId: BigInt(advise.id as string) },
      select: { subject: true, attachments: true },
    });
    // B29, verbatim — the client's own subject line.
    expect(letter.subject).toBe(`Shipment Advise of Booking no : ${bk.code}`);
    const files = letter.attachments as unknown as { filename: string; storageKey: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe(`${advise.code}.pdf`);
    expect(files[0]?.storageKey).toBe(stored.pdfFile);

    // --- 6. the BL draft now carries the advise's number and its containers
    const blPre = await as(token).get(
      `/api/tenant/documentation/bookings/${bk.id}/bl-draft/prefill`,
    );
    expect(blPre.status, JSON.stringify(blPre.body)).toBe(200);
    expect(blPre.body.data.blNo).toBe(advise.houseBlNo);
    expect(blPre.body.data.blockedReason).toBeNull();
    // §3.4: the parties are pulled from the booking and become the document's.
    expect(blPre.body.data.shipperText).toContain('Shafidi Exports');
    expect(blPre.body.data.consigneeText).toContain('Hamburg Import GmbH');
    expect(blPre.body.data.containers).toHaveLength(1);
    expect(blPre.body.data.containers[0].containerNo).toBe(containerNo);

    const bl = await as(token)
      .post(`/api/tenant/documentation/bookings/${bk.id}/bl-draft`)
      .send({
        shipperText: blPre.body.data.shipperText,
        consigneeText: blPre.body.data.consigneeText,
        notifyText: blPre.body.data.consigneeText,
        // The prefill leaves this empty when the booking carries no mode; B34
        // is starred, so the form is where it gets chosen.
        preCarriageByModeId: modeId.toString(),
        placeOfReceipt: 'Dhaka CFS',
        polId: blPre.body.data.polId,
        podId: blPre.body.data.podId,
        originalBlCount: 3,
      });
    expect(bl.status, JSON.stringify(bl.body)).toBe(201);
    expect(bl.body.data.blNo).toBe(advise.houseBlNo);
    expect(bl.body.data.origin).toBe('STAFF');
    expect(bl.body.data.containers).toHaveLength(1);

    // --- 7. the advise cannot be cancelled out from under a live draft
    const pull = await as(token)
      .post(`/api/tenant/documentation/shipment-advise/${advise.id}/cancel`)
      .send({ reason: 'changed my mind' });
    expect(pull.status).toBe(409);
    expect(JSON.stringify(pull.body)).toMatch(/BL draft/i);

    // --- 8. approve, and the booking moves on
    const approved = await as(token)
      .post(`/api/tenant/documentation/bl-drafts/${bl.body.data.id}/approve`)
      .send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(
      (
        await owner.shipment.findFirstOrThrow({
          where: { id: bk.id },
          select: { status: true },
        })
      ).status,
    ).toBe('BL_DRAFTED');

    const blPdf = await as(token)
      .get(`/api/tenant/documentation/bl-drafts/${bl.body.data.id}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      });
    expect(blPdf.status).toBe(200);
    const blText = await extractPdfText(blPdf.body as Buffer);
    expect(blText).toContain(advise.houseBlNo);
    expect(blText).toContain(containerNo);
    // Approved now, so the DRAFT watermark is gone — a page that can be
    // mistaken for an original is the one way this document does damage.
    expect(blText).not.toContain('DRAFT');

    // An approved BL is the document, not a form.
    const late = await as(token)
      .patch(`/api/tenant/documentation/bl-drafts/${bl.body.data.id}`)
      .send({
        shipperText: 'changed',
        consigneeText: 'changed',
        notifyText: 'changed',
        preCarriageByModeId: modeId.toString(),
        placeOfReceipt: 'Dhaka CFS',
        polId: blPre.body.data.polId,
        podId: blPre.body.data.podId,
      });
    expect(late.status).toBe(409);
  });
});

describe('the permission boundary', () => {
  it('refuses to send for a user who may only edit', async () => {
    const weak = await signAccessToken({
      sub: staffId.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      tokenVersion: 0,
      permissions: [
        'DOCUMENTATION.SHIPMENT_ADVISE.VIEW',
        'DOCUMENTATION.SHIPMENT_ADVISE.CREATE',
        'DOCUMENTATION.SHIPMENT_ADVISE.EDIT',
        // deliberately NOT SEND
      ],
    });
    const res = await as(weak)
      .post('/api/tenant/documentation/shipment-advise/1/send')
      .send({ to: [{ email: 'x@y.test' }] });
    expect(res.status).toBe(403);
  });

  it('refuses a customer session on a staff router', async () => {
    const customer = await owner.customer.findFirstOrThrow({
      where: { tenantId, deletedAt: null },
      select: { id: true },
    });
    /*
     * CR-004: the kind check sits above the permission check, so a role with
     * every documentation permission ticked onto it still opens nothing here.
     * The claim has to match a real customer-linked user, which no fixture
     * creates — so this asserts the refusal, whichever of the two fires.
     */
    const token = await signAccessToken({
      sub: superadminId.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: true,
      permissions: [],
      tokenVersion: 0,
      customerId: customer.id.toString(),
    });
    const res = await as(token).get('/api/tenant/documentation/bookings/1/advise');
    expect([401, 403]).toContain(res.status);
  });
});
