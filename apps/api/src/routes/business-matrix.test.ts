import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Sales → Business Matrix, through HTTP — docs/DESIGN-UPDATE-2026-10-28.md §1.
 *
 * Two workspaces. Each has Chittagong → Antwerp traffic that every column
 * counts (inquiries, a quotation revised once, two finalised containers, an
 * issued invoice) beside traffic none of them may count: a draft quotation, a
 * draft load plan, a draft invoice and a Cross Border inquiry.
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'matrix-alpha';
const SLUG_B = 'matrix-beta';
const YEAR = new Date().getUTCFullYear();
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface World {
  tenantId: bigint;
  slug: string;
  superToken: string;
  viewerToken: string;
  ports: { ctg: bigint; anr: bigint; rtm: bigint; leh: bigint; dac: bigint };
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'trade_lane_port',
    'trade_lane',
    'debit_invoice',
    'clp_booking',
    'clp',
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
  const superUser = await user(`USR-S${tag}`, true, []);

  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = await owner.customer.create({
    data: { tenantId, code: `CUS-${tag}`, name: `Exporter ${tag}`, country: 'Bangladesh', customerType: 'EXPORTER', businessArea: 'BOTH', industrySectorId: sector.id },
    select: { id: true },
  });
  const port = async (code: string, type: 'SEAPORT' | 'AIRPORT' = 'SEAPORT') =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${code}`, name: `${code} ${tag}`, portCode: `${tag}${code}`, country: 'Bangladesh', type },
        select: { id: true },
      })
    ).id;
  const ports = { ctg: await port('CTG'), anr: await port('ANR'), rtm: await port('RTM'), leh: await port('LEH'), dac: await port('DAC', 'AIRPORT') };
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({ data: { tenantId, code: `CAR-${tag}`, name: `Line ${tag}`, typeId: carrierType.id }, select: { id: true } });
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });

  let inquiryNo = 0;
  const inquiry = async (movementType: 'OUTBOUND' | 'INBOUND' | 'CROSS_BORDER', pol: bigint, pod: bigint, date: string) => {
    inquiryNo += 1;
    return owner.inquiry.create({
      data: {
        tenantId,
        code: `INQ-${YEAR}-7${tag}${String(inquiryNo).padStart(2, '0')}`,
        seriesYear: YEAR,
        inquiryDate: at(date),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        movementType,
        polId: pol,
        podId: pod,
      },
      select: { id: true },
    });
  };
  // Outbound Chittagong → Antwerp three times, one of them in January.
  const first = await inquiry('OUTBOUND', ports.ctg, ports.anr, `${YEAR}-01-05`);
  await inquiry('OUTBOUND', ports.ctg, ports.anr, `${YEAR}-03-10`);
  await inquiry('OUTBOUND', ports.ctg, ports.anr, `${YEAR}-03-12`);
  await inquiry('OUTBOUND', ports.ctg, ports.rtm, `${YEAR}-03-12`);
  // Inbound Antwerp → Chittagong twice. Cross Border is on no lane.
  await inquiry('INBOUND', ports.anr, ports.ctg, `${YEAR}-03-12`);
  await inquiry('INBOUND', ports.anr, ports.ctg, `${YEAR}-03-13`);
  await inquiry('CROSS_BORDER', ports.ctg, ports.anr, `${YEAR}-03-12`);

  const quotation = async (code: string, revisionNo: number, status: 'DRAFT' | 'SENT' | 'SUPERSEDED' | 'ACCEPTED' | 'CANCELLED') =>
    owner.quotation.create({
      data: {
        tenantId,
        code,
        revisionNo,
        seriesYear: YEAR,
        inquiryId: first.id,
        quotationDate: at(`${YEAR}-03-14`),
        customerId: customer.id,
        shipmentType: 'SEA',
        movementType: 'OUTBOUND',
        polId: ports.ctg,
        podId: ports.anr,
        carrierId: carrier.id,
        localCurrencyId: bdt,
        conversionRate: '1',
        status,
        ...(status === 'CANCELLED' ? { cancelledAt: new Date(), cancelReason: 'Quoted again.' } : {}),
      },
      select: { id: true },
    });
  // One quotation, revised once: it is one quotation. A draft is none, and
  // nor is a number withdrawn after a revision (cancelled, 2026-10-29).
  await quotation(`QTN-${YEAR}-7${tag}01`, 1, 'SUPERSEDED');
  const accepted = await quotation(`QTN-${YEAR}-7${tag}01`, 2, 'ACCEPTED');
  await quotation(`QTN-${YEAR}-7${tag}02`, 1, 'DRAFT');
  await quotation(`QTN-${YEAR}-7${tag}03`, 1, 'SUPERSEDED');
  await quotation(`QTN-${YEAR}-7${tag}03`, 2, 'CANCELLED');

  const booking = await owner.shipment.create({
    data: {
      tenantId,
      code: `BKG-${YEAR}-7${tag}01`,
      seriesYear: YEAR,
      quotationId: accepted.id,
      shipmentType: 'SEA',
      customerId: customer.id,
      carrierId: carrier.id,
      polId: ports.ctg,
      podId: ports.anr,
      status: 'BL_ISSUED',
    },
    select: { id: true },
  });

  const size = async (code: string) => (await owner.containerSize.findFirstOrThrow({ where: { tenantId: null, code } })).id;
  let clpNo = 0;
  const container = async (sizeCode: string, status: 'FINAL' | 'DRAFT') => {
    clpNo += 1;
    const clp = await owner.clp.create({
      data: {
        tenantId,
        code: `CLP-${YEAR}-7${tag}0${clpNo}`,
        seriesYear: YEAR,
        containerSizeId: await size(sizeCode),
        carrierId: carrier.id,
        status,
        ...(status === 'FINAL'
          ? { containerNo: 'MSCU1234565', sealNo: `SL-${clpNo}`, loadDatetime: at(`${YEAR}-03-20`), finalisedAt: at(`${YEAR}-03-20`), finalisedBy: superUser.id }
          : {}),
      },
      select: { id: true },
    });
    await owner.clpBooking.create({ data: { tenantId, clpId: clp.id, shipmentId: booking.id } });
  };
  await container('40HC', 'FINAL');
  await container('20STD', 'FINAL');
  await container('40HC', 'DRAFT');

  let invoiceNo = 0;
  const invoice = async (status: 'ISSUED' | 'DRAFT', amount: string) => {
    invoiceNo += 1;
    await owner.debitInvoice.create({
      data: {
        tenantId,
        code: `DN-${YEAR}-7${tag}0${invoiceNo}`,
        seriesYear: YEAR,
        // One live freight invoice per booking; the draft is an OTHER one.
        kind: status === 'ISSUED' ? 'FREIGHT' : 'OTHER',
        shipmentId: booking.id,
        quotationId: accepted.id,
        customerId: customer.id,
        invoiceDate: at(`${YEAR}-03-25`),
        currencyId: bdt,
        currencyCode: 'BDT',
        conversionRate: '1',
        totalAmount: amount,
        totalAmountBase: amount,
        costTotalBase: '0',
        status,
      },
    });
  };
  await invoice('ISSUED', '4000');
  await invoice('DRAFT', '999');

  return {
    tenantId,
    slug,
    superToken: superUser.token,
    viewerToken: (await user(`USR-V${tag}`, false, ['SALES.BUSINESS_MATRIX.VIEW'])).token,
    ports,
  };
}

function api(world: World, token = world.superToken) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', world.slug);
  const base = '/api/tenant/sales/business-matrix';
  return {
    get: (path: string) => wrap(request(app).get(`${base}${path}`)),
    post: (path: string, body?: Record<string, unknown>) => wrap(request(app).post(`${base}${path}`)).send(body ?? {}),
    put: (path: string, body: Record<string, unknown>) => wrap(request(app).put(`${base}${path}`)).send(body),
  };
}

const lane = (w: World, name: string, portIds: bigint[], movementType: 'OUTBOUND' | 'INBOUND' = 'OUTBOUND', portId = w.ports.ctg) => ({
  name,
  movementType,
  portId: portId.toString(),
  portIds: portIds.map(String),
});

interface Row {
  pol: { id: string };
  pod: { id: string };
  inquiries: number;
  quotations: number;
  teus: string | null;
  revenue: string;
}

let euLaneId = '';

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Matrix Alpha', SLUG_A, 'MA');
  B = await makeWorld('Matrix Beta', SLUG_B, 'MB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('a trade lane', () => {
  it('is added with its single POL and many PODs, and numbered', async () => {
    const res = await api(A).post('/', lane(A, 'EU Base port', [A.ports.anr, A.ports.rtm]));
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'TLN-001', name: 'EU Base port', movementType: 'OUTBOUND', isAir: false });
    expect(res.body.data.ports.map((p: { id: string }) => p.id)).toEqual([A.ports.anr.toString(), A.ports.rtm.toString()]);
    euLaneId = res.body.data.id as string;
  });

  it('counts each column for each pair, and only what it should', async () => {
    const res = await api(A).get('/?movementType=OUTBOUND');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const [antwerp, rotterdam] = res.body.data[0].rows as Row[];
    // Three outbound inquiries, not the Cross Border one. One quotation, not
    // its superseded revision, the draft, or the cancelled number. A 40' and a 20' that are final,
    // not the draft plan. The issued invoice, not the draft.
    expect(antwerp).toMatchObject({ pol: { id: A.ports.ctg.toString() }, pod: { id: A.ports.anr.toString() }, inquiries: 3, quotations: 1, teus: '3.00', revenue: '4000.0000' });
    expect(rotterdam).toMatchObject({ inquiries: 1, quotations: 0, teus: '0.00', revenue: '0.0000' });
    expect(res.body.data[0].revenueCurrency).toBe('BDT');
  });

  it('counts within a period by each record’s own date', async () => {
    const res = await api(A).get(`/?movementType=OUTBOUND&from=${YEAR}-03-01&to=${YEAR}-03-31`);
    const [antwerp] = res.body.data[0].rows as Row[];
    expect(antwerp).toMatchObject({ inquiries: 2, quotations: 1, teus: '3.00', revenue: '4000.0000' });
    const backwards = await api(A).get(`/?from=${YEAR}-03-31&to=${YEAR}-03-01`);
    expect(backwards.status).toBe(400);
  });

  it('reads an inbound lane as many POLs into one POD', async () => {
    const res = await api(A).post('/', lane(A, 'EU Base port', [A.ports.anr, A.ports.leh], 'INBOUND'));
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    const list = await api(A).get('/?movementType=INBOUND');
    const rows = list.body.data[0].rows as Row[];
    expect(rows[0]).toMatchObject({ pol: { id: A.ports.anr.toString() }, pod: { id: A.ports.ctg.toString() }, inquiries: 2 });
    expect(rows[1]).toMatchObject({ pol: { id: A.ports.leh.toString() }, inquiries: 0 });
    // The outbound list does not show it.
    const outbound = await api(A).get('/?movementType=OUTBOUND');
    expect(outbound.body.data.map((l: { name: string; movementType: string }) => l.movementType)).toEqual(['OUTBOUND']);
  });
});

describe('the rules of a lane', () => {
  it('refuses a pair that is already on another live lane', async () => {
    const res = await api(A).post('/', lane(A, 'North Europe', [A.ports.leh, A.ports.anr]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAIR_ON_ANOTHER_LANE');
    expect(res.body.error.message).toMatch(/EU Base port/);
  });

  it('frees the pair while the lane is inactive, and refuses to switch it back on over a clash', async () => {
    const off = await api(A).post(`/${euLaneId}/toggle-status`);
    expect(off.body.data.isActive).toBe(false);
    const other = await api(A).post('/', lane(A, 'North Europe', [A.ports.anr]));
    expect(other.status, JSON.stringify(other.body.error ?? {})).toBe(201);
    const on = await api(A).post(`/${euLaneId}/toggle-status`);
    expect(on.status).toBe(409);
    await api(A).post(`/${other.body.data.id as string}/toggle-status`);
    const nowOn = await api(A).post(`/${euLaneId}/toggle-status`);
    expect(nowOn.body.data.isActive).toBe(true);
  });

  it('refuses a name already used in the same direction, whatever its case', async () => {
    const res = await api(A).post('/', lane(A, 'eu base PORT', [A.ports.leh]));
    expect(res.status).toBe(409);
  });

  it('refuses a mix of seaports and airports, and a port on both sides', async () => {
    const mixed = await api(A).post('/', lane(A, 'Mixed', [A.ports.dac]));
    expect(mixed.status).toBe(400);
    const both = await api(A).post('/', lane(A, 'Both sides', [A.ports.ctg]));
    expect(both.status).toBe(400);
  });

  it('replaces the ports on edit and keeps the old ones on the record', async () => {
    const res = await api(A).put(`/${euLaneId}`, lane(A, 'EU Base port', [A.ports.rtm]));
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data.ports.map((p: { id: string }) => p.id)).toEqual([A.ports.rtm.toString()]);
    const retired = await owner.tradeLanePort.count({ where: { tradeLaneId: BigInt(euLaneId), deletedAt: { not: null } } });
    expect(retired).toBe(2);
  });
});

describe('access', () => {
  it('lets a viewer read the matrix and nothing more', async () => {
    const read = await api(A, A.viewerToken).get('/?movementType=OUTBOUND');
    expect(read.status).toBe(200);
    const add = await api(A, A.viewerToken).post('/', lane(A, 'Viewer lane', [A.ports.leh]));
    expect(add.status).toBe(403);
  });

  it('keeps each workspace to its own lanes and ports', async () => {
    const list = await api(B).get('/?movementType=OUTBOUND');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    const edit = await api(B).put(`/${euLaneId}`, lane(B, 'Taken over', [B.ports.anr]));
    expect(edit.status).toBe(404);
    const foreignPort = await api(B).post('/', lane(B, 'Borrowed', [A.ports.anr]));
    expect(foreignPort.status).toBe(400);
    // B's own traffic is counted on B's lane, and A's is not.
    const own = await api(B).post('/', lane(B, 'EU Base port', [B.ports.anr]));
    expect(own.status, JSON.stringify(own.body.error ?? {})).toBe(201);
    expect(own.body.data.code).toBe('TLN-001');
    expect(own.body.data.rows[0]).toMatchObject({ inquiries: 3, quotations: 1, teus: '3.00', revenue: '4000.0000' });
  });
});
