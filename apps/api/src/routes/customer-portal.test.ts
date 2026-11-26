import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { PERMISSIONS } from '@ff/shared';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { hashPassword } from '../lib/password';

/**
 * The tabs on the customer's My Shipments page (owner, 2026-11-26), through
 * the real application: sign-in, session kind, permissions, RLS, the views.
 *
 * §7A rule 4 in the shape this portal needs. Two customers share workspace A,
 * because the boundary that matters most here is between two companies of the
 * same forwarder; a third sits in workspace B. Signed in as each, every tab
 * must return that company's rows and nothing else — and never a draft, and
 * never a column the forwarder keeps to itself.
 */

vi.mock('../lib/mailer', () => ({
  sendMail: () => Promise.resolve({ sent: true }),
  parseAddressList: () => [],
}));

const { createApp } = await import('../app');

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'cportal-alpha';
const SLUG_B = 'cportal-beta';
const PASSWORD = 'Correct-Horse-Battery';

/** Written onto rows the customer may see, in columns they may not. */
const SENTINEL_REMARK = 'SENTINEL-internal-remark';
const SENTINEL_COST = '424242.4242';
const SENTINEL_TARGET = '919191.9191';

let tenantA: bigint;
let tenantB: bigint;

const ids: Record<string, bigint> = {};

let alphaToken: string;
let bravoToken: string;
let foreignToken: string;
let staffToken: string;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  await owner.$executeRawUnsafe(`UPDATE "user" SET role_id = NULL WHERE tenant_id IN ${scope}`);
  for (const table of [
    'debit_invoice',
    'bl_draft',
    'shipment_advise_booking',
    'shipment_advise',
    'cargo_receipt_line',
    'cargo_receipt',
    'shipping_order',
    'shipment_schedule_leg',
    'shipment_schedule',
    'shipment_cargo_line',
    'shipment_po',
    'shipment',
    'quotation',
    'inquiry',
    'role_permission',
    'user_permission',
    '"user"',
    'role',
    'customer',
    'industry_sector',
    'carrier',
    'carrier_type',
    'port',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`);
}

const get = (path: string, token: string, slug = SLUG_A) =>
  request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);

async function signIn(username: string, slug: string): Promise<string> {
  const res = await request(app)
    .post('/api/tenant/auth/login')
    .set('X-Tenant-Slug', slug)
    .send({ username, password: PASSWORD })
    .expect(200);
  return res.body.data.accessToken as string;
}

async function roleWith(tenantId: bigint, code: string, keys: string[]): Promise<bigint> {
  const role = await owner.role.create({
    data: { tenantId, code, name: `${code} role` },
    select: { id: true },
  });
  const permissions = await owner.permission.findMany({
    where: { key: { in: keys } },
    select: { id: true },
  });
  await owner.rolePermission.createMany({
    data: permissions.map((p) => ({ tenantId, roleId: role.id, permissionId: p.id })),
  });
  return role.id;
}

const CUSTOMER_KEYS = PERMISSIONS.filter((p) => p.key.startsWith('CUSTOMER.')).map((p) => p.key);

/** One customer's whole file: an inquiry through to an invoice. */
async function seedFile(
  tenantId: bigint,
  tag: string,
  refs: {
    pol: bigint;
    pod: bigint;
    carrier: bigint;
    currency: bigint;
    source: bigint;
    sector: bigint;
    desk: bigint;
  },
): Promise<void> {
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: `CP-${tag}`,
      name: `Customer ${tag}`,
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: refs.sector,
    },
    select: { id: true },
  });
  ids[`customer${tag}`] = customer.id;

  // An inquiry in a forwarder-only state, with the forwarder's own notes on it.
  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: `INQ-${tag}`,
      seriesYear: 2026,
      inquiryDate: new Date('2026-11-02'),
      sourceId: refs.source,
      customerId: customer.id,
      shipmentType: 'SEA',
      movementType: 'OUTBOUND',
      loadingType: 'FCL',
      polId: refs.pol,
      podId: refs.pod,
      status: 'RFQ_SENT',
      remarks: SENTINEL_REMARK,
      targetPrice: SENTINEL_TARGET,
    },
    select: { id: true },
  });

  const quotation = (code: string, sent: boolean) =>
    owner.quotation.create({
      data: {
        tenantId,
        code,
        seriesYear: 2026,
        inquiryId: inquiry.id,
        customerId: customer.id,
        quotationDate: new Date('2026-11-03'),
        shipmentType: 'SEA',
        movementType: 'OUTBOUND',
        polId: refs.pol,
        podId: refs.pod,
        carrierId: refs.carrier,
        localCurrencyId: refs.currency,
        conversionRate: '122.0000',
        status: sent ? 'SENT' : 'DRAFT',
        sentAt: sent ? new Date('2026-11-03T06:00:00Z') : null,
      },
      select: { id: true },
    });
  const sentQuote = await quotation(`QTN-${tag}`, true);
  ids[`quotation${tag}`] = sentQuote.id;
  ids[`draftQuotation${tag}`] = (await quotation(`QTN-${tag}-D`, false)).id;

  // A booking whose sailing waits on the customer: two POs, one rejected.
  const shipment = await owner.shipment.create({
    data: {
      tenantId,
      code: `BKG-${tag}`,
      seriesYear: 2026,
      quotationId: sentQuote.id,
      shipmentType: 'SEA',
      customerId: customer.id,
      carrierId: refs.carrier,
      polId: refs.pol,
      podId: refs.pod,
      status: 'VESSEL_PROPOSED',
    },
    select: { id: true },
  });
  ids[`shipment${tag}`] = shipment.id;
  const po = await owner.shipmentPo.create({
    data: { tenantId, shipmentId: shipment.id, poNo: `PO-${tag}-1` },
    select: { id: true },
  });
  await owner.shipmentPo.create({
    data: {
      tenantId,
      shipmentId: shipment.id,
      poNo: `PO-${tag}-2`,
      approvalStatus: 'REJECTED',
      approvedBy: refs.desk,
      approvedAt: new Date('2026-11-21T06:00:00Z'),
      approvedOnBehalf: true,
      rejectionComments: 'Too late',
    },
  });
  const schedule = await owner.shipmentSchedule.create({
    data: {
      tenantId,
      code: `SCH-${tag}`,
      shipmentId: shipment.id,
      carrierId: refs.carrier,
      transitType: 'DIRECT',
      status: 'PROPOSED',
      cutOffDate: new Date('2026-11-20T06:00:00Z'),
    },
    select: { id: true },
  });
  await owner.shipmentScheduleLeg.create({
    data: {
      tenantId,
      scheduleId: schedule.id,
      legNo: 1,
      voyageNo: `V-${tag}`,
      originPortId: refs.pol,
      destinationPortId: refs.pod,
      etd: new Date('2026-11-22T00:00:00Z'),
      eta: new Date('2026-12-10T00:00:00Z'),
    },
  });

  // A cargo line, so a confirmed receipt has something to count.
  const cargoLine = await owner.shipmentCargoLine.create({
    data: { tenantId, shipmentId: shipment.id, shipmentPoId: po.id, itemCode: 'ITEM', ctnQty: 40 },
    select: { id: true },
  });
  const otherLine = await owner.shipmentCargoLine.create({
    data: { tenantId, shipmentId: shipment.id, shipmentPoId: po.id, itemCode: 'ITEM-2', ctnQty: 2 },
    select: { id: true },
  });

  const so = await owner.shippingOrder.create({
    data: {
      tenantId,
      code: `SO-${tag}`,
      seriesYear: 2026,
      shipmentId: shipment.id,
      issueDate: new Date('2026-11-15'),
      issuedBy: refs.desk,
      firstVesselName: `Vessel ${tag}`,
      status: 'ISSUED',
    },
    select: { id: true },
  });
  ids[`so${tag}`] = so.id;

  const confirmed = await owner.cargoReceipt.create({
    data: {
      tenantId,
      code: `CR-${tag}`,
      seriesYear: 2026,
      shipmentId: shipment.id,
      shippingOrderId: so.id,
      receiveDate: new Date('2026-11-18'),
      receiptSeq: 1,
      status: 'CONFIRMED',
      receivedBy: refs.desk,
      confirmedAt: new Date('2026-11-18T06:00:00Z'),
    },
    select: { id: true },
  });
  await owner.cargoReceiptLine.create({
    data: {
      tenantId,
      cargoReceiptId: confirmed.id,
      shipmentCargoLineId: cargoLine.id,
      receivedCtnQty: 38,
      receivedGrossWeightKg: '500.000',
    },
  });
  await owner.cargoReceiptLine.create({
    data: {
      tenantId,
      cargoReceiptId: confirmed.id,
      shipmentCargoLineId: otherLine.id,
      receivedCtnQty: 2,
      lineStatus: 'DECLINED',
      declineReason: SENTINEL_REMARK,
    },
  });
  await owner.cargoReceipt.create({
    data: {
      tenantId,
      code: `CR-${tag}-D`,
      seriesYear: 2026,
      shipmentId: shipment.id,
      receiveDate: new Date('2026-11-19'),
      receiptSeq: 2,
      status: 'DRAFT',
    },
  });

  // The advise numbers the bill. Bookings join an advise only while it is a
  // draft (CR-005's trigger), so it is sent afterwards.
  const advise = await owner.shipmentAdvise.create({
    data: {
      tenantId,
      code: `ADV-${tag}`,
      seriesYear: 2026,
      shipmentId: shipment.id,
      carrierId: refs.carrier,
      transitType: 'DIRECT',
      polId: refs.pol,
      podId: refs.pod,
      houseBlNo: `HBL-${tag}`,
      status: 'DRAFT',
    },
    select: { id: true },
  });
  await owner.shipmentAdviseBooking.create({
    data: { tenantId, adviseId: advise.id, shipmentId: shipment.id },
  });
  await owner.shipmentAdvise.update({
    where: { id: advise.id },
    data: { status: 'SENT', sentAt: new Date('2026-11-24T06:00:00Z'), sentBy: refs.desk },
  });
  ids[`advise${tag}`] = advise.id;

  // Alpha's bill is approved and issued; Bravo's is not started.
  if (tag === 'A') {
    await owner.blDraft.create({
      data: {
        tenantId,
        code: `BLD-${tag}`,
        seriesYear: 2026,
        shipmentId: shipment.id,
        adviseId: advise.id,
        blNo: `HBL-${tag}`,
        shipperText: 'Shipper',
        consigneeText: 'Consignee',
        notifyText: 'Notify',
        polId: refs.pol,
        podId: refs.pod,
        originalBlCount: 3,
        status: 'APPROVED',
        approvedAt: new Date('2026-11-24T08:00:00Z'),
        approvedBy: refs.desk,
        issuedAt: new Date('2026-11-25T08:00:00Z'),
        issuedBy: refs.desk,
      },
    });
  }

  const invoice = (code: string, issued: boolean) =>
    owner.debitInvoice.create({
      data: {
        tenantId,
        code,
        seriesYear: 2026,
        // One freight invoice per booking: the draft is an OTHER one.
        kind: issued ? 'FREIGHT' : 'OTHER',
        shipmentId: issued ? shipment.id : null,
        quotationId: issued ? sentQuote.id : null,
        customerId: customer.id,
        invoiceDate: new Date('2026-11-25'),
        currencyId: refs.currency,
        currencyCode: 'USD',
        conversionRate: '122.0000',
        totalAmount: '1500.0000',
        costTotalBase: SENTINEL_COST,
        status: issued ? 'ISSUED' : 'DRAFT',
        issuedAt: issued ? new Date('2026-11-25T06:00:00Z') : null,
        issuedBy: issued ? refs.desk : null,
      },
      select: { id: true },
    });
  ids[`invoice${tag}`] = (await invoice(`DN-${tag}`, true)).id;
  ids[`draftInvoice${tag}`] = (await invoice(`DN-${tag}-D`, false)).id;
}

async function seedWorkspace(tenantId: bigint, tags: string[]): Promise<void> {
  const sector = await owner.industrySector.create({
    data: { tenantId, code: `CP-SEC-${tenantId}`, name: 'Sector' },
    select: { id: true },
  });
  const carrierType = await owner.carrierType.create({
    data: { tenantId, code: `CP-CTY-${tenantId}`, name: 'CP type' },
    select: { id: true },
  });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: `CP-CAR-${tenantId}`, name: 'CP Lines', typeId: carrierType.id },
    select: { id: true },
  });
  const port = async (code: string) =>
    (
      await owner.port.create({
        data: {
          tenantId,
          code: `${code}${tenantId}`,
          name: `${code} Port`,
          portCode: `${code}${tenantId}`,
          country: 'Bangladesh',
          type: 'SEAPORT',
        },
        select: { id: true },
      })
    ).id;
  const refs = {
    pol: await port('CPPOL'),
    pod: await port('CPPOD'),
    carrier: carrier.id,
    currency: (await owner.currency.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } })).id,
    source: (await owner.inquirySource.findFirstOrThrow({ select: { id: true } })).id,
    sector: sector.id,
    // The C/S desk that recorded a decision on the customer's behalf.
    desk: (
      await owner.user.create({
        data: {
          tenantId,
          code: `USR-desk-${tenantId}`,
          username: `cp-desk-${tenantId}`,
          email: `desk-${tenantId}@cportal.test`,
          passwordHash: 'x',
          isActive: true,
        },
        select: { id: true },
      })
    ).id,
  };
  for (const tag of tags) await seedFile(tenantId, tag, refs);
}

async function makeUser(
  tenantId: bigint,
  username: string,
  customerId: bigint | null,
  roleId: bigint,
): Promise<void> {
  await owner.user.create({
    data: {
      tenantId,
      code: `USR-${username}`,
      username,
      email: `${username}@cportal.test`,
      passwordHash: await hashPassword(PASSWORD),
      customerId,
      roleId,
      isActive: true,
    },
  });
}

beforeAll(async () => {
  await cleanup();
  tenantA = (
    await owner.tenant.create({
      data: { name: 'CPortal Alpha', slug: SLUG_A, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;
  tenantB = (
    await owner.tenant.create({
      data: { name: 'CPortal Beta', slug: SLUG_B, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  await seedWorkspace(tenantA, ['A', 'B']);
  await seedWorkspace(tenantB, ['F']);

  // Alpha holds every customer permission. Bravo holds all but the invoices,
  // the forwarder keeping a clerk off the money.
  const full = await roleWith(tenantA, 'CP-FULL', CUSTOMER_KEYS);
  const noMoney = await roleWith(
    tenantA,
    'CP-NOINV',
    CUSTOMER_KEYS.filter((k) => !k.startsWith('CUSTOMER.INVOICE.')),
  );
  const foreignFull = await roleWith(tenantB, 'CP-FULL', CUSTOMER_KEYS);
  // A staff user holding the customer permissions by mistake.
  const staffRole = await roleWith(tenantA, 'CP-STAFF', PERMISSIONS.map((p) => p.key));

  await makeUser(tenantA, 'cp-alpha', ids['customerA']!, full);
  await makeUser(tenantA, 'cp-bravo', ids['customerB']!, noMoney);
  await makeUser(tenantB, 'cp-foreign', ids['customerF']!, foreignFull);
  await makeUser(tenantA, 'cp-staff', null, staffRole);

  alphaToken = await signIn('cp-alpha', SLUG_A);
  bravoToken = await signIn('cp-bravo', SLUG_A);
  foreignToken = await signIn('cp-foreign', SLUG_B);
  staffToken = await signIn('cp-staff', SLUG_A);
}, 120_000);

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

const LISTS = [
  { path: 'inquiries', code: 'INQ' },
  { path: 'quotations', code: 'QTN' },
  { path: 'shipments', code: 'BKG' },
  { path: 'approvals', code: 'BKG' },
  { path: 'shipping-orders', code: 'SO' },
  { path: 'cargo-receipts', code: 'CR' },
  { path: 'advises', code: 'ADV' },
  { path: 'invoices', code: 'DN' },
] as const;

const codesOf = (body: { data: { code: string }[] }): string[] => body.data.map((r) => r.code);

describe('each tab lists the signed-in customer’s own records', () => {
  it.each(LISTS)('$path: Alpha sees Alpha’s and no one else’s', async ({ path, code }) => {
    const res = await get(`/api/tenant/portal/${path}`, alphaToken).expect(200);
    expect(codesOf(res.body)).toEqual([`${code}-A`]);
  });

  it.each(LISTS.filter((l) => l.path !== 'invoices'))(
    '$path: Bravo sees Bravo’s and no one else’s',
    async ({ path, code }) => {
      const res = await get(`/api/tenant/portal/${path}`, bravoToken).expect(200);
      expect(codesOf(res.body)).toEqual([`${code}-B`]);
    },
  );

  it.each(LISTS)('$path: a customer of another workspace sees only their own', async ({ path, code }) => {
    const res = await get(`/api/tenant/portal/${path}`, foreignToken, SLUG_B).expect(200);
    expect(codesOf(res.body)).toEqual([`${code}-F`]);
  });

  it('bills: one per sent advise, the customer’s own', async () => {
    const res = await get('/api/tenant/portal/bills', alphaToken).expect(200);
    expect(res.body.data.map((r: { blNo: string }) => r.blNo)).toEqual(['HBL-A']);
    expect(res.body.data[0].shipmentId).toBe(ids['shipmentA']!.toString());
    expect(res.body.data[0].draftStatus).toBe('APPROVED');
    expect(res.body.data[0].issuedAt).not.toBeNull();

    const bravo = await get('/api/tenant/portal/bills', bravoToken).expect(200);
    expect(bravo.body.data.map((r: { blNo: string }) => r.blNo)).toEqual(['HBL-B']);
    expect(bravo.body.data[0].draftStatus).toBeNull();
  });
});

describe('a customer is shown only what the forwarder has issued', () => {
  it('never lists a draft quotation, a draft receipt or a draft invoice', async () => {
    // Asserted by the exact lists above too; named here because it is a rule.
    const quotes = await get('/api/tenant/portal/quotations', alphaToken).expect(200);
    expect(codesOf(quotes.body)).not.toContain('QTN-A-D');
    const receipts = await get('/api/tenant/portal/cargo-receipts', alphaToken).expect(200);
    expect(codesOf(receipts.body)).not.toContain('CR-A-D');
    const invoices = await get('/api/tenant/portal/invoices', alphaToken).expect(200);
    expect(codesOf(invoices.body)).not.toContain('DN-A-D');
  });

  it('reads the forwarder’s working states as one: in progress', async () => {
    const res = await get('/api/tenant/portal/inquiries', alphaToken).expect(200);
    expect(res.body.data[0].status).toBe('IN_PROGRESS');
  });

  it('counts the accepted cartons of a confirmed receipt, not the declined ones', async () => {
    const res = await get('/api/tenant/portal/cargo-receipts', alphaToken).expect(200);
    expect(res.body.data[0].ctnQty).toBe(38);
    expect(Number(res.body.data[0].grossWeightKg)).toBe(500);
  });

  it('summarises the POs on a proposed sailing', async () => {
    const res = await get('/api/tenant/portal/approvals', alphaToken).expect(200);
    expect(res.body.data[0]).toMatchObject({
      poCount: 2,
      approvedCount: 0,
      rejectedCount: 1,
      voyageOrFlight: 'V-A',
    });
  });
});

describe('the column boundary', () => {
  it('never carries the forwarder’s notes, target price or cost', async () => {
    for (const { path } of LISTS) {
      const res = await get(`/api/tenant/portal/${path}`, alphaToken).expect(200);
      const wire = JSON.stringify(res.body);
      expect(wire, path).not.toContain(SENTINEL_REMARK);
      expect(wire, path).not.toContain('919191');
      expect(wire, path).not.toContain('424242');
      expect(wire, path).not.toMatch(/cost|salesman|createdBy|conversionRate|remarks/i);
    }
  });
});

describe('printing', () => {
  it('prints their own issued documents', async () => {
    for (const path of [
      `quotations/${ids['quotationA']}`,
      `shipping-orders/${ids['soA']}`,
      `advises/${ids['adviseA']}`,
      `invoices/${ids['invoiceA']}`,
      `bills/${ids['adviseA']}`,
    ]) {
      const res = await get(`/api/tenant/portal/${path}/pdf`, alphaToken);
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type'], path).toContain('application/pdf');
    }
  });

  it('refuses another customer’s document as not found', async () => {
    for (const path of [
      `quotations/${ids['quotationB']}`,
      `shipping-orders/${ids['soB']}`,
      `advises/${ids['adviseB']}`,
      `invoices/${ids['invoiceB']}`,
      `bills/${ids['adviseB']}`,
    ]) {
      expect((await get(`/api/tenant/portal/${path}/pdf`, alphaToken)).status, path).toBe(404);
    }
  });

  it('refuses another workspace’s document as not found', async () => {
    for (const path of [`quotations/${ids['quotationF']}`, `invoices/${ids['invoiceF']}`]) {
      expect((await get(`/api/tenant/portal/${path}/pdf`, alphaToken)).status, path).toBe(404);
    }
  });

  it('refuses a draft, even their own', async () => {
    for (const path of [
      `quotations/${ids['draftQuotationA']}`,
      `invoices/${ids['draftInvoiceA']}`,
    ]) {
      expect((await get(`/api/tenant/portal/${path}/pdf`, alphaToken)).status, path).toBe(404);
    }
  });

  it('prints the bill as a non-negotiable copy, never the originals', async () => {
    const res = await get(`/api/tenant/portal/bills/${ids['adviseA']}/pdf`, alphaToken).expect(200);
    expect(res.headers['content-disposition']).toContain('-copy.pdf');
    // There is no way to ask for anything else: the parameter staff use is ignored.
    const asked = await get(
      `/api/tenant/portal/bills/${ids['adviseA']}/pdf?kind=ORIGINAL`,
      alphaToken,
    ).expect(200);
    expect(asked.headers['content-disposition']).toContain('-copy.pdf');
  });

  it('has no bill copy to print before the bill is issued', async () => {
    expect((await get(`/api/tenant/portal/bills/${ids['adviseB']}/pdf`, bravoToken)).status).toBe(404);
  });
});

describe('permissions', () => {
  it('hides a tab the customer was not given', async () => {
    expect((await get('/api/tenant/portal/invoices', bravoToken)).status).toBe(403);
    expect(
      (await get(`/api/tenant/portal/invoices/${ids['invoiceB']}/pdf`, bravoToken)).status,
    ).toBe(403);
  });

  it('refuses staff, even holding every customer permission', async () => {
    for (const { path } of LISTS) {
      expect((await get(`/api/tenant/portal/${path}`, staffToken)).status, path).toBe(403);
    }
  });
});
