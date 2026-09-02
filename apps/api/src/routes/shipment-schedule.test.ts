import { PrismaPg } from '@prisma/adapter-pg';
import { checkLegContinuity } from '@ff/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Vessel / Flight Booking — docs/MODULE_BOOKING_CARGO.md §4.2 and §6.4, phase E.
 *
 * Two things carry the weight here. §6.4's continuity rules, which decide
 * whether a schedule could physically happen; and §4.2's "a rejected schedule
 * is never edited in place", which is why proposing twice leaves two rows and
 * not one.
 *
 * The phase is done when an indirect three-leg schedule saves, so that is the
 * first test.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'sched-alpha';

let tenantId: bigint;
let token: string;
/** May view a schedule but not propose one. */
let tokenReadOnly: string;
/** May approve a PO but not reject one (§7 splits them). */
let tokenApproveOnly: string;
let carrierId: bigint;
let vesselId: bigint;
let chittagong: bigint;
let singapore: bigint;
let rotterdam: bigint;
let hamburg: bigint;
let quotationId: bigint;
let bookingSeq = 0;

function as(t: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
  };
}

/** A booking sitting at BOOKING_RECEIVED, ready for a schedule. */
async function makeBooking(): Promise<bigint> {
  bookingSeq += 1;
  const row = await owner.shipment.create({
    data: {
      tenantId,
      code: `BKG-2026-${String(bookingSeq).padStart(6, '0')}`,
      seriesYear: 2026,
      quotationId,
      shipmentType: 'SEA',
      customerId: (
        await owner.quotation.findFirstOrThrow({
          where: { id: quotationId },
          select: { customerId: true },
        })
      ).customerId,
      carrierId,
      polId: chittagong,
      podId: hamburg,
    },
    select: { id: true },
  });
  return row.id;
}

interface Leg {
  legNo: number;
  originPortId: string;
  destinationPortId: string;
  etd?: string;
  eta?: string;
  vesselId?: string;
  voyageNo?: string;
}

function body(transitType: 'DIRECT' | 'INDIRECT', legs: Leg[]) {
  return { carrierId: carrierId.toString(), transitType, legs };
}

/** Chittagong → Singapore → Rotterdam → Hamburg, each leg a week apart. */
function threeLegs(): Leg[] {
  return [
    {
      legNo: 1,
      originPortId: chittagong.toString(),
      destinationPortId: singapore.toString(),
      etd: '2026-10-01T08:00:00.000Z',
      eta: '2026-10-07T18:00:00.000Z',
      vesselId: vesselId.toString(),
      voyageNo: 'V001',
    },
    {
      legNo: 2,
      originPortId: singapore.toString(),
      destinationPortId: rotterdam.toString(),
      etd: '2026-10-09T08:00:00.000Z',
      eta: '2026-10-28T18:00:00.000Z',
      vesselId: vesselId.toString(),
      voyageNo: 'V002',
    },
    {
      legNo: 3,
      originPortId: rotterdam.toString(),
      destinationPortId: hamburg.toString(),
      etd: '2026-10-30T08:00:00.000Z',
      eta: '2026-11-01T18:00:00.000Z',
      vesselId: vesselId.toString(),
      voyageNo: 'V003',
    },
  ];
}

function oneLeg(): Leg[] {
  return [
    {
      legNo: 1,
      originPortId: chittagong.toString(),
      destinationPortId: hamburg.toString(),
      etd: '2026-10-01T08:00:00.000Z',
      eta: '2026-11-01T18:00:00.000Z',
      vesselId: vesselId.toString(),
      voyageNo: 'V100',
    },
  ];
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of [
    'shipment_schedule_leg',
    'shipment_schedule',
    'shipment_cargo_line',
    'shipment_commodity',
    'shipment_po',
    'shipment',
    'email_log',
    'quotation',
    'inquiry',
    'customer_pic',
    'customer',
    'industry_sector',
    'vessel',
    'carrier',
    'port',
    '"user"',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();

  const tenant = await owner.tenant.create({
    data: { name: 'Schedule Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const admin = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-sched',
      username: 'admin-sched',
      email: 'admin@sched.test',
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: admin.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  const reader = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-sched-ro',
      username: 'reader-sched',
      email: 'reader@sched.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenReadOnly = await signAccessToken({
    sub: reader.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: ['CUSTOMER_SERVICE.SCHEDULE.VIEW', 'CUSTOMER_SERVICE.CARGO_BOOKING.VIEW'],
    tokenVersion: 0,
  });

  const approver = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-sched-ap',
      username: 'approver-sched',
      email: 'approver@sched.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenApproveOnly = await signAccessToken({
    sub: approver.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: [
      'CUSTOMER_SERVICE.SHIPMENT_APPROVAL.VIEW',
      'CUSTOMER_SERVICE.SHIPMENT_APPROVAL.APPROVE',
    ],
    tokenVersion: 0,
  });

  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'SC-SEC', name: 'Garments' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'SC-CUS',
      name: 'Schedule Customer',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  // §6.4 notifies the customer, and the addresses come from their contacts.
  await owner.customerPic.create({
    data: {
      tenantId,
      code: 'SC-PIC',
      customerId: customer.id,
      name: 'Shipping Desk',
      email: 'desk@schedule-customer.test',
    },
  });

  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  carrierId = (
    await owner.carrier.create({
      data: { tenantId, code: 'SC-CAR', name: 'Schedule Line', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;
  vesselId = (
    await owner.vessel.create({
      data: { tenantId, code: 'SC-VSL', name: 'MV Schedule', carrierId },
      select: { id: true },
    })
  ).id;

  const port = async (code: string, name: string, portCode: string): Promise<bigint> =>
    (
      await owner.port.create({
        data: { tenantId, code, name, portCode, country: 'Test', type: 'SEAPORT' },
        select: { id: true },
      })
    ).id;
  chittagong = await port('SC-P1', 'Chittagong', 'ZZCGP');
  singapore = await port('SC-P2', 'Singapore', 'ZZSIN');
  rotterdam = await port('SC-P3', 'Rotterdam', 'ZZRTM');
  hamburg = await port('SC-P4', 'Hamburg', 'ZZHAM');

  const source = await owner.inquirySource.findFirstOrThrow({ select: { id: true } });
  const currency = await owner.currency.findFirstOrThrow({ select: { id: true } });
  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: 'SC-INQ-1',
      seriesYear: 2026,
      inquiryDate: new Date('2026-09-02'),
      sourceId: source.id,
      shipmentType: 'SEA',
      customerId: customer.id,
      movementType: 'OUTBOUND',
      polId: chittagong,
      podId: hamburg,
      status: 'OPEN',
    },
    select: { id: true },
  });
  quotationId = (
    await owner.quotation.create({
      data: {
        tenantId,
        code: 'SC-QTN-1',
        seriesYear: 2026,
        inquiryId: inquiry.id,
        quotationDate: new Date('2026-09-02'),
        customerId: customer.id,
        shipmentType: 'SEA',
        movementType: 'OUTBOUND',
        polId: chittagong,
        podId: hamburg,
        carrierId,
        localCurrencyId: currency.id,
        conversionRate: '122.0000',
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('proposing a schedule', () => {
  it('saves an indirect three-leg schedule — the phase gate', async () => {
    const bookingId = await makeBooking();
    const res = await as(token)
      .post(`/api/tenant/cs/bookings/${bookingId}/schedules`)
      .send(body('INDIRECT', threeLegs()));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const data = (res.body as { data: { legs: { legNo: number; originPortName: string; destinationPortName: string }[]; versionNo: number; status: string } }).data;

    expect(data.legs).toHaveLength(3);
    expect(data.versionNo).toBe(1);
    expect(data.status).toBe('PROPOSED');
    expect(data.legs.map((l) => `${l.originPortName}>${l.destinationPortName}`)).toEqual([
      'Chittagong>Singapore',
      'Singapore>Rotterdam',
      'Rotterdam>Hamburg',
    ]);
  });

  it('saves a direct one-leg schedule', async () => {
    const bookingId = await makeBooking();
    const res = await as(token)
      .post(`/api/tenant/cs/bookings/${bookingId}/schedules`)
      .send(body('DIRECT', oneLeg()));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('moves the booking to VESSEL_PROPOSED through §5.1’s service', async () => {
    const bookingId = await makeBooking();
    await as(token).post(`/api/tenant/cs/bookings/${bookingId}/schedules`).send(body('DIRECT', oneLeg()));

    const row = await owner.shipment.findFirstOrThrow({
      where: { id: bookingId },
      select: { status: true },
    });
    expect(row.status).toBe('VESSEL_PROPOSED');
  });

  it('notifies the customer (§6.4)', async () => {
    const bookingId = await makeBooking();
    await as(token).post(`/api/tenant/cs/bookings/${bookingId}/schedules`).send(body('DIRECT', oneLeg()));

    const mail = await owner.emailLog.findFirst({
      where: { tenantId, relatedType: 'shipment', relatedId: bookingId },
      select: { toAddresses: true, subject: true },
    });
    expect(mail?.toAddresses).toEqual(['desk@schedule-customer.test']);
    expect(mail?.subject).toMatch(/Schedule proposed/i);
  });

  it('refuses a user who may read a schedule but not propose one', async () => {
    const bookingId = await makeBooking();
    const res = await as(tokenReadOnly)
      .post(`/api/tenant/cs/bookings/${bookingId}/schedules`)
      .send(body('DIRECT', oneLeg()));
    expect(res.status).toBe(403);
  });

  it('refuses a booking that has moved past the point of proposing', async () => {
    // §5.1 again: the service decides, and CARGO_RECEIVED does not lead here.
    const bookingId = await makeBooking();
    await owner.shipment.update({ where: { id: bookingId }, data: { status: 'CARGO_RECEIVED' } });

    const res = await as(token)
      .post(`/api/tenant/cs/bookings/${bookingId}/schedules`)
      .send(body('DIRECT', oneLeg()));
    expect(res.status).toBe(409);
  });
});

describe('leg continuity (§6.4)', () => {
  async function reject(transitType: 'DIRECT' | 'INDIRECT', legs: Leg[]): Promise<number> {
    const bookingId = await makeBooking();
    const res = await as(token)
      .post(`/api/tenant/cs/bookings/${bookingId}/schedules`)
      .send(body(transitType, legs));
    return res.status;
  }

  it('refuses a leg that starts where the last one did not end', async () => {
    // Chittagong → Singapore, then CHITTAGONG → Rotterdam. The cargo would have
    // to teleport back from Singapore to Chittagong between the two.
    const legs = threeLegs();
    legs[1]!.originPortId = chittagong.toString();
    expect(await reject('INDIRECT', legs)).toBe(400);
  });

  it('refuses a leg that departs before the previous one lands', async () => {
    const legs = threeLegs();
    legs[1]!.etd = '2026-10-05T08:00:00.000Z'; // leg 1 arrives on the 7th
    expect(await reject('INDIRECT', legs)).toBe(400);
  });

  it('refuses a leg that arrives before it departs', async () => {
    const legs = oneLeg();
    legs[0]!.eta = '2026-09-01T00:00:00.000Z';
    expect(await reject('DIRECT', legs)).toBe(400);
  });

  it('refuses a leg from a port to itself', async () => {
    const legs = oneLeg();
    legs[0]!.destinationPortId = chittagong.toString();
    expect(await reject('DIRECT', legs)).toBe(400);
  });

  it('refuses two legs on a direct sailing', async () => {
    expect(await reject('DIRECT', threeLegs().slice(0, 2))).toBe(400);
  });

  it('refuses one leg on an indirect sailing', async () => {
    expect(await reject('INDIRECT', oneLeg())).toBe(400);
  });

  it('refuses four legs, which §6.4 does not allow', async () => {
    const legs = [
      ...threeLegs(),
      {
        legNo: 4,
        originPortId: hamburg.toString(),
        destinationPortId: chittagong.toString(),
        etd: '2026-11-03T08:00:00.000Z',
        eta: '2026-11-20T18:00:00.000Z',
      },
    ];
    expect(await reject('INDIRECT', legs)).toBe(400);
  });

  it('names the leg that is wrong, not just the schedule', () => {
    // The screen marks a row with this; a message that only said "invalid"
    // would leave an operator hunting three rows for the one that is broken.
    const legs = threeLegs();
    legs[1]!.originPortId = chittagong.toString();
    const problems = checkLegContinuity('INDIRECT', legs);

    expect(problems.some((p) => p.legNo === 2)).toBe(true);
    expect(problems.find((p) => p.legNo === 2)?.message).toMatch(/leg 1 did not end/i);
  });

  it('accepts a clean three-leg chain', () => {
    expect(checkLegContinuity('INDIRECT', threeLegs())).toEqual([]);
  });
});

describe('versions (§4.2)', () => {
  it('supersedes the live proposal rather than editing it', async () => {
    const bookingId = await makeBooking();
    await as(token).post(`/api/tenant/cs/bookings/${bookingId}/schedules`).send(body('DIRECT', oneLeg()));

    // The customer rejects it, and C/S proposes another.
    await owner.shipmentSchedule.updateMany({
      where: { shipmentId: bookingId, status: 'PROPOSED' },
      data: {
        status: 'REJECTED',
        rejectionComments: 'That sailing is too late for our season.',
        decidedBy: (await owner.user.findFirstOrThrow({ where: { tenantId }, select: { id: true } })).id,
        decidedAt: new Date(),
      },
    });
    await owner.shipment.update({ where: { id: bookingId }, data: { status: 'REJECTED' } });

    const second = await as(token)
      .post(`/api/tenant/cs/bookings/${bookingId}/schedules`)
      .send(body('INDIRECT', threeLegs()));
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect((second.body as { data: { versionNo: number } }).data.versionNo).toBe(2);

    // §4.2: version 1 is still there, still REJECTED, still carrying its reason.
    const all = await as(token).get(`/api/tenant/cs/bookings/${bookingId}/schedules`);
    const versions = (all.body as {
      data: { versionNo: number; status: string; rejectionComments: string | null }[];
    }).data;

    expect(versions.map((v) => v.versionNo)).toEqual([2, 1]);
    const first = versions.find((v) => v.versionNo === 1);
    expect(first?.status).toBe('REJECTED');
    expect(first?.rejectionComments).toBe('That sailing is too late for our season.');
  });

  it('leaves only one schedule live at a time', async () => {
    const bookingId = await makeBooking();
    await as(token).post(`/api/tenant/cs/bookings/${bookingId}/schedules`).send(body('DIRECT', oneLeg()));
    // Re-proposing over a live one: the first becomes SUPERSEDED.
    await owner.shipment.update({ where: { id: bookingId }, data: { status: 'REJECTED' } });
    await as(token)
      .post(`/api/tenant/cs/bookings/${bookingId}/schedules`)
      .send(body('INDIRECT', threeLegs()));

    const live = await owner.shipmentSchedule.count({
      where: { shipmentId: bookingId, deletedAt: null, status: { in: ['PROPOSED', 'APPROVED'] } },
    });
    expect(live).toBe(1);

    const superseded = await owner.shipmentSchedule.count({
      where: { shipmentId: bookingId, status: 'SUPERSEDED' },
    });
    expect(superseded).toBe(1);
  });
});

describe('the read-only header §6.4 draws', () => {
  it('summarises the booking and its cargo', async () => {
    const bookingId = await makeBooking();
    const po = await owner.shipmentPo.create({
      data: { tenantId, shipmentId: bookingId, poNo: 'PO-CTX' },
      select: { id: true },
    });
    await owner.shipmentCargoLine.create({
      data: {
        tenantId,
        shipmentId: bookingId,
        shipmentPoId: po.id,
        itemCode: 'ITEM',
        ctnQty: 100,
        grossWeightKg: '900',
        cartonLengthCm: '60',
        cartonWidthCm: '40',
        cartonHeightCm: '30',
      },
    });

    const res = await as(token).get(`/api/tenant/cs/bookings/${bookingId}/schedule-context`);
    expect(res.status).toBe(200);
    const ctx = (res.body as { data: Record<string, unknown> }).data;

    expect(ctx.customerName).toBe('Schedule Customer');
    expect(ctx.polName).toBe('Chittagong');
    expect(ctx.podName).toBe('Hamburg');
    expect((ctx.cargo as { ctnQty: string }).ctnQty).toBe('100');
    // The generated column, summed — not recomputed here.
    expect(Number((ctx.cargo as { volumeCbm: string }).volumeCbm)).toBe(7.2);
  });
});

describe('shipment approval (§5.3, §6.5)', () => {
  /** A booking with `count` POs and a schedule waiting for a decision. */
  async function readyForDecision(count: number): Promise<{ id: bigint; poIds: string[] }> {
    const bookingId = await makeBooking();
    const poIds: string[] = [];
    for (let i = 1; i <= count; i += 1) {
      const po = await owner.shipmentPo.create({
        data: { tenantId, shipmentId: bookingId, poNo: `PO-${bookingId}-${i}` },
        select: { id: true },
      });
      poIds.push(po.id.toString());
    }
    const res = await as(token)
      .post(`/api/tenant/cs/bookings/${bookingId}/schedules`)
      .send(body('DIRECT', oneLeg()));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: bookingId, poIds };
  }

  async function decide(
    id: bigint,
    decisions: { poId: string; decision: 'APPROVED' | 'REJECTED'; comments?: string }[],
    onBehalfOfCustomer = false,
  ) {
    return as(token)
      .post(`/api/tenant/cs/bookings/${id}/approval`)
      .send({ decisions, onBehalfOfCustomer });
  }

  it('approves some POs and holds the rest — the phase gate', async () => {
    /*
     * §5.3: "the shipment reaches APPROVED_FOR_SHIPMENT when at least one PO is
     * approved; unapproved POs stay PENDING and are excluded from the shipping
     * order". Three POs, two approved, one rejected.
     */
    const { id, poIds } = await readyForDecision(3);
    const res = await decide(id, [
      { poId: poIds[0]!, decision: 'APPROVED' },
      { poId: poIds[1]!, decision: 'APPROVED' },
      { poId: poIds[2]!, decision: 'REJECTED', comments: 'Not ready for this sailing.' },
    ]);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const data = (res.body as { data: { approved: number; total: number; summary: string } }).data;
    expect(data.approved).toBe(2);
    expect(data.total).toBe(3);
    expect(data.summary).toBe('2 of 3 POs approved. 1 will not ship on this vessel.');

    const shipment = await owner.shipment.findFirstOrThrow({
      where: { id },
      select: { status: true },
    });
    expect(shipment.status).toBe('APPROVED_FOR_SHIPMENT');

    const pos = await owner.shipmentPo.findMany({
      where: { shipmentId: id },
      orderBy: { poNo: 'asc' },
      select: { approvalStatus: true, rejectionComments: true },
    });
    expect(pos.map((p) => p.approvalStatus)).toEqual(['APPROVED', 'APPROVED', 'REJECTED']);
    expect(pos[2]?.rejectionComments).toBe('Not ready for this sailing.');
  });

  it('leaves an undecided PO PENDING without stopping the shipment', async () => {
    const { id, poIds } = await readyForDecision(3);
    await decide(id, [{ poId: poIds[0]!, decision: 'APPROVED' }]);

    const pending = await owner.shipmentPo.count({
      where: { shipmentId: id, approvalStatus: 'PENDING' },
    });
    expect(pending).toBe(2);

    const shipment = await owner.shipment.findFirstOrThrow({
      where: { id },
      select: { status: true },
    });
    expect(shipment.status).toBe('APPROVED_FOR_SHIPMENT');
  });

  it('rejects the whole schedule when no PO survives (§5.1)', async () => {
    const { id, poIds } = await readyForDecision(2);
    const res = await decide(id, [
      { poId: poIds[0]!, decision: 'REJECTED', comments: 'Too late for our season.' },
      { poId: poIds[1]!, decision: 'REJECTED', comments: 'Same.' },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const shipment = await owner.shipment.findFirstOrThrow({
      where: { id },
      select: { status: true },
    });
    expect(shipment.status).toBe('REJECTED');

    // §4.2: the schedule keeps the reason, so C/S can answer it.
    const schedule = await owner.shipmentSchedule.findFirstOrThrow({
      where: { shipmentId: id },
      select: { status: true, rejectionComments: true },
    });
    expect(schedule.status).toBe('REJECTED');
    expect(schedule.rejectionComments).toMatch(/Too late for our season/);
  });

  it('refuses a rejection with no comment (§5.3)', async () => {
    const { id, poIds } = await readyForDecision(1);
    const res = await decide(id, [{ poId: poIds[0]!, decision: 'REJECTED' }]);
    expect(res.status).toBe(400);

    // ...and nothing moved.
    const shipment = await owner.shipment.findFirstOrThrow({
      where: { id },
      select: { status: true },
    });
    expect(shipment.status).toBe('VESSEL_PROPOSED');
  });

  it('records who decided, and on whose behalf (§9 Q6)', async () => {
    const { id, poIds } = await readyForDecision(1);
    await decide(id, [{ poId: poIds[0]!, decision: 'APPROVED' }], true);

    const po = await owner.shipmentPo.findFirstOrThrow({
      where: { shipmentId: id },
      select: { approvedBy: true, approvedAt: true, approvedOnBehalf: true },
    });
    expect(po.approvedBy).not.toBeNull();
    expect(po.approvedAt).not.toBeNull();
    expect(po.approvedOnBehalf).toBe(true);

    const schedule = await owner.shipmentSchedule.findFirstOrThrow({
      where: { shipmentId: id },
      select: { decidedOnBehalf: true },
    });
    expect(schedule.decidedOnBehalf).toBe(true);
  });

  it('defaults to the customer deciding for themselves', async () => {
    const { id, poIds } = await readyForDecision(1);
    await decide(id, [{ poId: poIds[0]!, decision: 'APPROVED' }]);

    const po = await owner.shipmentPo.findFirstOrThrow({
      where: { shipmentId: id },
      select: { approvedOnBehalf: true },
    });
    expect(po.approvedOnBehalf).toBe(false);
  });

  it('emails whoever proposed the sailing (§6.5)', async () => {
    const { id, poIds } = await readyForDecision(1);
    await decide(id, [{ poId: poIds[0]!, decision: 'APPROVED' }]);

    const mail = await owner.emailLog.findFirst({
      where: { tenantId, relatedType: 'shipment', relatedId: id },
      orderBy: { id: 'desc' },
      select: { subject: true, toAddresses: true },
    });
    expect(mail?.subject).toMatch(/approved/i);
    expect(mail?.toAddresses).toEqual(['admin@sched.test']);
  });

  it('refuses when nothing has been proposed', async () => {
    const bookingId = await makeBooking();
    const po = await owner.shipmentPo.create({
      data: { tenantId, shipmentId: bookingId, poNo: 'PO-NOSCHED' },
      select: { id: true },
    });
    const res = await decide(bookingId, [{ poId: po.id.toString(), decision: 'APPROVED' }]);
    expect(res.status).toBe(409);
  });

  it('refuses a PO that belongs to another booking', async () => {
    const mine = await readyForDecision(1);
    const theirs = await readyForDecision(1);
    const res = await decide(mine.id, [{ poId: theirs.poIds[0]!, decision: 'APPROVED' }]);
    expect(res.status).toBe(404);
  });

  it('refuses a user who may approve but not reject', async () => {
    // §7 splits them: turning a sailing down is the decision with consequences.
    const { id, poIds } = await readyForDecision(1);
    const res = await request(app)
      .post(`/api/tenant/cs/bookings/${id}/approval`)
      .set('Authorization', `Bearer ${tokenApproveOnly}`)
      .set('X-Tenant-Slug', SLUG)
      .send({
        decisions: [{ poId: poIds[0]!, decision: 'REJECTED', comments: 'No.' }],
        onBehalfOfCustomer: false,
      });
    expect(res.status).toBe(403);
  });
});
