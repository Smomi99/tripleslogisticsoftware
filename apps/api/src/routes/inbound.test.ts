import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * IGM Submission and DO Issue, through HTTP — docs/DESIGN-UPDATE-2026-10-04.md §4.
 *
 * Two workspaces, each with an inbound sea booking, an inbound air booking,
 * an outbound sea booking (never listed: "Outbound Skip") and an inbound one
 * with no schedule yet (nothing to work on).
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');
const { extractPdfText } = await import('../lib/pdf-text');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'inbound-alpha';
const SLUG_B = 'inbound-beta';
const YEAR = new Date().getUTCFullYear();
const dayFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface World {
  tenantId: bigint;
  slug: string;
  superToken: string;
  /** IGM: may record a first one, not change it. */
  recorderToken: string;
  igmViewerToken: string;
  doToken: string;
  inSea: { id: bigint; code: string };
  inAir: { id: bigint; code: string };
  outSea: { id: bigint; code: string };
  inUnplanned: { id: bigint; code: string };
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'delivery_order',
    'igm_update',
    'shipment_schedule_leg',
    'shipment_schedule',
    'shipment',
    'quotation',
    'inquiry',
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
  const decider = await user(`USR-D${tag}`, false, []);

  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = await owner.customer.create({
    data: { tenantId, code: `CUS-${tag}`, name: `Importer ${tag}`, country: 'Bangladesh', customerType: 'IMPORTER', businessArea: 'INBOUND', industrySectorId: sector.id },
    select: { id: true },
  });
  const port = async (code: string, type: 'SEAPORT' | 'AIRPORT' = 'SEAPORT') =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${code}`, name: `${code} ${tag}`, portCode: `${tag}${code}`, country: 'Bangladesh', type },
        select: { id: true },
      })
    ).id;
  const sha = await port('SHA');
  const ctg = await port('CTG');
  const pvg = await port('PVG', 'AIRPORT');
  const dac = await port('DAC', 'AIRPORT');
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({ data: { tenantId, code: `CAR-${tag}`, name: `Line ${tag}`, typeId: carrierType.id }, select: { id: true } });
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });

  const quotationFor = async (n: number, movementType: 'INBOUND' | 'OUTBOUND') => {
    const inquiry = await owner.inquiry.create({
      data: {
        tenantId,
        code: `INQ-${YEAR}-6${tag}0${n}`,
        seriesYear: YEAR,
        inquiryDate: at(dayFromNow(-30)),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        movementType,
        polId: sha,
        podId: ctg,
      },
      select: { id: true },
    });
    return (
      await owner.quotation.create({
        data: {
          tenantId,
          code: `QTN-${YEAR}-6${tag}0${n}`,
          seriesYear: YEAR,
          inquiryId: inquiry.id,
          quotationDate: at(dayFromNow(-29)),
          customerId: customer.id,
          shipmentType: 'SEA',
          movementType,
          polId: sha,
          podId: ctg,
          carrierId: carrier.id,
          localCurrencyId: bdt,
          conversionRate: '1',
          status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;
  };
  const inbound = await quotationFor(1, 'INBOUND');
  const outbound = await quotationFor(2, 'OUTBOUND');

  let n = 0;
  const booking = async (quotationId: bigint, shipmentType: 'SEA' | 'AIR', scheduled: boolean) => {
    n += 1;
    const s = await owner.shipment.create({
      data: {
        tenantId,
        code: `BKG-${YEAR}-6${tag}0${n}`,
        seriesYear: YEAR,
        quotationId,
        shipmentType,
        customerId: customer.id,
        carrierId: carrier.id,
        polId: shipmentType === 'AIR' ? pvg : sha,
        podId: shipmentType === 'AIR' ? dac : ctg,
        status: 'APPROVED_FOR_SHIPMENT',
      },
      select: { id: true, code: true },
    });
    if (scheduled) {
      const sch = await owner.shipmentSchedule.create({
        data: { tenantId, code: `SCH-${tag}${n}`, shipmentId: s.id, carrierId: carrier.id, transitType: 'DIRECT', status: 'APPROVED', decidedBy: decider.id, decidedAt: new Date() },
        select: { id: true },
      });
      await owner.shipmentScheduleLeg.create({
        data: {
          tenantId,
          scheduleId: sch.id,
          legNo: 1,
          originPortId: shipmentType === 'AIR' ? pvg : sha,
          destinationPortId: shipmentType === 'AIR' ? dac : ctg,
          etd: at(dayFromNow(-10)),
          eta: at(dayFromNow(n)),
          flightNo: shipmentType === 'AIR' ? 'MU 2041' : null,
          voyageNo: shipmentType === 'SEA' ? '115S' : null,
        },
      });
    }
    return s;
  };

  return {
    tenantId,
    slug,
    superToken: (await user(`USR-S${tag}`, true, [])).token,
    recorderToken: (await user(`USR-R${tag}`, false, ['OPERATION.IGM_SUBMISSION.VIEW', 'OPERATION.IGM_SUBMISSION.CREATE'])).token,
    igmViewerToken: (await user(`USR-V${tag}`, false, ['OPERATION.IGM_SUBMISSION.VIEW'])).token,
    doToken: (
      await user(`USR-O${tag}`, false, [
        'OPERATION.DO_ISSUE.VIEW',
        'OPERATION.DO_ISSUE.CREATE',
        'OPERATION.DO_ISSUE.EXPORT',
        'OPERATION.DO_ISSUE.TOGGLE_STATUS',
      ])
    ).token,
    inSea: await booking(inbound, 'SEA', true),
    inAir: await booking(inbound, 'AIR', true),
    outSea: await booking(outbound, 'SEA', true),
    inUnplanned: await booking(inbound, 'SEA', false),
  };
}

function api(token: string, slug: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  const base = '/api/tenant/ops';
  return {
    get: (path: string) => wrap(request(app).get(`${base}${path}`)),
    post: (path: string, body?: Record<string, unknown>) => wrap(request(app).post(`${base}${path}`)).send(body ?? {}),
    upload: (path: string, hblNo: string) =>
      wrap(request(app).post(`${base}${path}`))
        .field('hblNo', hblNo)
        .attach('file', Buffer.from('%PDF-1.4 IGM test'), { filename: 'igm-manifest.pdf', contentType: 'application/pdf' }),
  };
}

const codes = (body: { data: { bookingCode: string }[] }) => body.data.map((r) => r.bookingCode).sort();

/** A response body as the bytes that came, whatever its type. */
function raw(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  // At this point supertest hands over the raw response stream.
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => done(null, Buffer.concat(chunks)));
}

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Inbound Alpha', SLUG_A, 'IA');
  B = await makeWorld('Inbound Beta', SLUG_B, 'IB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('IGM Update', () => {
  it('lists inbound bookings with a schedule, by mode, and never an outbound one', async () => {
    const sea = await api(A.recorderToken, A.slug).get('/igm?shipmentType=SEA');
    expect(sea.status).toBe(200);
    expect(codes(sea.body)).toEqual([A.inSea.code]);
    const air = await api(A.recorderToken, A.slug).get('/igm?shipmentType=AIR');
    expect(codes(air.body)).toEqual([A.inAir.code]);
  });

  it('refuses an outbound booking and one with nothing scheduled', async () => {
    const out = await api(A.superToken, A.slug).post(`/igm/${A.outSea.id}`, { hblNo: 'X1' });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe('NOT_INBOUND');
    const unplanned = await api(A.superToken, A.slug).post(`/igm/${A.inUnplanned.id}`, { hblNo: 'X1' });
    expect(unplanned.status).toBe(409);
  });

  it('keeps a booking Awaiting with only the HBL No, and Updated once the file is in', async () => {
    const hblOnly = await api(A.recorderToken, A.slug).post(`/igm/${A.inSea.id}`, { hblNo: 'SHACTG0001' });
    expect(hblOnly.status).toBe(200);
    expect(hblOnly.body.data).toMatchObject({ hblNo: 'SHACTG0001', updated: false, fileName: null });
    const stillWaiting = await api(A.recorderToken, A.slug).get('/igm?shipmentType=SEA');
    expect(codes(stillWaiting.body)).toEqual([A.inSea.code]);

    // A recorder may write the first one, not change it.
    const change = await api(A.recorderToken, A.slug).upload(`/igm/${A.inSea.id}`, 'SHACTG0001');
    expect(change.status).toBe(403);

    const upload = await api(A.superToken, A.slug).upload(`/igm/${A.inSea.id}`, 'SHACTG0001');
    expect(upload.status).toBe(200);
    expect(upload.body.data).toMatchObject({ updated: true, fileName: 'igm-manifest.pdf' });

    expect(codes((await api(A.recorderToken, A.slug).get('/igm?shipmentType=SEA')).body)).toEqual([]);
    const updated = await api(A.igmViewerToken, A.slug).get('/igm?shipmentType=SEA&view=UPDATED');
    expect(codes(updated.body)).toEqual([A.inSea.code]);

    const file = await api(A.igmViewerToken, A.slug).get(`/igm/${A.inSea.id}/file`).buffer(true).parse(raw);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect((file.body as Buffer).toString()).toContain('IGM test');
  });

  it('lets a viewer read but not record', async () => {
    expect((await api(A.igmViewerToken, A.slug).post(`/igm/${A.inAir.id}`, { hblNo: 'X' })).status).toBe(403);
  });
});

describe('DO Issue', () => {
  it('waits for the IGM', async () => {
    const res = await api(A.doToken, A.slug).post('/delivery-orders', {
      shipmentId: A.inAir.id.toString(),
      issueDate: dayFromNow(0),
      addressee: 'Cargo Village, Dhaka',
      subject: 'Release of cargo',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IGM_FIRST');
  });

  it("opens on the sheet's addressee and the IGM's HBL", async () => {
    const res = await api(A.doToken, A.slug).get(`/delivery-orders/prefill/${A.inSea.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      addressee: 'TERMINAL MANAGER\nCHITTAGONG PORT AUTHORITY\nCHITTAGONG',
      hblNo: 'SHACTG0001',
      igmUpdated: true,
    });
  });

  it('issues one numbered order, prints it, and cancels it with a reason without reusing the number', async () => {
    const body = {
      shipmentId: A.inSea.id.toString(),
      issueDate: dayFromNow(0),
      addressee: 'TERMINAL MANAGER\nCHITTAGONG PORT AUTHORITY\nCHITTAGONG',
      subject: 'Delivery of cargo under HBL SHACTG0001',
      body: 'Please deliver the containers below to the bearer.',
    };
    const issued = await api(A.doToken, A.slug).post('/delivery-orders', body);
    expect(issued.status).toBe(201);
    expect(issued.body.data).toMatchObject({ code: `DO-${YEAR}-000001`, status: 'ISSUED', hasPdf: true });

    const twice = await api(A.doToken, A.slug).post('/delivery-orders', body);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_ISSUED');

    const pdf = await api(A.doToken, A.slug)
      .get(`/delivery-orders/${issued.body.data.id}/pdf`)
      .buffer(true)
      .parse(raw);
    expect(pdf.status).toBe(200);
    const text = extractPdfText(pdf.body as Buffer);
    expect(text).toContain('DELIVERY ORDER');
    expect(text).toContain('CHITTAGONG PORT AUTHORITY');

    const issuedList = await api(A.doToken, A.slug).get('/delivery-orders?shipmentType=SEA&view=ISSUED');
    expect(codes(issuedList.body)).toEqual([A.inSea.code]);
    expect(codes((await api(A.doToken, A.slug).get('/delivery-orders?shipmentType=SEA')).body)).toEqual([]);

    const silent = await api(A.doToken, A.slug).post(`/delivery-orders/${issued.body.data.id}/cancel`, { reason: ' ' });
    expect(silent.status).toBe(400);
    const cancelled = await api(A.doToken, A.slug).post(`/delivery-orders/${issued.body.data.id}/cancel`, {
      reason: 'Wrong terminal',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const again = await api(A.doToken, A.slug).post('/delivery-orders', body);
    expect(again.status).toBe(201);
    expect(again.body.data.code).toBe(`DO-${YEAR}-000002`);
  });

  it("never shows or issues against another workspace's bookings", async () => {
    const b = await api(B.superToken, B.slug).get('/delivery-orders?shipmentType=SEA&view=ALL');
    expect(codes(b.body)).toEqual([B.inSea.code]);
    expect(b.body.data[0].deliveryOrder).toBeNull();

    const crossed = await api(A.superToken, A.slug).post(`/igm/${B.inSea.id}`, { hblNo: 'X' });
    expect(crossed.status).toBe(404);
    expect(await owner.igmUpdate.count({ where: { tenantId: B.tenantId } })).toBe(0);
    expect(await owner.deliveryOrder.count({ where: { tenantId: B.tenantId } })).toBe(0);
  });
});
