import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The books, end to end through HTTP — docs/MODULE_ACCOUNTS.md §14.
 *
 * Two workspaces are built from nothing, so every assertion about one is also
 * a check that the other sees none of it (CLAUDE.md §7A rule 4). The money is
 * followed through each sheet the client drew:
 *
 *   Bank Set up -> Account Set up -> the chart's Bank sub ledger
 *   Journal (opening) -> Expense -> Income -> Internal Transfer -> balances
 *   Credit Invoice -> Make Payment (Expense-Vendor) -> the supplier's ledger
 *   Receive (Income) -> the customer's ledger -> cancel the voucher -> back
 *   Receivable-Payable list's new Unbilled column
 *
 * and every figure is checked against arithmetic done here.
 */

const queueMailSpy = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ queued: true })));
vi.mock('../lib/email-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email-queue')>();
  return { ...actual, queueMail: queueMailSpy };
});

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient, Prisma } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'books-alpha';
const SLUG_B = 'books-beta';
const YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);

interface World {
  tenantId: bigint;
  superToken: string;
  /** May write a journal, not agree it; may record income but not against an invoice. */
  clerkToken: string;
  bareToken: string;
  customerId: bigint;
  carrierId: bigint;
  vendorId: bigint;
  freightHead: bigint;
  /** BL_DRAFTED, invoiced during the run. */
  shipmentId: bigint;
  /** APPROVED_FOR_SHIPMENT, never invoiced: its quote is unbilled. */
  unbilledShipmentId: bigint;
}

let A: World;
let B: World;
let usd: bigint;
let bdt: bigint;
let usdRate: InstanceType<typeof Prisma.Decimal>;
let size20: bigint;
let containerUnit: bigint;

const D = (v: string | number) => new Prisma.Decimal(v);
const fixed4 = (v: InstanceType<typeof Prisma.Decimal>) => v.toDecimalPlaces(4).toFixed(4);

function as(token: string, slug: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  return {
    get: (p: string) => wrap(request(app).get(`/api/tenant/accounts${p}`)),
    post: (p: string) => wrap(request(app).post(`/api/tenant/accounts${p}`)),
    patch: (p: string) => wrap(request(app).patch(`/api/tenant/accounts${p}`)),
    put: (p: string) => wrap(request(app).put(`/api/tenant/accounts${p}`)),
    delete: (p: string) => wrap(request(app).delete(`/api/tenant/accounts${p}`)),
  };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  const wipe = (table: string, extra = '') =>
    owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}${extra}`);
  for (const table of ['debit_invoice_receipt', 'supplier_payment', 'opening_settlement', 'journal_line', 'journal_entry', 'bank_account']) {
    await wipe(table);
  }
  await wipe('ledger_account', ' AND parent_id IS NOT NULL');
  await wipe('ledger_account');
  await wipe('bank');
  for (const table of [
    'debit_invoice_cost_line',
    'debit_invoice_cost',
    'debit_invoice_line',
    'debit_invoice',
    'shipment',
    'quotation_line',
    'quotation',
    'inquiry',
    'customer',
    'vendor',
    'cost_head',
    'carrier',
    'port',
    'industry_sector',
    'email_log',
    'user',
  ]) {
    await wipe(table);
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
    signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin, permissions, tokenVersion: 0 });

  const superId = await user(`USR-S${tag}`, true);
  const clerkId = await user(`USR-C${tag}`, false);
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
    },
    select: { id: true },
  });
  const port = async (code: string, portName: string) =>
    (
      await owner.port.create({
        data: { tenantId, code: `PL-${tag}${code}`, name: portName, portCode: `Y${tag}${code}`, country: 'Bangladesh', type: 'SEAPORT' },
        select: { id: true },
      })
    ).id;
  const pol = await port('1', `Chittagong ${tag}`);
  const pod = await port('2', `Hamburg ${tag}`);
  const carrierType = await owner.carrierType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: `CAR-${tag}`, name: `CMA-CGM ${tag}`, typeId: carrierType.id },
    select: { id: true },
  });
  const vendorType = await owner.vendorType.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  // §14.6: a vendor we owe BDT 20,000 from before the system — CRM's opening.
  const vendor = await owner.vendor.create({
    data: {
      tenantId,
      code: `VND-${tag}`,
      name: `Trust Cargo ${tag}`,
      country: 'Bangladesh',
      vendorTypeId: vendorType.id,
      weOwe: '20000',
      openingCurrencyId: bdt,
    },
    select: { id: true },
  });
  const freightHead = (
    await owner.costHead.create({
      data: { tenantId, code: `CH-${tag}1`, category: 'SERVICE', name: 'Ocean Freight', unitId: containerUnit },
      select: { id: true },
    })
  ).id;

  const source = await owner.inquirySource.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } });
  const quotationFor = async (n: string) => {
    const inquiry = await owner.inquiry.create({
      data: {
        tenantId,
        code: `INQ-${YEAR}-8${tag}000${n}`,
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
        code: `QTN-${YEAR}-8${tag}000${n}`,
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
    await owner.quotationLine.create({
      data: {
        tenantId,
        quotationId: quotation.id,
        sortOrder: 0,
        costHeadId: freightHead,
        costHeadName: 'Ocean Freight',
        containerSizeId: size20,
        containerSizeName: '20STD',
        costUnitId: containerUnit,
        unitName: 'Container',
        quantity: '1',
        sellingPrice: '1000',
        currencyId: usd,
        currencyCode: 'USD',
        conversionRate: usdRate,
      },
    });
    return quotation.id;
  };
  const shipment = async (n: string, status: 'BL_DRAFTED' | 'APPROVED_FOR_SHIPMENT') =>
    (
      await owner.shipment.create({
        data: {
          tenantId,
          code: `BKG-${YEAR}-8${tag}000${n}`,
          seriesYear: YEAR,
          quotationId: await quotationFor(n),
          shipmentType: 'SEA',
          customerId: customer.id,
          carrierId: carrier.id,
          polId: pol,
          podId: pod,
          loadingType: 'FCL',
          status,
        },
        select: { id: true },
      })
    ).id;

  return {
    tenantId,
    superToken: await token(superId, true, []),
    clerkToken: await token(clerkId, false, [
      'ACCOUNTS.JOURNAL.VIEW',
      'ACCOUNTS.JOURNAL.CREATE',
      'ACCOUNTS.INCOME.VIEW',
      'ACCOUNTS.INCOME.CREATE',
    ]),
    bareToken: await token(bareId, false, []),
    customerId: customer.id,
    carrierId: carrier.id,
    vendorId: vendor.id,
    freightHead,
    shipmentId: await shipment('1', 'BL_DRAFTED'),
    unbilledShipmentId: await shipment('2', 'APPROVED_FOR_SHIPMENT'),
  };
}

beforeAll(async () => {
  usd = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'USD' } } })).id;
  usdRate = (await owner.currency.findFirstOrThrow({ where: { id: usd }, select: { conversion: true } })).conversion;
  bdt = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } } })).id;
  size20 = (await owner.containerSize.findFirstOrThrow({ where: { tenantId: null, code: '20STD' } })).id;
  containerUnit = (await owner.costUnit.findFirstOrThrow({ where: { tenantId: null, name: 'Container' } })).id;

  await cleanup();
  A = await makeWorld('Books Alpha', SLUG_A, 'A');
  B = await makeWorld('Books Beta', SLUG_B, 'B');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

const asA = () => as(A.superToken, SLUG_A);
const asB = () => as(B.superToken, SLUG_B);

interface Option {
  id: string;
  label: string;
  systemKey: string | null;
  balance: string | null;
}
let bank: string;
let cash: string;
let options: { moneyAccounts: Option[]; accounts: Option[] };

const account = (key: string): string => {
  const found = options.accounts.find((a) => a.systemKey === key);
  if (found === undefined) throw new Error(`no ${key} on the chart`);
  return found.id;
};

async function refreshOptions(): Promise<void> {
  const res = await asA().get('/vouchers/options');
  expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
  options = res.body.data;
}

async function moneyBalance(id: string): Promise<string> {
  await refreshOptions();
  return options.moneyAccounts.find((a) => a.id === id)!.balance!;
}

// ---------------------------------------------------------------------------

describe('Chart of accounts (§14.1)', () => {
  it('gives a new workspace the predefined chart the first time it is opened', async () => {
    const res = await asA().get('/chart');
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const heads = res.body.data.heads as { accountType: string; ledgers: { name: string; subLedgers: { name: string }[] }[] }[];
    // The sheet's own order: Expense, Income, Owners Equity, Liabilities, Asset.
    expect(heads.map((h) => h.accountType)).toEqual(['EXPENSE', 'INCOME', 'EQUITY', 'LIABILITY', 'ASSET']);
    const expense = heads[0]!;
    expect(expense.ledgers[0]!.name).toBe('Cost of Service');
    expect(expense.ledgers[0]!.subLedgers.map((s) => s.name)).toContain('Sea Freight-FCL');
    const asset = heads[4]!;
    expect(asset.ledgers.map((l) => l.name)).toEqual(
      expect.arrayContaining(['Bank', 'Cash', 'Expected Payments from Customers']),
    );
    // Opening it twice seeds nothing twice.
    await asA().get('/chart');
    const count = await owner.ledgerAccount.count({ where: { tenantId: A.tenantId, systemKey: 'ASSET.CASH' } });
    expect(count).toBe(1);
  });

  it('adds a sub ledger under a ledger ("+ ADD new"), and a new ledger under a head ("++")', async () => {
    const chart = (await asA().get('/chart')).body.data;
    const operating = chart.heads[0].ledgers.find((l: { name: string }) => l.name === 'Operating Expense');
    const sub = await asA().post('/chart').send({ accountType: 'EXPENSE', parentId: operating.id, name: 'Courier' });
    expect(sub.status, JSON.stringify(sub.body.error ?? {})).toBe(201);
    const ledger = await asA().post('/chart').send({ accountType: 'EXPENSE', name: 'Depreciation' });
    expect(ledger.status).toBe(201);

    const twice = await asA().post('/chart').send({ accountType: 'EXPENSE', parentId: operating.id, name: 'courier' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('DUPLICATE_NAME');
  });

  it('sends bank accounts to Account Set up, and keeps Bank and Cash switched on', async () => {
    const chart = (await asA().get('/chart')).body.data;
    const bankLedger = chart.heads[4].ledgers.find((l: { systemKey: string }) => l.systemKey === 'ASSET.BANK');
    const underBank = await asA().post('/chart').send({ accountType: 'ASSET', parentId: bankLedger.id, name: 'Bank Asia Ltd-878' });
    expect(underBank.status).toBe(400);
    expect(underBank.body.error.message).toContain('Account Set up');

    const off = await asA().post(`/chart/${bankLedger.id}/toggle-status`);
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('STRUCTURAL_ACCOUNT');
  });

  it('refuses, in the database, a chart three levels deep', async () => {
    const sub = await owner.ledgerAccount.findFirstOrThrow({
      where: { tenantId: A.tenantId, systemKey: 'ASSET.CASH.ON_HAND' },
      select: { id: true },
    });
    await expect(
      owner.ledgerAccount.create({
        data: { tenantId: A.tenantId, code: 'ACC-DEEP', accountType: 'ASSET', parentId: sub.id, name: 'Petty cash tin' },
      }),
    ).rejects.toThrow(/two levels deep/);
  });
});

describe('Bank Set up and Account Set up (§14.3)', () => {
  it('sets up a branch, then an account at it that appears on the chart under Bank', async () => {
    const branch = await asA()
      .post('/banks')
      .send({ bankName: 'Bank Asia Plc', branch: 'Ring Road', bankAddress: 'Ring Road, Mohammadpur, Dhaka', swiftNo: 'BAHDD9876', routingNo: '07214563' });
    expect(branch.status, JSON.stringify(branch.body.error ?? {})).toBe(201);
    expect(branch.body.data.code).toBe('BNK-001');

    const again = await asA().post('/banks').send({ bankName: 'bank asia plc', branch: 'ring road' });
    expect(again.status).toBe(409);

    const acct = await asA()
      .post('/bank-accounts')
      .send({ accountName: 'Triple S Logistics', accountNo: '08633033878', bankId: branch.body.data.id });
    expect(acct.status, JSON.stringify(acct.body.error ?? {})).toBe(201);
    // Sheet Z11: "Bank Asia Ltd-878" — the bank and the last three digits.
    expect(acct.body.data.ledgerName).toBe('Bank Asia Plc-878');
    expect(acct.body.data.swiftNo).toBe('BAHDD9876');
    bank = acct.body.data.ledgerAccountId;

    await refreshOptions();
    expect(options.moneyAccounts.map((a) => a.label)).toEqual(
      expect.arrayContaining(['Bank › Bank Asia Plc-878', 'Cash › Cash on Hand']),
    );
    cash = account('ASSET.CASH.ON_HAND');
  });

  it('keeps the chart name in step with the account, and refuses to rename it from the chart', async () => {
    const chart = (await asA().get('/chart')).body.data;
    const bankLedger = chart.heads[4].ledgers.find((l: { systemKey: string }) => l.systemKey === 'ASSET.BANK');
    const sub = bankLedger.subLedgers.find((s: { id: string }) => s.id === bank);
    expect(sub.bankAccountId).not.toBeNull();
    const rename = await asA().patch(`/chart/${bank}`).send({ name: 'Something else' });
    expect(rename.status).toBe(409);
    expect(rename.body.error.code).toBe('BANK_ACCOUNT_LEDGER');
  });
});

describe('the four Transaction screens (§14.4)', () => {
  it('Journal: an opening balance agreed into the books (Save & agreed)', async () => {
    const res = await asA()
      .post('/journal')
      .send({
        entryDate: TODAY,
        description: 'Opening balance of the Bank Asia account',
        post: true,
        lines: [
          { ledgerAccountId: bank, debit: '500000', credit: '' },
          { ledgerAccountId: account('EQUITY.OWNER.OPENING_BALANCE'), debit: '', credit: '500000' },
        ],
      });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    expect(res.body.data.code).toBe(`JV-${YEAR}-000001`);
    expect(res.body.data.status).toBe('POSTED');
    expect(await moneyBalance(bank)).toBe('500000.0000');
  });

  it('Journal: refuses a difference, and a draft (Save) moves nothing until it is agreed', async () => {
    const unbalanced = await asA()
      .post('/journal')
      .send({
        entryDate: TODAY,
        lines: [
          { ledgerAccountId: account('EXPENSE.PAYROLL.SALARY'), debit: '50000', credit: '' },
          { ledgerAccountId: bank, debit: '', credit: '40000' },
        ],
      });
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.body.error.message).toContain('must be equal');

    // The Journal sheet's own example: "Salary for the month of Sep 2026".
    const clerk = as(A.clerkToken, SLUG_A);
    const draft = await clerk.post('/journal').send({
      entryDate: TODAY,
      description: 'Salary for the month of Sep 2026',
      lines: [
        { ledgerAccountId: account('EXPENSE.PAYROLL.SALARY'), debit: '50000', credit: '' },
        { ledgerAccountId: bank, debit: '', credit: '50000' },
      ],
    });
    expect(draft.status, JSON.stringify(draft.body.error ?? {})).toBe(201);
    expect(draft.body.data.status).toBe('DRAFT');
    expect(draft.body.data.editable).toBe(true);
    expect(await moneyBalance(bank)).toBe('500000.0000');

    // The clerk may write it, not agree it.
    const agree = await clerk.post(`/journal/${draft.body.data.id}/post`);
    expect(agree.status).toBe(403);
    const self = await clerk.post('/journal').send({
      entryDate: TODAY,
      post: true,
      lines: [
        { ledgerAccountId: account('EXPENSE.PAYROLL.SALARY'), debit: '1', credit: '' },
        { ledgerAccountId: bank, debit: '', credit: '1' },
      ],
    });
    expect(self.status).toBe(403);

    const agreed = await asA().post(`/journal/${draft.body.data.id}/post`);
    expect(agreed.status, JSON.stringify(agreed.body.error ?? {})).toBe(200);
    expect(agreed.body.data.status).toBe('POSTED');
    expect(await moneyBalance(bank)).toBe('450000.0000');

    const edit = await asA()
      .patch(`/journal/${draft.body.data.id}`)
      .send({ entryDate: TODAY, lines: draft.body.data.lines });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('NOT_DRAFT');
  });

  it('Expense: Dr the categories, Cr "Payment from" — and the rows must add up', async () => {
    const off = await asA()
      .post('/expense')
      .send({
        entryDate: TODAY,
        moneyAccountId: bank,
        amount: '12000',
        lines: [{ ledgerAccountId: account('EXPENSE.OPERATING.RENT'), amount: '10000' }],
      });
    expect(off.status).toBe(400);
    expect(off.body.error.message).toContain('difference must be nil');

    const notExpense = await asA()
      .post('/expense')
      .send({ entryDate: TODAY, moneyAccountId: bank, amount: '1', lines: [{ ledgerAccountId: account('INCOME.OTHER.FIXED_DEPOSIT'), amount: '1' }] });
    expect(notExpense.status).toBe(400);

    const res = await asA()
      .post('/expense')
      .send({
        entryDate: TODAY,
        description: 'Office rent and internet, September',
        moneyAccountId: bank,
        amount: '12000',
        lines: [
          { ledgerAccountId: account('EXPENSE.OPERATING.RENT'), amount: '10000' },
          { ledgerAccountId: account('EXPENSE.OPERATING.INTERNET'), amount: '2000' },
        ],
      });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    expect(res.body.data.code).toBe(`PV-${YEAR}-000001`);
    expect(res.body.data.lines.map((l: { debit: string; credit: string }) => [l.debit, l.credit])).toEqual([
      ['10000.0000', '0.0000'],
      ['2000.0000', '0.0000'],
      ['0.0000', '12000.0000'],
    ]);
    expect(await moneyBalance(bank)).toBe('438000.0000');
  });

  it('Income (Other): Dr "Deposit to", Cr the categories', async () => {
    const res = await asA()
      .post('/income')
      .send({
        entryDate: TODAY,
        moneyAccountId: cash,
        amount: '3000',
        lines: [{ ledgerAccountId: account('INCOME.OTHER.FIXED_DEPOSIT'), amount: '3000' }],
      });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    expect(res.body.data.code).toBe(`RV-${YEAR}-000001`);
    expect(await moneyBalance(cash)).toBe('3000.0000');
  });

  it('Internal Transfer: out of one money account, into another — never into itself', async () => {
    const self = await asA()
      .post('/internal-transfer')
      .send({ entryDate: TODAY, moneyAccountId: bank, amount: '100', lines: [{ ledgerAccountId: bank, amount: '100' }] });
    expect(self.status).toBe(400);

    const notMoney = await asA()
      .post('/internal-transfer')
      .send({ entryDate: TODAY, moneyAccountId: bank, amount: '100', lines: [{ ledgerAccountId: account('EXPENSE.OPERATING.RENT'), amount: '100' }] });
    expect(notMoney.status).toBe(400);

    const res = await asA()
      .post('/internal-transfer')
      .send({ entryDate: TODAY, moneyAccountId: bank, amount: '8000', lines: [{ ledgerAccountId: cash, amount: '8000' }] });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    expect(res.body.data.code).toBe(`TV-${YEAR}-000001`);
    expect(await moneyBalance(bank)).toBe('430000.0000');
    expect(await moneyBalance(cash)).toBe('11000.0000');
  });

  it('shows the chart the same money, each ledger adding up its sub ledgers', async () => {
    const chart = (await asA().get('/chart')).body.data;
    const operating = chart.heads[0].ledgers.find((l: { name: string }) => l.name === 'Operating Expense');
    expect(operating.balance).toBe('12000.0000');
    const assets = chart.heads[4].ledgers;
    expect(assets.find((l: { systemKey: string }) => l.systemKey === 'ASSET.BANK').balance).toBe('430000.0000');
    // Owners Equity is credit-normal, so the opening shows positive.
    const owner_ = chart.heads[2].ledgers.find((l: { systemKey: string }) => l.systemKey === 'EQUITY.OWNER');
    expect(owner_.balance).toBe('500000.0000');
  });

  it('cancels a voucher with a reason, and takes it out of the balances', async () => {
    const list = await asA().get('/internal-transfer');
    expect(list.status).toBe(200);
    const transfer = list.body.data[0];
    expect(transfer.accounts).toBe('Bank Asia Plc-878 → Cash on Hand');

    const bare = await asA().post(`/internal-transfer/${transfer.id}/cancel`).send({ reason: ' ' });
    expect(bare.status).toBe(400);
    const done = await asA().post(`/internal-transfer/${transfer.id}/cancel`).send({ reason: 'Keyed twice' });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('CANCELLED');
    expect(done.body.data.code).toBe(`TV-${YEAR}-000001`);
    expect(await moneyBalance(bank)).toBe('438000.0000');
    expect(await moneyBalance(cash)).toBe('3000.0000');
  });

  it('refuses, in the database, a posted voucher that does not balance', async () => {
    await expect(
      owner.$transaction(async (tx) => {
        const entry = await tx.journalEntry.create({
          data: {
            tenantId: A.tenantId,
            code: `JV-${YEAR}-999999`,
            seriesYear: YEAR,
            kind: 'JOURNAL',
            entryDate: new Date(`${TODAY}T00:00:00Z`),
            status: 'POSTED',
          },
          select: { id: true },
        });
        await tx.journalLine.createMany({
          data: [
            { tenantId: A.tenantId, journalEntryId: entry.id, ledgerAccountId: BigInt(bank), debit: '10' },
            { tenantId: A.tenantId, journalEntryId: entry.id, ledgerAccountId: BigInt(cash), credit: '9' },
          ],
        });
      }),
    ).rejects.toThrow(/does not balance/);
  });
});

// ---------------------------------------------------------------------------

let debitInvoiceId: string;
let carrierCostId: string;

describe('Credit Invoice and Make Payment (§14.2, §14.6)', () => {
  it('lists the carrier’s invoice once the debit invoice is issued', async () => {
    const made = await asA()
      .post(`/shipments/${A.shipmentId}/debit-invoice`)
      .send({
        invoiceDate: TODAY,
        currencyId: usd.toString(),
        conversionRate: usdRate.toString(),
        recipientEmails: ['accounts@shafidi-a.test'],
        lines: [{ costHeadId: A.freightHead.toString(), containerSizeId: size20.toString(), quantity: '1', unitPrice: '1000' }],
        costs: [
          {
            partyType: 'CARRIER',
            partyId: A.carrierId.toString(),
            supplierInvoiceNo: 'Inv-CMA-001',
            currencyId: usd.toString(),
            conversionRate: usdRate.toString(),
            lines: [{ costHeadId: A.freightHead.toString(), containerSizeId: size20.toString(), quantity: '1', unitPrice: '800' }],
          },
        ],
      });
    expect(made.status, JSON.stringify(made.body.error ?? {})).toBe(201);
    debitInvoiceId = made.body.data.id;
    carrierCostId = made.body.data.costs[0].id;

    // A draft's supplier invoice is not a credit invoice yet — it is unbilled.
    const before = await asA().get('/credit-invoices');
    expect(before.body.data).toEqual([]);

    const sent = await asA().post(`/debit-invoices/${debitInvoiceId}/send`).send({ to: ['accounts@shafidi-a.test'] });
    expect(sent.status, JSON.stringify(sent.body.error ?? {})).toBe(200);

    const list = await asA().get('/credit-invoices');
    expect(list.status, JSON.stringify(list.body.error ?? {})).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: carrierCostId,
      supplierInvoiceNo: 'Inv-CMA-001',
      partyName: 'CMA-CGM A',
      currencyCode: 'USD',
      amount: '800.0000',
      // Sheet G8: =F8*E8.
      amountBase: fixed4(D(800).times(usdRate)),
      paymentStatus: 'UNPAID',
      deletable: true,
    });
  });

  it('offers the invoice under "Select Invoice No", with what is still owed', async () => {
    const docs = await asA().get(`/vouchers/open-documents?partyType=CARRIER&partyId=${A.carrierId}`);
    expect(docs.status, JSON.stringify(docs.body.error ?? {})).toBe(200);
    expect(docs.body.data).toEqual([
      expect.objectContaining({
        against: 'INVOICE',
        documentId: carrierCostId,
        reference: 'Inv-CMA-001',
        outstanding: '800.0000',
        serviceKey: 'SEA_FCL',
        // The block's frozen rate, to suggest what the bank will move.
        conversionRate: usdRate.toString(),
        isBaseCurrency: false,
      }),
    ]);

    // `Make Payment` names only the credit invoice; the form asks whose it is.
    const party = await asA().get(`/vouchers/document-party?creditInvoice=${carrierCostId}`);
    expect(party.status, JSON.stringify(party.body.error ?? {})).toBe(200);
    expect(party.body.data).toEqual({ partyType: 'CARRIER', partyId: A.carrierId.toString(), partyName: 'CMA-CGM A' });
    const customer = await asA().get(`/vouchers/document-party?debitInvoice=${debitInvoiceId}`);
    expect(customer.body.data).toMatchObject({ partyType: 'CUSTOMER', partyId: A.customerId.toString() });
    expect((await asB().get(`/vouchers/document-party?creditInvoice=${carrierCostId}`)).status).toBe(404);
  });

  it('pays part of it (Expense-Vendor), then the rest, and refuses a cent more', async () => {
    const pay = (amount: string) =>
      asA()
        .post('/expense')
        .send({
          entryDate: TODAY,
          moneyAccountId: bank,
          amount: fixed4(D(amount).times(usdRate)),
          lines: [{ ledgerAccountId: account('EXPENSE.COST_OF_SERVICE.SEA_FCL'), amount: fixed4(D(amount).times(usdRate)) }],
          settlement: { partyType: 'CARRIER', partyId: A.carrierId.toString(), against: 'INVOICE', documentId: carrierCostId, amount },
        });

    const part = await pay('300');
    expect(part.status, JSON.stringify(part.body.error ?? {})).toBe(201);
    expect(part.body.data.party).toMatchObject({ type: 'CARRIER', name: 'CMA-CGM A' });
    expect(part.body.data.settlement).toMatchObject({ reference: 'Inv-CMA-001', amount: '300.0000' });

    let list = await asA().get('/credit-invoices');
    expect(list.body.data[0]).toMatchObject({ paymentStatus: 'PARTIAL', paidAmount: '300.0000', outstandingAmount: '500.0000', deletable: false });

    const over = await pay('501');
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('OVER_PAID');

    const rest = await pay('500');
    expect(rest.status, JSON.stringify(rest.body.error ?? {})).toBe(201);
    list = await asA().get('/credit-invoices?payment=PAID');
    expect(list.body.data.map((r: { id: string }) => r.id)).toEqual([carrierCostId]);

    // "Pay to : ledger will update ( minus )": nothing is owed the carrier now.
    const rp = await asA().get('/receivable-payable?partyType=CARRIER&openOnly=false');
    const carrier = rp.body.data.find((r: { partyName: string }) => r.partyName === 'CMA-CGM A');
    expect(carrier.payableUsd).toBe('0.0000');
    expect(carrier.payableBase).toBe('0.0000');

    const ledger = await asA().get(`/receivable-payable/CARRIER/${A.carrierId}`);
    expect(ledger.body.data.entries.map((e: { kind: string }) => e.kind)).toEqual(['SUPPLIER_INVOICE', 'PAYMENT', 'PAYMENT']);
    expect(ledger.body.data.entries[0].paymentStatus).toBe('PAID');
    expect(ledger.body.data.entries[1].journalEntryCode).toMatch(/^PV-/);
  });

  it('will not let a paid credit invoice be deleted, repriced below what was paid, or its debit invoice cancelled', async () => {
    const del = await asA().delete(`/credit-invoices/${carrierCostId}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('CREDIT_INVOICE_PAID');

    const inv = (await asA().get(`/debit-invoices/${debitInvoiceId}`)).body.data;
    expect(inv.costs[0]).toMatchObject({ paymentStatus: 'PAID', paidAmount: '800.0000' });
    const cheaper = await asA()
      .put(`/debit-invoices/${debitInvoiceId}/costs`)
      .send({
        costs: [
          {
            id: carrierCostId,
            partyType: 'CARRIER',
            partyId: A.carrierId.toString(),
            supplierInvoiceNo: 'Inv-CMA-001',
            currencyId: usd.toString(),
            conversionRate: usdRate.toString(),
            lines: [{ costHeadId: A.freightHead.toString(), quantity: '1', unitPrice: '700' }],
          },
        ],
      });
    expect(cheaper.status).toBe(409);
    expect(cheaper.body.error.code).toBe('CREDIT_INVOICE_PAID');

    const cancel = await asA().post(`/debit-invoices/${debitInvoiceId}/cancel`).send({ reason: 'Wrong customer' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe('MONEY_PAID');
  });
});

describe('Receive against a debit invoice (§14.6)', () => {
  let voucherId: string;

  it('needs the Debit Invoice RECEIVE grant as well as Income', async () => {
    const clerk = as(A.clerkToken, SLUG_A);
    const res = await clerk.post('/income').send({
      entryDate: TODAY,
      moneyAccountId: cash,
      amount: '1',
      lines: [{ ledgerAccountId: account('INCOME.SERVICE.SEA_FCL'), amount: '1' }],
      settlement: { partyType: 'CUSTOMER', partyId: A.customerId.toString(), against: 'INVOICE', documentId: debitInvoiceId, amount: '1' },
    });
    expect(res.status).toBe(403);
  });

  it('banks the money, closes the invoice, and cancelling the voucher opens it again', async () => {
    const banked = fixed4(D(1000).times(usdRate));
    const res = await asA()
      .post('/income')
      .send({
        entryDate: TODAY,
        moneyAccountId: bank,
        amount: banked,
        lines: [{ ledgerAccountId: account('INCOME.SERVICE.SEA_FCL'), amount: banked }],
        settlement: { partyType: 'CUSTOMER', partyId: A.customerId.toString(), against: 'INVOICE', documentId: debitInvoiceId, amount: '1000' },
      });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    voucherId = res.body.data.id;

    let inv = (await asA().get(`/debit-invoices/${debitInvoiceId}`)).body.data;
    expect(inv.displayStatus).toBe('PAID');

    const cancelled = await asA().post(`/income/${voucherId}/cancel`).send({ reason: 'Cheque bounced' });
    expect(cancelled.status).toBe(200);
    inv = (await asA().get(`/debit-invoices/${debitInvoiceId}`)).body.data;
    expect(inv.displayStatus).toBe('UNPAID');
    expect(inv.receipts).toEqual([]);
  });
});

describe('the opening balance, settled (§14.6)', () => {
  it('pays off part of what CRM says we owed the vendor before the system', async () => {
    const docs = await asA().get(`/vouchers/open-documents?partyType=VENDOR&partyId=${A.vendorId}`);
    expect(docs.body.data).toEqual([
      expect.objectContaining({ against: 'OPENING', currencyCode: 'BDT', outstanding: '20000.0000' }),
    ]);

    // In the base currency, the amount settled and the amount paid are one figure.
    const mismatch = await asA()
      .post('/expense')
      .send({
        entryDate: TODAY,
        moneyAccountId: bank,
        amount: '5000',
        lines: [{ ledgerAccountId: account('EXPENSE.COST_OF_SERVICE.SEA_LCL'), amount: '5000' }],
        settlement: { partyType: 'VENDOR', partyId: A.vendorId.toString(), against: 'OPENING', amount: '4000' },
      });
    expect(mismatch.status).toBe(400);

    const res = await asA()
      .post('/expense')
      .send({
        entryDate: TODAY,
        moneyAccountId: bank,
        amount: '5000',
        lines: [{ ledgerAccountId: account('EXPENSE.COST_OF_SERVICE.SEA_LCL'), amount: '5000' }],
        settlement: { partyType: 'VENDOR', partyId: A.vendorId.toString(), against: 'OPENING', amount: '5000' },
      });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);

    const rp = await asA().get('/receivable-payable?partyType=VENDOR&openOnly=false');
    const vendor = rp.body.data.find((r: { partyName: string }) => r.partyName === 'Trust Cargo A');
    expect(vendor.payableBase).toBe('15000.0000');
    const ledger = await asA().get(`/receivable-payable/VENDOR/${A.vendorId}`);
    expect(ledger.body.data.entries.map((e: { kind: string }) => e.kind)).toEqual(['OPENING', 'OPENING_SETTLEMENT']);
  });
});

describe('the Receivable-Payable list’s Unbilled column (§14.7)', () => {
  it('carries the quoted amount of a confirmed booking nobody has invoiced yet', async () => {
    const rp = await asA().get('/receivable-payable?partyType=CUSTOMER');
    expect(rp.status).toBe(200);
    const customer = rp.body.data.find((r: { partyName: string }) => r.partyName === 'Shafidi Exports A');
    // The second booking's quotation: 1 x USD 1,000.
    expect(customer.unbilledUsd).toBe('1000.0000');
    expect(customer.unbilledBase).toBe(fixed4(D(1000).times(usdRate)));
    expect(rp.body.meta.totals.unbilledUsd).toBe('1000.0000');
  });

  it('moves to the draft invoice’s figures once one is started, suppliers included', async () => {
    const made = await asA()
      .post(`/shipments/${A.unbilledShipmentId}/debit-invoice`)
      .send({
        invoiceDate: TODAY,
        currencyId: usd.toString(),
        conversionRate: usdRate.toString(),
        lines: [{ costHeadId: A.freightHead.toString(), quantity: '1', unitPrice: '1100' }],
        costs: [
          {
            partyType: 'VENDOR',
            partyId: A.vendorId.toString(),
            currencyId: bdt.toString(),
            conversionRate: '1',
            lines: [{ costHeadId: A.freightHead.toString(), quantity: '1', unitPrice: '7000' }],
          },
        ],
      });
    expect(made.status, JSON.stringify(made.body.error ?? {})).toBe(201);

    const rp = await asA().get('/receivable-payable?openOnly=false');
    const byName = new Map(rp.body.data.map((r: { partyName: string }) => [r.partyName, r]));
    expect((byName.get('Shafidi Exports A') as Record<string, string>).unbilledUsd).toBe('1100.0000');
    const vendor = byName.get('Trust Cargo A') as Record<string, string>;
    expect(vendor.unbilledBase).toBe('7000.0000');
    // Unbilled is not payable yet.
    expect(vendor.payableBase).toBe('15000.0000');
  });
});

// ---------------------------------------------------------------------------

describe('who may see what', () => {
  it('guards every books route with its own permission', async () => {
    const bare = as(A.bareToken, SLUG_A);
    for (const path of [
      '/chart',
      '/banks',
      '/bank-accounts',
      '/bank-accounts/banks',
      '/journal',
      '/expense',
      '/income',
      '/internal-transfer',
      '/credit-invoices',
      '/vouchers/options',
      `/vouchers/open-documents?partyType=CUSTOMER&partyId=${A.customerId}`,
      `/vouchers/document-party?creditInvoice=${carrierCostId}`,
    ]) {
      expect((await bare.get(path)).status, path).toBe(403);
    }
    expect((await bare.post('/expense').send({})).status).toBe(403);
    expect((await bare.delete(`/credit-invoices/${carrierCostId}`)).status).toBe(403);
    const anon = await request(app).get('/api/tenant/accounts/journal').set('X-Tenant-Slug', SLUG_A);
    expect(anon.status).toBe(401);
  });

  it('shows workspace B none of workspace A (§7A rule 4)', async () => {
    const [journal, expense, banks, accounts, credits] = await Promise.all([
      asB().get('/journal'),
      asB().get('/expense'),
      asB().get('/banks'),
      asB().get('/bank-accounts'),
      asB().get('/credit-invoices'),
    ]);
    for (const res of [journal, expense, banks, accounts, credits]) {
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
    const aJournal = (await asA().get('/journal')).body.data[0].id as string;
    expect((await asB().get(`/journal/${aJournal}`)).status).toBe(404);

    // B's own chart is its own, and holds none of A's money.
    const chart = (await asB().get('/chart')).body.data;
    const bankLedger = chart.heads[4].ledgers.find((l: { systemKey: string }) => l.systemKey === 'ASSET.BANK');
    expect(bankLedger.subLedgers).toEqual([]);
    expect(bankLedger.balance).toBe('0.0000');

    // A's bank account cannot be paid from in B.
    await asB().get('/vouchers/options');
    const cross = await asB()
      .post('/expense')
      .send({ entryDate: TODAY, moneyAccountId: bank, amount: '1', lines: [{ ledgerAccountId: bank, amount: '1' }] });
    expect(cross.status).toBe(400);
  });
});
