import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Operation → Upload VGM & EGM, through HTTP — docs/DESIGN-UPDATE-2026-10-28.md §2.
 *
 * Two workspaces. Each has two outbound sea bookings on one shipment advise
 * (CR-005), the first stuffed into two finalised containers beside a draft
 * plan; an outbound air booking with its own advise; and an inbound sea
 * booking with a finalised container, which is never listed ("Inbound skip").
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'vgm-alpha';
const SLUG_B = 'vgm-beta';
const YEAR = new Date().getUTCFullYear();
const dayFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface Booking {
  id: bigint;
  code: string;
}

interface World {
  tenantId: bigint;
  slug: string;
  superToken: string;
  /** May record a first VGM and add EGM copies, not change or remove them. */
  recorderToken: string;
  viewerToken: string;
  seaOne: Booking;
  seaTwo: Booking;
  air: Booking;
  inbound: Booking;
  clps: { first: bigint; second: bigint; draft: bigint; inbound: bigint };
  seaAdviseId: bigint;
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'egm_document',
    'vgm',
    'shipment_advise_booking',
    'shipment_advise',
    'clp_booking',
    'clp',
    'shipment_commodity',
    'shipment_schedule_leg',
    'shipment_schedule',
    'shipment',
    'quotation',
    'inquiry',
    'commodity_item',
    'customer',
    'carrier',
    'port',
    'industry_sector',
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
    return { id, token: await signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin, permissions, tokenVersion: 0 }) };
  };
  const superUser = await user(`USR-S${tag}`, true, []);

  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Jute ${tag}` }, select: { id: true } });
  const jute = await owner.commodityItem.create({
    data: { tenantId, code: `CIT-${tag}`, industrySectorId: sector.id, name: `Jute yarn ${tag}` },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: { tenantId, code: `CUS-${tag}`, name: `Shafidi ${tag}`, country: 'Bangladesh', customerType: 'EXPORTER', businessArea: 'BOTH', industrySectorId: sector.id },
    select: { id: true },
  });
  const port = async (code: string, type: 'SEAPORT' | 'AIRPORT' = 'SEAPORT') =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${code}`, name: `${code} ${tag}`, portCode: `${tag}${code}`, country: 'Bangladesh', type },
        select: { id: true },
      })
    ).id;
  const ctg = await port('CTG');
  const ham = await port('HAM');
  const dac = await port('DAC', 'AIRPORT');
  const dxb = await port('DXB', 'AIRPORT');
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({ data: { tenantId, code: `CAR-${tag}`, name: `SITC ${tag}`, typeId: carrierType.id }, select: { id: true } });
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });

  const quotationFor = async (n: number, movementType: 'INBOUND' | 'OUTBOUND') => {
    const inquiry = await owner.inquiry.create({
      data: { tenantId, code: `INQ-${YEAR}-5${tag}0${n}`, seriesYear: YEAR, inquiryDate: at(dayFromNow(-30)), sourceId: source.id, shipmentType: 'SEA', customerId: customer.id, movementType, polId: ctg, podId: ham },
      select: { id: true },
    });
    return (
      await owner.quotation.create({
        data: {
          tenantId,
          code: `QTN-${YEAR}-5${tag}0${n}`,
          seriesYear: YEAR,
          inquiryId: inquiry.id,
          quotationDate: at(dayFromNow(-29)),
          customerId: customer.id,
          shipmentType: 'SEA',
          movementType,
          polId: ctg,
          podId: ham,
          carrierId: carrier.id,
          localCurrencyId: bdt,
          conversionRate: '1',
          status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;
  };
  const outbound = await quotationFor(1, 'OUTBOUND');
  const inboundQ = await quotationFor(2, 'INBOUND');

  let n = 0;
  const booking = async (quotationId: bigint, shipmentType: 'SEA' | 'AIR') => {
    n += 1;
    const [pol, pod] = shipmentType === 'AIR' ? [dac, dxb] : [ctg, ham];
    const s = await owner.shipment.create({
      data: { tenantId, code: `BKG-${YEAR}-5${tag}0${n}`, seriesYear: YEAR, quotationId, shipmentType, customerId: customer.id, exporterName: `Shafidi ${tag}`, carrierId: carrier.id, polId: pol, podId: pod, status: 'CARGO_RECEIVED' },
      select: { id: true, code: true },
    });
    const sch = await owner.shipmentSchedule.create({
      data: { tenantId, code: `SCH-${tag}${n}`, shipmentId: s.id, carrierId: carrier.id, transitType: 'DIRECT', status: 'APPROVED', decidedBy: superUser.id, decidedAt: new Date() },
      select: { id: true },
    });
    await owner.shipmentScheduleLeg.create({
      data: {
        tenantId,
        scheduleId: sch.id,
        legNo: 1,
        originPortId: pol,
        destinationPortId: pod,
        etd: at(dayFromNow(n)),
        eta: at(dayFromNow(n + 20)),
        flightNo: shipmentType === 'AIR' ? 'G9 052' : null,
        voyageNo: shipmentType === 'SEA' ? '2604W' : null,
      },
    });
    await owner.shipmentCommodity.create({ data: { tenantId, shipmentId: s.id, commodityItemId: jute.id } });
    return { ...s, scheduleId: sch.id, pol, pod };
  };
  const seaOne = await booking(outbound, 'SEA');
  const seaTwo = await booking(outbound, 'SEA');
  const air = await booking(outbound, 'AIR');
  const inbound = await booking(inboundQ, 'SEA');

  const size = (await owner.containerSize.findFirstOrThrow({ where: { tenantId: null, code: '40HC' } })).id;
  let clpNo = 0;
  const container = async (shipmentId: bigint, status: 'FINAL' | 'DRAFT') => {
    clpNo += 1;
    const clp = await owner.clp.create({
      data: {
        tenantId,
        code: `CLP-${YEAR}-5${tag}0${clpNo}`,
        seriesYear: YEAR,
        containerSizeId: size,
        carrierId: carrier.id,
        status,
        totalGrossWeightKg: '18000.000',
        ...(status === 'FINAL'
          ? { containerNo: `TGHU12345${clpNo}0`, sealNo: `SL-${tag}${clpNo}`, loadDatetime: new Date(), finalisedAt: new Date(), finalisedBy: superUser.id }
          : {}),
      },
      select: { id: true },
    });
    await owner.clpBooking.create({ data: { tenantId, clpId: clp.id, shipmentId } });
    return clp.id;
  };
  const clps = {
    first: await container(seaOne.id, 'FINAL'),
    second: await container(seaOne.id, 'FINAL'),
    draft: await container(seaOne.id, 'DRAFT'),
    inbound: await container(inbound.id, 'FINAL'),
  };

  const advise = async (lead: typeof seaOne, members: (typeof seaOne)[], hbl: string, mbl: string | null) => {
    const a = await owner.shipmentAdvise.create({
      data: {
        tenantId,
        code: `SA-${YEAR}-5${tag}0${lead.id}`,
        seriesYear: YEAR,
        shipmentId: lead.id,
        scheduleId: lead.scheduleId,
        carrierId: carrier.id,
        transitType: 'DIRECT',
        polId: lead.pol,
        podId: lead.pod,
        houseBlNo: hbl,
        mblNo: mbl,
        status: 'DRAFT',
      },
      select: { id: true },
    });
    for (const m of members) await owner.shipmentAdviseBooking.create({ data: { tenantId, adviseId: a.id, shipmentId: m.id } });
    await owner.shipmentAdvise.update({ where: { id: a.id }, data: { status: 'SENT', sentAt: new Date(), sentBy: superUser.id } });
    return a.id;
  };
  const seaAdviseId = await advise(seaOne, [seaOne, seaTwo], `${tag}HBL001`, `SITC${tag}0001`);
  await advise(air, [air], `${tag}HAWB001`, null);

  return {
    tenantId,
    slug,
    superToken: superUser.token,
    recorderToken: (await user(`USR-R${tag}`, false, ['OPERATION.VGM_EGM.VIEW', 'OPERATION.VGM_EGM.CREATE'])).token,
    viewerToken: (await user(`USR-V${tag}`, false, ['OPERATION.VGM_EGM.VIEW'])).token,
    seaOne,
    seaTwo,
    air,
    inbound,
    clps,
    seaAdviseId,
  };
}

function api(world: World, token = world.superToken) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', world.slug);
  const base = '/api/tenant/ops';
  return {
    get: (path: string) => wrap(request(app).get(`${base}${path}`)),
    post: (path: string, body?: Record<string, unknown>) => wrap(request(app).post(`${base}${path}`)).send(body ?? {}),
    del: (path: string) => wrap(request(app).delete(`${base}${path}`)),
    upload: (path: string, fields: Record<string, string>, filename = 'vgm-declaration.pdf') => {
      let r = wrap(request(app).post(`${base}${path}`));
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return r.attach('file', Buffer.from('%PDF-1.4 test'), { filename, contentType: 'application/pdf' });
    },
  };
}

interface Row {
  bookingCode: string;
  commodity: string | null;
  vgmStatus: string | null;
  egmStatus: string;
  vgmContainers: { clpId: string; clpCode: string; containerNo: string; cargoGrossWeightKg: string | null; vgm: { uploaded: boolean; carrierBookingNo: string } | null }[];
  egm: { houseBlNo: string; mblNo: string | null; files: { id: string; fileName: string }[] } | null;
}

const rowsOf = (body: { data: Row[] }) => body.data;
const codes = (body: { data: Row[] }) => body.data.map((r) => r.bookingCode).sort();
const vgmBody = { carrierBookingNo: 'SITC-BK-77120', vgmKg: '22150', grossWeightKg: '18000', signatoryName: 'Rahim Uddin' };

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('VGM Alpha', SLUG_A, 'VA');
  B = await makeWorld('VGM Beta', SLUG_B, 'VB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the list', () => {
  it('shows outbound bookings by mode, never an inbound one', async () => {
    const sea = await api(A, A.viewerToken).get('/vgm-egm?shipmentType=SEA&view=ALL');
    expect(sea.status).toBe(200);
    expect(codes(sea.body)).toEqual([A.seaOne.code, A.seaTwo.code].sort());
    const air = await api(A, A.viewerToken).get('/vgm-egm?shipmentType=AIR&view=ALL');
    expect(codes(air.body)).toEqual([A.air.code]);
  });

  it('lists a booking once per finalised container, with the bill its EGM is filed against', async () => {
    const res = await api(A).get('/vgm-egm?shipmentType=SEA&view=ALL');
    const one = rowsOf(res.body).find((r) => r.bookingCode === A.seaOne.code)!;
    expect(one.vgmContainers.map((c) => c.clpId)).toEqual([A.clps.first.toString(), A.clps.second.toString()]);
    expect(one.vgmContainers[0]).toMatchObject({ cargoGrossWeightKg: '18000.000', vgm: null });
    expect(one).toMatchObject({ commodity: 'Jute yarn VA', vgmStatus: 'PENDING', egmStatus: 'PENDING' });
    expect(one.egm).toMatchObject({ houseBlNo: 'VAHBL001', mblNo: 'SITCVA0001', files: [] });
    // Nothing finalised yet: Pending, with nothing to record against.
    const two = rowsOf(res.body).find((r) => r.bookingCode === A.seaTwo.code)!;
    expect(two.vgmContainers).toEqual([]);
    expect(two.vgmStatus).toBe('PENDING');
    // Air has no VGM.
    const air = await api(A).get('/vgm-egm?shipmentType=AIR&view=ALL');
    expect(rowsOf(air.body)[0]).toMatchObject({ vgmStatus: null, vgmContainers: [], egm: { houseBlNo: 'VAHAWB001' } });
  });
});

describe('VGM', () => {
  it('keeps a container Pending until the file is in', async () => {
    const typed = await api(A, A.recorderToken).post(`/vgm/${A.clps.first}`, vgmBody);
    expect(typed.status, JSON.stringify(typed.body.error ?? {})).toBe(200);
    expect(typed.body.data).toMatchObject({ carrierBookingNo: 'SITC-BK-77120', vgmKg: '22150.000', uploaded: false, fileName: null });
    const uploaded = await api(A).upload(`/vgm/${A.clps.second}`, vgmBody);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.data).toMatchObject({ uploaded: true, fileName: 'vgm-declaration.pdf' });
    const list = await api(A).get('/vgm-egm?shipmentType=SEA&view=ALL');
    const one = rowsOf(list.body).find((r) => r.bookingCode === A.seaOne.code)!;
    expect(one.vgmContainers.map((c) => c.vgm?.uploaded)).toEqual([false, true]);
    expect(one.vgmStatus).toBe('PENDING');
  });

  it('lets a recorder add a first VGM but not change one', async () => {
    const change = await api(A, A.recorderToken).post(`/vgm/${A.clps.first}`, { ...vgmBody, signatoryName: 'Someone else' });
    expect(change.status).toBe(403);
    const viewer = await api(A, A.viewerToken).post(`/vgm/${A.clps.first}`, vgmBody);
    expect(viewer.status).toBe(403);
  });

  it('refuses a VGM lighter than the cargo, a missing name, a draft plan and an inbound container', async () => {
    const light = await api(A).post(`/vgm/${A.clps.first}`, { ...vgmBody, vgmKg: '17000' });
    expect(light.status).toBe(400);
    const nameless = await api(A).post(`/vgm/${A.clps.first}`, { ...vgmBody, signatoryName: ' ' });
    expect(nameless.status).toBe(400);
    const draft = await api(A).post(`/vgm/${A.clps.draft}`, vgmBody);
    expect(draft.status).toBe(409);
    expect(draft.body.error.code).toBe('CLP_NOT_FINAL');
    const inbound = await api(A).post(`/vgm/${A.clps.inbound}`, vgmBody);
    expect(inbound.status).toBe(409);
    expect(inbound.body.error.code).toBe('NOT_OUTBOUND');
  });

  it('downloads the uploaded file, and says so when there is none', async () => {
    const file = await api(A, A.viewerToken).get(`/vgm/${A.clps.second}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/application\/pdf/);
    const none = await api(A).get(`/vgm/${A.clps.first}/file`);
    expect(none.status).toBe(404);
  });
});

describe('EGM', () => {
  it('takes several copies against the bill, shared by every booking on it', async () => {
    const first = await api(A, A.recorderToken).upload(`/egm/${A.seaAdviseId}/files`, {}, 'egm-page-1.pdf');
    expect(first.status, JSON.stringify(first.body.error ?? {})).toBe(201);
    const second = await api(A, A.recorderToken).upload(`/egm/${A.seaAdviseId}/files`, {}, 'egm-page-2.pdf');
    expect(second.body.data.files.map((f: { fileName: string }) => f.fileName)).toEqual(['egm-page-1.pdf', 'egm-page-2.pdf']);
    const list = await api(A).get('/vgm-egm?shipmentType=SEA&view=ALL');
    for (const row of rowsOf(list.body)) expect(row.egmStatus).toBe('UPLOADED');
  });

  it('lets only EDIT take a copy off, and keeps it on the record', async () => {
    const list = await api(A).get('/vgm-egm?shipmentType=SEA&view=ALL');
    const fileId = rowsOf(list.body)[0]!.egm!.files[0]!.id;
    const refused = await api(A, A.recorderToken).del(`/egm/${A.seaAdviseId}/files/${fileId}`);
    expect(refused.status).toBe(403);
    const removed = await api(A).del(`/egm/${A.seaAdviseId}/files/${fileId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.files).toHaveLength(1);
    const kept = await owner.egmDocument.findUniqueOrThrow({ where: { id: BigInt(fileId) }, select: { deletedAt: true } });
    expect(kept.deletedAt).not.toBeNull();
  });

  it('moves a booking to Uploaded once every container and the EGM are in', async () => {
    const pending = await api(A).get('/vgm-egm?shipmentType=SEA');
    expect(codes(pending.body)).toEqual([A.seaOne.code, A.seaTwo.code].sort());
    await api(A).upload(`/vgm/${A.clps.first}`, vgmBody);
    const uploaded = await api(A).get('/vgm-egm?shipmentType=SEA&view=UPLOADED');
    expect(codes(uploaded.body)).toEqual([A.seaOne.code]);
    // The second booking shares the EGM but has no container yet.
    const stillPending = await api(A).get('/vgm-egm?shipmentType=SEA&view=PENDING');
    expect(codes(stillPending.body)).toEqual([A.seaTwo.code]);
  });
});

describe('two workspaces', () => {
  it('never shows, records against or opens the other workspace’s rows', async () => {
    const list = await api(B).get('/vgm-egm?shipmentType=SEA&view=ALL');
    expect(codes(list.body)).toEqual([B.seaOne.code, B.seaTwo.code].sort());
    for (const row of rowsOf(list.body)) {
      expect(row.vgmContainers.every((c) => c.vgm === null)).toBe(true);
      expect(row.egm?.files).toEqual([]);
    }
    expect((await api(B).post(`/vgm/${A.clps.first}`, vgmBody)).status).toBe(404);
    expect((await api(B).get(`/vgm/${A.clps.second}/file`)).status).toBe(404);
    expect((await api(B).upload(`/egm/${A.seaAdviseId}/files`, {}, 'egm.pdf')).status).toBe(404);
  });
});
