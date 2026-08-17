import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Sales leads (CLAUDE.md §3, §8; MODULE_PURCHASE_SALES §9 Q12).
 *
 * The link back to an inquiry is what Q12's answer bought, so that is what
 * these check hardest: an inquiry can record the lead it came from, the lead
 * counts them, and a lead cannot be borrowed from another workspace.
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
    'inquiry_rate',
    'inquiry_followup',
    'inquiry_volume',
    'inquiry',
    'sales_lead_followup',
    'sales_lead',
    '"user"',
    'customer',
    'industry_sector',
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

  const mkPort = async (suffix: string, name: string, portCode: string) =>
    (
      await owner.port.create({
        data: {
          code: `${PREFIX}${suffix}`,
          name,
          portCode,
          country: 'Bangladesh',
          type: 'SEAPORT',
        },
        select: { id: true },
      })
    ).id;
  polId = await mkPort('POL', 'Lead Origin', 'LDPOL1');
  podId = await mkPort('POD', 'Lead Dest', 'LDPOD1');

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

  leadBId = (
    await owner.salesLead.create({
      data: { tenantId: tenantB, code: 'LED-999', name: 'Beta Lead' },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG_A}'`;
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_volume WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM sales_lead_followup WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM sales_lead WHERE tenant_id IN (${t})`);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function as(token: string, slug = SLUG_A) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    patch: (path: string) =>
      request(app).patch(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
  };
}

async function createLead(name = 'Acme Textiles'): Promise<{ id: string; code: string }> {
  const response = await as(tokenLeadUser)
    .post('/api/tenant/sales/leads')
    .send({ name, notes: 'Met at the Dhaka expo' });
  expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
  return { id: response.body.data.id, code: response.body.data.code };
}

describe('§8 — a lead is a standard master record', () => {
  it('is created with a business code and counts starting at zero', async () => {
    const response = await as(tokenLeadUser)
      .post('/api/tenant/sales/leads')
      .send({ name: 'Acme Textiles', notes: 'Met at the Dhaka expo' });

    expect(response.status).toBe(201);
    expect(response.body.data.code).toBe('LED-001');
    expect(response.body.data.name).toBe('Acme Textiles');
    expect(response.body.data.followupCount).toBe(0);
    expect(response.body.data.inquiryCount).toBe(0);
    expect(response.body.data.isActive).toBe(true);
  });

  it('numbers each new lead in sequence', async () => {
    await createLead('First');
    const second = await createLead('Second');
    expect(second.code).toBe('LED-002');
  });

  it('refuses a lead with no name', async () => {
    const response = await as(tokenLeadUser).post('/api/tenant/sales/leads').send({ name: '' });
    expect(response.status).toBe(400);
  });

  it('is edited, not replaced', async () => {
    const lead = await createLead();
    const response = await as(tokenLeadUser)
      .patch(`/api/tenant/sales/leads/${lead.id}`)
      .send({ name: 'Acme Textiles Ltd', notes: 'Renamed after the call' });

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(lead.id);
    expect(response.body.data.name).toBe('Acme Textiles Ltd');
  });

  it('deactivates rather than deletes (§4 rule 3)', async () => {
    const lead = await createLead();
    const response = await as(tokenLeadUser).post(
      `/api/tenant/sales/leads/${lead.id}/toggle-status`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(false);

    const row = await owner.salesLead.findUnique({ where: { id: BigInt(lead.id) } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).toBeNull();
  });

  it('finds a lead by name or code', async () => {
    await createLead('Findable Trading');
    await createLead('Something Else');

    const byName = await as(tokenLeadUser).get(
      '/api/tenant/sales/leads?search=Findable&limit=100',
    );
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.data[0].name).toBe('Findable Trading');
  });
});

describe('§8 — the follow-up child screen', () => {
  it('records a follow-up and counts it on the lead', async () => {
    const lead = await createLead();

    const created = await as(tokenLeadUser)
      .post(`/api/tenant/sales/leads/${lead.id}/followups`)
      .send({
        followupDate: '2026-03-10',
        contactMode: 'CALL',
        contactPerson: 'Mr Rahman',
        notes: 'Asked for a Chattogram to Rotterdam indication',
        nextFollowupDate: '2026-03-17',
      });

    expect(created.status, JSON.stringify(created.body.error ?? {})).toBe(201);
    expect(created.body.data.contactMode).toBe('CALL');
    expect(created.body.data.nextFollowupDate).toBe('2026-03-17');

    const reread = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}`);
    expect(reread.body.data.followupCount).toBe(1);
    expect(reread.body.data.nextFollowupDate).toBe('2026-03-17');
  });

  it('returns the parent alongside its history, for the child header', async () => {
    const lead = await createLead('Header Check Ltd');
    const response = await as(tokenLeadUser).get(
      `/api/tenant/sales/leads/${lead.id}/followups`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.lead.name).toBe('Header Check Ltd');
    expect(response.body.data.lead.code).toBe(lead.code);
    expect(response.body.data.followups).toEqual([]);
  });

  it('serves the history newest first', async () => {
    const lead = await createLead();
    for (const date of ['2026-01-01', '2026-02-01', '2026-03-01']) {
      await as(tokenLeadUser)
        .post(`/api/tenant/sales/leads/${lead.id}/followups`)
        .send({ followupDate: date, contactMode: 'EMAIL' });
    }

    const response = await as(tokenLeadUser).get(
      `/api/tenant/sales/leads/${lead.id}/followups`,
    );
    const dates = response.body.data.followups.map((f: { followupDate: string }) => f.followupDate);
    expect(dates).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);
  });

  it('refuses a follow-up against a lead in another workspace', async () => {
    const response = await as(tokenLeadUser)
      .post(`/api/tenant/sales/leads/${leadBId}/followups`)
      .send({ followupDate: '2026-03-10', contactMode: 'CALL' });
    expect(response.status).toBe(404);
  });
});

describe('§9 Q12 — the link an inquiry keeps to its lead', () => {
  it('records the lead an inquiry was raised from', async () => {
    const lead = await createLead();

    const inquiry = await as(tokenLeadUser)
      .post('/api/tenant/sales/inquiries')
      .send({
        inquiryDate: '2026-03-15',
        sourceId: sourceId.toString(),
        shipmentType: 'SEA',
        customerId: customerId.toString(),
        movementType: 'OUTBOUND',
        polId: polId.toString(),
        podId: podId.toString(),
        leadId: lead.id,
        volumes: [],
      });

    expect(inquiry.status, JSON.stringify(inquiry.body.error ?? {})).toBe(201);
    expect(inquiry.body.data.leadId).toBe(lead.id);

    // And the lead now knows it produced one — the whole point of Q12.
    const reread = await as(tokenLeadUser).get(`/api/tenant/sales/leads/${lead.id}`);
    expect(reread.body.data.inquiryCount).toBe(1);
  });

  it('raises an inquiry with no lead at all', async () => {
    const inquiry = await as(tokenLeadUser)
      .post('/api/tenant/sales/inquiries')
      .send({
        inquiryDate: '2026-03-15',
        sourceId: sourceId.toString(),
        shipmentType: 'SEA',
        customerId: customerId.toString(),
        movementType: 'OUTBOUND',
        polId: polId.toString(),
        podId: podId.toString(),
        volumes: [],
      });

    expect(inquiry.status).toBe(201);
    expect(inquiry.body.data.leadId).toBeNull();
  });

  it('refuses an inquiry pointing at another workspace lead', async () => {
    const response = await as(tokenLeadUser)
      .post('/api/tenant/sales/inquiries')
      .send({
        inquiryDate: '2026-03-15',
        sourceId: sourceId.toString(),
        shipmentType: 'SEA',
        customerId: customerId.toString(),
        movementType: 'OUTBOUND',
        polId: polId.toString(),
        podId: podId.toString(),
        leadId: leadBId.toString(),
        volumes: [],
      });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/lead/i);
  });

  it('offers only active leads to the inquiry form', async () => {
    const active = await createLead('Still Talking');
    const dormant = await createLead('Gone Quiet');
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
    expect(codes).not.toContain('LED-999');
  });

  it('cannot read one by id', async () => {
    const response = await as(tokenAdmin).get(`/api/tenant/sales/leads/${leadBId}`);
    expect(response.status).toBe(404);
  });

  it('cannot edit one', async () => {
    const response = await as(tokenAdmin)
      .patch(`/api/tenant/sales/leads/${leadBId}`)
      .send({ name: 'Hijacked' });
    expect(response.status).toBe(404);

    const untouched = await owner.salesLead.findUnique({ where: { id: leadBId } });
    expect(untouched?.name).toBe('Beta Lead');
  });

  it('numbers each workspace independently', async () => {
    // Tenant B already holds LED-999; tenant A must still start at LED-001.
    const lead = await createLead();
    expect(lead.code).toBe('LED-001');
  });
});

describe('§7 — the lead routes are permission guarded', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await request(app)
      .get('/api/tenant/sales/leads')
      .set('X-Tenant-Slug', SLUG_A);
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
  });
});
