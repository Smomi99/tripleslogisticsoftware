import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';
import { hashPassword } from '../lib/password';

/**
 * The forwarder's view of what an agent quoted.
 *
 * The portal writes to agent_quote and, until this endpoint existed, nothing on
 * the staff side ever read it — a price could be submitted and be invisible to
 * the company that asked for it.
 *
 * The amendment history is derived from the Phase 0 audit trail rather than
 * from a history table, so these assertions are also a check that the trigger
 * captures what a human would need to answer "what did they change?".
 */

vi.mock('../lib/mailer', () => ({
  sendMail: () => Promise.resolve({ sent: true }),
  parseAddressList: () => [],
}));

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'aqv-alpha';
const PASSWORD = 'Correct-Horse-Battery';

let tenantId: bigint;
let inquiryId: bigint;
let nordic: bigint;
let baltic: bigint;
let currencyId: bigint;
let staffToken: string;
let nordicToken: string;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  await owner.$executeRawUnsafe(`UPDATE "user" SET agent_id = NULL WHERE tenant_id IN ${scope}`);
  for (const table of [
    'agent_quote',
    'inquiry_party_contact',
    'inquiry_party',
    'inquiry_volume',
    'inquiry',
    'user_credential_token',
    'agent_pic',
    'agent',
    '"user"',
    'customer',
    'industry_sector',
    'port',
    'inquiry_source',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

const staff = (path: string) =>
  request(app).get(path).set('Authorization', `Bearer ${staffToken}`).set('X-Tenant-Slug', SLUG);

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'AQV Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const makeAgent = async (code: string, name: string, username: string) => {
    const agent = await owner.agent.create({
      data: { tenantId, code, name, country: 'Denmark', agentType: 'GENERAL' },
      select: { id: true },
    });
    await owner.user.create({
      data: {
        tenantId,
        code: `USR-${code}`,
        agentId: agent.id,
        username,
        email: username,
        passwordHash: await hashPassword(PASSWORD),
        isActive: true,
      },
    });
    return agent.id;
  };
  nordic = await makeAgent('AQV-N', 'Nordic Forwarding', 'nordic@aqv.test');
  baltic = await makeAgent('AQV-B', 'Baltic Lines', 'baltic@aqv.test');

  const admin = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-AQV-S',
      username: 'aqv-staff',
      email: 'staff@aqv.test',
      passwordHash: await hashPassword(PASSWORD),
      isSuperadmin: true,
    },
    select: { id: true },
  });
  staffToken = await signAccessToken({
    sub: admin.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'AQV-SEC', name: 'AQV Sector' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'AQV-CUS',
      name: 'AQV Customer',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const source = await owner.inquirySource.create({
    data: { tenantId, code: 'AQV-SRC', name: 'AQV Source' },
    select: { id: true },
  });
  const port = (code: string, country: string) =>
    owner.port.create({
      data: { tenantId, code, name: `${code} Port`, portCode: code, country, type: 'SEAPORT' },
      select: { id: true },
    });
  const pol = await port('AQVPOL', 'Bangladesh');
  const pod = await port('AQVPOD', 'Denmark');
  currencyId = (
    await owner.currency.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } })
  ).id;

  inquiryId = (
    await owner.inquiry.create({
      data: {
        tenantId,
        code: 'INQ-2026-AQV001',
        seriesYear: 2026,
        inquiryDate: new Date('2026-08-23'),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        movementType: 'INBOUND',
        loadingType: 'FCL',
        polId: pol.id,
        podId: pod.id,
      },
      select: { id: true },
    })
  ).id;
  for (const agentId of [nordic, baltic]) {
    await owner.inquiryParty.create({ data: { tenantId, inquiryId, agentId } });
  }

  const login = await request(app)
    .post('/api/portal/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ username: 'nordic@aqv.test', password: PASSWORD })
    .expect(200);
  nordicToken = login.body.data.accessToken as string;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('a quote an agent submits', () => {
  it('is visible to staff on the inquiry', async () => {
    await request(app)
      .post(`/api/portal/inquiries/${inquiryId}/quote`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({
        amount: '1450.50',
        currencyId: currencyId.toString(),
        transitDays: 22,
        remarks: 'Subject to space.',
      })
      .expect(201);

    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    expect(res.body.data).toHaveLength(1);
    const quote = res.body.data[0];
    expect(quote.agentName).toBe('Nordic Forwarding');
    expect(quote.amount).toBe('1450.5');
    // The ISO code, not the CUR-001 business code.
    expect(quote.currencyCode).toMatch(/^[A-Z]{3}$/);
    expect(quote.submittedByName).toBe('nordic@aqv.test');
    expect(quote.remarks).toBe('Subject to space.');
  });

  it('records its submission in the history', async () => {
    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const history = res.body.data[0].history;
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe('SUBMITTED');
  });
});

describe('an amendment', () => {
  it('shows both sides of what changed', async () => {
    const quoteId = (
      await owner.agentQuote.findFirstOrThrow({
        where: { tenantId, agentId: nordic },
        select: { id: true },
      })
    ).id;

    await request(app)
      .patch(`/api/portal/quotes/${quoteId}`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ amount: '1399', currencyId: currencyId.toString(), transitDays: 19 })
      .expect(200);

    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const history = res.body.data[0].history;
    // Newest first, so the amendment leads.
    expect(history[0].kind).toBe('AMENDED');

    const price = history[0].changes.find((c: { field: string }) => c.field === 'Price');
    expect(price.from).toBe('1450.5');
    expect(price.to).toBe('1399');

    const transit = history[0].changes.find((c: { field: string }) => c.field === 'Transit days');
    expect(transit.from).toBe('22');
    expect(transit.to).toBe('19');
  });

  it('lists only the fields that actually moved', async () => {
    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const fields = res.body.data[0].history[0].changes.map((c: { field: string }) => c.field);
    // updated_at moves on every write and says nothing; remarks did not change.
    expect(fields).not.toContain('Remarks');
    expect(fields.sort()).toEqual(['Price', 'Transit days']);
  });
});

describe('who may see it', () => {
  it('shows every agent quote to staff, not just one', async () => {
    const login = await request(app)
      .post('/api/portal/auth/login')
      .set('X-Tenant-Slug', SLUG)
      .send({ username: 'baltic@aqv.test', password: PASSWORD })
      .expect(200);
    await request(app)
      .post(`/api/portal/inquiries/${inquiryId}/quote`)
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ amount: '1502', currencyId: currencyId.toString() })
      .expect(201);

    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    // The whole point for the forwarder: compare what came back.
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((q: { agentName: string }) => q.agentName).sort()).toEqual([
      'Baltic Lines',
      'Nordic Forwarding',
    ]);
  });

  it('is refused to an agent token', async () => {
    // An agent must never read the staff comparison — it holds a competitor's
    // price. authenticate refuses the session before the handler runs.
    await request(app)
      .get(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(403);
  });

  it('does not leak another agent quote through the portal', async () => {
    const res = await request(app)
      .get(`/api/portal/inquiries/${inquiryId}`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);
    expect(res.body.data.quote.amount).toBe('1399');
    expect(JSON.stringify(res.body)).not.toContain('1502');
    expect(JSON.stringify(res.body)).not.toContain('Baltic');
  });
});
