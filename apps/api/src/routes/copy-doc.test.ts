import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Documentation → Copy Doc upload, through HTTP — docs/DESIGN-UPDATE-2026-10-28.md §3.
 *
 * Two workspaces, each with the sheet's two sample rows: a sea export with an
 * advise (rows 7) and an air import whose HBL No and IGM are on IGM Update
 * (row 8). A second sea export carries a Pre-Alert MBL upload, and a cancelled
 * booking is never listed.
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'copydoc-alpha';
const SLUG_B = 'copydoc-beta';
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
  /** May upload a first copy, not replace or remove one. */
  uploaderToken: string;
  viewerToken: string;
  seaExport: Booking;
  seaExportTwo: Booking;
  airImport: Booking;
  cancelled: Booking;
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'copy_document',
    'pre_alert_document',
    'igm_update',
    'shipment_advise_booking',
    'shipment_advise',
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

  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Cosmetics ${tag}` }, select: { id: true } });
  const item = await owner.commodityItem.create({ data: { tenantId, code: `CIT-${tag}`, industrySectorId: sector.id, name: `Cosmetics ${tag}` }, select: { id: true } });
  const customer = await owner.customer.create({
    data: { tenantId, code: `CUS-${tag}`, name: `AOD ${tag}`, country: 'Bangladesh', customerType: 'TRADER', businessArea: 'BOTH', industrySectorId: sector.id },
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
  const dxb = await port('DXB', 'AIRPORT');
  const dac = await port('DAC', 'AIRPORT');
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({ data: { tenantId, code: `CAR-${tag}`, name: `SITC ${tag}`, typeId: carrierType.id }, select: { id: true } });
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });

  const quotationFor = async (n: number, movementType: 'INBOUND' | 'OUTBOUND') => {
    const inquiry = await owner.inquiry.create({
      data: { tenantId, code: `INQ-${YEAR}-4${tag}0${n}`, seriesYear: YEAR, inquiryDate: at(dayFromNow(-30)), sourceId: source.id, shipmentType: 'SEA', customerId: customer.id, movementType, polId: ctg, podId: ham },
      select: { id: true },
    });
    return (
      await owner.quotation.create({
        data: { tenantId, code: `QTN-${YEAR}-4${tag}0${n}`, seriesYear: YEAR, inquiryId: inquiry.id, quotationDate: at(dayFromNow(-29)), customerId: customer.id, shipmentType: 'SEA', movementType, polId: ctg, podId: ham, carrierId: carrier.id, localCurrencyId: bdt, conversionRate: '1', status: 'ACCEPTED' },
        select: { id: true },
      })
    ).id;
  };
  const outbound = await quotationFor(1, 'OUTBOUND');
  const inbound = await quotationFor(2, 'INBOUND');

  let n = 0;
  const booking = async (quotationId: bigint, shipmentType: 'SEA' | 'AIR', status: 'CARGO_RECEIVED' | 'CANCELLED' = 'CARGO_RECEIVED') => {
    n += 1;
    const [pol, pod] = shipmentType === 'AIR' ? [dxb, dac] : [ctg, ham];
    const s = await owner.shipment.create({
      data: {
        tenantId,
        code: `BKG-${YEAR}-4${tag}0${n}`,
        seriesYear: YEAR,
        quotationId,
        shipmentType,
        customerId: customer.id,
        exporterName: `AOD ${tag}`,
        importerName: `JF trader ${tag}`,
        carrierId: carrier.id,
        polId: pol,
        podId: pod,
        status,
        ...(status === 'CANCELLED' ? { cancelledAt: new Date(), cancelledBy: superUser.id, cancelReason: 'Shipper withdrew' } : {}),
      },
      select: { id: true, code: true },
    });
    const sch = await owner.shipmentSchedule.create({
      data: { tenantId, code: `SCH-${tag}${n}`, shipmentId: s.id, carrierId: carrier.id, transitType: 'DIRECT', status: 'APPROVED', decidedBy: superUser.id, decidedAt: new Date() },
      select: { id: true },
    });
    await owner.shipmentScheduleLeg.create({
      data: { tenantId, scheduleId: sch.id, legNo: 1, originPortId: pol, destinationPortId: pod, etd: at(dayFromNow(n)), eta: at(dayFromNow(n + 9)), flightNo: shipmentType === 'AIR' ? 'G9 052' : null, voyageNo: shipmentType === 'SEA' ? '2604W' : null },
    });
    await owner.shipmentCommodity.create({ data: { tenantId, shipmentId: s.id, commodityItemId: item.id } });
    return { ...s, scheduleId: sch.id, pol, pod };
  };
  const seaExport = await booking(outbound, 'SEA');
  const seaExportTwo = await booking(outbound, 'SEA');
  const airImport = await booking(inbound, 'AIR');
  const cancelled = await booking(outbound, 'SEA', 'CANCELLED');

  const advise = await owner.shipmentAdvise.create({
    data: { tenantId, code: `SA-${YEAR}-4${tag}01`, seriesYear: YEAR, shipmentId: seaExport.id, scheduleId: seaExport.scheduleId, carrierId: carrier.id, transitType: 'DIRECT', polId: ctg, podId: ham, houseBlNo: `${tag}HBL001`, mblNo: `SITC${tag}77`, status: 'DRAFT' },
    select: { id: true },
  });
  await owner.shipmentAdviseBooking.create({ data: { tenantId, adviseId: advise.id, shipmentId: seaExport.id } });
  await owner.shipmentAdvise.update({ where: { id: advise.id }, data: { status: 'SENT', sentAt: new Date(), sentBy: superUser.id } });

  // Row 8: an import with no advise; its HBL No and IGM came in on IGM Update.
  await owner.igmUpdate.create({ data: { tenantId, shipmentId: airImport.id, hblNo: `DXB-${tag}-9`, igmFile: `${tenantId}/igm/0000__igm-dxb.pdf`, createdBy: superUser.id } });

  return {
    tenantId,
    slug,
    superToken: superUser.token,
    uploaderToken: (await user(`USR-U${tag}`, false, ['DOCUMENTATION.COPY_DOC_UPLOAD.VIEW', 'DOCUMENTATION.COPY_DOC_UPLOAD.CREATE'])).token,
    viewerToken: (await user(`USR-V${tag}`, false, ['DOCUMENTATION.COPY_DOC_UPLOAD.VIEW'])).token,
    seaExport,
    seaExportTwo,
    airImport,
    cancelled,
  };
}

function api(world: World, token = world.superToken, base = '/api/tenant/documentation') {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', world.slug);
  return {
    get: (path: string) => wrap(request(app).get(`${base}${path}`)),
    del: (path: string) => wrap(request(app).delete(`${base}${path}`)),
    upload: (path: string, kind: string, filename = 'copy.pdf') =>
      wrap(request(app).post(`${base}${path}`))
        .field('kind', kind)
        .attach('file', Buffer.from('%PDF-1.4 copy'), { filename, contentType: 'application/pdf' }),
  };
}

interface Doc {
  kind: string;
  label: string;
  source: 'UPLOAD' | 'SYSTEM' | null;
  fileName: string | null;
  note: string | null;
}
interface Row {
  bookingCode: string;
  importerName: string | null;
  commodity: string | null;
  houseBlNo: string | null;
  mblNo: string | null;
  onFile: number;
}

const codes = (body: { data: Row[] }) => body.data.map((r) => r.bookingCode).sort();
const rowOf = (body: { data: Row[] }, code: string) => body.data.find((r) => r.bookingCode === code)!;
const docOf = (body: { data: { documents: Doc[] } }, kind: string) => body.data.documents.find((d) => d.kind === kind)!;

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Copy Doc Alpha', SLUG_A, 'CA');
  B = await makeWorld('Copy Doc Beta', SLUG_B, 'CB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the list', () => {
  it('shows sea and air, inbound and outbound, but never a cancelled booking', async () => {
    const all = await api(A, A.viewerToken).get('/copy-docs');
    expect(all.status).toBe(200);
    expect(codes(all.body)).toEqual([A.seaExport.code, A.seaExportTwo.code, A.airImport.code].sort());
    const air = await api(A).get('/copy-docs?shipmentType=AIR');
    expect(codes(air.body)).toEqual([A.airImport.code]);
    const exports = await api(A).get('/copy-docs?movementType=OUTBOUND');
    expect(codes(exports.body)).toEqual([A.seaExport.code, A.seaExportTwo.code].sort());
  });

  it('carries the sheet’s columns, taking the HBL No from IGM Update when there is no advise', async () => {
    const res = await api(A).get('/copy-docs');
    expect(rowOf(res.body, A.seaExport.code)).toMatchObject({ importerName: 'JF trader CA', commodity: 'Cosmetics CA', houseBlNo: 'CAHBL001', mblNo: 'SITCCA77', onFile: 0 });
    // The IGM is on file from IGM Update.
    expect(rowOf(res.body, A.airImport.code)).toMatchObject({ houseBlNo: 'DXB-CA-9', mblNo: null, onFile: 1 });
  });
});

describe('the nine papers', () => {
  it('are offered in the sheet’s order, as air waybills on air', async () => {
    const res = await api(A).get(`/copy-docs/${A.airImport.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.documents.map((d: Doc) => d.kind)).toEqual([
      'HOUSE_BL',
      'MASTER_BL',
      'CO',
      'COMMERCIAL_INVOICE',
      'PACKING_LIST',
      'GSP',
      'EXP',
      'IGM',
      'DELIVERY_ORDER',
    ]);
    expect(docOf(res.body, 'HOUSE_BL').label).toBe('House air waybill (HAWB)');
    expect(docOf(res.body, 'IGM')).toMatchObject({ source: 'SYSTEM', fileName: 'igm-dxb.pdf', note: 'From IGM Update.' });
  });

  it('lets an uploader add a first copy but not replace it', async () => {
    const first = await api(A, A.uploaderToken).upload(`/copy-docs/${A.seaExport.id}/documents`, 'CO', 'co-certificate.pdf');
    expect(first.status, JSON.stringify(first.body.error ?? {})).toBe(201);
    expect(docOf(first.body, 'CO')).toMatchObject({ source: 'UPLOAD', fileName: 'co-certificate.pdf' });
    const replace = await api(A, A.uploaderToken).upload(`/copy-docs/${A.seaExport.id}/documents`, 'CO', 'co-v2.pdf');
    expect(replace.status).toBe(403);
    const viewer = await api(A, A.viewerToken).upload(`/copy-docs/${A.seaExport.id}/documents`, 'GSP');
    expect(viewer.status).toBe(403);
    const replaced = await api(A).upload(`/copy-docs/${A.seaExport.id}/documents`, 'CO', 'co-v2.pdf');
    expect(docOf(replaced.body, 'CO').fileName).toBe('co-v2.pdf');
    const file = await api(A, A.viewerToken).get(`/copy-docs/${A.seaExport.id}/documents/CO`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('puts an upload ahead of what the system holds, and falls back when it is removed', async () => {
    const up = await api(A).upload(`/copy-docs/${A.airImport.id}/documents`, 'IGM', 'igm-scan.pdf');
    expect(docOf(up.body, 'IGM')).toMatchObject({ source: 'UPLOAD', fileName: 'igm-scan.pdf' });
    const refused = await api(A, A.uploaderToken).del(`/copy-docs/${A.airImport.id}/documents/IGM`);
    expect(refused.status).toBe(403);
    const removed = await api(A).del(`/copy-docs/${A.airImport.id}/documents/IGM`);
    expect(removed.status).toBe(200);
    expect(docOf(removed.body, 'IGM')).toMatchObject({ source: 'SYSTEM', note: 'From IGM Update.' });
    const kept = await owner.copyDocument.count({ where: { shipmentId: A.airImport.id, kind: 'IGM', deletedAt: { not: null } } });
    expect(kept).toBe(1);
  });

  it('refuses an unknown paper, and a cancelled booking', async () => {
    const unknown = await api(A).upload(`/copy-docs/${A.seaExport.id}/documents`, 'PASSPORT');
    expect(unknown.status).toBe(400);
    const cancelled = await api(A).upload(`/copy-docs/${A.cancelled.id}/documents`, 'CO');
    expect(cancelled.status).toBe(409);
  });
});

describe('Pre-Alert and Copy Doc share the bills', () => {
  it('offers Pre-Alert the master bill uploaded here', async () => {
    await api(A).upload(`/copy-docs/${A.seaExport.id}/documents`, 'MASTER_BL', 'sitc-mbl.pdf');
    const preAlert = await api(A, A.superToken, '/api/tenant/cs').get(`/pre-alerts/${A.seaExport.id}`);
    expect(preAlert.status, JSON.stringify(preAlert.body.error ?? {})).toBe(200);
    expect(preAlert.body.data.documents.find((d: Doc) => d.kind === 'MBL')).toMatchObject({
      source: 'SYSTEM',
      fileName: 'sitc-mbl.pdf',
      note: 'Uploaded on Copy Doc upload.',
    });
  });

  it('shows here the master bill uploaded on Pre-Alert', async () => {
    const up = await api(A, A.superToken, '/api/tenant/cs').upload(`/pre-alerts/${A.seaExportTwo.id}/documents`, 'MBL', 'carrier-mbl.pdf');
    expect(up.status, JSON.stringify(up.body.error ?? {})).toBe(201);
    const res = await api(A).get(`/copy-docs/${A.seaExportTwo.id}`);
    expect(docOf(res.body, 'MASTER_BL')).toMatchObject({ source: 'SYSTEM', fileName: 'carrier-mbl.pdf', note: 'Uploaded on Pre-Alert.' });
  });
});

describe('two workspaces', () => {
  it('never lists, opens or uploads to the other workspace’s bookings', async () => {
    const list = await api(B).get('/copy-docs');
    expect(codes(list.body)).toEqual([B.seaExport.code, B.seaExportTwo.code, B.airImport.code].sort());
    for (const row of list.body.data as Row[]) expect(row.houseBlNo === null || row.houseBlNo.startsWith('CB') || row.houseBlNo.startsWith('DXB-CB')).toBe(true);
    expect(rowOf(list.body, B.seaExport.code).onFile).toBe(0);
    expect((await api(B).get(`/copy-docs/${A.seaExport.id}`)).status).toBe(404);
    expect((await api(B).get(`/copy-docs/${A.seaExport.id}/documents/CO`)).status).toBe(404);
    expect((await api(B).upload(`/copy-docs/${A.seaExport.id}/documents`, 'CO')).status).toBe(404);
  });
});
