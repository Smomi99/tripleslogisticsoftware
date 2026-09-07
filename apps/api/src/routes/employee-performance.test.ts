import { PrismaPg } from '@prisma/adapter-pg';
import { resolvePeriod } from '@ff/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * The Employee Performance Report — client wireframe, 2026-09-07.
 *
 * Two properties carry this suite. Every figure must count only this
 * employee's work inside the period — a report that quietly includes a
 * colleague's shipment is worse than no report, because somebody is paid on
 * it. And every figure must agree with the list behind it, since the client
 * asked for both and an operator who finds them disagreeing stops trusting the
 * screen.
 *
 * Fixtures sit either side of the period boundary on purpose: one of each kind
 * inside it, one outside, one belonging to somebody else.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'perf-alpha';

let tenantId: bigint;
let token: string;
/** Holds no CRM.EMPLOYEE.VIEW — the report is behind it. */
let tokenOutsider: string;
let subject: bigint;
let colleague: bigint;

/** Inside THIS_MONTH, given the suite runs on a real clock. */
const inPeriod = new Date(`${new Date().toISOString().slice(0, 8)}01T09:00:00.000Z`);
/** Comfortably before it. */
const outOfPeriod = new Date('2024-02-14T09:00:00.000Z');

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of [
    'shipment_cargo_line',
    'shipment_po',
    'shipment',
    'quotation_line',
    'quotation',
    'inquiry_volume',
    'inquiry_commodity',
    'inquiry',
    'sales_lead_followup',
    'sales_lead',
    'inquiry_source',
    'customer_pic',
    'customer',
    'industry_sector',
    'currency',
    'carrier',
    'port',
    'goods_type',
    'audit_log',
    '"user"',
    'employee',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug = '${SLUG}'`);
}

const as = (t: string) => (path: string) =>
  request(app).get(path).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG);

const report = (query = '') => as(token)(`/api/tenant/crm/employees/${subject}/performance${query}`);
const detail = (metric: string, query = '') =>
  as(token)(`/api/tenant/crm/employees/${subject}/performance/${metric}${query}`);

beforeAll(async () => {
  await cleanup();

  const tenant = await owner.tenant.create({
    data: { name: 'Perf Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  subject = (
    await owner.employee.create({
      data: { tenantId, code: 'EMP-P1', name: 'Mr Nasir', country: 'Bangladesh', incentivePercentage: '7.50' },
      select: { id: true },
    })
  ).id;
  colleague = (
    await owner.employee.create({
      data: { tenantId, code: 'EMP-P2', name: 'Someone Else', country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  // The subject's own login — a lead records who created it as a USER.
  const subjectUser = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-P1',
      username: 'nasir',
      email: 'nasir@perf.test',
      passwordHash: 'x',
      employeeId: subject,
      isSuperadmin: true,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: subjectUser.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  const plain = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-P3',
      username: 'outsider',
      email: 'outsider@perf.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenOutsider = await signAccessToken({
    sub: plain.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: [],
    tokenVersion: 0,
  });

  // ------------------------------------------------------------- masters
  const garments = await owner.industrySector.create({
    data: { tenantId, code: 'PIS-1', name: 'Garments' },
    select: { id: true },
  });
  const leather = await owner.industrySector.create({
    data: { tenantId, code: 'PIS-2', name: 'Leather' },
    select: { id: true },
  });
  const source = await owner.inquirySource.create({
    data: { tenantId, code: 'PSRC', name: 'Direct' },
    select: { id: true },
  });
  const port = (code: string, name: string) =>
    owner.port.create({
      data: { tenantId, code, name, portCode: code, country: 'Bangladesh', type: 'SEAPORT' },
      select: { id: true },
    });
  const pol = await port('PPOL', 'Chittagong');
  const pod = await port('PPOD', 'Hamburg');
  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: 'PCAR', name: 'Perf Lines', typeId: carrierType.id },
    select: { id: true },
  });
  const currency = await owner.currency.create({
    data: { tenantId, code: 'PCUR', currency: 'PFT — Perf Test Dollar', conversion: '120.0000' },
    select: { id: true },
  });

  // ----------------------------------------------------------- customers
  const customer = async (
    code: string,
    name: string,
    sectorId: bigint,
    salesmanId: bigint | null,
    createdAt: Date,
  ) =>
    owner.customer.create({
      data: {
        tenantId,
        code,
        name,
        country: 'Bangladesh',
        customerType: 'EXPORTER',
        businessArea: 'BOTH',
        industrySectorId: sectorId,
        salesmanId,
        createdAt,
      },
      select: { id: true },
    });

  // Two in period, in two categories — so the category count is distinct.
  const alpha = await customer('PCUS-1', 'Alpha Apparels', garments.id, subject, inPeriod);
  await customer('PCUS-2', 'Beta Knitwear', garments.id, subject, inPeriod);
  await customer('PCUS-3', 'Gamma Leather', leather.id, subject, inPeriod);
  // One outside the period, one belonging to a colleague.
  await customer('PCUS-4', 'Old Customer', garments.id, subject, outOfPeriod);
  await customer('PCUS-5', 'Not Mine', garments.id, colleague, inPeriod);

  // ----------------------------------------------------------- inquiries
  const today = new Date().toISOString().slice(0, 10);
  const inquiry = async (code: string, salesmanId: bigint | null, date: string) =>
    owner.inquiry.create({
      data: {
        tenantId,
        code,
        seriesYear: Number(date.slice(0, 4)),
        inquiryDate: new Date(`${date}T00:00:00.000Z`),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: alpha.id,
        movementType: 'OUTBOUND',
        polId: pol.id,
        podId: pod.id,
        salesmanId,
        status: 'OPEN',
      },
      select: { id: true },
    });
  const mine = await inquiry('PINQ-1', subject, today);
  await inquiry('PINQ-2', subject, today);
  await inquiry('PINQ-3', subject, '2024-02-14');
  await inquiry('PINQ-4', colleague, today);

  // ----------------------------------------------------------- shipments
  const quotation = await owner.quotation.create({
    data: {
      tenantId,
      code: 'PQTN-1',
      seriesYear: 2026,
      inquiryId: mine.id,
      quotationDate: new Date(`${today}T00:00:00.000Z`),
      customerId: alpha.id,
      shipmentType: 'SEA',
      movementType: 'OUTBOUND',
      polId: pol.id,
      podId: pod.id,
      carrierId: carrier.id,
      localCurrencyId: currency.id,
      conversionRate: '120.0000',
    },
    select: { id: true },
  });
  const shipment = async (code: string, type: 'AIR' | 'SEA', createdAt: Date) =>
    owner.shipment.create({
      data: {
        tenantId,
        code,
        seriesYear: 2026,
        quotationId: quotation.id,
        shipmentType: type,
        customerId: alpha.id,
        carrierId: carrier.id,
        polId: pol.id,
        podId: pod.id,
        createdAt,
      },
      select: { id: true },
    });
  await shipment('PBKG-1', 'SEA', inPeriod);
  await shipment('PBKG-2', 'SEA', inPeriod);
  await shipment('PBKG-3', 'AIR', inPeriod);
  await shipment('PBKG-4', 'AIR', outOfPeriod);

  // --------------------------------------------------------- sales leads
  const lead = async (code: string, name: string, createdBy: bigint, createdAt: Date) =>
    owner.salesLead.create({ data: { tenantId, code, name, createdBy, createdAt } });
  await lead('PLED-1', 'A prospect', subjectUser.id, inPeriod);
  await lead('PLED-2', 'Another prospect', subjectUser.id, inPeriod);
  await lead('PLED-3', 'An old prospect', subjectUser.id, outOfPeriod);
  await lead('PLED-4', 'Not mine', plain.id, inPeriod);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

// ---------------------------------------------------------------- periods

describe('the report period', () => {
  // A fixed clock, so these say what they mean rather than what today is.
  const on = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

  it('runs this month from the first to today', () => {
    expect(resolvePeriod('THIS_MONTH', on('2026-09-07'))).toEqual({
      from: '2026-09-01',
      to: '2026-09-07',
    });
  });

  it('runs last month end to end, not a rolling thirty days', () => {
    // The whole of August, including its 31st — the question "how did I do
    // last month" is about a calendar month.
    expect(resolvePeriod('LAST_MONTH', on('2026-09-07'))).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  it('handles last month across a year boundary', () => {
    expect(resolvePeriod('LAST_MONTH', on('2026-01-09'))).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('handles last month landing on February', () => {
    expect(resolvePeriod('LAST_MONTH', on('2028-03-15'))).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('runs the week from Monday', () => {
    // 2026-09-07 is a Monday, so this week starts today.
    expect(resolvePeriod('THIS_WEEK', on('2026-09-07'))).toEqual({
      from: '2026-09-07',
      to: '2026-09-07',
    });
    // 2026-09-13 is the Sunday after it.
    expect(resolvePeriod('THIS_WEEK', on('2026-09-13'))).toEqual({
      from: '2026-09-07',
      to: '2026-09-13',
    });
  });

  it('counts three, six and twelve months back', () => {
    expect(resolvePeriod('LAST_3_MONTHS', on('2026-09-07')).from).toBe('2026-06-07');
    expect(resolvePeriod('LAST_6_MONTHS', on('2026-09-07')).from).toBe('2026-03-07');
    expect(resolvePeriod('LAST_12_MONTHS', on('2026-09-07')).from).toBe('2025-09-07');
  });

  it('runs the year from January', () => {
    expect(resolvePeriod('THIS_YEAR', on('2026-09-07'))).toEqual({
      from: '2026-01-01',
      to: '2026-09-07',
    });
  });

  it('takes the dates given for a custom range', () => {
    expect(
      resolvePeriod('CUSTOM', on('2026-09-07'), { from: '2026-04-01', to: '2026-04-30' }),
    ).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });
});

// ---------------------------------------------------------------- the report

describe('the performance report', () => {
  const metric = (body: unknown, key: string) =>
    (body as { data: { metrics: { key: string; value: number | null; pendingReason: string | null }[] } }).data.metrics.find(
      (m) => m.key === key,
    );

  it('counts only this employee, only in the period', async () => {
    const res = await report();
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // Three customers in period; the fourth is old and the fifth is somebody
    // else's.
    expect(metric(res.body, 'CUSTOMERS')?.value).toBe(3);
    // Two inquiries; one is old and one is a colleague's.
    expect(metric(res.body, 'INQUIRIES')?.value).toBe(2);
    expect(metric(res.body, 'SEA_SHIPMENTS')?.value).toBe(2);
    expect(metric(res.body, 'AIR_SHIPMENTS')?.value).toBe(1);
    expect(metric(res.body, 'SALES_LEADS')?.value).toBe(2);
  });

  it('counts a commodity category once, however many customers sit in it', async () => {
    // Two garment customers and one leather one is two categories, not three.
    const res = await report();
    expect(metric(res.body, 'COMMODITY_CATEGORIES')?.value).toBe(2);
  });

  it('names the employee and the dates it covers', async () => {
    const res = await report();
    const data = res.body.data as { employeeName: string; from: string; to: string; incentivePercentage: string | null };
    expect(data.employeeName).toBe('Mr Nasir');
    expect(data.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(data.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // From the employee record, per the client's note.
    expect(data.incentivePercentage).toBe('7.5');
  });

  it('says why the money figures are missing rather than showing zero', async () => {
    /*
     * The client's note defines them from tables that do not exist yet — a
     * booking debit note and an invoice margin. A zero would be a lie an
     * operator could act on.
     */
    const res = await report();
    for (const key of ['REVENUE', 'GROSS_PROFIT', 'INCENTIVE']) {
      const m = metric(res.body, key);
      expect(m?.value, key).toBeNull();
      expect(m?.pendingReason, key).toMatch(/Accounts module/);
    }
  });

  it('finds nothing in a period the work is not in', async () => {
    const res = await report('?period=CUSTOM&from=2020-01-01&to=2020-12-31');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const key of ['CUSTOMERS', 'INQUIRIES', 'SEA_SHIPMENTS', 'SALES_LEADS']) {
      expect(metric(res.body, key)?.value, key).toBe(0);
    }
  });

  it('widens to a year and picks the old work back up', async () => {
    const res = await report('?period=CUSTOM&from=2024-01-01&to=2030-12-31');
    expect(metric(res.body, 'CUSTOMERS')?.value).toBe(4);
    expect(metric(res.body, 'INQUIRIES')?.value).toBe(3);
    expect(metric(res.body, 'AIR_SHIPMENTS')?.value).toBe(2);
  });

  it('refuses a custom period with only one date', async () => {
    const res = await report('?period=CUSTOM&from=2026-01-01');
    expect(res.status).toBe(400);
  });

  it('refuses a period that ends before it starts', async () => {
    const res = await report('?period=CUSTOM&from=2026-09-30&to=2026-09-01');
    expect(res.status).toBe(400);
  });
});

// ------------------------------------------------------------ the drilldowns

describe('the detail behind a figure', () => {
  const rows = (body: unknown) =>
    (body as { data: { code: string; title: string; subtitle: string | null }[] }).data;

  it('lists exactly the customers it counted', async () => {
    const res = await detail('CUSTOMERS');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rows(res.body)).toHaveLength(3);
    expect(rows(res.body).map((r) => r.title).sort()).toEqual([
      'Alpha Apparels',
      'Beta Knitwear',
      'Gamma Leather',
    ]);
  });

  it("lists the inquiries, not a colleague's", async () => {
    const res = await detail('INQUIRIES');
    expect(rows(res.body).map((r) => r.code).sort()).toEqual(['PINQ-1', 'PINQ-2']);
  });

  it('lists each category once, with how many customers sit in it', async () => {
    const res = await detail('COMMODITY_CATEGORIES');
    const found = rows(res.body);
    expect(found.map((r) => r.title).sort()).toEqual(['Garments', 'Leather']);
    expect(found.find((r) => r.title === 'Garments')?.subtitle).toBe('2 customers');
    expect(found.find((r) => r.title === 'Leather')?.subtitle).toBe('1 customer');
  });

  it('splits air from sea', async () => {
    expect(rows((await detail('AIR_SHIPMENTS')).body).map((r) => r.code)).toEqual(['PBKG-3']);
    expect(rows((await detail('SEA_SHIPMENTS')).body).map((r) => r.code).sort()).toEqual([
      'PBKG-1',
      'PBKG-2',
    ]);
  });

  it('lists the leads this employee raised', async () => {
    const res = await detail('SALES_LEADS');
    expect(rows(res.body).map((r) => r.code).sort()).toEqual(['PLED-1', 'PLED-2']);
  });

  it('agrees with the count, on every drillable figure', async () => {
    /*
     * The property worth the most here. The client asked for both a number and
     * the rows behind it; the two disagreeing is how somebody stops trusting
     * the screen.
     */
    const summary = await report();
    const metrics = (summary.body as { data: { metrics: { key: string; value: number | null; drillable: boolean }[] } }).data.metrics;

    for (const m of metrics.filter((x) => x.drillable)) {
      const list = await detail(m.key);
      expect(list.status, m.key).toBe(200);
      expect(rows(list.body).length, m.key).toBe(m.value);
    }
  });

  it('honours the same period as the report', async () => {
    const res = await detail('CUSTOMERS', '?period=CUSTOM&from=2020-01-01&to=2020-12-31');
    expect(rows(res.body)).toHaveLength(0);
  });

  it('refuses a figure that has no rows behind it', async () => {
    const res = await detail('REVENUE');
    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/Accounts module/);
  });

  it('refuses a metric it does not know', async () => {
    expect((await detail('MADE_UP')).status).toBe(400);
  });
});

describe('§7 — the report is behind the employee permission', () => {
  it('refuses a user without CRM.EMPLOYEE.VIEW', async () => {
    const res = await as(tokenOutsider)(`/api/tenant/crm/employees/${subject}/performance`);
    expect(res.status).toBe(403);
    const list = await as(tokenOutsider)(
      `/api/tenant/crm/employees/${subject}/performance/CUSTOMERS`,
    );
    expect(list.status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request(app)
      .get(`/api/tenant/crm/employees/${subject}/performance`)
      .set('X-Tenant-Slug', SLUG);
    expect(res.status).toBe(401);
  });

  it('404s for an employee who does not exist', async () => {
    const res = await as(token)('/api/tenant/crm/employees/99999999/performance');
    expect(res.status).toBe(404);
  });
});
