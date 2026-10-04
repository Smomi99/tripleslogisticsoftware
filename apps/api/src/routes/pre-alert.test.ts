import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pre-Alert, through HTTP — docs/DESIGN-UPDATE-2026-10-04.md §3.
 *
 * Two workspaces, each with an outbound sea booking (advised, its freight
 * invoice sent), an outbound air booking, and an inbound booking that the
 * screen must refuse. Two agents: one covering the destination port.
 */

const queueMailSpy = vi.hoisted(() =>
  vi.fn(
    async (_input: {
      templateKey: string;
      to: string[];
      attachments?: { filename: string; storageKey: string }[];
      variables: Record<string, unknown>;
    }) => ({ queued: true, id: 7n }),
  ),
);
vi.mock('../lib/email-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email-queue')>();
  return { ...actual, queueMail: queueMailSpy };
});

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');
const { putFile } = await import('../lib/storage');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'prealert-alpha';
const SLUG_B = 'prealert-beta';
const YEAR = new Date().getUTCFullYear();
const dayFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface World {
  tenantId: bigint;
  slug: string;
  senderToken: string;
  viewerToken: string;
  sea: { id: bigint; code: string };
  air: { id: bigint; code: string };
  inbound: { id: bigint; code: string };
  coveringAgent: bigint;
  otherAgent: bigint;
  invoiceCode: string;
}
let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'pre_alert',
    'pre_alert_document',
    'debit_invoice',
    'shipment_advise_booking',
    'shipment_advise',
    'shipment_schedule_leg',
    'shipment_schedule',
    'shipment',
    'quotation',
    'inquiry',
    'customer',
    'agent_port_coverage',
    'agent_pic',
    'agent',
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
  const { id: tenantId } = await owner.tenant.create({ data: { name, slug, country: 'Bangladesh', currencyId: bdt }, select: { id: true } });
  const user = async (code: string, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x' },
      select: { id: true },
    });
    return { id, token: await signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin: false, permissions, tokenVersion: 0 }) };
  };
  const decider = await user(`USR-D${tag}`, []);
  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = await owner.customer.create({
    data: { tenantId, code: `CUS-${tag}`, name: `Exporter ${tag}`, country: 'Bangladesh', customerType: 'EXPORTER', businessArea: 'OUTBOUND', industrySectorId: sector.id },
    select: { id: true },
  });
  const port = async (code: string, type: 'SEAPORT' | 'AIRPORT' = 'SEAPORT') =>
    (await owner.port.create({ data: { tenantId, code: `PL-${tag}${code}`, name: `${code} ${tag}`, portCode: `${tag}${code}`, country: 'Bangladesh', type }, select: { id: true } })).id;
  const ctg = await port('CTG');
  const ham = await port('HAM');
  const dac = await port('DAC', 'AIRPORT');
  const lhr = await port('LHR', 'AIRPORT');
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({ data: { tenantId, code: `CAR-${tag}`, name: `Line ${tag}`, typeId: carrierType.id }, select: { id: true } });

  const agent = async (code: string, agentName: string, email: string, covers: bigint | null) => {
    const a = await owner.agent.create({
      data: { tenantId, code: `AGT-${tag}${code}`, name: agentName, country: 'Germany', agentType: 'GENERAL' },
      select: { id: true },
    });
    await owner.agentPic.create({ data: { tenantId, code: `APC-${tag}${code}`, agentId: a.id, name: 'Imports', email } });
    if (covers !== null) await owner.agentPortCoverage.create({ data: { tenantId, agentId: a.id, portId: covers } });
    return a.id;
  };
  // Named so the one covering Hamburg sorts second alphabetically: coverage must win.
  const otherAgent = await agent('1', `Alpha Freight ${tag}`, `ops@alpha-${tag.toLowerCase()}.test`, null);
  const coveringAgent = await agent('2', `Zeta Hamburg ${tag}`, `imports@zeta-${tag.toLowerCase()}.test`, ham);

  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const quotation = async (n: number, movementType: 'INBOUND' | 'OUTBOUND') => {
    const inquiry = await owner.inquiry.create({
      data: { tenantId, code: `INQ-${YEAR}-5${tag}0${n}`, seriesYear: YEAR, inquiryDate: at(dayFromNow(-30)), sourceId: source.id, shipmentType: 'SEA', customerId: customer.id, movementType, polId: ctg, podId: ham },
      select: { id: true },
    });
    return (
      await owner.quotation.create({
        data: {
          tenantId, code: `QTN-${YEAR}-5${tag}0${n}`, seriesYear: YEAR, inquiryId: inquiry.id, quotationDate: at(dayFromNow(-29)), customerId: customer.id,
          shipmentType: 'SEA', movementType, polId: ctg, podId: ham, carrierId: carrier.id, localCurrencyId: bdt, conversionRate: '1', status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;
  };
  const outbound = await quotation(1, 'OUTBOUND');
  const inboundQ = await quotation(2, 'INBOUND');

  let n = 0;
  const booking = async (quotationId: bigint, shipmentType: 'SEA' | 'AIR') => {
    n += 1;
    const s = await owner.shipment.create({
      data: {
        tenantId, code: `BKG-${YEAR}-5${tag}0${n}`, seriesYear: YEAR, quotationId, shipmentType, customerId: customer.id, carrierId: carrier.id,
        polId: shipmentType === 'AIR' ? dac : ctg, podId: shipmentType === 'AIR' ? lhr : ham, exporterName: `Knit ${tag}`, importerName: `Buyer ${tag}`,
        status: 'APPROVED_FOR_SHIPMENT',
      },
      select: { id: true, code: true },
    });
    const sch = await owner.shipmentSchedule.create({
      data: { tenantId, code: `SCH-${tag}${n}`, shipmentId: s.id, carrierId: carrier.id, transitType: 'DIRECT', status: 'APPROVED', decidedBy: decider.id, decidedAt: new Date() },
      select: { id: true },
    });
    await owner.shipmentScheduleLeg.create({
      data: {
        tenantId, scheduleId: sch.id, legNo: 1, originPortId: shipmentType === 'AIR' ? dac : ctg, destinationPortId: shipmentType === 'AIR' ? lhr : ham,
        etd: at(dayFromNow(-3)), eta: at(dayFromNow(20)), flightNo: shipmentType === 'AIR' ? 'EK 585' : null, voyageNo: shipmentType === 'SEA' ? '044W' : null,
      },
    });
    return { ...s, scheduleId: sch.id };
  };
  const sea = await booking(outbound, 'SEA');
  const air = await booking(outbound, 'AIR');
  const inbound = await booking(inboundQ, 'SEA');

  const advise = await owner.shipmentAdvise.create({
    data: {
      tenantId, code: `SA-${YEAR}-5${tag}01`, seriesYear: YEAR, shipmentId: sea.id, scheduleId: sea.scheduleId, carrierId: carrier.id, transitType: 'DIRECT',
      polId: ctg, podId: ham, etd: at(dayFromNow(-3)), eta: at(dayFromNow(20)), houseBlNo: `HBL${tag}5001`, mblNo: `MSCU${tag}77`,
    },
    select: { id: true },
  });
  await owner.shipmentAdviseBooking.create({ data: { tenantId, adviseId: advise.id, shipmentId: sea.id } });
  await owner.shipmentAdvise.update({ where: { id: advise.id }, data: { status: 'SENT' } });

  // The freight invoice as it was sent to the customer: the Debit Note.
  const stored = await putFile(tenantId, 'debit-invoice', {
    buffer: Buffer.from('%PDF-1.4 debit note'),
    originalname: 'dn.pdf',
    mimetype: 'application/pdf',
    size: 19,
  });
  const invoiceCode = `DN-${YEAR}-5${tag}01`;
  await owner.debitInvoice.create({
    data: {
      tenantId, code: invoiceCode, seriesYear: YEAR, kind: 'FREIGHT', shipmentId: sea.id, quotationId: outbound, customerId: customer.id,
      invoiceDate: at(dayFromNow(-2)), currencyId: bdt, currencyCode: 'BDT', conversionRate: '1', status: 'ISSUED', pdfFile: stored.key,
    },
  });

  return {
    tenantId,
    slug,
    senderToken: (await user(`USR-S${tag}`, ['CUSTOMER_SERVICE.PRE_ALERT.VIEW', 'CUSTOMER_SERVICE.PRE_ALERT.EDIT', 'CUSTOMER_SERVICE.PRE_ALERT.SEND'])).token,
    viewerToken: (await user(`USR-V${tag}`, ['CUSTOMER_SERVICE.PRE_ALERT.VIEW'])).token,
    sea,
    air,
    inbound,
    coveringAgent,
    otherAgent,
    invoiceCode,
  };
}

function api(token: string, slug: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  const base = '/api/tenant/cs/pre-alerts';
  return {
    get: (path = '') => wrap(request(app).get(`${base}${path}`)),
    post: (path: string, body: Record<string, unknown>) => wrap(request(app).post(`${base}${path}`)).send(body),
    upload: (shipmentId: bigint, kind: string) =>
      wrap(request(app).post(`${base}/${shipmentId}/documents`))
        .field('kind', kind)
        .attach('file', Buffer.from('%PDF-1.4 carrier paper'), { filename: `${kind.toLowerCase()}.pdf`, contentType: 'application/pdf' }),
  };
}
const codes = (body: { data: { bookingCode: string }[] }) => body.data.map((r) => r.bookingCode).sort();

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Pre-alert Alpha', SLUG_A, 'PA');
  B = await makeWorld('Pre-alert Beta', SLUG_B, 'PB');
});
afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});
beforeEach(() => queueMailSpy.mockClear());

describe('Pre-Alert', () => {
  it('lists outbound bookings by mode, never inbound ones', async () => {
    expect(codes((await api(A.viewerToken, A.slug).get('?shipmentType=SEA')).body)).toEqual([A.sea.code]);
    expect(codes((await api(A.viewerToken, A.slug).get('?shipmentType=AIR')).body)).toEqual([A.air.code]);
    const inbound = await api(A.viewerToken, A.slug).get(`/${A.inbound.id}`);
    expect(inbound.status).toBe(409);
    expect(inbound.body.error.code).toBe('NOT_OUTBOUND');
  });

  it("offers the mode's documents, the sent invoice as the debit note, and the destination's agents first", async () => {
    const res = await api(A.viewerToken, A.slug).get(`/${A.sea.id}`);
    expect(res.status).toBe(200);
    const docs = res.body.data.documents as { kind: string; source: string | null; fileName: string | null }[];
    expect(docs.map((d) => d.kind)).toEqual(['BOOKING_CONFIRMATION', 'HBL', 'MBL', 'DEBIT_NOTE']);
    expect(docs.find((d) => d.kind === 'DEBIT_NOTE')).toMatchObject({ source: 'SYSTEM', fileName: `${A.invoiceCode}.pdf` });
    expect(docs.find((d) => d.kind === 'HBL')?.source).toBeNull();

    const agents = res.body.data.agents as { id: string; coversPod: boolean; emails: string[] }[];
    expect(agents[0]).toMatchObject({ id: A.coveringAgent.toString(), coversPod: true, emails: ['imports@zeta-pa.test'] });

    const air = await api(A.viewerToken, A.slug).get(`/${A.air.id}`);
    expect((air.body.data.documents as { kind: string }[]).map((d) => d.kind)).toEqual([
      'BOOKING_CONFIRMATION',
      'HAWB',
      'MAWB',
      'MANIFEST_AIR',
      'DEBIT_NOTE',
    ]);
  });

  it('takes uploads of the papers the system does not make, for the right mode only', async () => {
    const mbl = await api(A.senderToken, A.slug).upload(A.sea.id, 'MBL');
    expect(mbl.status).toBe(201);
    expect((mbl.body.data.documents as { kind: string; source: string | null }[]).find((d) => d.kind === 'MBL')?.source).toBe('UPLOAD');

    expect((await api(A.senderToken, A.slug).upload(A.sea.id, 'HAWB')).status).toBe(400);
    expect((await api(A.viewerToken, A.slug).upload(A.sea.id, 'MBL')).status).toBe(403);
  });

  it('refuses a document that is not there, naming it', async () => {
    const res = await api(A.senderToken, A.slug).post(`/${A.sea.id}/send`, {
      agentId: A.coveringAgent.toString(),
      to: ['imports@zeta-pa.test'],
      documents: ['BOOKING_CONFIRMATION', 'MBL'],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Booking confirmation');
    expect(queueMailSpy).not.toHaveBeenCalled();
  });

  it('sends the ticked documents to the agent and records it', async () => {
    const res = await api(A.senderToken, A.slug).post(`/${A.sea.id}/send`, {
      agentId: A.coveringAgent.toString(),
      to: ['imports@zeta-pa.test'],
      documents: ['DEBIT_NOTE', 'MBL'],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.sends[0]).toMatchObject({ agentName: 'Zeta Hamburg PA', documents: ['MBL', 'DEBIT_NOTE'], emailed: true });

    expect(queueMailSpy).toHaveBeenCalledTimes(1);
    const mail = queueMailSpy.mock.calls[0]![0];
    expect(mail.templateKey).toBe('PRE_ALERT_SENT');
    expect(mail.to).toEqual(['imports@zeta-pa.test']);
    expect(mail.attachments?.map((a) => a.filename)).toEqual(['mbl.pdf', `${A.invoiceCode}.pdf`]);
    expect(mail.variables.houseBlNo).toBe('HBLPA5001');
    expect(mail.variables.mblNo).toBe('MSCUPA77');

    expect(codes((await api(A.viewerToken, A.slug).get('?shipmentType=SEA')).body)).toEqual([]);
    const sent = await api(A.viewerToken, A.slug).get('?shipmentType=SEA&view=SENT');
    expect(sent.body.data[0].lastSent.agentName).toBe('Zeta Hamburg PA');
  });

  it('lets a viewer look but not send', async () => {
    const res = await api(A.viewerToken, A.slug).post(`/${A.sea.id}/send`, {
      agentId: A.coveringAgent.toString(),
      to: ['x@y.test'],
      documents: ['DEBIT_NOTE'],
    });
    expect(res.status).toBe(403);
  });

  it("never reaches another workspace's bookings or agents", async () => {
    const foreignAgent = await api(A.senderToken, A.slug).post(`/${A.sea.id}/send`, {
      agentId: B.coveringAgent.toString(),
      to: ['x@y.test'],
      documents: ['DEBIT_NOTE'],
    });
    expect(foreignAgent.status).toBe(400);
    expect((await api(A.senderToken, A.slug).get(`/${B.sea.id}`)).status).toBe(404);
    expect(await owner.preAlert.count({ where: { tenantId: B.tenantId } })).toBe(0);
  });
});
