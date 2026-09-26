import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Accounts, end to end through HTTP — docs/MODULE_ACCOUNTS.md §10.
 *
 * Two workspaces are built from nothing, so every assertion about one is also a
 * check that the other sees none of it (CLAUDE.md §7A rule 4). The money is
 * followed the whole way round the loop the client drew:
 *
 *   booking -> Awaiting Freight Inv -> Make invoice -> Save & Send
 *     -> Receive -> Receivable-Payable list -> the party's ledger
 *
 * and every figure is checked against arithmetic done here from the rates the
 * workspace actually holds, not against numbers copied out of the code.
 */

// The outbox is mocked: a real queued letter would be picked up by a running
// dev server's worker and sent while this file cleans it away underneath it.
const queueMailSpy = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ queued: true })));
vi.mock('../lib/email-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email-queue')>();
  return { ...actual, queueMail: queueMailSpy };
});

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient, Prisma } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'acct-alpha';
const SLUG_B = 'acct-beta';
const YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);

interface World {
  tenantId: bigint;
  superUserId: bigint;
  superToken: string;
  /** Staff who may see invoices but not what the suppliers charged (§3.9). */
  noBuyToken: string;
  /** Staff with no Accounts permission at all. */
  bareToken: string;
  customerId: bigint;
  carrierId: bigint;
  agentId: bigint;
  vendorId: bigint;
  freightHead: bigint;
  blHead: bigint;
  /** BL_DRAFTED — ready to invoice. */
  shipmentId: bigint;
  shipmentCode: string;
  /** BOOKING_RECEIVED — not confirmed, never on the awaiting list. */
  earlyShipmentId: bigint;
}

let A: World;
let B: World;
let usd: bigint;
let bdt: bigint;
let usdRate: InstanceType<typeof Prisma.Decimal>;
let size20: bigint;
let containerUnit: bigint;

function as(token: string, slug: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  return {
    get: (p: string) => wrap(request(app).get(`/api/tenant/accounts${p}`)),
    post: (p: string) => wrap(request(app).post(`/api/tenant/accounts${p}`)),
    patch: (p: string) => wrap(request(app).patch(`/api/tenant/accounts${p}`)),
    put: (p: string) => wrap(request(app).put(`/api/tenant/accounts${p}`)),
  };
}

const D = (v: string | number) => new Prisma.Decimal(v);
const fixed4 = (v: InstanceType<typeof Prisma.Decimal>) => v.toDecimalPlaces(4).toFixed(4);

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'debit_invoice_receipt',
    'debit_invoice_cost_line',
    'debit_invoice_cost',
    'debit_invoice_line',
    'debit_invoice',
    'clp_booking',
    'clp',
    'shipment',
    'quotation_line',
    'quotation',
    'inquiry',
    'customer_pic',
    'customer',
    'agent',
    'vendor',
    'cost_head',
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
  const tenant = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh', currencyId: bdt },
    select: { id: true },
  });
  const tenantId = tenant.id;

  const user = async (code: string, isSuperadmin: boolean) =>
    (
      await owner.user.create({
        data: {
          tenantId,
          code,
          username: `${code.toLowerCase()}-${slug}`,
          email: `${code.toLowerCase()}@${slug}.test`,
          passwordHash: 'x',
          isSuperadmin,
        },
        select: { id: true },
      })
    ).id;
  const token = (id: bigint, isSuperadmin: boolean, permissions: string[]) =>
    signAccessToken({
      sub: id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin,
      permissions,
      tokenVersion: 0,
    });

  const superId = await user(`USR-S${tag}`, true);
  const noBuyId = await user(`USR-N${tag}`, false);
  const bareId = await user(`USR-B${tag}`, false);

  const sector = await owner.industrySector.create({
    data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: `CUS-${tag}`,
      name: `Shafidi Exports ${tag}`,
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sector.id,
      // §3.6: the CRM opening balance is where this ledger starts.
      openingBalance: '500',
      openingCurrencyId: usd,
    },
    select: { id: true },
  });
  await owner.customerPic.create({
    data: {
      tenantId,
      code: `CPC-${tag}`,
      customerId: customer.id,
      name: 'Accounts desk',
      email: `accounts@shafidi-${tag.toLowerCase()}.test`,
    },
  });

  const port = async (code: string, name: string) =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${code}`, name, portCode: `Z${tag}${code}`, country: 'Bangladesh', type: 'SEAPORT' },
        select: { id: true },
      })
    ).id;
  const pol = await port('1', `Chittagong ${tag}`);
  const pod = await port('2', `Hamburg ${tag}`);

  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: `CAR-${tag}`, name: `Ocean Line ${tag}`, typeId: carrierType.id },
    select: { id: true },
  });
  const agent = await owner.agent.create({
    data: { tenantId, code: `AGT-${tag}`, name: `DK International ${tag}`, country: 'Germany', agentType: 'GENERAL' },
    select: { id: true },
  });
  const vendorType = await owner.vendorType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const vendor = await owner.vendor.create({
    data: { tenantId, code: `VND-${tag}`, name: `Trust Cargo ${tag}`, country: 'Bangladesh', vendorTypeId: vendorType.id },
    select: { id: true },
  });

  const head = async (code: string, headName: string) =>
    (
      await owner.costHead.create({
        data: { tenantId, code: `CH-${tag}${code}`, category: 'SERVICE', name: headName, unitId: containerUnit },
        select: { id: true },
      })
    ).id;
  const freightHead = await head('1', 'Ocean Freight');
  const blHead = await head('2', 'B/L Fee');

  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: `INQ-${YEAR}-9${tag}0001`,
      seriesYear: YEAR,
      inquiryDate: new Date(`${TODAY}T00:00:00Z`),
      sourceId: source.id,
      shipmentType: 'SEA',
      customerId: customer.id,
      movementType: 'OUTBOUND',
      polId: pol,
      podId: pod,
    },
    select: { id: true },
  });
  const quotation = await owner.quotation.create({
    data: {
      tenantId,
      code: `QTN-${YEAR}-9${tag}0001`,
      seriesYear: YEAR,
      inquiryId: inquiry.id,
      quotationDate: new Date(`${TODAY}T00:00:00Z`),
      customerId: customer.id,
      shipmentType: 'SEA',
      movementType: 'OUTBOUND',
      polId: pol,
      podId: pod,
      carrierId: carrier.id,
      localCurrencyId: bdt,
      conversionRate: usdRate,
      status: 'ACCEPTED',
    },
    select: { id: true },
  });
  // The client's own sample shape: freight per box, a document fee per BL.
  await owner.quotationLine.createMany({
    data: [
      {
        tenantId,
        quotationId: quotation.id,
        sortOrder: 0,
        costHeadId: freightHead,
        costHeadName: 'Ocean Freight',
        containerSizeId: size20,
        containerSizeName: '20STD',
        costUnitId: containerUnit,
        unitName: 'Container',
        quantity: '2',
        sellingPrice: '1500',
        currencyId: usd,
        currencyCode: 'USD',
        conversionRate: usdRate,
      },
      {
        tenantId,
        quotationId: quotation.id,
        sortOrder: 1,
        costHeadId: blHead,
        costHeadName: 'B/L Fee',
        quantity: '1',
        sellingPrice: '50',
        currencyId: usd,
        currencyCode: 'USD',
        conversionRate: usdRate,
      },
    ],
  });

  const shipment = async (code: string, status: 'BL_DRAFTED' | 'BOOKING_RECEIVED') =>
    owner.shipment.create({
      data: {
        tenantId,
        code,
        seriesYear: YEAR,
        quotationId: quotation.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        carrierId: carrier.id,
        polId: pol,
        podId: pod,
        loadingType: 'FCL',
        status,
      },
      select: { id: true, code: true },
    });
  const ready = await shipment(`BKG-${YEAR}-9${tag}0001`, 'BL_DRAFTED');
  const early = await shipment(`BKG-${YEAR}-9${tag}0002`, 'BOOKING_RECEIVED');

  return {
    tenantId,
    superUserId: superId,
    superToken: await token(superId, true, []),
    noBuyToken: await token(noBuyId, false, [
      'ACCOUNTS.DEBIT_INVOICE.VIEW',
      'ACCOUNTS.DEBIT_INVOICE.EDIT',
      'ACCOUNTS.AWAITING_FREIGHT_INV.VIEW',
    ]),
    bareToken: await token(bareId, false, []),
    customerId: customer.id,
    carrierId: carrier.id,
    agentId: agent.id,
    vendorId: vendor.id,
    freightHead,
    blHead,
    shipmentId: ready.id,
    shipmentCode: ready.code,
    earlyShipmentId: early.id,
  };
}

beforeAll(async () => {
  usd = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'USD' } } })).id;
  const usdRow = await owner.currency.findFirstOrThrow({ where: { id: usd }, select: { conversion: true } });
  usdRate = usdRow.conversion;
  bdt = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } } })).id;
  size20 = (await owner.containerSize.findFirstOrThrow({ where: { tenantId: null, code: '20STD' } })).id;
  containerUnit = (await owner.costUnit.findFirstOrThrow({ where: { tenantId: null, name: 'Container' } })).id;

  await cleanup();
  A = await makeWorld('Accounts Alpha', SLUG_A, 'A');
  B = await makeWorld('Accounts Beta', SLUG_B, 'B');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

const asA = () => as(A.superToken, SLUG_A);
const asB = () => as(B.superToken, SLUG_B);

/** The body `Drat` sends: the prefill, as the operator leaves it. */
function saveBody(world: World) {
  return {
    invoiceDate: TODAY,
    currencyId: usd.toString(),
    conversionRate: usdRate.toString(),
    recipientEmails: [`accounts@shafidi-${world === A ? 'a' : 'b'}.test`],
    lines: [
      { costHeadId: world.freightHead.toString(), containerSizeId: size20.toString(), quantity: '2', unitPrice: '1500', source: 'QUOTATION' },
      { costHeadId: world.blHead.toString(), quantity: '1', unitPrice: '50', source: 'QUOTATION' },
    ],
    costs: [
      {
        partyType: 'CARRIER',
        partyId: world.carrierId.toString(),
        supplierInvoiceNo: 'Inv-CMA-001',
        currencyId: usd.toString(),
        conversionRate: usdRate.toString(),
        lines: [{ costHeadId: world.freightHead.toString(), containerSizeId: size20.toString(), quantity: '2', unitPrice: '1200' }],
      },
      {
        partyType: 'VENDOR',
        partyId: world.vendorId.toString(),
        currencyId: bdt.toString(),
        // Sent as 99 on purpose: the base currency converts at exactly 1 (§3.4).
        conversionRate: '99',
        lines: [{ costHeadId: world.blHead.toString(), quantity: '1', unitPrice: '5000' }],
      },
      // An empty agent block that names nobody is dropped, not refused (§5 rule 3).
      { partyType: 'AGENT', partyId: '', currencyId: usd.toString(), conversionRate: usdRate.toString(), lines: [] },
    ],
  };
}

let invoiceId: string;

describe('Awaiting Freight Inv', () => {
  it('lists the confirmed booking, and not the unconfirmed one or the other workspace’s', async () => {
    const res = await asA().get('/awaiting-freight-inv?limit=100');
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const ids = res.body.data.map((r: { shipmentId: string }) => r.shipmentId);
    expect(ids).toContain(A.shipmentId.toString());
    expect(ids).not.toContain(A.earlyShipmentId.toString());
    expect(ids).not.toContain(B.shipmentId.toString());

    const row = res.body.data.find((r: { shipmentId: string }) => r.shipmentId === A.shipmentId.toString());
    expect(row.invoiceState).toBe('AWAITING');
    // L5: the quoted amount, per currency — 2 x 1500 + 50.
    expect(row.quotedAmount).toEqual([{ currencyCode: 'USD', amount: '3050.0000' }]);
    expect(row.requiredContainer).toContain('20STD');
  });

  it('prefills from the quotation, the booking’s carrier and the customer’s contacts (§3.5)', async () => {
    const res = await asA().get(`/shipments/${A.shipmentId}/debit-invoice/prefill`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const p = res.body.data;
    expect(p.currencyId).toBe(usd.toString());
    expect(p.conversionRate).toBe(usdRate.toString());
    expect(p.lines.map((l: { costHeadName: string; quantity: string; unitPrice: string }) => [l.costHeadName, l.quantity, l.unitPrice])).toEqual([
      ['Ocean Freight', '2', '1500'],
      ['B/L Fee', '1', '50'],
    ]);
    expect(p.costs.map((c: { partyType: string }) => c.partyType)).toEqual(['CARRIER', 'AGENT', 'VENDOR']);
    expect(p.costs[0].partyId).toBe(A.carrierId.toString());
    expect(p.recipientEmails).toEqual(['accounts@shafidi-a.test']);
  });

  it('offers the form its lookups, with today’s rates and the base named by its ISO code', async () => {
    const res = await asA().get('/debit-invoices/options');
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data.baseCurrencyCode).toBe('BDT');
    const usdOption = res.body.data.currencies.find((c: { id: string }) => c.id === usd.toString());
    expect(usdOption).toMatchObject({ code: 'USD', rate: usdRate.toString() });
    expect(res.body.data.carriers.map((c: { label: string }) => c.label)).toContain('Ocean Line A');
    expect(res.body.data.carriers.map((c: { label: string }) => c.label)).not.toContain('Ocean Line B');
  });

  it('refuses a booking that is not confirmed yet', async () => {
    const res = await asA().get(`/shipments/${A.earlyShipmentId}/debit-invoice/prefill`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BOOKING_NOT_INVOICEABLE');
  });
});

describe('Make invoice → Save & Send → Receive', () => {
  it('saves a draft with the sheet’s arithmetic', async () => {
    const res = await asA().post(`/shipments/${A.shipmentId}/debit-invoice`).send(saveBody(A));
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    const inv = res.body.data;
    invoiceId = inv.id;

    expect(inv.code).toBe(`DN-${YEAR}-000001`);
    expect(inv.status).toBe('DRAFT');
    expect(inv.kind).toBe('FREIGHT');
    // The money's ISO code, never the currency row's business code (CUR-001).
    expect(inv.baseCurrencyCode).toBe('BDT');

    // Selling: 2 x 1500 + 50 = 3050 USD, at the frozen rate.
    const sellBase = D(3000).times(usdRate).plus(D(50).times(usdRate));
    expect(inv.totalAmount).toBe('3050.0000');
    expect(inv.totalAmountBase).toBe(fixed4(sellBase));

    // Cost: carrier 2 x 1200 USD; vendor 5000 BDT at 1 whatever was sent.
    const carrierBase = D(2400).times(usdRate);
    const costBase = carrierBase.plus(5000);
    expect(inv.costTotalBase).toBe(fixed4(costBase));
    expect(inv.costs).toHaveLength(2);
    expect(inv.costs[1].conversionRate).toBe('1');

    // G58: Gross profit = Total sell price − Grand total cost.
    expect(inv.grossProfitBase).toBe(fixed4(sellBase.minus(costBase)));
    expect(inv.grossProfitPercent).toBe(
      sellBase.minus(costBase).dividedBy(sellBase).times(100).toDecimalPlaces(2).toFixed(2),
    );
  });

  it('shows the booking as Draft on the awaiting list, and refuses a second invoice', async () => {
    const list = await asA().get('/awaiting-freight-inv?limit=100');
    const row = list.body.data.find((r: { shipmentId: string }) => r.shipmentId === A.shipmentId.toString());
    expect(row.invoiceState).toBe('DRAFT');
    expect(row.invoiceId).toBe(invoiceId);

    const again = await asA().post(`/shipments/${A.shipmentId}/debit-invoice`).send(saveBody(A));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_INVOICED');
  });

  it('issues on Save & Send, attaches the PDF, and takes the booking off the queue', async () => {
    queueMailSpy.mockClear();
    const res = await asA().post(`/debit-invoices/${invoiceId}/send`).send({ to: ['accounts@shafidi-a.test'] });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data.status).toBe('ISSUED');
    expect(res.body.data.displayStatus).toBe('UNPAID');

    expect(queueMailSpy).toHaveBeenCalledTimes(1);
    const mail = queueMailSpy.mock.calls[0]![0] as unknown as {
      templateKey: string;
      to: string[];
      attachments: { filename: string }[];
    };
    expect(mail.templateKey).toBe('DEBIT_INVOICE_SENT');
    expect(mail.to).toEqual(['accounts@shafidi-a.test']);
    expect(mail.attachments.map((a) => a.filename)).toEqual([`DN-${YEAR}-000001.pdf`]);

    const list = await asA().get('/awaiting-freight-inv?limit=100');
    const ids = list.body.data.map((r: { shipmentId: string }) => r.shipmentId);
    expect(ids).not.toContain(A.shipmentId.toString());
  });

  it('puts the receivable on the customer and the payables on the carrier and vendor (§3.6)', async () => {
    const res = await asA().get('/receivable-payable?limit=100');
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const byName = new Map(res.body.data.map((r: { partyName: string }) => [r.partyName, r]));

    const customer = byName.get('Shafidi Exports A') as Record<string, string>;
    const opening = D(500);
    const sellBase = D(3050).times(usdRate);
    expect(customer.partyType).toBe('CUSTOMER');
    expect(customer.receivableUsd).toBe(fixed4(D(3050).plus(opening)));
    expect(customer.receivableBase).toBe(fixed4(sellBase.plus(opening.times(usdRate))));

    const carrier = byName.get('Ocean Line A') as Record<string, string>;
    expect(carrier.payableUsd).toBe('2400.0000');
    expect(carrier.payableBase).toBe(fixed4(D(2400).times(usdRate)));

    // Billed in taka: nothing in the USD column, all of it in base.
    const vendor = byName.get('Trust Cargo A') as Record<string, string>;
    expect(vendor.payableUsd).toBe('0.0000');
    expect(vendor.payableBase).toBe('5000.0000');

    // The empty agent block was dropped, so the agent owes and is owed nothing.
    expect(byName.has('DK International A')).toBe(false);

    // The sheet's "Total =" row adds every page.
    expect(res.body.meta.totals.payableBase).toBe(fixed4(D(2400).times(usdRate).plus(5000)));
  });

  it('records part of the money, then locks the sell side but not the cost side (§3.7)', async () => {
    const part = await asA().post(`/debit-invoices/${invoiceId}/receipts`).send({ paymentDate: TODAY, amount: '1000' });
    expect(part.status, JSON.stringify(part.body.error ?? {})).toBe(201);
    expect(part.body.data.displayStatus).toBe('PARTIAL');
    expect(part.body.data.outstandingAmount).toBe('2050.0000');
    expect(part.body.data.sellEditable).toBe(false);
    expect(part.body.data.costEditable).toBe(true);
    expect(part.body.data.cancellable).toBe(false);

    const edit = await asA().patch(`/debit-invoices/${invoiceId}`).send(saveBody(A));
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('SELL_SIDE_LOCKED');

    const cancel = await asA().post(`/debit-invoices/${invoiceId}/cancel`).send({ reason: 'Wrong customer' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('MONEY_RECEIVED');

    // The carrier's revised invoice still lands.
    const body = saveBody(A);
    const costs = await asA()
      .put(`/debit-invoices/${invoiceId}/costs`)
      .send({
        costs: [
          { ...body.costs[0], id: part.body.data.costs[0].id, lines: [{ ...body.costs[0]!.lines[0], unitPrice: '1250' }] },
          { ...body.costs[1], id: part.body.data.costs[1].id },
        ],
      });
    expect(costs.status, JSON.stringify(costs.body.error ?? {})).toBe(200);
    expect(costs.body.data.costs[0].totalAmount).toBe('2500.0000');
  });

  it('refuses more than is outstanding, then closes to exactly zero (§5 rule 4)', async () => {
    const over = await asA().post(`/debit-invoices/${invoiceId}/receipts`).send({ paymentDate: TODAY, amount: '3000' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('OVER_RECEIVED');

    const rest = await asA().post(`/debit-invoices/${invoiceId}/receipts`).send({ paymentDate: TODAY, amount: '2050' });
    expect(rest.status, JSON.stringify(rest.body.error ?? {})).toBe(201);
    expect(rest.body.data.displayStatus).toBe('PAID');
    expect(rest.body.data.outstandingAmount).toBe('0.0000');

    // Only the CRM opening is left on the customer — in both columns, exactly.
    const res = await asA().get('/receivable-payable?limit=100&partyType=CUSTOMER');
    const customer = res.body.data.find((r: { partyName: string }) => r.partyName === 'Shafidi Exports A');
    expect(customer.receivableUsd).toBe('500.0000');
    expect(customer.receivableBase).toBe(fixed4(D(500).times(usdRate)));
  });

  it('shows each document on the party ledger in its own currency (the Ledger sheet)', async () => {
    const carrier = await asA().get(`/receivable-payable/CARRIER/${A.carrierId}`);
    expect(carrier.status, JSON.stringify(carrier.body.error ?? {})).toBe(200);
    expect(carrier.body.data.entries).toHaveLength(1);
    const entry = carrier.body.data.entries[0];
    expect(entry.reference).toBe('Inv-CMA-001');
    // "Freight 1x40HC" on the sheet: head, quantity, box — the box by its name.
    expect(entry.description).toMatch(/^Ocean Freight 2x/);
    expect(entry.amount).toBe('2500.0000');
    expect(entry.paymentStatus).toBe('UNPAID');

    const customer = await asA().get(`/receivable-payable/CUSTOMER/${A.customerId}`);
    expect(customer.body.data.baseCurrencyCode).toBe('BDT');
    const kinds = customer.body.data.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(['OPENING', 'DEBIT_INVOICE', 'RECEIPT', 'RECEIPT']);
    expect(customer.body.data.totals.receivableUsd).toBe('500.0000');
  });
});

describe('Debit Invoice list and Create New', () => {
  it('raises an OTHER invoice by hand, in the base currency at a rate of 1', async () => {
    const res = await asA()
      .post('/debit-invoices')
      .send({
        invoiceDate: TODAY,
        customerId: A.customerId.toString(),
        currencyId: bdt.toString(),
        conversionRate: '5',
        lines: [{ costHeadId: A.blHead.toString(), quantity: '1', unitPrice: '2500' }],
      });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    expect(res.body.data.kind).toBe('OTHER');
    expect(res.body.data.code).toBe(`DN-${YEAR}-000002`);
    expect(res.body.data.conversionRate).toBe('1');
    expect(res.body.data.totalAmountBase).toBe('2500.0000');
    expect(res.body.data.booking).toBeNull();
  });

  it('lists both, newest first, with the status in one word', async () => {
    const res = await asA().get('/debit-invoices?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { code: string; displayStatus: string }) => [r.code, r.displayStatus])).toEqual([
      [`DN-${YEAR}-000002`, 'DRAFT'],
      [`DN-${YEAR}-000001`, 'PAID'],
    ]);
    const paid = await asA().get('/debit-invoices?status=PAID');
    expect(paid.body.data.map((r: { code: string }) => r.code)).toEqual([`DN-${YEAR}-000001`]);
  });

  it('cancels a draft with a reason, and keeps its number', async () => {
    const list = await asA().get('/debit-invoices?status=DRAFT');
    const id = list.body.data[0].id as string;
    const bare = await asA().post(`/debit-invoices/${id}/cancel`).send({ reason: '  ' });
    expect(bare.status).toBe(400);
    const done = await asA().post(`/debit-invoices/${id}/cancel`).send({ reason: 'Raised twice' });
    expect(done.status).toBe(200);
    expect(done.body.data.displayStatus).toBe('CANCELLED');
    expect(done.body.data.code).toBe(`DN-${YEAR}-000002`);
  });
});

describe('the carrier cost the load plan allocated (§3.5, CR-002 §9)', () => {
  it('is pulled into the carrier block when the booking has been through a finalised CLP', async () => {
    // A second workspace-B booking-to-be: B's own booking, through a CLP.
    const clp = await owner.clp.create({
      data: {
        tenantId: B.tenantId,
        code: `CLP-${YEAR}-9B0001`,
        seriesYear: YEAR,
        containerSizeId: size20,
        carrierId: B.carrierId,
        status: 'FINAL',
        actualContainerCost: '1800',
        costCurrencyId: usd,
        costAllocationBasis: 'CBM',
        containerNo: 'MSCU1234565',
        sealNo: 'SL-9B',
        loadDatetime: new Date(),
        finalisedAt: new Date(),
        finalisedBy: B.superUserId,
      },
      select: { id: true },
    });
    await owner.clpBooking.create({
      data: { tenantId: B.tenantId, clpId: clp.id, shipmentId: B.shipmentId, allocatedCostAmount: '1800' },
    });

    const res = await asB().get(`/shipments/${B.shipmentId}/debit-invoice/prefill`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const carrier = res.body.data.costs[0];
    expect(carrier.currencyId).toBe(usd.toString());
    expect(carrier.lines).toEqual([
      expect.objectContaining({ costHeadName: 'Ocean Freight', quantity: '1', unitPrice: '1800', source: 'LOAD_PLAN' }),
    ]);
  });
});

describe('a quotation priced in two currencies', () => {
  it('is invoiced in the base currency, each charge converted — never relabelled', async () => {
    // Quotations raised before the one-currency rule can still say
    // "USD 3,050 + BDT 5,000". Relabelling would bill 5,000 dollars.
    const quotation = await owner.shipment.findUniqueOrThrow({
      where: { id: B.shipmentId },
      select: { quotationId: true },
    });
    await owner.quotationLine.create({
      data: {
        tenantId: B.tenantId,
        quotationId: quotation.quotationId,
        sortOrder: 2,
        costHeadId: B.blHead,
        costHeadName: 'THC',
        quantity: '1',
        sellingPrice: '5000',
        currencyId: bdt,
        currencyCode: 'BDT',
        conversionRate: '1',
      },
    });

    const res = await asB().get(`/shipments/${B.shipmentId}/debit-invoice/prefill`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const p = res.body.data;
    expect(p.currencyId).toBe(bdt.toString());
    expect(p.conversionRate).toBe('1');
    expect(p.lines.map((l: { costHeadName: string; unitPrice: string }) => [l.costHeadName, l.unitPrice])).toEqual([
      ['Ocean Freight', D(1500).times(usdRate).toString()],
      ['B/L Fee', D(50).times(usdRate).toString()],
      ['THC', '5000'],
    ]);
    expect(p.notes.join(' ')).toContain('converted at today’s rate');
  });
});

describe('who may see what', () => {
  it('leaves every cost figure out for a user without VIEW_BUY_PRICE (§3.9)', async () => {
    const res = await as(A.noBuyToken, SLUG_A).get(`/debit-invoices/${invoiceId}`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data.costs).toBeNull();
    expect(res.body.data.costTotalBase).toBeNull();
    expect(res.body.data.grossProfitBase).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Inv-CMA-001');

    const file = await as(A.noBuyToken, SLUG_A).put(`/debit-invoices/${invoiceId}/costs`).send({ costs: [] });
    expect(file.status).toBe(403);
  });

  it('guards every screen with its own permission', async () => {
    const bare = as(A.bareToken, SLUG_A);
    for (const path of [
      '/awaiting-freight-inv',
      '/debit-invoices',
      `/debit-invoices/${invoiceId}`,
      '/debit-invoices/options',
      '/receivable-payable',
      `/receivable-payable/CUSTOMER/${A.customerId}`,
    ]) {
      expect((await bare.get(path)).status, path).toBe(403);
    }
    expect((await bare.post(`/debit-invoices/${invoiceId}/receipts`).send({ paymentDate: TODAY, amount: '1' })).status).toBe(403);

    const anon = await request(app).get('/api/tenant/accounts/debit-invoices').set('X-Tenant-Slug', SLUG_A);
    expect(anon.status).toBe(401);
  });

  it('shows workspace B none of workspace A (§7A rule 4)', async () => {
    expect((await asB().get(`/debit-invoices/${invoiceId}`)).status).toBe(404);
    expect((await asB().get(`/receivable-payable/CUSTOMER/${A.customerId}`)).status).toBe(404);
    expect((await asB().get(`/shipments/${A.shipmentId}/debit-invoice/prefill`)).status).toBe(404);

    const list = await asB().get('/debit-invoices?limit=100');
    expect(list.body.data).toEqual([]);
    const rp = await asB().get('/receivable-payable?limit=100&openOnly=false');
    const names = rp.body.data.map((r: { partyName: string }) => r.partyName);
    expect(names.some((n: string) => n.endsWith(' A'))).toBe(false);
  });
});
