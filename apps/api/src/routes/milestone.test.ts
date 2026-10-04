import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Depart-Arrive Confirmation, through HTTP — docs/DESIGN-UPDATE-2026-10-04.md §2.
 *
 * Two workspaces, each with:
 *   direct    sea, direct, advised (the advise's ETD differs from the
 *             schedule's, so "pulled from the advise" is visible), with a BL
 *             draft waiting for its on-board date
 *   indirect  sea, two legs, approved schedule and no advise — how an inbound
 *             booking reaches these screens
 *   air       air, one flight
 *   cancelled sea, approved schedule, but cancelled: never listed
 *   unplanned sea, no schedule and no advise: nothing to confirm against
 */

const queueMailSpy = vi.hoisted(() =>
  vi.fn(async (_input: { templateKey: string; to: string[]; variables: Record<string, unknown> }) => ({
    queued: true,
    id: 1n,
  })),
);
vi.mock('../lib/email-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email-queue')>();
  return { ...actual, queueMail: queueMailSpy };
});

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');
const { withTenant } = await import('../lib/tenant-client');
const { blDraftPrefill } = await import('../lib/bl-draft-view');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'milestone-alpha';
const SLUG_B = 'milestone-beta';
const YEAR = new Date().getUTCFullYear();

/** A calendar day `n` days from today, YYYY-MM-DD. Departures are kept well in the past. */
function dayFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const SCHEDULE_ETD = dayFromNow(-12);
const ADVISE_ETD = dayFromNow(-10);
const ADVISE_ETA = dayFromNow(15);
const HUB_ETD = dayFromNow(-4);
const LAST_ETA = dayFromNow(20);

interface World {
  tenantId: bigint;
  slug: string;
  superToken: string;
  editorToken: string;
  viewerToken: string;
  bareToken: string;
  direct: { id: bigint; code: string };
  indirect: { id: bigint; code: string };
  air: { id: bigint; code: string };
  cancelled: { id: bigint; code: string };
  unplanned: { id: bigint; code: string };
  blDraftId: bigint;
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'shipment_milestone',
    'bl_draft',
    'shipment_advise_booking',
    'shipment_advise',
    'shipment_schedule_leg',
    'shipment_schedule',
    'shipment',
    'quotation',
    'inquiry',
    'customer_pic',
    'customer',
    'vessel',
    'carrier',
    'port',
    'industry_sector',
    'email_log',
    'user',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string): Promise<World> {
  const bdt = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } } })).id;
  const { id: tenantId } = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh', currencyId: bdt },
    select: { id: true },
  });

  const user = async (code: string, isSuperadmin: boolean, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x', isSuperadmin },
      select: { id: true },
    });
    return signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin, permissions, tokenVersion: 0 });
  };

  // Who approved the schedules: an APPROVED one must name its decider.
  const decider = await owner.user.create({
    data: { tenantId, code: `USR-D${tag}`, username: `usr-d${tag.toLowerCase()}-${slug}`, email: `d@${slug}.test`, passwordHash: 'x', isSuperadmin: false },
    select: { id: true },
  });

  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: `CUS-${tag}`,
      name: `Shafidi ${tag}`,
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  await owner.customerPic.create({
    data: { tenantId, code: `CPC-${tag}`, customerId: customer.id, name: 'Shipping desk', email: `desk@shafidi-${tag.toLowerCase()}.test` },
  });

  const port = async (code: string, portName: string, type: 'SEAPORT' | 'AIRPORT' = 'SEAPORT') =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${code}`, name: portName, portCode: `${tag}${code}`, country: 'Bangladesh', type },
        select: { id: true },
      })
    ).id;
  const ctg = await port('CTG', `Chittagong ${tag}`);
  const cmb = await port('CMB', `Colombo ${tag}`);
  const ham = await port('HAM', `Hamburg ${tag}`);
  const dac = await port('DAC', `Dhaka ${tag}`, 'AIRPORT');
  const lhr = await port('LHR', `London ${tag}`, 'AIRPORT');

  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: `CAR-${tag}`, name: `Ocean Line ${tag}`, typeId: carrierType.id },
    select: { id: true },
  });
  const vessel = async (code: string, vesselName: string) =>
    (await owner.vessel.create({ data: { tenantId, code: `VSL-${tag}${code}`, name: vesselName, carrierId: carrier.id }, select: { id: true } })).id;
  const feeder = await vessel('1', `Feeder ${tag}`);
  const mother = await vessel('2', `Mother ${tag}`);
  const advised = await vessel('3', `Advised ${tag}`);

  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: `INQ-${YEAR}-7${tag}01`,
      seriesYear: YEAR,
      inquiryDate: at(dayFromNow(-40)),
      sourceId: source.id,
      shipmentType: 'SEA',
      customerId: customer.id,
      movementType: 'OUTBOUND',
      polId: ctg,
      podId: ham,
    },
    select: { id: true },
  });
  const quotation = await owner.quotation.create({
    data: {
      tenantId,
      code: `QTN-${YEAR}-7${tag}01`,
      seriesYear: YEAR,
      inquiryId: inquiry.id,
      quotationDate: at(dayFromNow(-39)),
      customerId: customer.id,
      shipmentType: 'SEA',
      movementType: 'OUTBOUND',
      polId: ctg,
      podId: ham,
      carrierId: carrier.id,
      localCurrencyId: bdt,
      conversionRate: '1',
      status: 'ACCEPTED',
    },
    select: { id: true },
  });

  let n = 0;
  const shipment = async (shipmentType: 'SEA' | 'AIR', status: 'APPROVED_FOR_SHIPMENT' | 'CANCELLED' = 'APPROVED_FOR_SHIPMENT') => {
    n += 1;
    return owner.shipment.create({
      data: {
        tenantId,
        code: `BKG-${YEAR}-7${tag}0${n}`,
        seriesYear: YEAR,
        quotationId: quotation.id,
        shipmentType,
        customerId: customer.id,
        carrierId: carrier.id,
        polId: shipmentType === 'AIR' ? dac : ctg,
        podId: shipmentType === 'AIR' ? lhr : ham,
        exporterName: `Shafidi Knit ${tag}`,
        status,
        ...(status === 'CANCELLED'
          ? { cancelledAt: new Date(), cancelledBy: decider.id, cancelReason: 'Buyer withdrew the order' }
          : {}),
      },
      select: { id: true, code: true },
    });
  };

  let s = 0;
  const schedule = async (
    shipmentId: bigint,
    transitType: 'DIRECT' | 'INDIRECT',
    legs: { origin: bigint; destination: bigint; etd: string; eta: string; vesselId?: bigint; voyageNo?: string; flightNo?: string }[],
  ) => {
    s += 1;
    const made = await owner.shipmentSchedule.create({
      data: {
        tenantId,
        code: `SCH-${tag}${s}`,
        shipmentId,
        carrierId: carrier.id,
        transitType,
        status: 'APPROVED',
        decidedBy: decider.id,
        decidedAt: new Date(),
      },
      select: { id: true },
    });
    for (const [index, leg] of legs.entries()) {
      await owner.shipmentScheduleLeg.create({
        data: {
          tenantId,
          scheduleId: made.id,
          legNo: index + 1,
          originPortId: leg.origin,
          destinationPortId: leg.destination,
          etd: at(leg.etd),
          eta: at(leg.eta),
          vesselId: leg.vesselId ?? null,
          voyageNo: leg.voyageNo ?? null,
          flightNo: leg.flightNo ?? null,
        },
      });
    }
    return made.id;
  };

  const direct = await shipment('SEA');
  const directSchedule = await schedule(direct.id, 'DIRECT', [
    { origin: ctg, destination: ham, etd: SCHEDULE_ETD, eta: dayFromNow(14), vesselId: feeder, voyageNo: '001W' },
  ]);
  const indirect = await shipment('SEA');
  await schedule(indirect.id, 'INDIRECT', [
    { origin: ctg, destination: cmb, etd: SCHEDULE_ETD, eta: dayFromNow(-6), vesselId: feeder, voyageNo: '002W' },
    { origin: cmb, destination: ham, etd: HUB_ETD, eta: LAST_ETA, vesselId: mother, voyageNo: '9MA' },
  ]);
  const air = await shipment('AIR');
  await schedule(air.id, 'DIRECT', [{ origin: dac, destination: lhr, etd: SCHEDULE_ETD, eta: dayFromNow(-11), flightNo: 'EK 585' }]);
  const cancelled = await shipment('SEA', 'CANCELLED');
  await schedule(cancelled.id, 'DIRECT', [{ origin: ctg, destination: ham, etd: SCHEDULE_ETD, eta: dayFromNow(14) }]);
  const unplanned = await shipment('SEA');

  // The direct booking is advised: a draft first, because the CR-005 guard
  // only takes members while it is one, then sent.
  const advise = await owner.shipmentAdvise.create({
    data: {
      tenantId,
      code: `SA-${YEAR}-7${tag}01`,
      seriesYear: YEAR,
      shipmentId: direct.id,
      scheduleId: directSchedule,
      carrierId: carrier.id,
      transitType: 'DIRECT',
      firstVesselId: advised,
      voyageNo: '777E',
      polId: ctg,
      podId: ham,
      etd: at(ADVISE_ETD),
      eta: at(ADVISE_ETA),
      houseBlNo: `HBL${tag}7001`,
    },
    select: { id: true },
  });
  await owner.shipmentAdviseBooking.create({ data: { tenantId, adviseId: advise.id, shipmentId: direct.id } });
  await owner.shipmentAdvise.update({ where: { id: advise.id }, data: { status: 'SENT' } });

  const mode = await owner.mode.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const bl = await owner.blDraft.create({
    data: {
      tenantId,
      code: `BLD-${YEAR}-7${tag}01`,
      seriesYear: YEAR,
      shipmentId: direct.id,
      adviseId: advise.id,
      blNo: `HBL${tag}7001`,
      shipperText: 'Shafidi Knit',
      consigneeText: 'Hamburg buyer',
      notifyText: 'Same as consignee',
      preCarriageByModeId: mode.id,
      placeOfReceipt: 'Chittagong',
      polId: ctg,
      podId: ham,
    },
    select: { id: true },
  });

  return {
    tenantId,
    slug,
    superToken: await user(`USR-S${tag}`, true, []),
    editorToken: await user(`USR-E${tag}`, false, ['CUSTOMER_SERVICE.DEPART_ARRIVE.VIEW', 'CUSTOMER_SERVICE.DEPART_ARRIVE.EDIT']),
    viewerToken: await user(`USR-V${tag}`, false, ['CUSTOMER_SERVICE.DEPART_ARRIVE.VIEW']),
    bareToken: await user(`USR-B${tag}`, false, []),
    direct,
    indirect,
    air,
    cancelled,
    unplanned,
    blDraftId: bl.id,
  };
}

function api(token: string, slug: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  return {
    list: (query: string) => wrap(request(app).get(`/api/tenant/cs/depart-arrive?${query}`)),
    summary: () => wrap(request(app).get('/api/tenant/cs/depart-arrive/summary')),
    confirm: (shipmentId: bigint, body: Record<string, unknown>) =>
      wrap(request(app).post(`/api/tenant/cs/depart-arrive/${shipmentId}`)).send(body),
  };
}

interface Row {
  bookingCode: string;
  legLabel: string | null;
  plannedOn: string | null;
  soCode: string | null;
  exporterName: string | null;
  recipients: string[];
  confirmation: { confirmedOn: string; pulledOn: string | null; changeReason: string | null; notified: boolean } | null;
}
const codes = (body: { data: Row[] }) => body.data.map((r) => r.bookingCode).sort();

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Milestone Alpha', SLUG_A, 'MA');
  B = await makeWorld('Milestone Beta', SLUG_B, 'MB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

beforeEach(() => {
  queueMailSpy.mockClear();
});

describe('Depart-Arrive Confirmation', () => {
  it('lists every booking with a schedule or an advise on On board, and pulls the advise date first', async () => {
    const res = await api(A.editorToken, A.slug).list('kind=DEPARTED&shipmentType=SEA');
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual([A.direct.code, A.indirect.code].sort());

    const rows = res.body.data as Row[];
    const direct = rows.find((r) => r.bookingCode === A.direct.code)!;
    // "This date pull from shipment advise": the advise, not the schedule.
    expect(direct.plannedOn).toBe(ADVISE_ETD);
    expect(direct.legLabel).toBe('Advised MA / 777E');
    expect(direct.exporterName).toBe('Shafidi Knit MA');
    expect(direct.recipients).toEqual(['desk@shafidi-ma.test']);
    // No advise yet: the approved schedule's first leg.
    const indirect = rows.find((r) => r.bookingCode === A.indirect.code)!;
    expect(indirect.plannedOn).toBe(SCHEDULE_ETD);
    expect(indirect.legLabel).toBe('Feeder MA / 002W');

    const air = await api(A.editorToken, A.slug).list('kind=DEPARTED&shipmentType=AIR');
    expect(codes(air.body)).toEqual([A.air.code]);
    expect((air.body.data as Row[])[0]!.legLabel).toBe('EK 585');
  });

  it('counts the work on each tile, and nothing waits on transshipment or arrival before a departure', async () => {
    const res = await api(A.viewerToken, A.slug).summary();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      'onboard-sea': 2,
      'onboard-air': 1,
      'transshipment-sea': 0,
      'transshipment-air': 0,
      'arrival-sea': 0,
      'arrival-air': 0,
    });
  });

  it('refuses a transshipment or an arrival before the departure, and a booking with nothing to confirm against', async () => {
    const early = await api(A.editorToken, A.slug).confirm(A.indirect.id, { kind: 'ARRIVED', date: LAST_ETA });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('DEPARTURE_FIRST');

    const none = await api(A.editorToken, A.slug).confirm(A.unplanned.id, { kind: 'DEPARTED', date: dayFromNow(-2) });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NO_SCHEDULE');

    const gone = await api(A.editorToken, A.slug).confirm(A.cancelled.id, { kind: 'DEPARTED', date: SCHEDULE_ETD });
    expect(gone.status).toBe(409);
  });

  it('wants a reason when the vessel sailed on another day, and never a departure still to come', async () => {
    const silent = await api(A.editorToken, A.slug).confirm(A.direct.id, { kind: 'DEPARTED', date: dayFromNow(-9) });
    expect(silent.status).toBe(400);
    expect(silent.body.error.message).toContain(ADVISE_ETD);

    const future = await api(A.editorToken, A.slug).confirm(A.direct.id, {
      kind: 'DEPARTED',
      date: dayFromNow(5),
      reason: 'Rolled to the next sailing',
    });
    expect(future.status).toBe(400);
    expect(queueMailSpy).not.toHaveBeenCalled();
  });

  it('confirms a late departure: tells the customer why, and sets the BL draft on-board date', async () => {
    const late = dayFromNow(-9);
    const res = await api(A.editorToken, A.slug).confirm(A.direct.id, {
      kind: 'DEPARTED',
      date: late,
      reason: 'Vessel delayed one day at berth.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.notified).toBe(true);
    expect(res.body.data.blDraftsUpdated).toBe(1);
    expect(res.body.data.row.confirmation).toMatchObject({
      confirmedOn: late,
      pulledOn: ADVISE_ETD,
      changeReason: 'Vessel delayed one day at berth.',
      notified: true,
    });

    expect(queueMailSpy).toHaveBeenCalledTimes(1);
    const mail = queueMailSpy.mock.calls[0]![0];
    expect(mail.templateKey).toBe('SHIPMENT_DEPARTED');
    expect(mail.to).toEqual(['desk@shafidi-ma.test']);
    expect(String(mail.variables.reasonLine)).toContain('Vessel delayed one day at berth.');
    expect(mail.variables.houseBlNo).toBe('HBLMA7001');

    const bl = await owner.blDraft.findUniqueOrThrow({ where: { id: A.blDraftId }, select: { ladenOnBoardDate: true } });
    expect(bl.ladenOnBoardDate?.toISOString().slice(0, 10)).toBe(late);

    // And a BL drawn from now on opens with it.
    const prefill = await withTenant(A.tenantId, (db) => blDraftPrefill(db, A.direct.id));
    expect(prefill.ladenOnBoardDate).toBe(late);

    // Off the worklist, onto the record.
    const awaiting = await api(A.editorToken, A.slug).list('kind=DEPARTED&shipmentType=SEA');
    expect(codes(awaiting.body)).toEqual([A.indirect.code]);
    const confirmed = await api(A.editorToken, A.slug).list('kind=DEPARTED&shipmentType=SEA&view=CONFIRMED');
    expect(codes(confirmed.body)).toEqual([A.direct.code]);
  });

  it('corrects a confirmation in place, measured against the date first pulled', async () => {
    const res = await api(A.editorToken, A.slug).confirm(A.direct.id, { kind: 'DEPARTED', date: ADVISE_ETD, notify: false });
    expect(res.status).toBe(200);
    expect(res.body.data.notified).toBe(false);
    // Back on the advise's own date, so no reason is owed, and none is kept.
    expect(res.body.data.row.confirmation).toMatchObject({ confirmedOn: ADVISE_ETD, pulledOn: ADVISE_ETD, changeReason: null });
    expect(queueMailSpy).not.toHaveBeenCalled();
    const live = await owner.shipmentMilestone.count({ where: { shipmentId: A.direct.id, deletedAt: null } });
    expect(live).toBe(1);
  });

  it('offers transshipment for the indirect route only, after it has sailed', async () => {
    const departed = await api(A.editorToken, A.slug).confirm(A.indirect.id, { kind: 'DEPARTED', date: SCHEDULE_ETD });
    expect(departed.status).toBe(200);

    const list = await api(A.editorToken, A.slug).list('kind=TRANSSHIPPED&shipmentType=SEA');
    expect(codes(list.body)).toEqual([A.indirect.code]);
    const row = (list.body.data as Row[])[0]!;
    expect(row.plannedOn).toBe(HUB_ETD);
    expect(row.legLabel).toBe('Mother MA / 9MA');

    const direct = await api(A.editorToken, A.slug).confirm(A.direct.id, { kind: 'TRANSSHIPPED', date: HUB_ETD });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('DIRECT_ROUTE');

    const before = await api(A.editorToken, A.slug).confirm(A.indirect.id, {
      kind: 'TRANSSHIPPED',
      date: dayFromNow(-13),
      reason: 'Typed the wrong day',
    });
    expect(before.status).toBe(400);

    const ok = await api(A.editorToken, A.slug).confirm(A.indirect.id, { kind: 'TRANSSHIPPED', date: HUB_ETD });
    expect(ok.status).toBe(200);
    expect(queueMailSpy.mock.calls.at(-1)![0].templateKey).toBe('SHIPMENT_TRANSSHIPPED');
  });

  it('confirms the final arrival date ahead of time, from the advise or the last leg', async () => {
    const list = await api(A.editorToken, A.slug).list('kind=ARRIVED&shipmentType=SEA');
    const rows = list.body.data as Row[];
    expect(rows.map((r) => r.bookingCode).sort()).toEqual([A.direct.code, A.indirect.code].sort());
    expect(rows.find((r) => r.bookingCode === A.direct.code)!.plannedOn).toBe(ADVISE_ETA);
    expect(rows.find((r) => r.bookingCode === A.indirect.code)!.plannedOn).toBe(LAST_ETA);

    // Arrival is confirmed before it happens, and a firmer date needs no excuse.
    const res = await api(A.editorToken, A.slug).confirm(A.indirect.id, { kind: 'ARRIVED', date: dayFromNow(21) });
    expect(res.status).toBe(200);
    expect(queueMailSpy.mock.calls.at(-1)![0].templateKey).toBe('SHIPMENT_ARRIVED');

    // A departure cannot now move past the arrival.
    const late = await api(A.editorToken, A.slug).confirm(A.indirect.id, {
      kind: 'DEPARTED',
      date: dayFromNow(-1),
      reason: 'Wrong day',
    });
    expect(late.status).toBe(400);
  });

  it('lets a viewer read but not confirm, and a stranger do neither', async () => {
    expect((await api(A.viewerToken, A.slug).list('kind=DEPARTED&shipmentType=AIR')).status).toBe(200);
    expect((await api(A.viewerToken, A.slug).confirm(A.air.id, { kind: 'DEPARTED', date: SCHEDULE_ETD })).status).toBe(403);
    expect((await api(A.bareToken, A.slug).summary()).status).toBe(403);
  });

  it("never shows or confirms another workspace's bookings", async () => {
    const b = await api(B.superToken, B.slug).list('kind=DEPARTED&shipmentType=SEA&view=ALL');
    expect(codes(b.body)).toEqual([B.direct.code, B.indirect.code].sort());
    // A's confirmations did not leak into B's counts.
    const summary = await api(B.superToken, B.slug).summary();
    expect(summary.body.data['onboard-sea']).toBe(2);

    const crossed = await api(A.superToken, A.slug).confirm(B.direct.id, { kind: 'DEPARTED', date: ADVISE_ETD });
    expect(crossed.status).toBe(404);
    expect(await owner.shipmentMilestone.count({ where: { tenantId: B.tenantId } })).toBe(0);
  });
});
