import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The air shipment, end to end through HTTP — docs/MODULE_DOCUMENTATION.md §14.
 *
 * Air has no container load plan (Menu I23, "No need CLP for Air Shipment"):
 *
 *   cargo receipt confirmed -> Shipment Advise - Air (from the receipts)
 *     -> HAWB draft -> Approve -> BL Print: Issue HAWB -> three originals
 *
 * Two workspaces, so every assertion about one is also a check that the other
 * sees none of it (CLAUDE.md §7A rule 4). The advise is inserted as the advise
 * route leaves it once sent, routing and totals included; everything after it
 * goes through the routes.
 */

// The outbox is mocked, for the reason bl-print.test.ts gives.
const queueMailSpy = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ queued: true })));
vi.mock('../lib/email-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email-queue')>();
  return { ...actual, queueMail: queueMailSpy };
});

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');
const { extractPdfText } = await import('../lib/pdf-text');

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'awb-alpha';
const SLUG_B = 'awb-beta';
const YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);

interface Booking {
  id: bigint;
  code: string;
  houseBlNo: string;
}

interface World {
  slug: string;
  tenantId: bigint;
  token: string;
  dacId: bigint;
  vieId: bigint;
  agentId: bigint;
  /** Advised, FOB, DAC -> SHJ -> VIE on Air Arabia. */
  air: Booking;
  /** Cargo received under a confirmed receipt, not yet advised. */
  received: Booking;
  /** A sea booking, advised — its bill still needs the sea boxes. */
  sea: Booking;
}

let A: World;
let B: World;
let modeId: bigint;
let bdt: bigint;
let usd: bigint;
let size20: bigint;
const tosId = new Map<string, bigint>();

function as(world: World) {
  const wrap = (r: request.Test) =>
    r.set('Authorization', `Bearer ${world.token}`).set('X-Tenant-Slug', world.slug);
  return {
    get: (p: string) => wrap(request(app).get(`/api/tenant${p}`)),
    post: (p: string) => wrap(request(app).post(`/api/tenant${p}`)),
    patch: (p: string) => wrap(request(app).patch(`/api/tenant${p}`)),
    put: (p: string) => wrap(request(app).put(`/api/tenant${p}`)),
  };
}

function pdf(r: request.Test) {
  return r.buffer(true).parse((res, cb) => {
    const parts: Buffer[] = [];
    res.on('data', (c: Buffer) => parts.push(c));
    res.on('end', () => cb(null, Buffer.concat(parts)));
  });
}

const pageCount = (bytes: Buffer): number =>
  (bytes.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;

async function statusOf(id: bigint): Promise<string> {
  return (await owner.shipment.findFirstOrThrow({ where: { id }, select: { status: true } })).status;
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'bl_draft_container',
    'bl_draft',
    'shipment_advise_booking',
    'shipment_advise',
    'cargo_receipt_line',
    'cargo_receipt',
    'shipment_cargo_line',
    'shipment_po',
    'shipment_schedule_leg',
    'shipment_schedule',
    'shipment',
    'quotation_line',
    'quotation',
    'inquiry',
    'cost_head',
    'agent',
    'customer_pic',
    'customer',
    'carrier',
    'port',
    'industry_sector',
    'notification_setting',
    'email_log',
    'user',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string): Promise<World> {
  const tenantId = (
    await owner.tenant.create({
      data: { name, slug, country: 'Bangladesh', currencyId: bdt },
      select: { id: true },
    })
  ).id;

  const superUser = await owner.user.create({
    data: {
      tenantId,
      code: `USR-S${tag}`,
      username: `super-${slug}`,
      email: `super@${slug}.test`,
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  const token = await signAccessToken({
    sub: superUser.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  // The address and licence lines under the name (Settings → Notifications).
  await owner.notificationSetting.create({
    data: { tenantId, awbIssuerDetails: `AIN NO-30119046${tag === 'A' ? '5' : '6'}\nFF LICENSE NO- 0465/19` },
  });

  const sector = await owner.industrySector.create({
    data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: `CUS-${tag}`,
      name: `Darkesh Tex ${tag}`,
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });

  const port = async (n: string, portName: string, code: string, country: string, type: 'SEAPORT' | 'AIRPORT') =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${n}`, name: portName, portCode: `${code}${tag}`, country, type },
        select: { id: true },
      })
    ).id;
  const dacId = await port('1', `Dhaka Airport ${tag}`, 'DAC', 'Bangladesh', 'AIRPORT');
  const shjId = await port('2', `Sharjah ${tag}`, 'SHJ', 'UAE', 'AIRPORT');
  const vieId = await port('3', `Vienna International Airport ${tag}`, 'VIE', 'Austria', 'AIRPORT');
  const ctgId = await port('4', `Chittagong ${tag}`, 'CTG', 'Bangladesh', 'SEAPORT');
  const hamId = await port('5', `Hamburg ${tag}`, 'HAM', 'Germany', 'SEAPORT');

  const carrierType = await owner.carrierType.findFirstOrThrow({
    where: { tenantId: null },
    select: { id: true },
  });
  const airline = await owner.carrier.create({
    data: { tenantId, code: `CAR-A${tag}`, name: `Air Arabia ${tag}`, typeId: carrierType.id },
    select: { id: true },
  });
  const line = await owner.carrier.create({
    data: { tenantId, code: `CAR-S${tag}`, name: `Ocean Line ${tag}`, typeId: carrierType.id },
    select: { id: true },
  });
  const agent = await owner.agent.create({
    data: {
      tenantId,
      code: `AGT-${tag}`,
      name: `TPG Express ${tag}`,
      country: 'Austria',
      deliveryAgentDetails: 'FRIHUSWEG 2, 8141 PREMSTATTEN, AUSTRIA',
      agentType: 'GENERAL',
    },
    select: { id: true },
  });

  const source = await owner.inquirySource.findFirstOrThrow({
    where: { tenantId: null },
    select: { id: true },
  });
  const quote = async (type: 'SEA' | 'AIR', polId: bigint, podId: bigint, carrierId: bigint) => {
    const inquiry = await owner.inquiry.create({
      data: {
        tenantId,
        code: `INQ-${YEAR}-7${tag}${type === 'AIR' ? 1 : 2}`,
        seriesYear: YEAR,
        inquiryDate: new Date(`${TODAY}T00:00:00Z`),
        sourceId: source.id,
        shipmentType: type,
        customerId: customer.id,
        movementType: 'OUTBOUND',
        polId,
        podId,
      },
      select: { id: true },
    });
    return (
      await owner.quotation.create({
        data: {
          tenantId,
          code: `QTN-${YEAR}-7${tag}${type === 'AIR' ? 1 : 2}`,
          seriesYear: YEAR,
          inquiryId: inquiry.id,
          quotationDate: new Date(`${TODAY}T00:00:00Z`),
          customerId: customer.id,
          shipmentType: type,
          movementType: 'OUTBOUND',
          polId,
          podId,
          carrierId,
          localCurrencyId: bdt,
          conversionRate: '1',
          status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;
  };
  const airQuote = await quote('AIR', dacId, vieId, airline.id);
  const seaQuote = await quote('SEA', ctgId, hamId, line.id);

  // The air freight is priced in dollars: the waybill's Currency box.
  const unit = await owner.costUnit.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const head = await owner.costHead.create({
    data: { tenantId, code: `CH-${tag}`, category: 'SERVICE', name: 'Air Freight', unitId: unit.id },
    select: { id: true },
  });
  await owner.quotationLine.create({
    data: {
      tenantId,
      quotationId: airQuote,
      costHeadId: head.id,
      costHeadName: 'Air Freight',
      quantity: '3880',
      sellingPrice: '2.1',
      currencyId: usd,
      currencyCode: 'USD',
      conversionRate: '120',
    },
  });

  const shipment = async (
    n: number,
    type: 'SEA' | 'AIR',
    status: 'ADVISED' | 'CARGO_RECEIVED',
  ): Promise<{ id: bigint; code: string }> => {
    const code = `BKG-${YEAR}-7${tag}00${n}`;
    const row = await owner.shipment.create({
      data: {
        tenantId,
        code,
        seriesYear: YEAR,
        quotationId: type === 'AIR' ? airQuote : seaQuote,
        shipmentType: type,
        customerId: customer.id,
        carrierId: type === 'AIR' ? airline.id : line.id,
        polId: type === 'AIR' ? dacId : ctgId,
        podId: type === 'AIR' ? vieId : hamId,
        loadingType: type === 'SEA' ? 'FCL' : null,
        tosId: tosId.get('FOB')!,
        exporterName: `Darkesh Tex ${tag}`,
        exporterAddress: 'Plot A-169, BSCIC, Narayanganj',
        importerName: `Peter Mlakar ${tag}`,
        importerAddress: 'M-2000 Opri Bajerju 25A, Slovenia',
        status,
      },
      select: { id: true },
    });
    return { id: row.id, code };
  };

  // ------------------------------------------------- the advised air booking
  const air = await shipment(1, 'AIR', 'ADVISED');
  const scheduleId = (
    await owner.shipmentSchedule.create({
      data: {
        tenantId,
        code: `SCH-${tag}1`,
        shipmentId: air.id,
        carrierId: airline.id,
        transitType: 'INDIRECT',
        status: 'APPROVED',
        decidedBy: superUser.id,
        decidedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  await owner.shipmentScheduleLeg.createMany({
    data: [
      { tenantId, scheduleId, legNo: 1, flightNo: 'G9 507', originPortId: dacId, destinationPortId: shjId, etd: new Date('2026-07-10T04:00:00Z') },
      { tenantId, scheduleId, legNo: 2, flightNo: 'G9 129', originPortId: shjId, destinationPortId: vieId, etd: new Date('2026-07-12T03:30:00Z') },
    ],
  });
  const advised = async (
    s: { id: bigint; code: string },
    n: number,
    extra: Record<string, unknown>,
  ): Promise<Booking> => {
    const houseBlNo = `${tag}HAWB${YEAR}${n}`;
    const advise = await owner.shipmentAdvise.create({
      data: {
        tenantId,
        code: `SA-${YEAR}-7${tag}00${n}`,
        seriesYear: YEAR,
        shipmentId: s.id,
        houseBlNo,
        status: 'DRAFT',
        ...extra,
      } as never,
      select: { id: true },
    });
    await owner.shipmentAdviseBooking.create({
      data: { tenantId, adviseId: advise.id, shipmentId: s.id },
    });
    await owner.shipmentAdvise.update({
      where: { id: advise.id },
      data: { status: 'SENT', sentAt: new Date(), sentBy: superUser.id },
    });
    return { ...s, houseBlNo };
  };

  return {
    slug,
    tenantId,
    token,
    dacId,
    vieId,
    agentId: agent.id,
    air: await advised(air, 1, {
      scheduleId,
      carrierId: airline.id,
      transitType: 'INDIRECT',
      firstFlightNo: 'G9 507',
      etd: new Date('2026-07-10T04:00:00Z'),
      polId: dacId,
      podId: vieId,
      mblNo: `514-1234567${tag === 'A' ? 5 : 6}`,
      totalPoCount: 1,
      totalCtnQty: 176,
      totalGrossWeightKg: '3880',
      totalVolumeCbm: '21.4',
      totalChargeableWtKg: '3880',
    }),
    received: await (async () => {
      const s = await shipment(2, 'AIR', 'CARGO_RECEIVED');
      const receipt = await owner.cargoReceipt.create({
        data: {
          tenantId,
          code: `CRGR-7${tag}-1`,
          seriesYear: YEAR,
          shipmentId: s.id,
          receiptSeq: 1,
          receiveDate: new Date(`${TODAY}T00:00:00Z`),
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          receivedBy: superUser.id,
        },
        select: { id: true },
      });
      const po = await owner.shipmentPo.create({
        data: { tenantId, shipmentId: s.id, poNo: `PO-7${tag}` },
        select: { id: true },
      });
      const cargo = await owner.shipmentCargoLine.create({
        data: {
          tenantId,
          shipmentId: s.id,
          shipmentPoId: po.id,
          itemCode: 'TSHIRT',
          ctnQty: 12,
          grossWeightKg: '240',
          cartonLengthCm: '50',
          cartonWidthCm: '40',
          cartonHeightCm: '30',
        },
        select: { id: true },
      });
      await owner.cargoReceiptLine.create({
        data: {
          tenantId,
          cargoReceiptId: receipt.id,
          shipmentCargoLineId: cargo.id,
          receivedCtnQty: 12,
          lineStatus: 'ACCEPTED',
        },
      });
      return { ...s, houseBlNo: '' };
    })(),
    sea: await advised(await shipment(3, 'SEA', 'ADVISED'), 3, {
      carrierId: line.id,
      transitType: 'DIRECT',
      polId: ctgId,
      podId: hamId,
    }),
  };
}

beforeAll(async () => {
  bdt = (
    await owner.currency.findFirstOrThrow({
      where: { tenantId: null, currency: { startsWith: 'BDT' } },
      select: { id: true },
    })
  ).id;
  usd = (
    await owner.currency.findFirstOrThrow({
      where: { tenantId: null, currency: { startsWith: 'USD' } },
      select: { id: true },
    })
  ).id;
  modeId = (
    await owner.mode.findFirstOrThrow({ where: { tenantId: null, deletedAt: null }, select: { id: true } })
  ).id;
  size20 = (await owner.containerSize.findFirstOrThrow({ where: { tenantId: null, code: '20STD' } })).id;
  for (const row of await owner.tos.findMany({ where: { tenantId: null }, select: { id: true, code: true } })) {
    tosId.set(row.code, row.id);
  }

  await cleanup();
  A = await makeWorld('Air Waybill Alpha', SLUG_A, 'A');
  B = await makeWorld('Air Waybill Beta', SLUG_B, 'B');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('air has no container load plan (Menu I23)', () => {
  it('advises an air booking from its receipt, and says so on Shipment Advise - Air', async () => {
    const res = await as(A).get('/documentation/shipment-advise?view=TO_ADVISE&shipmentType=AIR&limit=100');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.data.find((r: { id: string }) => r.id === A.received.id.toString());
    expect(row).toBeDefined();
    expect(row.detail).toBe('12 CTN received — air needs no load plan, ready to advise');
    expect(row.detail).not.toContain('load plan yet');
  });

  it('keeps air cargo off Available stock — that list is for making a CLP', async () => {
    const all = await as(A).get('/ops/cargo-stock?limit=100');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.data.map((r: { shipmentId: string }) => r.shipmentId)).not.toContain(A.received.id.toString());

    const air = await as(A).get('/ops/cargo-stock?shipmentType=AIR&limit=100');
    expect(air.status).toBe(200);
    expect(air.body.data).toEqual([]);
  });

  it('refuses a load plan for an air booking', async () => {
    const res = await as(A)
      .post(`/ops/bookings/${A.received.id}/clps`)
      .send({ containerSizeId: size20.toString() });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AIR_NO_CLP');
    expect(await owner.clp.count({ where: { shipmentId: A.received.id } })).toBe(0);
  });
});

let draftId: string;

describe('the HAWB draft (§14)', () => {
  it('opens on the advise: its totals, its flights, three originals and no sea boxes', async () => {
    const res = await as(A).get(`/documentation/bookings/${A.air.id}/bl-draft/prefill`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.data;
    expect(p.blockedReason).toBeNull();
    expect(p.shipmentType).toBe('AIR');
    expect(p.blNo).toBe(A.air.houseBlNo);
    expect(p.mblNo).toBe('514-12345675');
    expect(p.packageCount).toBe(176);
    expect(Number(p.grossWeightKg)).toBe(3880);
    expect(Number(p.chargeableWeightKg)).toBe(3880);
    expect(Number(p.measurementCbm)).toBe(21.4);
    expect(p.originalBlCount).toBe(3);
    expect(p.preCarriageByModeId).toBeNull();
    expect(p.placeOfReceipt).toBeNull();
    expect(p.oceanVesselVoyage).toBeNull();
    expect(p.containers).toEqual([]);
    // Executed on: the departure, in Dhaka's calendar, until a milestone says otherwise.
    expect(p.ladenOnBoardDate).toBe('2026-07-10');
    expect(
      p.airRoute.map((l: { flightNo: string; carrier: string; fromCode: string; toCode: string }) => [
        l.flightNo,
        l.carrier,
        l.fromCode,
        l.toCode,
      ]),
    ).toEqual([
      ['G9 507', 'G9', 'DACA', 'SHJA'],
      ['G9 129', 'G9', 'SHJA', 'VIEA'],
    ]);
  });

  it('is drafted without a pre-carriage or place of receipt, always for three originals', async () => {
    const res = await as(A)
      .post(`/documentation/bookings/${A.air.id}/bl-draft`)
      .send({
        shipperText: 'DARKESH TEX WEAR LTD.\nPlot A-169, BSCIC, Narayanganj',
        consigneeText: 'PETER MLAKAR\nM-2000 Opri Bajerju 25A, Slovenia',
        notifyText: 'PETER MLAKAR',
        polId: A.dacId.toString(),
        podId: A.vieId.toString(),
        packageCount: 176,
        grossWeightKg: 3880,
        chargeableWeightKg: 3880,
        measurementCbm: 21.4,
        packagesDescription: 'ORDER NO : 488, T-SHIRT, HS CODE: 61091000',
        deliveryAgentId: A.agentId.toString(),
        ladenOnBoardDate: '2026-07-09',
        // Not the form's to say on air: the waybill is issued in three.
        originalBlCount: 1,
        // Nor these — a waybill has no such boxes.
        preCarriageByModeId: modeId.toString(),
        oceanVesselVoyage: 'SHOULD NOT KEEP',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.shipmentType).toBe('AIR');
    draftId = res.body.data.id as string;

    const row = await owner.blDraft.findFirstOrThrow({
      where: { id: BigInt(draftId) },
      select: {
        originalBlCount: true,
        preCarriageByModeId: true,
        placeOfReceipt: true,
        oceanVesselVoyage: true,
        packageCount: true,
        chargeableWeightKg: true,
      },
    });
    expect(row.originalBlCount).toBe(3);
    expect(row.preCarriageByModeId).toBeNull();
    expect(row.placeOfReceipt).toBeNull();
    expect(row.oceanVesselVoyage).toBeNull();
    expect(row.packageCount).toBe(176);
    expect(row.chargeableWeightKg?.toString()).toBe('3880');
    expect(await owner.blDraftContainer.count({ where: { blDraftId: BigInt(draftId) } })).toBe(0);
  });

  it('prints as a House Air Waybill, watermarked until approved', async () => {
    const res = await pdf(as(A).get(`/documentation/bl-drafts/${draftId}/pdf`));
    expect(res.status).toBe(200);
    expect(pageCount(res.body as Buffer)).toBe(1);
    const text = extractPdfText(res.body as Buffer);
    expect(text).toContain('HOUSE AIR WAY BILL NUMBER');
    expect(text).toContain(A.air.houseBlNo);
    expect(text).toContain('DRAFT');
    expect(text).not.toContain('BILL OF LADING');
  });

  it('names the HAWB and MAWB on the BL Draft list', async () => {
    const res = await as(A).get('/documentation/bl-drafts/worklist?view=TO_DRAFT&limit=100');
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: { id: string }) => r.id === A.air.id.toString());
    expect(row.detail).toContain('drafted in house');
    const untouched = res.body.data.find((r: { id: string }) => r.id === A.sea.id.toString());
    expect(untouched.detail).toContain(`HBL ${A.sea.houseBlNo}`);
  });
});

describe('issuing the HAWB on BL Print', () => {
  it('waits in To issue once approved, with its three originals', async () => {
    const approved = await as(A).post(`/documentation/bl-drafts/${draftId}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await statusOf(A.air.id)).toBe('BL_DRAFTED');

    const list = await as(A).get('/documentation/bl-print?view=TO_ISSUE&limit=100');
    const row = list.body.data.find((r: { id: string }) => r.id === A.air.id.toString());
    expect(row.detail).toBe(`HAWB ${A.air.houseBlNo}, MAWB 514-12345675 — 3 originals, not issued`);

    const bill = await as(A).get(`/documentation/bookings/${A.air.id}/bl`);
    expect(bill.body.data.shipmentType).toBe('AIR');
    expect(bill.body.data.originalBlCount).toBe(3);
  });

  it('never takes another number of originals', async () => {
    const res = await as(A).post(`/documentation/bookings/${A.air.id}/bl/issue`).send({ originalBlCount: 2 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORIGINALS_FIXED');
    expect(await statusOf(A.air.id)).toBe('BL_DRAFTED');
  });

  it('issues without asking, and moves the booking to issued', async () => {
    const res = await as(A).post(`/documentation/bookings/${A.air.id}/bl/issue`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.originalBlCount).toBe(3);
    expect(res.body.data.issuedAt).not.toBeNull();
    expect(await statusOf(A.air.id)).toBe('BL_ISSUED');
  });

  it('prints the three originals, each naming whose it is', async () => {
    const res = await pdf(as(A).get(`/documentation/bookings/${A.air.id}/bl/pdf?kind=ORIGINAL`));
    expect(res.status).toBe(200);
    expect(pageCount(res.body as Buffer)).toBe(3);
    const text = extractPdfText(res.body as Buffer);
    for (const expected of [
      '1-ISSUING CARRIER',
      '2-CONSIGNEE',
      '3-SHIPPER',
      A.air.houseBlNo,
      '514-12345675',
      'AIR WAYBILL ALPHA',
      'AIN NO-301190465',
      'Dhaka Airport A, Bangladesh . DACA-SHJA-VIEA',
      'Vienna International Airport A',
      'G9 507/10-Jul-26',
      'G9 129/12-Jul-26',
      // FOB: freight collect, payable at destination.
      'FREIGHT COLLECT',
      'DESTINATION',
      'USD',
      '176',
      '3880.00',
      'VOLUME: 21.40 CBM',
      'TPG Express A',
      'FRIHUSWEG 2, 8141 PREMSTATTEN, AUSTRIA',
      '09/07/2026',
      'AWB/DACA',
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).not.toContain('DRAFT');
    expect(text).not.toContain('AIN NO-301190466');
  });

  it('prints a copy as not negotiable', async () => {
    const res = await pdf(as(A).get(`/documentation/bookings/${A.air.id}/bl/pdf?kind=COPY`));
    expect(res.status).toBe(200);
    expect(pageCount(res.body as Buffer)).toBe(1);
    expect(extractPdfText(res.body as Buffer)).toContain('COPY — NOT NEGOTIABLE');
  });
});

describe('a sea bill still needs its sea boxes', () => {
  it('refuses a sea draft without pre-carriage or place of receipt, naming both', async () => {
    const res = await as(A)
      .post(`/documentation/bookings/${A.sea.id}/bl-draft`)
      .send({
        shipperText: 'Shipper',
        consigneeText: 'Consignee',
        notifyText: 'Notify',
        polId: A.dacId.toString(),
        podId: A.vieId.toString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.error.fields).sort()).toEqual(['placeOfReceipt', 'preCarriageByModeId']);
    expect(await owner.blDraft.count({ where: { shipmentId: A.sea.id } })).toBe(0);
  });
});

describe('isolation (CLAUDE.md §7A rule 4)', () => {
  it('shows the other workspace none of it', async () => {
    const draft = await as(B).get(`/documentation/bookings/${A.air.id}/bl-draft`);
    expect(draft.status).toBe(200);
    expect(draft.body.data).toBeNull();

    const print = await as(B).get(`/documentation/bookings/${A.air.id}/bl/pdf?kind=ORIGINAL`);
    expect(print.status).toBe(404);

    const issued = await as(B).get('/documentation/bl-print?view=ISSUED&limit=100');
    expect(issued.body.data).toEqual([]);

    const advise = await as(B).get('/documentation/shipment-advise?view=TO_ADVISE&limit=100');
    expect(advise.body.data.map((r: { id: string }) => r.id)).not.toContain(A.received.id.toString());
  });
});
