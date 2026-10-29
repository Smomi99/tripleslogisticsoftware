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
 *   settled    the FCL invoice received as 10,500 (booked 10,000: a 500
 *              gain), of which the bank kept 50 and credited 10,450; the
 *              carrier paid 6,100 (booked 6,000: a 100 loss). Their category
 *              lines are not revenue or cost a second time; the bank's 50 is
 *              a Bank Charge, not part of the gain (MODULE_ACCOUNTS §14.15)
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
  /** The statement, and buy prices: job costs listed one by one in a breakdown. */
  costToken: string;
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
  const viewer = await user(`USR-V${tag}`, [
    'ACCOUNTS.INCOME_STATEMENT.VIEW',
    'ACCOUNTS.INCOME_STATEMENT.EXPORT',
    'ACCOUNTS.BALANCE_SHEET.VIEW',
    'ACCOUNTS.BALANCE_SHEET.EXPORT',
    'ACCOUNTS.CASH_FLOW_STATEMENT.VIEW',
    'ACCOUNTS.CASH_FLOW_STATEMENT.EXPORT',
  ]);
  const costViewer = await user(`USR-C${tag}`, [
    'ACCOUNTS.INCOME_STATEMENT.VIEW',
    'ACCOUNTS.BALANCE_SHEET.VIEW',
    'ACCOUNTS.CASH_FLOW_STATEMENT.VIEW',
    'ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE',
  ]);
  const bare = await user(`USR-B${tag}`, []);
  const world = { slug, viewerToken: viewer.token, costToken: costViewer.token, bareToken: bare.token };
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
    /** What the bank kept: a Bank Service Charge debit, out of the `debit` side. */
    bankCharge?: number;
  }) => {
    v += 1;
    const charge = args.bankCharge ?? 0;
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
        { tenantId, journalEntryId: entry.id, sortOrder: 0, ledgerAccountId: args.debit, debit: String(args.amount - charge), credit: '0' },
        ...(charge === 0
          ? []
          : [{ tenantId, journalEntryId: entry.id, sortOrder: 1, ledgerAccountId: acct('EXPENSE.OPERATING.BANK_CHARGE'), debit: String(charge), credit: '0' }]),
        { tenantId, journalEntryId: entry.id, sortOrder: 2, ledgerAccountId: args.credit, debit: '0', credit: String(args.amount) },
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
  const received = await voucher({ kind: 'INCOME', date: '2026-10-25', debit: cash, credit: acct('INCOME.SERVICE.SEA_FCL'), amount: 10500, bankCharge: 50 });
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

type Row = { key: string; amounts: (string | null)[] };
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
  const n = (key: string, column: 0 | 1 | 2 | 3) => Number(rows.get(key)![column]);

  beforeAll(async () => {
    const res = await api(A.viewerToken, A.slug)(QUERY);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      currencyCode: 'BDT',
      basis: 'ACCRUAL',
      periods: {
        currentMonth: { from: '2026-10-01', to: '2026-10-31' },
        previousMonth: { from: '2026-09-01', to: '2026-09-30' },
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
    expect(n('REV_OTHER', 2)).toBe(500);
    expect(n('GROSS_REVENUE', 0)).toBe(14000);
    expect(n('DISCOUNTS', 0)).toBe(100);
    expect(n('NET_REVENUE', 0)).toBe(13900);
    expect(n('REV_FCL', 3)).toBe(7000);
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
    // + the 50 the bank kept of the FCL receipt.
    expect(n('OPEX_BANK', 0)).toBe(50);
    expect(n('TOTAL_OPEX', 0)).toBe(2400);
    expect(n('OPERATING_PROFIT', 0)).toBe(1500);
    expect(n('NONOP_INTEREST', 0)).toBe(0);
    expect(n('NONOP_INTEREST', 2)).toBe(200);
    expect(n('INCOME_TAX', 0)).toBe(400);
  });

  it('counts a settlement once — as the invoice — and its exchange difference as gain or loss', () => {
    // 10,500 received against 10,000 booked; 6,100 paid against 6,000 booked.
    // The 50 the bank kept of the 10,500 is a Bank Charge, not less gain.
    expect(n('FX_GAIN', 0)).toBe(500);
    expect(n('FX_LOSS', 0)).toBe(100);
    expect(n('REV_FCL', 0)).toBe(10000);
    expect(n('COST_FCL', 0)).toBe(6000);
    expect(n('PROFIT_BEFORE_TAX', 0)).toBe(1900);
    expect(n('NET_PROFIT_AFTER_TAX', 0)).toBe(1500);
  });

  it('carries the year to date and last year to date', () => {
    // + the August invoice and the September interest.
    expect(n('NET_REVENUE', 2)).toBe(14400);
    expect(n('PROFIT_BEFORE_TAX', 2)).toBe(2600);
    expect(n('NET_PROFIT_AFTER_TAX', 2)).toBe(2200);
    expect(n('GROSS_PROFIT', 3)).toBe(2000);
    expect(n('NET_PROFIT_AFTER_TAX', 3)).toBe(2000);
  });

  it('carries the month before, beside the month', () => {
    // September holds only the fixed-deposit interest.
    expect(n('NONOP_INTEREST', 1)).toBe(200);
    expect(n('REV_FCL', 1)).toBe(0);
    expect(n('NET_REVENUE', 1)).toBe(0);
    expect(n('NET_PROFIT_AFTER_TAX', 1)).toBe(200);
  });

  it('takes the month before from the calendar, not the financial year', async () => {
    // September, in a year that starts in September: August is in neither YTD.
    const sep = await api(A.viewerToken, A.slug)('?month=2026-09&yearStartMonth=9');
    expect(sep.status).toBe(200);
    expect(sep.body.data.periods.previousMonth).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    const september = new Map((sep.body.data.rows as Row[]).map((r) => [r.key, r.amounts]));
    expect(september.get('REV_OTHER')).toEqual(['0.00', '500.00', '0.00', '0.00']);
    // January's month before is December of the year before.
    const jan = await api(A.viewerToken, A.slug)('?month=2026-01');
    expect(jan.body.data.periods.previousMonth).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('on a cash basis, reads only the Transaction screens: what was received and paid', async () => {
    const res = await api(A.viewerToken, A.slug)(`${QUERY}&basis=CASH`);
    expect(res.status).toBe(200);
    expect(res.body.data.basis).toBe('CASH');
    const cash = new Map((res.body.data.rows as Row[]).map((r) => [r.key, r.amounts]));
    const c = (key: string, column: 0 | 1 | 2 | 3) => Number(cash.get(key)![column]);
    // Transaction → Income took 10,500 for the FCL job (10,450 banked, 50 kept); the Air invoice is unpaid.
    expect(c('REV_FCL', 0)).toBe(10500);
    expect(c('REV_AIR', 0)).toBe(0);
    // Transaction → Expense paid the carrier 6,100; the agent and the airline are unpaid.
    expect(c('COST_FCL', 0)).toBe(6100);
    expect(c('COST_AGENT', 0)).toBe(0);
    expect(c('COST_AIR', 0)).toBe(0);
    // The exchange difference is inside the cash, not a line of its own.
    expect(c('FX_GAIN', 0)).toBe(0);
    expect(c('FX_LOSS', 0)).toBe(0);
    expect(c('NET_REVENUE', 0)).toBe(10400);
    expect(c('GROSS_PROFIT', 0)).toBe(4300);
    expect(c('OPEX_BANK', 0)).toBe(50);
    expect(c('TOTAL_OPEX', 0)).toBe(2400);
    expect(c('NET_PROFIT_AFTER_TAX', 0)).toBe(1500);
    expect(c('NET_PROFIT_AFTER_TAX', 2)).toBe(1700);
    // Last year's invoice was never received, so on cash it is not revenue.
    expect(c('NET_REVENUE', 3)).toBe(0);
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
    expect(other.get('NET_REVENUE')).toEqual(['0.00', '0.00', '0.00', '0.00']);
    expect(other.get('NET_PROFIT_AFTER_TAX')).toEqual(['0.00', '0.00', '0.00', '0.00']);
    expect(other.get('GROSS_PROFIT_PERCENT')).toEqual([null, null, null, null]);
  });
});

// ---------------------------------------------------------------------------
// A line's breakdown (2026-10-20): the documents a figure was added up from.
// ---------------------------------------------------------------------------

type Entry = {
  source: string;
  date: string;
  documentCode: string;
  voucherKind: string | null;
  partyName: string | null;
  reference: string | null;
  details: string | null;
  amount: string;
};
type Breakdown = {
  total: string;
  entries: Entry[];
  withheld: { count: number; amount: string } | null;
  groups: { label: string; count: number; amount: string }[];
};

describe('Income Statement breakdown', () => {
  const COLUMNS = ['CURRENT_MONTH', 'PREVIOUS_MONTH', 'YTD', 'PREVIOUS_YTD'] as const;
  const breakdown = (token: string, slug: string, query: string) => api(token, slug)(`/breakdown${QUERY}&${query}`);
  const open = async (token: string, query: string): Promise<Breakdown> => {
    const res = await breakdown(token, A.slug, query);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    return res.body.data as Breakdown;
  };

  it('adds up to the statement, for every line and column, on both bases', async () => {
    for (const basis of ['ACCRUAL', 'CASH'] as const) {
      const statement = await api(A.viewerToken, A.slug)(`${QUERY}&basis=${basis}`);
      const lines = (statement.body.data.rows as (Row & { kind: string })[]).filter((r) => r.kind === 'LINE');
      expect(lines).toHaveLength(56);
      for (const row of lines) {
        const results = await Promise.all(
          COLUMNS.map((column) => breakdown(A.costToken, A.slug, `basis=${basis}&line=${row.key}&column=${column}`)),
        );
        results.forEach((res, i) => {
          const where = `${basis} ${row.key} ${COLUMNS[i]}`;
          expect(res.status, where).toBe(200);
          const data = res.body.data as Breakdown;
          expect(data.total, where).toBe(row.amounts[i]);
          const listed = data.entries.reduce((acc, e) => acc + Number(e.amount), 0) + Number(data.withheld?.amount ?? 0);
          expect(listed.toFixed(2), where).toBe(data.total);
        });
      }
    }
  }, 120_000);

  it('lists revenue as the issued invoices, with customer and booking', async () => {
    const data = await open(A.viewerToken, 'line=REV_FCL');
    expect(data.total).toBe('10000.00');
    expect(data.entries).toEqual([
      expect.objectContaining({
        source: 'DEBIT_INVOICE',
        date: '2026-10-05',
        documentCode: 'DN-2026-4IA01',
        voucherKind: null,
        partyName: 'Exporter IA',
        reference: 'BKG-2026-4IA01',
        amount: '10000.00',
      }),
    ]);
    // The August invoice had no booking, so it is Other, in the year to date only.
    const other = await open(A.viewerToken, 'line=REV_OTHER&column=YTD');
    expect(other.entries.map((e) => [e.documentCode, e.reference, e.amount])).toEqual([['DN-2026-4IA03', null, '500.00']]);
  });

  it('lists job costs only with the buy-price grant, and sums them without it', async () => {
    const hidden = await open(A.viewerToken, 'line=COST_FCL');
    expect(hidden.entries).toEqual([]);
    expect(hidden.withheld).toEqual({ count: 1, amount: '6000.00' });
    expect(hidden.total).toBe('6000.00');

    const shown = await open(A.costToken, 'line=COST_FCL');
    expect(shown.withheld).toBeNull();
    expect(shown.entries).toEqual([
      expect.objectContaining({ source: 'INVOICE_COST', documentCode: 'DN-2026-4IA01', partyName: 'Line IA', amount: '6000.00' }),
    ]);
    const agent = await open(A.costToken, 'line=COST_AGENT');
    expect(agent.entries.map((e) => [e.partyName, e.amount])).toEqual([['Agent IA', '1000.00']]);
  });

  it('lists vouchers by the account they were posted to, and leaves drafts out', async () => {
    const admin = await open(A.viewerToken, 'line=OPEX_OTHER_ADMIN');
    expect(admin.entries).toEqual([
      expect.objectContaining({ source: 'VOUCHER', documentCode: 'JV-2026-4IA03', voucherKind: 'EXPENSE', reference: 'Courier', amount: '50.00' }),
    ]);
    expect(admin.groups).toEqual([{ label: 'Courier', count: 1, amount: '50.00' }]);
    // The draft 9,999 is not there.
    const rent = await open(A.viewerToken, 'line=OPEX_RENT');
    expect(rent.entries.map((e) => e.amount)).toEqual(['2000.00']);
    const discounts = await open(A.viewerToken, 'line=DISCOUNTS');
    expect(discounts.entries.map((e) => [e.documentCode, e.amount])).toEqual([['JV-2026-4IA04', '100.00']]);
    // The FCL receipt's own lines are the invoice's, but what the bank kept of it is listed.
    const bankCharges = await open(A.viewerToken, 'line=OPEX_BANK');
    expect(bankCharges.entries.map((e) => [e.documentCode, e.amount])).toEqual([['JV-2026-4IA08', '50.00']]);
  });

  it("shows each settlement's exchange difference against what it settled", async () => {
    const gain = await open(A.viewerToken, 'line=FX_GAIN');
    expect(gain.entries).toEqual([
      expect.objectContaining({
        source: 'EXCHANGE',
        documentCode: 'JV-2026-4IA08',
        voucherKind: 'INCOME',
        details: 'Against DN-2026-4IA01',
        amount: '500.00',
      }),
    ]);
    const loss = await open(A.viewerToken, 'line=FX_LOSS');
    expect(loss.entries.map((e) => [e.documentCode, e.details, e.amount])).toEqual([['JV-2026-4IA09', 'Against DN-2026-4IA01', '100.00']]);
  });

  it('breaks down the month before as well', async () => {
    const interest = await open(A.viewerToken, 'line=NONOP_INTEREST&column=PREVIOUS_MONTH');
    expect(interest.entries.map((e) => [e.documentCode, e.date, e.amount])).toEqual([['JV-2026-4IA06', '2026-09-05', '200.00']]);
  });

  it('on a cash basis, lists the vouchers that received the money', async () => {
    const fcl = await open(A.viewerToken, 'basis=CASH&line=REV_FCL');
    expect(fcl.entries).toEqual([expect.objectContaining({ source: 'VOUCHER', documentCode: 'JV-2026-4IA08', amount: '10500.00' })]);
    const gain = await open(A.viewerToken, 'basis=CASH&line=FX_GAIN');
    expect(gain.entries).toEqual([]);
  });

  it('refuses a user without the permission and a line the statement does not draw', async () => {
    expect((await breakdown(A.bareToken, A.slug, 'line=REV_FCL')).status).toBe(403);
    expect((await breakdown(A.viewerToken, A.slug, 'line=GROSS_REVENUE')).status).toBe(400);
    expect((await breakdown(A.viewerToken, A.slug, 'line=REV_FCL&column=LAST_WEEK')).status).toBe(400);
  });

  it("shows one workspace nothing of another's", async () => {
    for (const line of ['REV_FCL', 'COST_FCL', 'OPEX_RENT', 'FX_GAIN']) {
      const res = await breakdown(B.costToken, B.slug, `line=${line}&column=YTD`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ total: '0.00', entries: [], withheld: null });
    }
  });
});

// ---------------------------------------------------------------------------
// Balance Sheet and Cash Flow Statement (2026-10-18), over the same fixtures.
//
//   books to 31-Oct-2026   cash: −2,000 rent −50 courier −100 discount −400 tax
//                          +200 interest +10,450 received −6,100 paid = 2,000;
//                          building −300 (depreciation); profit 1,700
//   accrual adds           billed 10,000 + 4,000 + 500 + 7,000, received 10,000:
//                          receivable 11,500; costed 6,000 + 1,000 + 3,000 +
//                          5,000, paid 6,000: payable 9,000
//   so                     earned 1,700 + 11,500 − 9,000 = 4,200: this year's
//                          2,200 (the Income Statement's YTD) and last year's 2,000
// ---------------------------------------------------------------------------

function statement(kind: 'balance-sheet' | 'cash-flow', token: string, slug: string) {
  return (path: string) =>
    request(app).get(`/api/tenant/accounts/${kind}${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
}

type StatementRow = { key: string; amounts: (string | null)[] };
const byKey = (rows: StatementRow[]) => new Map(rows.map((r) => [r.key, r.amounts]));

describe('Balance Sheet', () => {
  const AS_AT = '?asOf=2026-10-31&yearStartMonth=7';

  it('balances on accrual: the books, plus what the invoices leave owing', async () => {
    const res = await statement('balance-sheet', A.viewerToken, A.slug)(AS_AT);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data).toMatchObject({ currencyCode: 'BDT', basis: 'ACCRUAL', balanced: true });
    expect(res.body.data.columns.map((c: { asOf: string }) => c.asOf)).toEqual(['2026-10-31', '2025-10-31']);
    const rows = byKey(res.body.data.rows);
    expect(rows.get('CASH')).toEqual(['2000.00', '0.00']);
    expect(rows.get('LONG_TERM_ASSETS')).toEqual(['-300.00', '0.00']);
    expect(rows.get('RECEIVABLE')).toEqual(['11500.00', '7000.00']);
    expect(rows.get('TOTAL_ASSETS')).toEqual(['13200.00', '7000.00']);
    expect(rows.get('PAYABLE')).toEqual(['9000.00', '5000.00']);
    expect(rows.get('TOTAL_LIABILITIES')).toEqual(['9000.00', '5000.00']);
    // Profit for the Year is the Income Statement's accrual YTD; the rest came before.
    expect(rows.get('PROFIT')).toEqual(['2200.00', '2000.00']);
    expect(rows.get('RETAINED')).toEqual(['2000.00', '0.00']);
    expect(rows.get('TOTAL_LIABILITIES_AND_EQUITY')).toEqual(['13200.00', '7000.00']);
    expect(rows.has('DIFFERENCE')).toBe(false);
  });

  it('on a cash basis, is the books as they stand', async () => {
    const res = await statement('balance-sheet', A.viewerToken, A.slug)(`${AS_AT}&basis=CASH`);
    expect(res.status).toBe(200);
    expect(res.body.data.balanced).toBe(true);
    const rows = byKey(res.body.data.rows);
    expect(rows.get('RECEIVABLE')).toEqual(['0.00', '0.00']);
    expect(rows.get('PAYABLE')).toEqual(['0.00', '0.00']);
    expect(rows.get('TOTAL_ASSETS')).toEqual(['1700.00', '0.00']);
    expect(rows.get('PROFIT')).toEqual(['1700.00', '0.00']);
    expect(rows.get('RETAINED')).toEqual(['0.00', '0.00']);
  });

  it('exports, refuses a user without the permission, and shows another workspace nothing', async () => {
    const xlsx = await statement('balance-sheet', A.viewerToken, A.slug)(`/export${AS_AT}`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

    expect((await statement('balance-sheet', A.bareToken, A.slug)(AS_AT)).status).toBe(403);
    expect((await statement('balance-sheet', A.viewerToken, A.slug)('?asOf=31-10-2026')).status).toBe(400);
    const other = await statement('balance-sheet', B.viewerToken, B.slug)(AS_AT);
    expect(other.status).toBe(200);
    expect(byKey(other.body.data.rows).get('TOTAL_ASSETS')).toEqual(['0.00', '0.00']);
  });
});

describe('Cash Flow Statement', () => {
  it('splits what the cash moved by where it went, and reconciles to the books', async () => {
    const res = await statement('cash-flow', A.viewerToken, A.slug)(QUERY);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const rows = byKey(res.body.data.rows);
    // October: 10,500 received less the 100 discount; 6,100 to the carrier;
    // the 50 the bank kept of the receipt is an operating expense.
    expect(rows.get('OP_CUSTOMERS')).toEqual(['10400.00', '10400.00', '0.00']);
    expect(rows.get('OP_SUPPLIERS')).toEqual(['-6100.00', '-6100.00', '0.00']);
    expect(rows.get('OP_EXPENSES')).toEqual(['-2100.00', '-2100.00', '0.00']);
    expect(rows.get('OP_TAX')).toEqual(['-400.00', '-400.00', '0.00']);
    expect(rows.get('NET_OPERATING')).toEqual(['1800.00', '1800.00', '0.00']);
    // September's deposit interest is in the year to date, not the month.
    expect(rows.get('INV_INTEREST')).toEqual(['0.00', '200.00', '0.00']);
    expect(rows.get('NET_CHANGE')).toEqual(['1800.00', '2000.00', '0.00']);
    expect(rows.get('OPENING_CASH')).toEqual(['200.00', '0.00', '0.00']);
    expect(rows.get('CLOSING_CASH')).toEqual(['2000.00', '2000.00', '0.00']);
    // Depreciation moved no cash, and a draft is not in the books.
    expect(rows.has('DIFFERENCE')).toBe(false);
  });

  it('refuses a user without the permission, and shows another workspace nothing', async () => {
    expect((await statement('cash-flow', A.bareToken, A.slug)(QUERY)).status).toBe(403);
    const other = await statement('cash-flow', B.viewerToken, B.slug)(QUERY);
    expect(other.status).toBe(200);
    expect(byKey(other.body.data.rows).get('CLOSING_CASH')).toEqual(['0.00', '0.00', '0.00']);
  });
});

// ---------------------------------------------------------------------------
// A figure's breakdown on the Balance Sheet and the Cash Flow Statement
// (client, 2026-10-28): what each amount is made of, over the same fixtures.
// ---------------------------------------------------------------------------

type StatementEntry = {
  source: string;
  date: string | null;
  documentCode: string | null;
  voucherKind: string | null;
  partyType: string | null;
  partyName: string | null;
  reference: string | null;
  details: string | null;
  amount: string;
};
type StatementBreakdown = {
  total: string;
  period: { from: string | null; to: string };
  entries: StatementEntry[];
  withheld: { count: number; amount: string } | null;
  groups: { label: string; count: number; amount: string }[];
};

/** Every row and anything withheld add up to the total, which is the statement's figure. */
function expectAddsUp(data: StatementBreakdown, figure: string | null | undefined, where: string): void {
  expect(data.total, where).toBe(figure);
  const listed = data.entries.reduce((acc, e) => acc + Number(e.amount), 0) + Number(data.withheld?.amount ?? 0);
  expect(listed.toFixed(2), where).toBe(data.total);
}

describe('Balance Sheet breakdown', () => {
  const AS_AT = '?asOf=2026-10-31&yearStartMonth=7';
  const open = async (token: string, query: string): Promise<StatementBreakdown> => {
    const res = await statement('balance-sheet', token, A.slug)(`/breakdown${AS_AT}&${query}`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    return res.body.data as StatementBreakdown;
  };

  it('adds up to the statement, for every line and both columns, on both bases', async () => {
    for (const basis of ['ACCRUAL', 'CASH'] as const) {
      const sheet = await statement('balance-sheet', A.viewerToken, A.slug)(`${AS_AT}&basis=${basis}`);
      const lines = (sheet.body.data.rows as (StatementRow & { kind: string })[]).filter((r) => r.kind === 'LINE');
      expect(lines).toHaveLength(18);
      for (const row of lines) {
        for (const [i, column] of (['AS_AT', 'YEAR_EARLIER'] as const).entries()) {
          for (const token of [A.costToken, A.viewerToken]) {
            const where = `${basis} ${row.key} ${column}`;
            const res = await statement('balance-sheet', token, A.slug)(`/breakdown${AS_AT}&basis=${basis}&line=${row.key}&column=${column}`);
            expect(res.status, where).toBe(200);
            expectAddsUp(res.body.data as StatementBreakdown, row.amounts[i], where);
          }
        }
      }
    }
  }, 120_000);

  it('lists cash as every voucher on the cash accounts, to the day', async () => {
    const cash = await open(A.viewerToken, 'line=CASH');
    expect(cash.period).toEqual({ from: null, to: '2026-10-31' });
    expect(cash.entries.map((e) => [e.date, e.documentCode, e.reference, e.amount])).toEqual([
      ['2026-09-05', 'JV-2026-4IA06', 'Cash › Cash on Hand', '200.00'],
      ['2026-10-12', 'JV-2026-4IA01', 'Cash › Cash on Hand', '-2000.00'],
      ['2026-10-21', 'JV-2026-4IA03', 'Cash › Cash on Hand', '-50.00'],
      ['2026-10-22', 'JV-2026-4IA04', 'Cash › Cash on Hand', '-100.00'],
      ['2026-10-25', 'JV-2026-4IA08', 'Cash › Cash on Hand', '10450.00'],
      ['2026-10-26', 'JV-2026-4IA09', 'Cash › Cash on Hand', '-6100.00'],
      ['2026-10-30', 'JV-2026-4IA05', 'Cash › Cash on Hand', '-400.00'],
    ]);
    expect(cash.entries[0]).toMatchObject({ source: 'VOUCHER', voucherKind: 'INCOME' });
    // The draft rent 9,999 is not in the books.
    const building = await open(A.viewerToken, 'line=LONG_TERM_ASSETS');
    expect(building.entries.map((e) => [e.documentCode, e.amount])).toEqual([['JV-2026-4IA02', '-300.00']]);
  });

  it('lists receivables as the invoices still owed on, to the day', async () => {
    const now = await open(A.viewerToken, 'line=RECEIVABLE');
    // DN01 was received in full; the draft and the cancelled one never counted.
    expect(now.entries.map((e) => [e.source, e.documentCode, e.partyName, e.reference, e.amount])).toEqual([
      ['DEBIT_INVOICE', 'DN-2026-4IA06', 'Exporter IA', 'BKG-2026-4IA03', '7000.00'],
      ['DEBIT_INVOICE', 'DN-2026-4IA03', 'Exporter IA', null, '500.00'],
      ['DEBIT_INVOICE', 'DN-2026-4IA02', 'Exporter IA', 'BKG-2026-4IA02', '4000.00'],
    ]);
    expect(now.groups).toEqual([{ label: 'Issued debit invoices, not yet received', count: 3, amount: '11500.00' }]);
    const before = await open(A.viewerToken, 'line=RECEIVABLE&column=YEAR_EARLIER');
    expect(before.period.to).toBe('2025-10-31');
    expect(before.entries.map((e) => [e.documentCode, e.amount])).toEqual([['DN-2026-4IA06', '7000.00']]);
    // On the cash basis an invoice is nothing until money moves.
    const cash = await open(A.viewerToken, 'line=RECEIVABLE&basis=CASH');
    expect(cash).toMatchObject({ total: '0.00', entries: [] });
  });

  it("lists suppliers' costs only with the buy-price grant, and sums them without it", async () => {
    const hidden = await open(A.viewerToken, 'line=PAYABLE');
    expect(hidden.entries).toEqual([]);
    // The FCL carrier was paid in full, so three are owed on.
    expect(hidden.withheld).toEqual({ count: 3, amount: '9000.00' });
    const shown = await open(A.costToken, 'line=PAYABLE');
    expect(shown.withheld).toBeNull();
    expect(shown.entries.map((e) => [e.source, e.documentCode, e.partyName, e.amount])).toEqual([
      ['INVOICE_COST', 'DN-2026-4IA06', 'Line IA', '5000.00'],
      ['INVOICE_COST', 'DN-2026-4IA01', 'Agent IA', '1000.00'],
      ['INVOICE_COST', 'DN-2026-4IA02', 'Line IA', '3000.00'],
    ]);
  });

  it("splits Profit for the Year by the Income Statement's sections", async () => {
    const profit = await open(A.viewerToken, 'line=PROFIT');
    expect(profit.total).toBe('2200.00');
    expect(profit.entries.map((e) => [e.source, e.reference, e.amount])).toEqual([
      ['FIGURE', 'Net Revenue', '14400.00'],
      ['FIGURE', 'Less: Total Direct Cost', '-10000.00'],
      ['FIGURE', 'Less: Total Operating Expenses', '-2400.00'],
      ['FIGURE', 'Add: Total Non-Operating Income', '700.00'],
      ['FIGURE', 'Less: Total Non-Operating Expenses', '-100.00'],
      ['FIGURE', 'Less: Income Tax Expense', '-400.00'],
    ]);
    expect(profit.entries[0]!.details).toBe('01-Jul-2026 to 31-Oct-2026');
  });

  it('shows how Retained Earnings is worked out', async () => {
    const retained = await open(A.viewerToken, 'line=RETAINED');
    expect(retained.total).toBe('2000.00');
    expect(retained.entries.map((e) => [e.reference, e.amount])).toEqual([
      ['Income less expenses on posted vouchers', '1700.00'],
      ['Add: still owed by customers on issued invoices', '11500.00'],
      ['Less: still owed to suppliers on issued invoices', '-9000.00'],
      ['Less: Profit for the Year', '-2200.00'],
    ]);
    expect(retained.groups).toEqual([
      { label: 'Profit earned to the day', count: 3, amount: '4200.00' },
      { label: 'Less: Profit for the Year', count: 1, amount: '-2200.00' },
    ]);
  });

  it('lists the CRM openings: owed, still owed, and their other side in equity', async () => {
    const tenant = await owner.tenant.findUniqueOrThrow({ where: { slug: A.slug }, select: { id: true, currencyId: true } });
    const sector = await owner.industrySector.findFirstOrThrow({ where: { tenantId: tenant.id }, select: { id: true } });
    await owner.customer.create({
      data: {
        tenantId: tenant.id, code: 'CUS-IAOPEN', name: 'Opening Trader IA', country: 'Bangladesh', customerType: 'TRADER', businessArea: 'BOTH',
        industrySectorId: sector.id, customerOwe: '1500', weOwe: '800', openingCurrencyId: tenant.currencyId,
      },
    });

    const receivable = await open(A.viewerToken, 'line=RECEIVABLE');
    expect(receivable.entries.filter((e) => e.source === 'OPENING')).toEqual([
      expect.objectContaining({ documentCode: 'CUS-IAOPEN', partyType: 'CUSTOMER', partyName: 'Opening Trader IA', amount: '1500.00' }),
    ]);
    expect(receivable.total).toBe('13000.00');
    const payable = await open(A.viewerToken, 'line=PAYABLE');
    expect(payable.entries.map((e) => [e.source, e.partyName, e.amount])).toEqual([['OPENING', 'Opening Trader IA', '800.00']]);
    const equity = await open(A.viewerToken, 'line=OPENING_EQUITY');
    expect(equity.entries.map((e) => [e.details, e.amount])).toEqual([
      ['Owed to us when the books began', '1500.00'],
      ['Owed by us when the books began', '-800.00'],
    ]);
    expect(equity.total).toBe('700.00');

    // Still the statement's figures, line by line.
    const sheet = byKey((await statement('balance-sheet', A.viewerToken, A.slug)(AS_AT)).body.data.rows);
    for (const line of ['RECEIVABLE', 'PAYABLE', 'OPENING_EQUITY', 'RETAINED'] as const) {
      expectAddsUp(await open(A.costToken, `line=${line}`), sheet.get(line)?.[0], line);
    }
  });

  it('refuses a user without the permission, a total, and an unknown column; shows another workspace nothing', async () => {
    const breakdown = (token: string, slug: string, query: string) => statement('balance-sheet', token, slug)(`/breakdown${AS_AT}&${query}`);
    expect((await breakdown(A.bareToken, A.slug, 'line=CASH')).status).toBe(403);
    expect((await breakdown(A.viewerToken, A.slug, 'line=TOTAL_ASSETS')).status).toBe(400);
    expect((await breakdown(A.viewerToken, A.slug, 'line=CASH&column=LAST_WEEK')).status).toBe(400);
    for (const line of ['CASH', 'RECEIVABLE', 'PAYABLE', 'PROFIT']) {
      const res = await breakdown(B.viewerToken, B.slug, `line=${line}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ total: '0.00', entries: [], withheld: null });
    }
  });
});

describe('Cash Flow Statement breakdown', () => {
  const open = async (query: string): Promise<StatementBreakdown> => {
    const res = await statement('cash-flow', A.viewerToken, A.slug)(`/breakdown${QUERY}&${query}`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    return res.body.data as StatementBreakdown;
  };

  it('adds up to the statement, for every line it opens and every column', async () => {
    const flows = await statement('cash-flow', A.viewerToken, A.slug)(QUERY);
    const rows = (flows.body.data.rows as (StatementRow & { kind: string })[]).filter(
      (r) => r.kind === 'LINE' || r.key === 'CLOSING_CASH',
    );
    expect(rows).toHaveLength(14);
    for (const row of rows) {
      for (const [i, column] of (['CURRENT_MONTH', 'YTD', 'PREVIOUS_YTD'] as const).entries()) {
        expectAddsUp(await open(`line=${row.key}&column=${column}`), row.amounts[i], `${row.key} ${column}`);
      }
    }
  }, 60_000);

  it('lists each voucher that moved cash, by where the money came from', async () => {
    const customers = await open('line=OP_CUSTOMERS');
    expect(customers.period).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(customers.entries.map((e) => [e.documentCode, e.reference, e.amount])).toEqual([
      ['JV-2026-4IA04', 'Discount', '-100.00'],
      ['JV-2026-4IA08', 'Income on Service › Sea Freight-FCL', '10500.00'],
    ]);
    // The 50 the bank kept of the receipt is an operating expense; depreciation moved no cash.
    const expenses = await open('line=OP_EXPENSES');
    expect(expenses.entries.map((e) => [e.documentCode, e.amount])).toEqual([
      ['JV-2026-4IA01', '-2000.00'],
      ['JV-2026-4IA03', '-50.00'],
      ['JV-2026-4IA08', '-50.00'],
    ]);
    const interest = await open('line=INV_INTEREST&column=YTD');
    expect(interest.entries.map((e) => [e.date, e.documentCode, e.amount])).toEqual([['2026-09-05', 'JV-2026-4IA06', '200.00']]);
  });

  it('lists the cash at either end of the period by its vouchers, to the day', async () => {
    const opening = await open('line=OPENING_CASH');
    expect(opening.period).toEqual({ from: null, to: '2026-09-30' });
    expect(opening.entries.map((e) => [e.documentCode, e.amount])).toEqual([['JV-2026-4IA06', '200.00']]);
    const closing = await open('line=CLOSING_CASH');
    expect(closing.total).toBe('2000.00');
    expect(closing.groups).toEqual([{ label: 'Cash › Cash on Hand', count: 7, amount: '2000.00' }]);
  });

  it('refuses a user without the permission and a total; shows another workspace nothing', async () => {
    const breakdown = (token: string, slug: string, query: string) => statement('cash-flow', token, slug)(`/breakdown${QUERY}&${query}`);
    expect((await breakdown(A.bareToken, A.slug, 'line=OP_CUSTOMERS')).status).toBe(403);
    expect((await breakdown(A.viewerToken, A.slug, 'line=NET_OPERATING')).status).toBe(400);
    expect((await breakdown(A.viewerToken, A.slug, 'line=OP_CUSTOMERS&column=PREVIOUS_MONTH')).status).toBe(400);
    for (const line of ['OP_CUSTOMERS', 'CLOSING_CASH']) {
      const res = await breakdown(B.viewerToken, B.slug, `line=${line}&column=YTD`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ total: '0.00', entries: [] });
    }
  });
});
