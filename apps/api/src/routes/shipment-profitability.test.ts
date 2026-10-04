import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Shipment Profitability, through HTTP — docs/DESIGN-UPDATE-2026-10-04.md §8.
 *
 * The figures are the client's own sample rows (sheet rows 7 and 10), so the
 * arithmetic checked here is the arithmetic they drew: 10200 − 8925 = 1275 at
 * 12.5 %, and 7200 − 7650 = −450 at −6.3 %.
 *
 * Two workspaces, so every assertion about one is also a check that the other
 * sees none of it (CLAUDE.md §7A rule 4).
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'profit-alpha';
const SLUG_B = 'profit-beta';
const YEAR = new Date().getUTCFullYear();

interface World {
  slug: string;
  superToken: string;
  /** Both grants the screen needs. */
  viewerToken: string;
  /** The screen's VIEW, but not the cost grant (MODULE_ACCOUNTS §3.9). */
  noBuyToken: string;
  /** The cost grant, but not the screen. */
  noScreenToken: string;
  /** FCL: a freight and an OTHER invoice, both issued. Advised, so it has a BL No. */
  fclCode: string;
  /** Air: issued at a loss. */
  airCode: string;
}

let A: World;
let B: World;
let bdt: bigint;

function as(token: string, slug: string) {
  return (query = '') =>
    request(app)
      .get(`/api/tenant/accounts/shipment-profitability${query}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', slug);
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'shipment_advise_booking',
    'shipment_advise',
    'debit_invoice',
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
  const { id: tenantId } = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh', currencyId: bdt },
    select: { id: true },
  });

  const user = async (code: string, isSuperadmin: boolean, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: {
        tenantId,
        code,
        username: `${code.toLowerCase()}-${slug}`,
        email: `${code.toLowerCase()}@${slug}.test`,
        passwordHash: 'x',
        isSuperadmin,
      },
      select: { id: true },
    });
    return signAccessToken({
      sub: id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin,
      permissions,
      tokenVersion: 0,
    });
  };

  const sector = await owner.industrySector.create({
    data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: `CUS-${tag}`,
      name: `ABC Ltd ${tag}`,
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const port = async (code: string, portName: string) =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${code}`, name: portName, portCode: `${tag}${code}`, country: 'Bangladesh', type: 'SEAPORT' },
        select: { id: true },
      })
    ).id;
  const pol = await port('CTG', `Chittagong ${tag}`);
  const pod = await port('HAM', `Hamburg ${tag}`);
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: `CAR-${tag}`, name: `Ocean Line ${tag}`, typeId: carrierType.id },
    select: { id: true },
  });
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const inquiry = await owner.inquiry.create({
    data: {
      tenantId,
      code: `INQ-${YEAR}-8${tag}01`,
      seriesYear: YEAR,
      inquiryDate: new Date(`${YEAR}-01-05T00:00:00Z`),
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
      code: `QTN-${YEAR}-8${tag}01`,
      seriesYear: YEAR,
      inquiryId: inquiry.id,
      quotationDate: new Date(`${YEAR}-01-06T00:00:00Z`),
      customerId: customer.id,
      shipmentType: 'SEA',
      movementType: 'OUTBOUND',
      polId: pol,
      podId: pod,
      carrierId: carrier.id,
      localCurrencyId: bdt,
      conversionRate: '1',
      status: 'ACCEPTED',
    },
    select: { id: true },
  });

  const shipment = async (n: number, shipmentType: 'SEA' | 'AIR') =>
    owner.shipment.create({
      data: {
        tenantId,
        code: `BKG-${YEAR}-8${tag}0${n}`,
        seriesYear: YEAR,
        quotationId: quotation.id,
        shipmentType,
        customerId: customer.id,
        carrierId: carrier.id,
        polId: pol,
        podId: pod,
        loadingType: shipmentType === 'SEA' ? 'FCL' : null,
        status: 'BL_DRAFTED',
      },
      select: { id: true, code: true },
    });
  const fcl = await shipment(1, 'SEA');
  const air = await shipment(2, 'AIR');
  // Invoiced, but not in a way that bills anybody: neither may appear.
  const draft = await shipment(3, 'SEA');
  const cancelled = await shipment(4, 'SEA');

  let invoiceNo = 0;
  const invoice = async (input: {
    shipmentId: bigint | null;
    kind: 'FREIGHT' | 'OTHER';
    status: 'DRAFT' | 'ISSUED' | 'CANCELLED';
    date: string;
    revenue: string;
    cost: string;
  }) => {
    invoiceNo += 1;
    await owner.debitInvoice.create({
      data: {
        tenantId,
        code: `DN-${YEAR}-8${tag}0${invoiceNo}`,
        seriesYear: YEAR,
        kind: input.kind,
        shipmentId: input.shipmentId,
        quotationId: input.shipmentId === null ? null : quotation.id,
        customerId: customer.id,
        invoiceDate: new Date(`${input.date}T00:00:00Z`),
        currencyId: bdt,
        currencyCode: 'BDT',
        conversionRate: '1',
        totalAmount: input.revenue,
        totalAmountBase: input.revenue,
        costTotalBase: input.cost,
        status: input.status,
        ...(input.status === 'CANCELLED' ? { cancelReason: 'Raised against the wrong booking' } : {}),
      },
    });
  };
  // Sheet row 7 (JOB-001), split across the freight invoice and a later OTHER one.
  await invoice({ shipmentId: fcl.id, kind: 'FREIGHT', status: 'ISSUED', date: `${YEAR}-02-10`, revenue: '10000', cost: '8925' });
  await invoice({ shipmentId: fcl.id, kind: 'OTHER', status: 'ISSUED', date: `${YEAR}-03-15`, revenue: '200', cost: '0' });
  // Sheet row 10 (JOB-004): a loss.
  await invoice({ shipmentId: air.id, kind: 'FREIGHT', status: 'ISSUED', date: `${YEAR}-03-01`, revenue: '7200', cost: '7650' });
  await invoice({ shipmentId: draft.id, kind: 'FREIGHT', status: 'DRAFT', date: `${YEAR}-03-02`, revenue: '999', cost: '1' });
  await invoice({ shipmentId: cancelled.id, kind: 'FREIGHT', status: 'CANCELLED', date: `${YEAR}-03-03`, revenue: '888', cost: '1' });
  // Names no booking, so it belongs to no row and to no total.
  await invoice({ shipmentId: null, kind: 'OTHER', status: 'ISSUED', date: `${YEAR}-03-04`, revenue: '777', cost: '1' });

  // The FCL booking has been advised: its HBL is the BL No.
  const advise = await owner.shipmentAdvise.create({
    data: {
      tenantId,
      code: `SA-${YEAR}-8${tag}01`,
      seriesYear: YEAR,
      shipmentId: fcl.id,
      carrierId: carrier.id,
      transitType: 'DIRECT',
      polId: pol,
      podId: pod,
      houseBlNo: `HBL${tag}0001`,
    },
    select: { id: true },
  });
  await owner.shipmentAdviseBooking.create({ data: { tenantId, adviseId: advise.id, shipmentId: fcl.id } });

  return {
    slug,
    superToken: await user(`USR-S${tag}`, true, []),
    viewerToken: await user(`USR-V${tag}`, false, [
      'ACCOUNTS.SHIPMENT_PROFITABILITY.VIEW',
      'ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE',
    ]),
    noBuyToken: await user(`USR-N${tag}`, false, ['ACCOUNTS.SHIPMENT_PROFITABILITY.VIEW']),
    noScreenToken: await user(`USR-C${tag}`, false, ['ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE']),
    fclCode: fcl.code,
    airCode: air.code,
  };
}

beforeAll(async () => {
  bdt = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } } })).id;
  await cleanup();
  A = await makeWorld('Profit Alpha', SLUG_A, 'PA');
  B = await makeWorld('Profit Beta', SLUG_B, 'PB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

interface Row {
  bookingCode: string;
  quotationCode: string;
  blNo: string | null;
  customerName: string;
  shipmentType: string;
  loadingType: string | null;
  polCode: string;
  podCode: string;
  currencyCode: string;
  revenue: string;
  cost: string;
  gp: string;
  gpPercent: string | null;
}

describe('Shipment Profitability', () => {
  it('sums every issued invoice on a booking, and leaves drafts, cancellations and unlinked invoices out', async () => {
    const res = await as(A.viewerToken, A.slug)('?sortBy=code&sortOrder=asc');
    expect(res.status).toBe(200);
    const rows = res.body.data as Row[];

    expect(rows.map((r) => r.bookingCode)).toEqual([A.fclCode, A.airCode]);
    expect(res.body.meta.total).toBe(2);

    const [fcl, air] = rows;
    expect(fcl).toMatchObject({
      quotationCode: `QTN-${YEAR}-8PA01`,
      blNo: 'HBLPA0001',
      customerName: 'ABC Ltd PA',
      shipmentType: 'SEA',
      loadingType: 'FCL',
      polCode: 'PACTG',
      podCode: 'PAHAM',
      currencyCode: 'BDT',
    });
    // 10000 + 200 billed, 8925 charged: the sheet's 10200 / 8925 / 1275 / 12.5 %.
    expect(Number(fcl!.revenue)).toBe(10200);
    expect(Number(fcl!.cost)).toBe(8925);
    expect(Number(fcl!.gp)).toBe(1275);
    expect(fcl!.gpPercent).toBe('12.5');

    expect(air).toMatchObject({ shipmentType: 'AIR', loadingType: null, blNo: null });
    expect(Number(air!.gp)).toBe(-450);
    expect(air!.gpPercent).toBe('-6.3');
  });

  it('totals the whole filtered list, with GP % as total GP over total revenue', async () => {
    const res = await as(A.viewerToken, A.slug)('?limit=1');
    expect(res.body.data).toHaveLength(1);
    const totals = res.body.meta.totals as Record<string, string>;
    expect(Number(totals.revenue)).toBe(17400);
    expect(Number(totals.cost)).toBe(16575);
    expect(Number(totals.gp)).toBe(825);
    // 825 / 17400 = 4.74 %, not the mean of 12.5 and -6.3.
    expect(totals.gpPercent).toBe('4.7');
  });

  it('sorts by the figures, so the losses come first on GP ascending', async () => {
    const byGp = await as(A.viewerToken, A.slug)('?sortBy=gp&sortOrder=asc');
    expect((byGp.body.data as Row[]).map((r) => r.bookingCode)).toEqual([A.airCode, A.fclCode]);

    const byPercent = await as(A.viewerToken, A.slug)('?sortBy=gpPercent&sortOrder=desc');
    expect((byPercent.body.data as Row[]).map((r) => r.bookingCode)).toEqual([A.fclCode, A.airCode]);
  });

  it('filters by mode, by search and by the first invoice date', async () => {
    const air = await as(A.viewerToken, A.slug)('?shipmentType=AIR');
    expect((air.body.data as Row[]).map((r) => r.bookingCode)).toEqual([A.airCode]);
    expect(Number(air.body.meta.totals.revenue)).toBe(7200);

    const byBl = await as(A.viewerToken, A.slug)('?search=hblpa');
    expect((byBl.body.data as Row[]).map((r) => r.bookingCode)).toEqual([A.fclCode]);

    // A wildcard is a character to match, not a pattern: nothing contains "%".
    const wildcard = await as(A.viewerToken, A.slug)(`?search=${encodeURIComponent('%')}`);
    expect(wildcard.body.data).toHaveLength(0);

    // The FCL job was first billed in February; its March OTHER invoice does
    // not move it into March, and it still counts in full.
    const march = await as(A.viewerToken, A.slug)(`?from=${YEAR}-03-01&to=${YEAR}-03-31`);
    expect((march.body.data as Row[]).map((r) => r.bookingCode)).toEqual([A.airCode]);
    const february = await as(A.viewerToken, A.slug)(`?from=${YEAR}-02-01&to=${YEAR}-02-28`);
    expect(Number((february.body.data as Row[])[0]!.revenue)).toBe(10200);
  });

  it('refuses a date range that ends before it starts', async () => {
    const res = await as(A.viewerToken, A.slug)(`?from=${YEAR}-03-31&to=${YEAR}-03-01`);
    expect(res.status).toBe(400);
  });

  it('needs both the screen and the cost grant; the superadmin needs neither', async () => {
    expect((await as(A.noBuyToken, A.slug)()).status).toBe(403);
    expect((await as(A.noScreenToken, A.slug)()).status).toBe(403);
    expect((await as(A.superToken, A.slug)()).status).toBe(200);
  });

  it("never shows one workspace another's bookings or money", async () => {
    const a = await as(A.superToken, A.slug)();
    const b = await as(B.superToken, B.slug)();
    const codesA = (a.body.data as Row[]).map((r) => r.bookingCode);
    const codesB = (b.body.data as Row[]).map((r) => r.bookingCode);

    expect(codesA).toEqual(expect.arrayContaining([A.fclCode, A.airCode]));
    expect(codesA.some((c) => codesB.includes(c))).toBe(false);
    expect(codesB).toEqual(expect.arrayContaining([B.fclCode, B.airCode]));
    // Identical worlds, so identical totals — B's money is not added to A's.
    expect(Number(a.body.meta.totals.revenue)).toBe(17400);
    expect(Number(b.body.meta.totals.revenue)).toBe(17400);

    // A token for workspace B, sent to workspace A's address, opens nothing of A's.
    const crossed = await as(B.superToken, A.slug)();
    expect(crossed.status).not.toBe(200);
  });
});
