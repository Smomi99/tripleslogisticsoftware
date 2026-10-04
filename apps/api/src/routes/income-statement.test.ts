import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Accounts → Income Statement, through HTTP — DESIGN-UPDATE-2026-10-04 §9.
 *
 * October 2026, in a financial year that starts in July. Every figure below
 * is arithmetic done here from the fixtures, not copied out of the code:
 *
 *   revenue    FCL invoice 10,000 and Air invoice 4,000 in October; an OTHER
 *              invoice 500 in August; a draft and a cancelled one that count
 *              for nothing; an FCL invoice 7,000 in October 2025
 *   job cost   carrier 6,000 and agent 1,000 on the FCL invoice, carrier
 *              3,000 on the Air one; carrier 5,000 on last year's
 *   vouchers   rent 2,000, depreciation 300, a workspace's own "Courier" sub
 *              ledger 50, a discount 100, income tax 400 — all October;
 *              fixed-deposit interest 200 in September; a draft rent 9,999
 *   settled    the FCL invoice received as 10,500 cash (booked 10,000: a
 *              500 gain); the carrier paid 6,100 (booked 6,000: a 100 loss);
 *              their category lines are not revenue or cost a second time
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');
const { withTenant } = await import('../lib/tenant-client');
const { ensureChart } = await import('../lib/ledger');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'income-alpha';
const SLUG_B = 'income-beta';
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface World {
  slug: string;
  viewerToken: string;
  bareToken: string;
}
let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'debit_invoice_receipt',
    'supplier_payment',
    'opening_settlement',
    'journal_line',
    'journal_entry',
    'debit_invoice_cost',
    'debit_invoice',
    'shipment',
    'quotation',
    'inquiry',
    'customer',
    'agent',
    'carrier',
    'port',
    'industry_sector',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  // The chart was made by a user, so it goes before them; sub ledgers first.
  await owner.$executeRawUnsafe(`DELETE FROM ledger_account WHERE tenant_id IN ${scope} AND parent_id IS NOT NULL`);
  await owner.$executeRawUnsafe(`DELETE FROM ledger_account WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string, withBooks: boolean): Promise<World> {
  const bdt = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } } })).id;
  const { id: tenantId } = await owner.tenant.create({ data: { name, slug, country: 'Bangladesh', currencyId: bdt }, select: { id: true } });
  const user = async (code: string, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x' },
      select: { id: true },
    });
    return { id, token: await signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin: false, permissions, tokenVersion: 0 }) };
  };
  const viewer = await user(`USR-V${tag}`, ['ACCOUNTS.INCOME_STATEMENT.VIEW', 'ACCOUNTS.INCOME_STATEMENT.EXPORT']);
  const bare = await user(`USR-B${tag}`, []);
  const world = { slug, viewerToken: viewer.token, bareToken: bare.token };
  if (!withBooks) return world;

  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = await owner.customer.create({
    data: { tenantId, code: `CUS-${tag}`, name: `Exporter ${tag}`, country: 'Bangladesh', customerType: 'EXPORTER', businessArea: 'OUTBOUND', industrySectorId: sector.id },
    select: { id: true },
  });
  const port = async (code: string) =>
    (await owner.port.create({ data: { tenantId, code: `PL-${tag}${code}`, name: code, portCode: `${tag}${code}`, country: 'Bangladesh', type: 'SEAPORT' }, select: { id: true } })).id;
  const ctg = await port('CTG');
  const ham = await port('HAM');
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({ data: { tenantId, code: `CAR-${tag}`, name: `Line ${tag}`, typeId: carrierType.id }, select: { id: true } });
  const agent = await owner.agent.create({ data: { tenantId, code: `AGT-${tag}`, name: `Agent ${tag}`, country: 'Germany', agentType: 'GENERAL' }, select: { id: true } });
  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const inquiry = await owner.inquiry.create({
    data: { tenantId, code: `INQ-2025-4${tag}01`, seriesYear: 2025, inquiryDate: at('2025-09-01'), sourceId: source.id, shipmentType: 'SEA', customerId: customer.id, movementType: 'OUTBOUND', polId: ctg, podId: ham },
    select: { id: true },
  });
  const quotation = await owner.quotation.create({
    data: {
      tenantId, code: `QTN-2025-4${tag}01`, seriesYear: 2025, inquiryId: inquiry.id, quotationDate: at('2025-09-02'), customerId: customer.id,
      shipmentType: 'SEA', movementType: 'OUTBOUND', polId: ctg, podId: ham, carrierId: carrier.id, localCurrencyId: bdt, conversionRate: '1', status: 'ACCEPTED',
    },
    select: { id: true },
  });
  let n = 0;
  const booking = async (shipmentType: 'SEA' | 'AIR') => {
    n += 1;
    return (
      await owner.shipment.create({
        data: {
          tenantId, code: `BKG-2026-4${tag}0${n}`, seriesYear: 2026, quotationId: quotation.id, shipmentType, customerId: customer.id,
          carrierId: carrier.id, polId: ctg, podId: ham, loadingType: shipmentType === 'SEA' ? 'FCL' : null, status: 'BL_ISSUED',
        },
        select: { id: true },
      })
    ).id;
  };
  const fcl = await booking('SEA');
  const air = await booking('AIR');
  const lastYearFcl = await booking('SEA');
  // One live freight invoice per booking: the draft needs a booking of its own.
  const draftJob = await booking('SEA');

  let inv = 0;
  const invoice = async (args: {
    shipmentId: bigint | null;
    date: string;
    revenue: number;
    status?: 'ISSUED' | 'DRAFT' | 'CANCELLED';
    costs?: { party: 'CARRIER' | 'AGENT'; amount: number }[];
  }) => {
    inv += 1;
    const created = await owner.debitInvoice.create({
      data: {
        tenantId, code: `DN-2026-4${tag}0${inv}`, seriesYear: 2026, kind: args.shipmentId === null ? 'OTHER' : 'FREIGHT',
        shipmentId: args.shipmentId, customerId: customer.id, invoiceDate: at(args.date), currencyId: bdt, currencyCode: 'BDT', conversionRate: '1',
        totalAmount: String(args.revenue), totalAmountBase: String(args.revenue), status: args.status ?? 'ISSUED',
        ...(args.status === 'CANCELLED' ? { cancelReason: 'Wrong customer' } : {}),
      },
      select: { id: true },
    });
    const costs = [];
    for (const c of args.costs ?? []) {
      costs.push(
        await owner.debitInvoiceCost.create({
          data: {
            tenantId, debitInvoiceId: created.id, partyType: c.party, ...(c.party === 'CARRIER' ? { carrierId: carrier.id } : { agentId: agent.id }),
            currencyId: bdt, currencyCode: 'BDT', conversionRate: '1', totalAmount: String(c.amount), totalAmountBase: String(c.amount),
          },
          select: { id: true, partyType: true },
        }),
      );
    }
    return { id: created.id, costs };
  };
  const fclInvoice = await invoice({ shipmentId: fcl, date: '2026-10-05', revenue: 10000, costs: [{ party: 'CARRIER', amount: 6000 }, { party: 'AGENT', amount: 1000 }] });
  await invoice({ shipmentId: air, date: '2026-10-08', revenue: 4000, costs: [{ party: 'CARRIER', amount: 3000 }] });
  await invoice({ shipmentId: null, date: '2026-08-10', revenue: 500 });
  await invoice({ shipmentId: draftJob, date: '2026-10-09', revenue: 999, status: 'DRAFT' });
  await invoice({ shipmentId: air, date: '2026-10-10', revenue: 888, status: 'CANCELLED' });
  await invoice({ shipmentId: lastYearFcl, date: '2025-10-15', revenue: 7000, costs: [{ party: 'CARRIER', amount: 5000 }] });

  // The books.
  await withTenant(tenantId, (db) => ensureChart(db, tenantId, viewer.id));
  const accounts = await owner.ledgerAccount.findMany({ where: { tenantId }, select: { id: true, systemKey: true } });
  const acct = (key: string) => accounts.find((a) => a.systemKey === key)!.id;
  const operating = acct('EXPENSE.OPERATING');
  const courier = await owner.ledgerAccount.create({
    data: { tenantId, code: `ACC-9${tag}`, accountType: 'EXPENSE', parentId: operating, name: 'Courier' },
    select: { id: true },
  });

  let v = 0;
  const voucher = async (args: {
    kind: 'JOURNAL' | 'EXPENSE' | 'INCOME';
    date: string;
    status?: 'POSTED' | 'DRAFT';
    debit: bigint;
    credit: bigint;
    amount: number;
  }) => {
    v += 1;
    // Drafted, given its lines, then posted: the balance check runs on posting.
    const entry = await owner.journalEntry.create({
      data: {
        tenantId, code: `JV-2026-4${tag}0${v}`, seriesYear: 2026, kind: args.kind, entryDate: at(args.date), status: 'DRAFT',
        totalAmount: String(args.amount),
      },
      select: { id: true },
    });
    await owner.journalLine.createMany({
      data: [
        { tenantId, journalEntryId: entry.id, sortOrder: 0, ledgerAccountId: args.debit, debit: String(args.amount), credit: '0' },
        { tenantId, journalEntryId: entry.id, sortOrder: 1, ledgerAccountId: args.credit, debit: '0', credit: String(args.amount) },
      ],
    });
    if ((args.status ?? 'POSTED') === 'POSTED') {
      await owner.journalEntry.update({ where: { id: entry.id }, data: { status: 'POSTED', postedAt: new Date() } });
    }
    return entry;
  };
  const cash = acct('ASSET.CASH.ON_HAND');
  await voucher({ kind: 'EXPENSE', date: '2026-10-12', debit: acct('EXPENSE.OPERATING.RENT'), credit: cash, amount: 2000 });
  await voucher({ kind: 'JOURNAL', date: '2026-10-20', debit: acct('EXPENSE.OPERATING.DEPRECIATION'), credit: acct('ASSET.OTHER_LONG_TERM.BUILDING'), amount: 300 });
  await voucher({ kind: 'EXPENSE', date: '2026-10-21', debit: courier.id, credit: cash, amount: 50 });
  await voucher({ kind: 'JOURNAL', date: '2026-10-22', debit: acct('EXPENSE.DISCOUNT'), credit: cash, amount: 100 });
  await voucher({ kind: 'JOURNAL', date: '2026-10-30', debit: acct('EXPENSE.TAX.INCOME_TAX'), credit: cash, amount: 400 });
  await voucher({ kind: 'INCOME', date: '2026-09-05', debit: cash, credit: acct('INCOME.OTHER.FIXED_DEPOSIT'), amount: 200 });
  await voucher({ kind: 'EXPENSE', date: '2026-10-15', status: 'DRAFT', debit: acct('EXPENSE.OPERATING.RENT'), credit: cash, amount: 9999 });

  // Settlements: the cash for what the invoices already counted.
  const received = await voucher({ kind: 'INCOME', date: '2026-10-25', debit: cash, credit: acct('INCOME.SERVICE.SEA_FCL'), amount: 10500 });
  await owner.debitInvoiceReceipt.create({
    data: { tenantId, debitInvoiceId: fclInvoice.id, journalEntryId: received.id, paymentDate: at('2026-10-25'), amount: '10000', amountBase: '10000' },
  });
  const paid = await voucher({ kind: 'EXPENSE', date: '2026-10-26', debit: acct('EXPENSE.COST_OF_SERVICE.SEA_FCL'), credit: cash, amount: 6100 });
  const carrierCost = fclInvoice.costs.find((c) => c.partyType === 'CARRIER')!;
  await owner.supplierPayment.create({
    data: { tenantId, journalEntryId: paid.id, debitInvoiceCostId: carrierCost.id, paymentDate: at('2026-10-26'), amount: '6000', amountBase: '6000' },
  });
  return world;
}

function api(token: string, slug: string) {
  return (path: string) =>
    request(app).get(`/api/tenant/accounts/income-statement${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
}

type Row = { key: string; amounts: [string | null, string | null, string | null] };
const QUERY = '?month=2026-10&yearStartMonth=7';

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Income Alpha', SLUG_A, 'IA', true);
  B = await makeWorld('Income Beta', SLUG_B, 'IB', false);
}, 60_000);
afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('Income Statement', () => {
  let rows: Map<string, Row['amounts']>;
  const n = (key: string, column: 0 | 1 | 2) => Number(rows.get(key)![column]);

  beforeAll(async () => {
    const res = await api(A.viewerToken, A.slug)(QUERY);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      currencyCode: 'BDT',
      basis: 'ACCRUAL',
      periods: {
        currentMonth: { from: '2026-10-01', to: '2026-10-31' },
        ytd: { from: '2026-07-01', to: '2026-10-31' },
        previousYtd: { from: '2025-07-01', to: '2025-10-31' },
      },
    });
    rows = new Map((res.body.data.rows as Row[]).map((r) => [r.key, r.amounts]));
  });

  it('books revenue on the invoice date, by service, and nothing a draft or a cancellation says', () => {
    expect(n('REV_FCL', 0)).toBe(10000);
    expect(n('REV_AIR', 0)).toBe(4000);
    expect(n('REV_OTHER', 0)).toBe(0);
    expect(n('REV_OTHER', 1)).toBe(500);
    expect(n('GROSS_REVENUE', 0)).toBe(14000);
    expect(n('DISCOUNTS', 0)).toBe(100);
    expect(n('NET_REVENUE', 0)).toBe(13900);
    expect(n('REV_FCL', 2)).toBe(7000);
  });

  it("books each job's cost with its revenue: freight by service, agents apart", () => {
    expect(n('COST_FCL', 0)).toBe(6000);
    expect(n('COST_AGENT', 0)).toBe(1000);
    expect(n('COST_AIR', 0)).toBe(3000);
    expect(n('TOTAL_DIRECT_COST', 0)).toBe(10000);
    expect(n('GROSS_PROFIT', 0)).toBe(3900);
    expect(rows.get('GROSS_PROFIT_PERCENT')![0]).toBe('28.1');
  });

  it('takes the rest from posted vouchers, by the chart, and leaves drafts out', () => {
    expect(n('OPEX_RENT', 0)).toBe(2000);
    expect(n('OPEX_DEPRECIATION', 0)).toBe(300);
    // A workspace's own sub ledger follows the ledger it sits under.
    expect(n('OPEX_OTHER_ADMIN', 0)).toBe(50);
    expect(n('TOTAL_OPEX', 0)).toBe(2350);
    expect(n('OPERATING_PROFIT', 0)).toBe(1550);
    expect(n('NONOP_INTEREST', 0)).toBe(0);
    expect(n('NONOP_INTEREST', 1)).toBe(200);
    expect(n('INCOME_TAX', 0)).toBe(400);
  });

  it('counts a settlement once — as the invoice — and its exchange difference as gain or loss', () => {
    // 10,500 banked against 10,000 booked; 6,100 paid against 6,000 booked.
    expect(n('FX_GAIN', 0)).toBe(500);
    expect(n('FX_LOSS', 0)).toBe(100);
    expect(n('REV_FCL', 0)).toBe(10000);
    expect(n('COST_FCL', 0)).toBe(6000);
    expect(n('PROFIT_BEFORE_TAX', 0)).toBe(1950);
    expect(n('NET_PROFIT_AFTER_TAX', 0)).toBe(1550);
  });

  it('carries the year to date and last year to date', () => {
    // + the August invoice and the September interest.
    expect(n('NET_REVENUE', 1)).toBe(14400);
    expect(n('PROFIT_BEFORE_TAX', 1)).toBe(2650);
    expect(n('NET_PROFIT_AFTER_TAX', 1)).toBe(2250);
    expect(n('GROSS_PROFIT', 2)).toBe(2000);
    expect(n('NET_PROFIT_AFTER_TAX', 2)).toBe(2000);
  });

  it('exports the same statement as a workbook', async () => {
    const res = await api(A.viewerToken, A.slug)(`/export${QUERY}`).buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    // An .xlsx is a zip: it starts "PK".
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('refuses a user without the permission, and a malformed month', async () => {
    expect((await api(A.bareToken, A.slug)(QUERY)).status).toBe(403);
    expect((await api(A.viewerToken, A.slug)('?month=2026-13')).status).toBe(400);
  });

  it("shows one workspace nothing of another's", async () => {
    const res = await api(B.viewerToken, B.slug)(QUERY);
    expect(res.status).toBe(200);
    const other = new Map((res.body.data.rows as Row[]).map((r) => [r.key, r.amounts]));
    expect(other.get('NET_REVENUE')).toEqual(['0.00', '0.00', '0.00']);
    expect(other.get('NET_PROFIT_AFTER_TAX')).toEqual(['0.00', '0.00', '0.00']);
    expect(other.get('GROSS_PROFIT_PERCENT')).toEqual([null, null, null]);
  });
});
