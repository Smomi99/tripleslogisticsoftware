import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { DEFAULT_QUOTATION_NOTES, quotationNotes } from '@ff/shared';

import { signAccessToken } from '../lib/jwt';

/**
 * §6.5 and §6.7 — the quotation.
 *
 * The arithmetic is checked against the client's own sample sheet, because it
 * is the one thing on this screen a customer will hold us to: 2 x 5252 =
 * 10,504, and 10,504 x 129 = 1,355,016. Those numbers are theirs, not mine.
 *
 * The other property worth this much care is the revision rule. Editing a sent
 * quotation must not edit it — a customer holding revision 1 has to still be
 * able to find what they were sent.
 */

vi.mock('../lib/mailer', () => ({
  sendMail: () => Promise.resolve({ sent: true }),
  parseAddressList: () => [],
}));

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'qtn-alpha';

let tenantId: bigint;
let token: string;
/** Holds every quotation permission except EXPORT_PDF (§7). */
let tokenNoPdf: string;
let inquiryId: bigint;
let carrierId: bigint;
let currencyId: bigint;
let freightHeadId: bigint;
let sealHeadId: bigint;
let size20: bigint;
let size40: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of [
    'notification_setting',
    'quotation_followup',
    'quotation_recipient',
    'quotation_commodity',
    'quotation_line',
    'quotation',
    'inquiry_volume',
    'inquiry_commodity',
    'inquiry_party',
    'inquiry',
    'rate_local_charge',
    'freight_rate_line',
    'freight_rate',
    'audit_log',
    'role_permission',
    'user_permission',
    '"user"',
    'role',
    'agent',
    'cost_head',
    'currency',
    'customer',
    'industry_sector',
    'inquiry_source',
    'goods_type',
    'carrier',
    'port',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
}

const as = (path: string) =>
  request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG);

const post = (path: string, body: object) =>
  request(app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Slug', SLUG)
    .send(body);

const patch = (path: string, body: object) =>
  request(app)
    .patch(path)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Slug', SLUG)
    .send(body);

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'QTN Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const user = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-q',
      username: 'admin-q',
      email: 'a@qtn.test',
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  const limited = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-qtn-nopdf',
      username: 'nopdf-qtn',
      email: 'nopdf@qtn.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenNoPdf = await signAccessToken({
    sub: limited.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: [
      'CUSTOMER_SERVICE.QUOTATION.VIEW',
      'CUSTOMER_SERVICE.QUOTATION.CREATE',
      'CUSTOMER_SERVICE.QUOTATION.EDIT',
      'SETTING.NOTIFICATION.VIEW',
    ],
    tokenVersion: 0,
  });

  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  carrierId = (
    await owner.carrier.create({
      data: { tenantId, code: 'CAR-Q', name: 'Q Lines', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;

  const port = (code: string, name: string) =>
    owner.port.create({
      data: { tenantId, code, name, portCode: code, country: 'Bangladesh', type: 'SEAPORT' },
      select: { id: true },
    });
  const pol = await port('QPOL', 'Chittagong');
  const pod = await port('QPOD', 'Hamburg');

  const goodsType = await owner.goodsType.create({
    data: { tenantId, code: 'QGD', name: 'Textile' },
    select: { id: true },
  });
  const source = await owner.inquirySource.create({
    data: { tenantId, code: 'QSRC', name: 'Direct' },
    select: { id: true },
  });
  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'QIS', name: 'Garments' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'QCUS',
      name: 'Dhaka Apparels',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });

  /*
   * §5.4's booking rate: the client's sample bills at 129.
   *
   * A currency of this workspace's own, not the shared USD row. A system
   * currency (tenant_id NULL) belongs to every tenant at once, so a test that
   * moved its conversion rate would move the number under all of them —
   * including the one somebody is using.
   */
  currencyId = (
    await owner.currency.create({
      data: { tenantId, code: 'QCUR', currency: 'QTD — Quote Test Dollar', conversion: '129.0000' },
      select: { id: true },
    })
  ).id;

  const unit = await owner.costUnit.findFirstOrThrow({ select: { id: true } });
  freightHeadId = (
    await owner.costHead.create({
      data: { tenantId, code: 'QCH1', name: 'Ocean Freight', category: 'SERVICE', unitId: unit.id },
      select: { id: true },
    })
  ).id;
  sealHeadId = (
    await owner.costHead.create({
      data: { tenantId, code: 'QCH2', name: 'Seal Charge', category: 'SERVICE', unitId: unit.id },
      select: { id: true },
    })
  ).id;

  /*
   * The container_size master calls them "20' Standard"; the rate tiers that
   * price them are labelled 20STD, the way the client's sheet writes it. Two
   * names for one box, and the quotation snapshots the master's, because that
   * is what this workspace calls the equipment.
   */
  const sizes = await owner.containerSize.findMany({
    where: { name: { in: ["20' Standard", "40' Standard"] } },
    select: { id: true, name: true },
  });
  size20 = sizes.find((s) => s.name === "20' Standard")!.id;
  size40 = sizes.find((s) => s.name === "40' Standard")!.id;

  // The lane, priced. sell_price is GENERATED from buy + profit, so the buy
  // price is set to land on the client's own figures.
  const rate = await owner.freightRate.create({
    data: {
      tenantId,
      code: 'QRATE-1',
      mode: 'SEA_FCL',
      polId: pol.id,
      podId: pod.id,
      carrierId,
      goodsTypeId: goodsType.id,
      currencyId,
      validFrom: new Date(Date.now() - 86_400_000),
      validTo: new Date(Date.now() + 30 * 86_400_000),
      status: 'PUBLISHED',
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: carrierId,
    },
    select: { id: true },
  });

  const tiers = await owner.rateTier.findMany({
    where: { mode: 'SEA_FCL', containerSizeId: { in: [size20, size40] } },
    select: { id: true, containerSizeId: true },
  });
  for (const tier of tiers) {
    await owner.freightRateLine.create({
      data: {
        tenantId,
        rateId: rate.id,
        tierId: tier.id,
        buyPrice: tier.containerSizeId === size20 ? '2828.0000' : '5252.0000',
        profitType: 'FLAT',
        profitValue: '0',
      },
    });
  }
  // A charge that bills per box, and one that bills per document.
  await owner.rateLocalCharge.create({
    data: {
      tenantId,
      rateId: rate.id,
      costHeadId: sealHeadId,
      side: 'POL',
      amount: '13.0000',
      currencyId,
      containerSizeId: size20,
    },
  });
  await owner.rateLocalCharge.create({
    data: {
      tenantId,
      rateId: rate.id,
      costHeadId: sealHeadId,
      side: 'POD',
      amount: '30.0000',
      currencyId,
    },
  });

  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: 'INQ-2026-000001',
      seriesYear: 2026,
      inquiryDate: new Date('2026-08-27'),
      sourceId: source.id,
      shipmentType: 'SEA',
      customerId: customer.id,
      movementType: 'OUTBOUND',
      loadingType: 'FCL',
      polId: pol.id,
      podId: pod.id,
      goodsTypeId: goodsType.id,
      status: 'OPEN',
    },
    select: { id: true },
  });
  inquiryId = inquiry.id;

  // One 20ft and two 40ft — the sample's quantities.
  await owner.inquiryVolume.create({
    data: {
      tenantId,
      inquiryId,
      volumeKind: 'FCL',
      containerSizeId: size20,
      quantity: 1,
    },
  });
  await owner.inquiryVolume.create({
    data: {
      tenantId,
      inquiryId,
      volumeKind: 'FCL',
      containerSizeId: size40,
      quantity: 2,
    },
  });
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

const create = () =>
  post('/api/tenant/cs/quotations', {
    inquiryId: inquiryId.toString(),
    carrierId: carrierId.toString(),
    localCurrencyId: currencyId.toString(),
    quotationDate: '2026-08-27',
    validityDate: '2026-09-30',
    freightCostHeadId: freightHeadId.toString(),
  });

describe('raising a quotation', () => {
  let quotationId: string;

  it('numbers it the way the client does', async () => {
    const res = await create().expect(201);
    quotationId = res.body.data.id as string;
    expect(res.body.data.code).toBe('QTN-2026-000001');
    expect(res.body.data.revisionNo).toBe(1);
    expect(res.body.data.status).toBe('DRAFT');
  });

  it('copies the inquiry header down', async () => {
    const res = await as(`/api/tenant/cs/quotations/${quotationId}`).expect(200);
    expect(res.body.data.inquiryCode).toBe('INQ-2026-000001');
    expect(res.body.data.customerName).toBe('Dhaka Apparels');
    expect(res.body.data.shipmentType).toBe('SEA');
    expect(res.body.data.loadingType).toBe('FCL');
  });

  it('freezes the booking rate rather than joining it', async () => {
    // §5.4 and §2.2: the rate the document bills at is the one it was issued
    // with, so moving the master afterwards must not move the quotation.
    const res = await as(`/api/tenant/cs/quotations/${quotationId}`).expect(200);
    expect(res.body.data.conversionRate).toBe('129');

    await owner.currency.update({ where: { id: currencyId }, data: { conversion: '150.0000' } });
    const after = await as(`/api/tenant/cs/quotations/${quotationId}`).expect(200);
    expect(after.body.data.conversionRate).toBe('129');
    await owner.currency.update({ where: { id: currencyId }, data: { conversion: '129.0000' } });
  });

  it('pulls the freight, one line per size the customer asked for', async () => {
    const res = await as(`/api/tenant/cs/quotations/${quotationId}`).expect(200);
    const freight = res.body.data.lines.filter(
      (l: { costHeadName: string }) => l.costHeadName === 'Ocean Freight',
    );
    expect(freight).toHaveLength(2);
    for (const line of freight) expect(line.source).toBe('AUTO');

    const twenty = freight.find(
      (l: { containerSizeName: string }) => l.containerSizeName === "20' Standard",
    );
    const forty = freight.find(
      (l: { containerSizeName: string }) => l.containerSizeName === "40' Standard",
    );
    expect(twenty.quantity).toBe('1');
    expect(twenty.sellingPrice).toBe('2828');
    expect(forty.quantity).toBe('2');
    expect(forty.sellingPrice).toBe('5252');
  });

  it('does the client arithmetic exactly', async () => {
    const res = await as(`/api/tenant/cs/quotations/${quotationId}`).expect(200);
    const forty = res.body.data.lines.find(
      (l: { costHeadName: string; containerSizeName: string }) =>
        l.costHeadName === 'Ocean Freight' && l.containerSizeName === "40' Standard",
    );
    // The sample: 2 x 5252 = 10504, and 10504 x 129 = 1,355,016.
    expect(forty.totalAmount).toBe('10504');
    expect(forty.billAmountLocal).toBe('1355016');
  });

  it('bills a sized charge per box and an unsized one per document', async () => {
    const res = await as(`/api/tenant/cs/quotations/${quotationId}`).expect(200);
    const seals = res.body.data.lines.filter(
      (l: { costHeadName: string }) => l.costHeadName === 'Seal Charge',
    );
    const perBox = seals.find(
      (l: { containerSizeName: string | null }) => l.containerSizeName === "20' Standard",
    );
    const perDoc = seals.find((l: { containerSizeName: string | null }) => l.containerSizeName === null);
    expect(perBox.quantity).toBe('1');
    // The client's ENS and HBL lines: "No size", quantity 1.
    expect(perDoc.quantity).toBe('1');
    expect(perDoc.sellingPrice).toBe('30');
  });

  it('totals in both currencies and writes the words', async () => {
    const res = await as(`/api/tenant/cs/quotations/${quotationId}`).expect(200);
    // 2828 + 10504 + 13 + 30 = 13,375.
    expect(res.body.data.totalAmountUsd).toBe('13375');
    expect(res.body.data.totalAmountLocal).toBe('1725375');
    expect(res.body.data.amountInWords).toContain('Thirteen thousand three hundred and seventy-five');
  });

  it('takes the customer addresses without being asked', async () => {
    // The client's own note on the wireframe.
    const res = await as(`/api/tenant/cs/quotations/${quotationId}`).expect(200);
    expect(Array.isArray(res.body.data.recipients)).toBe(true);
  });

  it('refuses a lane it cannot price without refusing the quotation', async () => {
    // §5.3 rule 5: an incomplete price table flags the line, never blocks the
    // document. A different carrier holds no rate on this lane at all.
    const other = await owner.carrier.create({
      data: {
        tenantId,
        code: 'CAR-Q2',
        name: 'No Rates Lines',
        typeId: (await owner.carrierType.findFirstOrThrow({ select: { id: true } })).id,
      },
      select: { id: true },
    });
    const res = await post('/api/tenant/cs/quotations', {
      inquiryId: inquiryId.toString(),
      carrierId: other.id.toString(),
      localCurrencyId: currencyId.toString(),
      quotationDate: '2026-08-27',
      freightCostHeadId: freightHeadId.toString(),
    }).expect(201);
    expect(res.body.data.lines).toHaveLength(0);
    expect(res.body.data.status).toBe('DRAFT');
  });
});

describe('the numbering', () => {
  it('runs a yearly series, per tenant', async () => {
    const res = await create().expect(201);
    // Two before this one in the same year.
    expect(res.body.data.code).toMatch(/^QTN-2026-0000\d\d$/);
    expect(res.body.data.code).not.toBe('QTN-2026-000001');
  });
});

describe('sending, and revising afterwards (§5.3 rule 8)', () => {
  let sentId: string;
  let sentCode: string;

  it('sends a draft and marks the inquiry quoted', async () => {
    const created = await create().expect(201);
    sentId = created.body.data.id as string;
    sentCode = created.body.data.code as string;

    const res = await post(`/api/tenant/cs/quotations/${sentId}/send`, {
      recipients: [{ email: 'buyer@customer.test', kind: 'TO' }],
    }).expect(200);
    expect(res.body.data.status).toBe('SENT');

    const inquiry = await owner.inquiry.findFirstOrThrow({
      where: { id: inquiryId },
      select: { status: true },
    });
    expect(inquiry.status).toBe('QUOTED');
  });

  it('will not send the same one twice', async () => {
    await post(`/api/tenant/cs/quotations/${sentId}/send`, {
      recipients: [{ email: 'buyer@customer.test', kind: 'TO' }],
    }).expect(409);
  });

  it('issues a revision rather than editing what the customer holds', async () => {
    const res = await patch(`/api/tenant/cs/quotations/${sentId}`, {
      validityDate: '2026-10-31',
    }).expect(200);

    expect(res.body.data.revisionNo).toBe(2);
    expect(res.body.data.code).toBe(sentCode);
    expect(res.body.data.id).not.toBe(sentId);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.validityDate).toBe('2026-10-31');
  });

  it('keeps revision 1 exactly as it was sent', async () => {
    const original = await as(`/api/tenant/cs/quotations/${sentId}`).expect(200);
    expect(original.body.data.status).toBe('SUPERSEDED');
    expect(original.body.data.revisionNo).toBe(1);
    // The date the customer was given, untouched by the revision.
    expect(original.body.data.validityDate).toBe('2026-09-30');
  });

  it('carries the lines onto the revision', async () => {
    const rows = await owner.quotation.findFirstOrThrow({
      where: { tenantId, code: sentCode, revisionNo: 2 },
      select: { lines: { where: { deletedAt: null }, select: { costHeadName: true } } },
    });
    // An edit that only touched the header must not issue an empty document.
    expect(rows.lines.length).toBeGreaterThan(0);
  });

  it('refuses to move the frozen rate on a sent quotation', async () => {
    // §5.4: editable before sending, never after. The revision inherits the
    // rate it was issued with rather than today's.
    const revision = await owner.quotation.findFirstOrThrow({
      where: { tenantId, code: sentCode, revisionNo: 2 },
      select: { conversionRate: true },
    });
    expect(revision.conversionRate.toString()).toBe('129');
  });
});

describe('the list (§6.7)', () => {
  it('renders the required container the way the client writes it', async () => {
    const res = await as('/api/tenant/cs/quotations?limit=50').expect(200);
    const row = res.body.data[0];
    expect(row.requiredContainer).toBe("20' Standard(1) + 40' Standard(2)");
  });

  it('carries the inquiry number beside the quotation number', async () => {
    const res = await as('/api/tenant/cs/quotations?limit=50').expect(200);
    for (const row of res.body.data) {
      expect(row.inquiryCode).toBe('INQ-2026-000001');
      expect(row.code).toMatch(/^QTN-2026-/);
    }
  });

  it('searches over both numbers and the customer', async () => {
    const byQuotation = await as('/api/tenant/cs/quotations?search=QTN-2026').expect(200);
    expect(byQuotation.body.data.length).toBeGreaterThan(0);
    const byCustomer = await as('/api/tenant/cs/quotations?search=Dhaka').expect(200);
    expect(byCustomer.body.data.length).toBeGreaterThan(0);
    const nothing = await as('/api/tenant/cs/quotations?search=zzzz').expect(200);
    expect(nothing.body.data).toHaveLength(0);
  });

  it('filters by status', async () => {
    const res = await as('/api/tenant/cs/quotations?status=SUPERSEDED').expect(200);
    for (const row of res.body.data) expect(row.status).toBe('SUPERSEDED');
  });
});

describe('the link back to the inquiry (§6.2)', () => {
  /*
   * Live Inquiry's Quotation column, and its Quote action, both read this.
   * Without it the two screens are strangers: an inquiry cannot say whether it
   * has been quoted, and Quote has nowhere to send you.
   */
  const inquiryRow = async () => {
    const res = await request(app)
      .get('/api/tenant/sales/inquiries?limit=50')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);
    return res.body.data.find((r: { id: string }) => r.id === inquiryId.toString());
  };

  it('names the live quotation on the inquiry', async () => {
    const row = await inquiryRow();
    expect(row.quotation).not.toBeNull();
    expect(row.quotation.code).toMatch(/^QTN-2026-/);
  });

  it('names the current revision, not the superseded one', async () => {
    // Revision 1 is still on the record and still reachable from the Quotation
    // List. It is not what this inquiry stands on any more.
    const row = await inquiryRow();
    const named = await owner.quotation.findFirstOrThrow({
      where: { id: BigInt(row.quotation.id as string) },
      select: { status: true },
    });
    expect(named.status).not.toBe('SUPERSEDED');
  });

  it('says nothing for an inquiry nobody has quoted', async () => {
    const bare = await owner.inquiry.create({
      data: {
        tenantId,
        code: 'INQ-2026-000099',
        seriesYear: 2026,
        inquiryDate: new Date('2026-08-27'),
        sourceId: (await owner.inquirySource.findFirstOrThrow({ where: { tenantId }, select: { id: true } })).id,
        shipmentType: 'SEA',
        customerId: (await owner.customer.findFirstOrThrow({ where: { tenantId }, select: { id: true } })).id,
        movementType: 'OUTBOUND',
        polId: (await owner.port.findFirstOrThrow({ where: { tenantId, code: 'QPOL' }, select: { id: true } })).id,
        podId: (await owner.port.findFirstOrThrow({ where: { tenantId, code: 'QPOD' }, select: { id: true } })).id,
        status: 'OPEN',
      },
      select: { id: true },
    });
    const res = await request(app)
      .get(`/api/tenant/sales/inquiries/${bare.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);
    expect(res.body.data.quotation).toBeNull();
  });
});

describe('what an agent may reach', () => {
  it('nothing at all', async () => {
    // A quotation names the customer and carries our margin. An agent reading
    // one would learn both in a single row — the thing §2.1 rule 2 exists to
    // prevent, enforced here by RLS rather than by a query somebody remembered.
    const agent = await owner.agent.create({
      data: { tenantId, code: 'QAGT', name: 'Some Agent', country: 'Germany', agentType: 'GENERAL' },
      select: { id: true },
    });
    const agentUser = await owner.user.create({
      data: {
        tenantId,
        code: 'USR-qa',
        username: 'agent-q',
        email: 'ag@qtn.test',
        passwordHash: 'x',
        agentId: agent.id,
      },
      select: { id: true, tokenVersion: true },
    });
    const agentToken = await signAccessToken({
      sub: agentUser.id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      // Generously: even holding the permission outright, they get nothing.
      permissions: ['CUSTOMER_SERVICE.QUOTATION.VIEW'],
      tokenVersion: agentUser.tokenVersion,
      // The middleware cross-checks this against the user row, so a token that
      // omits it is rejected before the staff guard is ever reached — and this
      // test is about the staff guard.
      agentId: agent.id.toString(),
    });

    await request(app)
      .get('/api/tenant/cs/quotations')
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(403);
  });
});

describe('the quotation PDF (§6.6)', () => {
  /** Fetches the document as raw bytes rather than letting supertest parse it. */
  function fetchPdf(id: string, bearer = token) {
    return request(app)
      .get(`/api/tenant/cs/quotations/${id}/pdf`)
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Tenant-Slug', SLUG)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  }

  it('prints — the phase gate', async () => {
    const created = await create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id, code } = (created.body as { data: { id: string; code: string } }).data;

    const res = await fetchPdf(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain(`${code}.pdf`);

    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // A page with a header, a field block, a line table and the notes on it.
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it('prints a draft too — reading it before it goes out is the point', async () => {
    const created = await create();
    expect((created.body as { data: { status: string } }).data.status).toBe('DRAFT');
    const res = await fetchPdf((created.body as { data: { id: string } }).data.id);
    expect(res.status).toBe(200);
  });

  it('refuses a user without EXPORT_PDF (§7)', async () => {
    const created = await create();
    const res = await fetchPdf((created.body as { data: { id: string } }).data.id, tokenNoPdf);
    expect(res.status).toBe(403);
  });

  it('survives a workspace with no logo uploaded', async () => {
    // §6.6 wants the logo from the tenant, and most workspaces have not
    // uploaded one. The name carries the letterhead on its own; a missing file
    // is never a reason to withhold the quotation.
    const tenant = await owner.tenant.findFirstOrThrow({
      where: { id: tenantId },
      select: { logoFile: true },
    });
    expect(tenant.logoFile).toBeNull();

    const created = await create();
    const res = await fetchPdf((created.body as { data: { id: string } }).data.id);
    expect(res.status).toBe(200);
  });

  it('survives a logo the storage cannot produce', async () => {
    // A key pointing at nothing is the state a restored backup leaves behind.
    await owner.tenant.update({
      where: { id: tenantId },
      data: { logoFile: `${tenantId}/missing-logo.png` },
    });
    const created = await create();
    const res = await fetchPdf((created.body as { data: { id: string } }).data.id);
    expect(res.status).toBe(200);
    await owner.tenant.update({ where: { id: tenantId }, data: { logoFile: null } });
  });
});

describe('the quotation notes (§6.6)', () => {
  const readSettings = () => as('/api/tenant/setting/notifications');
  const writeSettings = (quotationNotesText: string) =>
    request(app)
      .put('/api/tenant/setting/notifications')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .send({
        priceTeamEmails: '',
        signatureBlock: '',
        bccAddresses: '',
        quotationNotes: quotationNotesText,
      });

  it('starts as the product default, editable from settings', async () => {
    const res = await readSettings();
    expect(res.status).toBe(200);
    const notes = (res.body as { data: { quotationNotes: string } }).data.quotationNotes;

    // §6.6's three, as the wording a workspace is offered to edit from.
    expect(notes).toBe(DEFAULT_QUOTATION_NOTES);
    expect(quotationNotes(notes)).toHaveLength(3);
    expect(notes).toMatch(/This is a quotation only/);
  });

  it('keeps what the workspace types instead', async () => {
    const saved = await writeSettings('Ours only.\nAnd a second.');
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const read = await readSettings();
    const stored = (read.body as { data: { quotationNotes: string } }).data.quotationNotes;
    expect(quotationNotes(stored)).toEqual(['Ours only.', 'And a second.']);
  });

  it('prints none when a workspace clears them deliberately', async () => {
    /*
     * A cleared field is a decision, not an omission. Null means "never touched,
     * offer the product wording"; an empty string means "we want none" — and
     * `|| null` on the way in would have collapsed the two and made the second
     * impossible to say, while the settings screen promises it.
     */
    const saved = await writeSettings('');
    expect(saved.status).toBe(200);

    const row = await owner.notificationSetting.findFirstOrThrow({
      where: { tenantId },
      select: { quotationNotes: true },
    });
    expect(row.quotationNotes).toBe('');
    expect(quotationNotes(row.quotationNotes)).toEqual([]);

    // ...while a workspace that has never saved still gets the default.
    expect(quotationNotes(null)).toHaveLength(3);
  });

  it('still prints with no notes at all', async () => {
    await writeSettings('');
    const created = await create();
    const res = await request(app)
      .get(`/api/tenant/cs/quotations/${(created.body as { data: { id: string } }).data.id}/pdf`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
