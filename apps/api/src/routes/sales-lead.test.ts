import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Sales leads — the client's FOB Sales Lead Form (docs/SALES_LEAD_FOB.md), and
 * MODULE_PURCHASE_SALES §9 Q12's link from an inquiry back to its lead.
 *
 * What these check hardest: the form's arithmetic (§4) and KPIs (§7), that a
 * follow-up moves the lead's next date, that raising an inquiry moves the lead
 * along, and that nothing here crosses a workspace (§7A rule 4).
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG_A = 'lead-alpha';
const SLUG_B = 'lead-beta';
const PREFIX = 'LEADTEST-';

const LEAD_PERMS = [
  'SALES.NEW_SALES_LEAD.VIEW',
  'SALES.NEW_SALES_LEAD.CREATE',
  'SALES.NEW_SALES_LEAD.EDIT',
  'SALES.NEW_SALES_LEAD.TOGGLE_STATUS',
  'SALES.SALES_LEAD_FOLLOWUP.VIEW',
  'SALES.SALES_LEAD_FOLLOWUP.CREATE',
];

let tenantA: bigint;
let tenantB: bigint;
let tokenAdmin: string;
let tokenLeadUser: string;
let leadBId: bigint;

let sourceId: bigint;
let customerId: bigint;
let polId: bigint;
let podId: bigint;
let airPolId: bigint;
let airPodId: bigint;
let ownerId: bigint;
let otherOwnerId: bigint;
let commodityItemId: bigint;
let fortyId: bigint;
let createdUsd: boolean;

/** Today as the workspace reads it — follow-ups fall due on Dhaka's days. */
const today = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

function shift(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

async function makeUser(
  tenantId: bigint,
  suffix: string,
  permissions: string[],
  isSuperadmin = false,
): Promise<string> {
  const user = await owner.user.create({
    data: {
      tenantId,
      code: `USR-${suffix}`,
      username: `user-${suffix}`,
      email: `${suffix}@lead.test`,
      passwordHash: 'x',
      isSuperadmin,
    },
    select: { id: true },
  });
  return signAccessToken({
    sub: user.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin,
    permissions,
    tokenVersion: 0,
  });
}

async function cleanup(): Promise<void> {
  const t = `SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`;
  for (const table of [
    'email_log',
    'inquiry_rate',
    'inquiry_followup',
    'inquiry_commodity',
    'inquiry_volume',
    'inquiry',
    'sales_lead_document',
    'sales_lead_followup',
    'sales_lead',
    '"user"',
    'commodity_item',
    'customer',
    'industry_sector',
    'employee',
    'container_size',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN (${t})`);
  }
  await owner.$executeRawUnsafe(`DELETE FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_source WHERE code LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM port WHERE code LIKE '${PREFIX}%'`);
}

beforeAll(async () => {
  await cleanup();

  tenantA = (
    await owner.tenant.create({
      data: { name: 'Lead Alpha', slug: SLUG_A, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;
  tenantB = (
    await owner.tenant.create({
      data: { name: 'Lead Beta', slug: SLUG_B, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  tokenAdmin = await makeUser(tenantA, `super-${SLUG_A}`, [], true);
  tokenLeadUser = await makeUser(tenantA, `lead-${SLUG_A}`, [
    ...LEAD_PERMS,
    'SALES.INQUIRY.VIEW',
    'SALES.INQUIRY.CREATE',
  ]);

  sourceId = (
    await owner.inquirySource.create({
      data: { code: `${PREFIX}SRC`, name: 'Lead Test Source' },
      select: { id: true },
    })
  ).id;

  const mkPort = async (suffix: string, name: string, portCode: string, type: 'SEAPORT' | 'AIRPORT') =>
    (
      await owner.port.create({
        data: { code: `${PREFIX}${suffix}`, name, portCode, country: 'Bangladesh', type },
        select: { id: true },
      })
    ).id;
  polId = await mkPort('POL', 'Lead Origin', 'LDPOL1', 'SEAPORT');
  podId = await mkPort('POD', 'Lead Dest', 'LDPOD1', 'SEAPORT');
  airPolId = await mkPort('APOL', 'Lead Air Origin', 'LDA1', 'AIRPORT');
  airPodId = await mkPort('APOD', 'Lead Air Dest', 'LDA2', 'AIRPORT');

  const mkEmployee = async (suffix: string) =>
    (
      await owner.employee.create({
        data: { tenantId: tenantA, code: `EMP-${PREFIX}${suffix}`, name: `Sales ${suffix}`, country: 'Bangladesh', department: 'Sales' },
        select: { id: true },
      })
    ).id;
  ownerId = await mkEmployee('1');
  otherOwnerId = await mkEmployee('2');

  const sector = await owner.industrySector.create({
    data: { tenantId: tenantA, code: `ISC-${PREFIX}`, name: 'Lead Garments' },
    select: { id: true },
  });
  customerId = (
    await owner.customer.create({
      data: {
        tenantId: tenantA,
        code: `CUS-${PREFIX}`,
        name: 'Lead Test Customer',
        country: 'Bangladesh',
        customerType: 'EXPORTER',
        businessArea: 'OUTBOUND',
        industrySectorId: sector.id,
      },
      select: { id: true },
    })
  ).id;
  commodityItemId = (
    await owner.commodityItem.create({
      data: {
        tenantId: tenantA,
        code: `CIT-${PREFIX}`,
        industrySectorId: sector.id,
        name: 'Knit T-Shirts',
        hsCode: '610910',
      },
      select: { id: true },
    })
  ).id;
  fortyId = (
    await owner.containerSize.create({
      data: { tenantId: tenantA, code: `${PREFIX}40HC`, name: '40 High Cube', teuFactor: '2.00' },
      select: { id: true },
    })
  ).id;

  // §4 writes its figures in USD; a fresh database seeds it, but say so if not.
  const usd = await owner.currency.findFirst({
    where: { deletedAt: null, currency: { startsWith: 'USD' } },
    select: { id: true },
  });
  createdUsd = usd === null;
  if (createdUsd) {
    await owner.currency.create({
      data: { code: `${PREFIX}USD`, currency: 'USD — US Dollar', conversion: '1' },
    });
  }

  leadBId = (
    await owner.salesLead.create({
      data: {
        tenantId: tenantB,
        code: 'FOB-2026-0999',
        seriesYear: 2026,
        leadDate: new Date('2026-03-01'),
        name: 'Beta Lead',
        nextFollowupDate: new Date(shift(today(), -3)),
      },
      select: { id: true },
    })
  ).id;
  await owner.salesLeadFollowup.create({
    data: { tenantId: tenantB, leadId: leadBId, followupDate: new Date('2026-03-02'), contactMode: 'CALL' },
  });
});

beforeEach(async () => {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG_A}'`;
  for (const table of [
    'inquiry_volume',
    'inquiry',
    'sales_lead_document',
    'sales_lead_followup',
    'sales_lead',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN (${t})`);
  }
});

afterAll(async () => {
  await cleanup();
  if (createdUsd) {
    await owner.$executeRawUnsafe(`DELETE FROM currency WHERE code = '${PREFIX}USD'`);
  }
  await owner.$disconnect();
});

function as(token: string, slug = SLUG_A) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  return {
    get: (path: string) => wrap(request(app).get(path)),
    post: (path: string) => wrap(request(app).post(path)),
    patch: (path: string) => wrap(request(app).patch(path)),
    delete: (path: string) => wrap(request(app).delete(path)),
  };
}

/** A complete §1–§4 form, with whatever a test needs changed. */
function leadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leadDate: '2026-03-10',
    sourceId: sourceId.toString(),
    ownerId: ownerId.toString(),
    businessType: 'NEW_CUSTOMER',
    priority: 'HIGH',
    name: 'Acme Textiles',
    exporterContact: 'Mr Rahman',
    exporterMobile: '+8801711000000',
    exporterEmail: 'rahman@acme.test',
    factoryLocation: 'Gazipur',
    buyerName: 'Nordic Retail AB',
    buyerCountry: 'Sweden',
    buyingHouse: 'Dhaka Sourcing Ltd',
    agentName: 'Baltic Freight',
    agentCountry: 'Sweden',
    agentContact: 'ops@baltic.test',
    commodityItemId: commodityItemId.toString(),
    shipmentMode: 'SEA_FCL',
    polId: polId.toString(),
    podId: podId.toString(),
    containerSizeId: fortyId.toString(),
    monthlyVolume: '10',
    shipmentFrequency: 'WEEKLY',
    firstShipmentDate: '2026-05-01',
    incumbentForwarder: 'Other Forwarder Ltd',
    requirements: 'Weekly 40HC, 30 days free time at destination',
    freightControl: 'FREE_HAND',
    status: 'NEW',
    revenuePerUnit: '1200',
    profitPerUnit: '150',
    marketRatePerUnit: '1250',
    marketRateSource: 'Buyer',
    winProbability: '40',
    nextFollowupDate: '',
    outcomeReason: '',
    ...overrides,
  };
}

async function createLead(overrides: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const response = await as(tokenLeadUser).post('/api/tenant/sales/leads').send(leadBody(overrides));
  expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
  return { id: response.body.data.id, code: response.body.data.code };
}

describe('§1 — the Lead ID', () => {
  it('is FOB-<year>-0001, the year being the lead date’s', async () => {
    const response = await as(tokenLeadUser).post('/api/tenant/sales/leads').send(leadBody());
    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    expect(response.body.data.code).toBe('FOB-2026-0001');
    expect(response.body.data.status).toBe('NEW');
    expect(response.body.data.followupCount).toBe(0);
    expect(response.body.data.inquiryCount).toBe(0);
  });

  it('numbers in sequence, and starts again for another year', async () => {
    await createLead();
    const second = await createLead({ name: 'Second' });
    const lastYear = await createLead({ name: 'Old', leadDate: '2025-12-30' });
    expect(second.code).toBe('FOB-2026-0002');
    expect(lastYear.code).toBe('FOB-2025-0001');
  });

  it('numbers each workspace independently', async () => {
    // Tenant B holds FOB-2026-0999; tenant A still starts at 0001.
    const lead = await createLead();
    expect(lead.code).toBe('FOB-2026-0001');
  });

  it('keeps the transaction usable when a number clashes (lib/codes inSavepoint)', async () => {
    /*
      A row the series cannot see — no series_year — already holds the number
      it will compute. Every attempt clashes, so the request must end in the
      route's own 409. Before the savepoint, the first clash aborted the
      transaction and the retry died with a 500 instead.
    */
    await owner.salesLead.create({
      data: { tenantId: tenantA, code: 'FOB-2026-0001', leadDate: new Date('2026-01-05'), name: 'Hand-numbered' },
    });
    const response = await as(tokenLeadUser).post('/api/tenant/sales/leads').send(leadBody());
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CODE_GENERATION_FAILED');
  });
});

describe('§1–§3 — what the form requires', () => {
  it.each([
    ['name', { name: '' }],
    ['ownerId', { ownerId: '' }],
    ['sourceId', { sourceId: '' }],
    ['businessType', { businessType: '' }],
    ['commodityItemId', { commodityItemId: '' }],
    ['shipmentMode', { shipmentMode: '' }],
    ['polId', { polId: '' }],
  ])('refuses a lead with no %s', async (field, override) => {
    const response = await as(tokenLeadUser).post('/api/tenant/sales/leads').send(leadBody(override));
    expect(response.status).toBe(400);
    expect(response.body.error.fields[field]).toBeDefined();
  });

  it('refuses the same port at both ends', async () => {
    const response = await as(tokenLeadUser)
      .post('/api/tenant/sales/leads')
      .send(leadBody({ podId: polId.toString() }));
    expect(response.status).toBe(400);
    expect(response.body.error.fields.podId).toBeDefined();
  });

  it('refuses an equipment type on an LCL lead', async () => {
    const response = await as(tokenLeadUser)
      .post('/api/tenant/sales/leads')
      .send(leadBody({ shipmentMode: 'SEA_LCL' }));
    expect(response.status).toBe(400);
    expect(response.body.error.fields.containerSizeId).toBeDefined();
  });

  it('refuses an air lead between seaports', async () => {
    const response = await as(tokenLeadUser)
      .post('/api/tenant/sales/leads')
      .send(leadBody({ shipmentMode: 'AIR', containerSizeId: '' }));
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/airports/);
  });

  it('takes an air lead between airports, with no loading type', async () => {
    const lead = await createLead({
      shipmentMode: 'AIR',
      containerSizeId: '',
      polId: airPolId.toString(),
      podId: airPodId.toString(),
    });
    const row = await owner.salesLead.findUniqueOrThrow({ where: { id: BigInt(lead.id) } });
    expect(row.shipmentType).toBe('AIR');
    expect(row.loadingType).toBeNull();
  });

  it('is edited, not replaced', async () => {
    const lead = await createLead();
    const response = await as(tokenLeadUser)
      .patch(`/api/tenant/sales/leads/${lead.id}`)
      .send(leadBody({ name: 'Acme Textiles Ltd', status: 'QUALIFIED' }));

    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(200);
    expect(response.body.data.id).toBe(lead.id);
    expect(response.body.data.code).toBe(lead.code);
    expect(response.body.data.name).toBe('Acme Textiles Ltd');
    expect(response.body.data.status).toBe('QUALIFIED');
  });

  it('deactivates rather than deletes (§4 rule 3)', async () => {
    const lead = await createLead();
    const response = await as(tokenLeadUser).post(`/api/tenant/sales/leads/${lead.id}/toggle-status`);
    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(false);

    const row = await owner.salesLead.findUnique({ where: { id: BigInt(lead.id) } });
    expect(row?.deletedAt).toBeNull();
  });
});

describe('§4 — revenue potential and qualification', () => {
  it('calculates the opportunity value from a monthly volume', async () => {
    const lead = await createLead();
    const response = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}`);

    // 10 × 40HC a month at 1,200 revenue and 150 profit, 40% likely.
    expect(response.body.data.forecast).toEqual({
      monthlyRevenue: '12000.00',
      monthlyProfit: '1500.00',
      weightedProfit: '600.00',
      monthlyTeu: '20.00',
    });
    expect(response.body.data.currency).toBe('USD');
  });

  it('leaves a figure blank rather than zero when an input is missing', async () => {
    const lead = await createLead({ profitPerUnit: '', winProbability: '' });
    const response = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}`);
    expect(response.body.data.forecast.monthlyRevenue).toBe('12000.00');
    expect(response.body.data.forecast.monthlyProfit).toBeNull();
    expect(response.body.data.forecast.weightedProfit).toBeNull();
  });

  it('will not mark a lead Won until the exporter is a customer', async () => {
    const response = await as(tokenLeadUser)
      .post('/api/tenant/sales/leads')
      .send(leadBody({ status: 'WON', outcomeReason: 'Beat the incumbent on free time' }));
    expect(response.status).toBe(400);
    expect(response.body.error.fields.customerId).toBeDefined();
  });

  it('asks why a lead was lost', async () => {
    const response = await as(tokenLeadUser)
      .post('/api/tenant/sales/leads')
      .send(leadBody({ status: 'LOST' }));
    expect(response.status).toBe(400);
    expect(response.body.error.fields.outcomeReason).toBeDefined();
  });

  it('stamps when a lead is decided, and clears it if reopened', async () => {
    const lead = await createLead();
    const won = await as(tokenLeadUser)
      .patch(`/api/tenant/sales/leads/${lead.id}`)
      .send(leadBody({ status: 'WON', customerId: customerId.toString(), outcomeReason: 'Free time' }));
    expect(won.status, JSON.stringify(won.body.error ?? {})).toBe(200);
    expect(won.body.data.closedAt).not.toBeNull();

    const reopened = await as(tokenLeadUser)
      .patch(`/api/tenant/sales/leads/${lead.id}`)
      .send(leadBody({ status: 'NEGOTIATION', customerId: customerId.toString() }));
    expect(reopened.body.data.closedAt).toBeNull();
  });
});

describe('§7 — the register and its KPIs', () => {
  it('finds a lead by its exporter, buyer or code', async () => {
    const first = await createLead({ name: 'Findable Trading', buyerName: 'Hamburg Imports' });
    await createLead({ name: 'Something Else', buyerName: 'Elsewhere' });

    for (const search of ['Findable', 'Hamburg', first.code]) {
      const response = await as(tokenLeadUser).get(`/api/tenant/sales/leads?search=${search}&limit=100`);
      expect(response.body.data.map((l: { code: string }) => l.code)).toEqual([first.code]);
    }
  });

  it('filters by open or closed, and by salesperson', async () => {
    await createLead({ name: 'Open One' });
    await createLead({ name: 'Theirs', ownerId: otherOwnerId.toString() });
    await createLead({ name: 'Lost One', status: 'LOST', outcomeReason: 'Buyer nominated' });

    const open = await as(tokenLeadUser).get('/api/tenant/sales/leads?status=OPEN&limit=100');
    expect(open.body.data.map((l: { name: string }) => l.name).sort()).toEqual(['Open One', 'Theirs']);

    const closed = await as(tokenLeadUser).get('/api/tenant/sales/leads?status=CLOSED&limit=100');
    expect(closed.body.data.map((l: { name: string }) => l.name)).toEqual(['Lost One']);

    const theirs = await as(tokenLeadUser).get(`/api/tenant/sales/leads?ownerId=${otherOwnerId}&limit=100`);
    expect(theirs.body.data.map((l: { name: string }) => l.name)).toEqual(['Theirs']);
  });

  it('adds up the pipeline and the year’s conversions', async () => {
    const day = today();
    // Open: one new with no figures, one quoted 10 × 40HC, overdue.
    await createLead({ name: 'Bare', revenuePerUnit: '', profitPerUnit: '', monthlyVolume: '' });
    await createLead({ name: 'Quoted', status: 'QUOTED', nextFollowupDate: shift(day, -2) });
    // Decided this year: one won (a new customer), one lost.
    await createLead({
      name: 'Won',
      status: 'WON',
      customerId: customerId.toString(),
      outcomeReason: 'Free time',
    });
    await createLead({ name: 'Lost', status: 'LOST', outcomeReason: 'Nominated' });

    const response = await as(tokenLeadUser).get('/api/tenant/sales/leads/kpis');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      activeLeads: 2,
      qualifiedLeads: 1,
      monthlyTeuPipeline: '20.00',
      monthlyRevenue: '12000.00',
      monthlyProfit: '1500.00',
      weightedProfit: '600.00',
      conversionPending: 1,
      conversionRate: 50,
      wonThisYear: 1,
      lostThisYear: 1,
      overdueFollowups: 1,
      newCustomersWon: 1,
      currency: 'USD',
    });
  });

  it('counts nothing from another workspace', async () => {
    const response = await as(tokenAdmin).get('/api/tenant/sales/leads/kpis');
    expect(response.body.data.activeLeads).toBe(0);
    expect(response.body.data.overdueFollowups).toBe(0);
  });
});

describe('§5 step 05 — follow-ups', () => {
  it('records the conversation and moves the lead’s next follow-up', async () => {
    const lead = await createLead({ nextFollowupDate: '2026-03-12' });

    const created = await as(tokenLeadUser)
      .post(`/api/tenant/sales/leads/${lead.id}/followups`)
      .send({
        followupDate: '2026-03-10',
        contactMode: 'CALL',
        contactPerson: 'Mr Rahman',
        notes: 'Asked for a Chattogram to Rotterdam indication',
        outcome: 'Interested if we beat 1,250',
        nextAction: 'Send an indicative rate',
        targetRate: '1180',
        objections: 'Free time too short',
        nextFollowupDate: '2026-03-17',
      });

    expect(created.status, JSON.stringify(created.body.error ?? {})).toBe(201);
    expect(created.body.data).toMatchObject({
      outcome: 'Interested if we beat 1,250',
      nextAction: 'Send an indicative rate',
      targetRate: '1180.0000',
      currency: 'USD',
      objections: 'Free time too short',
    });

    const reread = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}`);
    expect(reread.body.data.followupCount).toBe(1);
    expect(reread.body.data.nextFollowupDate).toBe('2026-03-17');
  });

  it('clears the next date when the latest conversation sets none', async () => {
    const lead = await createLead({ nextFollowupDate: '2026-03-12' });
    await as(tokenLeadUser)
      .post(`/api/tenant/sales/leads/${lead.id}/followups`)
      .send({ followupDate: '2026-03-10', contactMode: 'EMAIL', nextFollowupDate: '' });

    const reread = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}`);
    expect(reread.body.data.nextFollowupDate).toBeNull();
  });

  it('returns the lead alongside its history, newest first', async () => {
    const lead = await createLead({ name: 'Header Check Ltd' });
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await as(tokenLeadUser)
        .post(`/api/tenant/sales/leads/${lead.id}/followups`)
        .send({ followupDate: date, contactMode: 'EMAIL' });
    }

    const response = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}/followups`);
    expect(response.status).toBe(200);
    expect(response.body.data.lead.name).toBe('Header Check Ltd');
    expect(response.body.data.followups.map((f: { followupDate: string }) => f.followupDate)).toEqual([
      '2026-03-01',
      '2026-02-01',
      '2026-01-01',
    ]);
  });

  it('refuses a follow-up against a lead in another workspace', async () => {
    const response = await as(tokenLeadUser)
      .post(`/api/tenant/sales/leads/${leadBId}/followups`)
      .send({ followupDate: '2026-03-10', contactMode: 'CALL' });
    expect(response.status).toBe(404);
  });
});

describe('Sales Lead follow up — the due list and activity log', () => {
  it('sorts open leads into due buckets and counts each', async () => {
    const day = today();
    const overdue = await createLead({ name: 'Late', nextFollowupDate: shift(day, -1) });
    const dueToday = await createLead({ name: 'Today', nextFollowupDate: day });
    const soon = await createLead({ name: 'Soon', nextFollowupDate: shift(day, 3) });
    const unset = await createLead({ name: 'Unset' });
    // Decided leads need no call, whatever their date says.
    await createLead({ name: 'Done', status: 'LOST', outcomeReason: 'x', nextFollowupDate: shift(day, -5) });

    const all = await as(tokenLeadUser).get('/api/tenant/sales/lead-followups/due?limit=100');
    expect(all.status).toBe(200);
    expect(all.body.data.map((r: { code: string }) => r.code)).toEqual([
      overdue.code,
      dueToday.code,
      soon.code,
      unset.code,
    ]);
    expect(all.body.meta.counts).toEqual({ OVERDUE: 1, TODAY: 1, UPCOMING: 1, UNSCHEDULED: 1 });

    const late = await as(tokenLeadUser).get('/api/tenant/sales/lead-followups/due?due=OVERDUE');
    expect(late.body.data.map((r: { name: string; due: string }) => [r.name, r.due])).toEqual([
      ['Late', 'OVERDUE'],
    ]);
  });

  it('shows the last conversation on each row', async () => {
    const lead = await createLead({ name: 'Talked' });
    await as(tokenLeadUser)
      .post(`/api/tenant/sales/leads/${lead.id}/followups`)
      .send({ followupDate: '2026-03-10', contactMode: 'VISIT', outcome: 'Wants a rate', nextAction: 'Quote' });

    const response = await as(tokenLeadUser).get('/api/tenant/sales/lead-followups/due');
    expect(response.body.data[0].last).toEqual({
      followupDate: '2026-03-10',
      contactMode: 'VISIT',
      outcome: 'Wants a rate',
      nextAction: 'Quote',
    });
  });

  it('logs every follow-up across leads, and none from another workspace', async () => {
    const lead = await createLead({ name: 'Logged' });
    await as(tokenLeadUser)
      .post(`/api/tenant/sales/leads/${lead.id}/followups`)
      .send({ followupDate: '2026-03-10', contactMode: 'CALL' });

    const response = await as(tokenLeadUser).get('/api/tenant/sales/lead-followups/activity');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ leadCode: lead.code, leadName: 'Logged' });
  });

  it('lists nothing from another workspace in the due list', async () => {
    const response = await as(tokenAdmin).get('/api/tenant/sales/lead-followups/due?limit=100');
    expect(response.body.data).toEqual([]);
  });
});

describe('§6 — document attachments', () => {
  const upload = (leadId: string | bigint, kind = 'RFQ', token = tokenLeadUser) =>
    as(token)
      .post(`/api/tenant/sales/leads/${leadId}/documents`)
      .field('kind', kind)
      .attach('file', Buffer.from('%PDF-1.4 rfq'), { filename: 'buyer-rfq.pdf', contentType: 'application/pdf' });

  it('attaches, lists, downloads and removes a document', async () => {
    const lead = await createLead();

    const uploaded = await upload(lead.id);
    expect(uploaded.status, JSON.stringify(uploaded.body.error ?? {})).toBe(201);
    expect(uploaded.body.data.documents).toHaveLength(1);
    const doc = uploaded.body.data.documents[0];
    expect(doc.kind).toBe('RFQ');
    expect(doc.fileName).toMatch(/buyer-rfq/);

    const file = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}/documents/${doc.id}`);
    expect(file.status).toBe(200);

    const removed = await as(tokenLeadUser).delete(`/api/tenant/sales/leads/${lead.id}/documents/${doc.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data.documents).toEqual([]);

    // Soft-deleted (§4 rule 3): the row is still there.
    const row = await owner.salesLeadDocument.findUniqueOrThrow({ where: { id: BigInt(doc.id) } });
    expect(row.deletedAt).not.toBeNull();
  });

  it('refuses an attachment to another workspace’s lead', async () => {
    const response = await upload(leadBId);
    expect(response.status).toBe(404);
  });

  it('needs EDIT to attach', async () => {
    const token = await makeUser(tenantA, `viewer-${SLUG_A}`, ['SALES.NEW_SALES_LEAD.VIEW']);
    const lead = await createLead();
    const response = await upload(lead.id, 'RFQ', token);
    expect(response.status).toBe(403);
  });
});

describe('§5 steps 03 and 06 — the inquiry raised from a lead', () => {
  const inquiryBody = (leadId: string | null) => ({
    inquiryDate: '2026-03-15',
    sourceId: sourceId.toString(),
    shipmentType: 'SEA',
    loadingType: 'FCL',
    customerId: customerId.toString(),
    movementType: 'OUTBOUND',
    polId: polId.toString(),
    podId: podId.toString(),
    ...(leadId === null ? {} : { leadId }),
    volumes: [],
  });

  it('records the lead, requests its rate and links its customer', async () => {
    const lead = await createLead();

    const inquiry = await as(tokenLeadUser).post('/api/tenant/sales/inquiries').send(inquiryBody(lead.id));
    expect(inquiry.status, JSON.stringify(inquiry.body.error ?? {})).toBe(201);
    expect(inquiry.body.data.leadId).toBe(lead.id);

    const reread = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}`);
    expect(reread.body.data.inquiryCount).toBe(1);
    expect(reread.body.data.status).toBe('RATE_REQUESTED');
    expect(reread.body.data.customerId).toBe(customerId.toString());

    const history = await as(tokenAdmin).get(`/api/tenant/sales/leads/${lead.id}/followups`);
    expect(history.body.data.inquiries.map((i: { code: string }) => i.code)).toEqual([
      inquiry.body.data.code,
    ]);
  });

  it('shows a lead’s inquiries only as far as the inquiry rules allow', async () => {
    // Plain VIEW sees the user's own inquiries; this user is no salesman at
    // all, so the inquiry is counted on the lead but not listed to them.
    const lead = await createLead();
    await as(tokenLeadUser).post('/api/tenant/sales/inquiries').send(inquiryBody(lead.id));

    const history = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}/followups`);
    expect(history.body.data.lead.inquiryCount).toBe(1);
    expect(history.body.data.inquiries).toEqual([]);
  });

  it('does not pull a quoted lead back', async () => {
    const lead = await createLead({ status: 'QUOTED' });
    await as(tokenLeadUser).post('/api/tenant/sales/inquiries').send(inquiryBody(lead.id));
    const reread = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}`);
    expect(reread.body.data.status).toBe('QUOTED');
  });

  it('raises an inquiry with no lead at all', async () => {
    const inquiry = await as(tokenLeadUser).post('/api/tenant/sales/inquiries').send(inquiryBody(null));
    expect(inquiry.status).toBe(201);
    expect(inquiry.body.data.leadId).toBeNull();
  });

  it('refuses an inquiry pointing at another workspace lead', async () => {
    const response = await as(tokenLeadUser)
      .post('/api/tenant/sales/inquiries')
      .send(inquiryBody(leadBId.toString()));
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/lead/i);
  });

  it('offers only active leads to the inquiry form', async () => {
    const active = await createLead({ name: 'Still Talking' });
    const dormant = await createLead({ name: 'Gone Quiet' });
    await as(tokenLeadUser).post(`/api/tenant/sales/leads/${dormant.id}/toggle-status`);

    const response = await as(tokenLeadUser).get('/api/tenant/sales/lead-options');
    const names: string[] = response.body.data.map((o: { name: string }) => o.name);
    expect(names.some((n) => n.includes('Still Talking'))).toBe(true);
    expect(names.some((n) => n.includes('Gone Quiet'))).toBe(false);
    expect(names.some((n) => n.includes(active.code))).toBe(true);
  });
});

describe('§7A rule 4 — leads do not cross workspaces', () => {
  it('never lists another workspace lead', async () => {
    await createLead();
    const response = await as(tokenAdmin).get('/api/tenant/sales/leads?limit=100');
    const codes: string[] = response.body.data.map((l: { code: string }) => l.code);
    expect(codes).not.toContain('FOB-2026-0999');
  });

  it('cannot read one by id', async () => {
    const response = await as(tokenAdmin).get(`/api/tenant/sales/leads/${leadBId}`);
    expect(response.status).toBe(404);
  });

  it('cannot edit one', async () => {
    const response = await as(tokenAdmin)
      .patch(`/api/tenant/sales/leads/${leadBId}`)
      .send(leadBody({ name: 'Hijacked' }));
    expect(response.status).toBe(404);

    const untouched = await owner.salesLead.findUnique({ where: { id: leadBId } });
    expect(untouched?.name).toBe('Beta Lead');
  });
});

describe('§7 — the lead routes are permission guarded', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await request(app).get('/api/tenant/sales/leads').set('X-Tenant-Slug', SLUG_A);
    expect(response.status).toBe(401);
  });

  it('rejects a user with no lead permission', async () => {
    const token = await makeUser(tenantA, `none-${SLUG_A}`, []);
    const response = await as(token).get('/api/tenant/sales/leads');
    expect(response.status).toBe(403);
  });

  it('separates the lead screen from the follow-up screen', async () => {
    const token = await makeUser(tenantA, `leadonly-${SLUG_A}`, [
      'SALES.NEW_SALES_LEAD.VIEW',
      'SALES.NEW_SALES_LEAD.CREATE',
    ]);
    const lead = await createLead();

    const list = await as(token).get('/api/tenant/sales/leads');
    expect(list.status).toBe(200);

    // Two menu entries, two permissions.
    const followups = await as(token).get(`/api/tenant/sales/leads/${lead.id}/followups`);
    expect(followups.status).toBe(403);
    const due = await as(token).get('/api/tenant/sales/lead-followups/due');
    expect(due.status).toBe(403);
  });
});
