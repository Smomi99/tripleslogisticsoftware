import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';
import { hashPassword } from '../lib/password';
import { quoteBody } from '../lib/test-quote';

/**
 * Phase 4 of the agent portal: what an agent can actually do.
 *
 * Phase 3 proved the database refuses to hand an agent the wrong rows. This
 * proves the API above it agrees — and, where the two could differ, that the
 * API is the narrower of the pair rather than the wider.
 */

const sent: { to: string[]; subject: string; text: string }[] = [];
vi.mock('../lib/mailer', () => ({
  sendMail: (mail: { to: string[]; subject: string; text: string }) => {
    sent.push(mail);
    return Promise.resolve({ sent: true });
  },
  parseAddressList: (raw: string | null | undefined) =>
    raw == null ? [] : raw.split(/[,;\n]/).map((a) => a.trim()).filter((a) => a !== ''),
}));

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'pinq-alpha';
const PASSWORD = 'Correct-Horse-Battery';

let tenantId: bigint;
let nordic: bigint;
let baltic: bigint;
let sharedInquiry: bigint;
let balticInquiry: bigint;
let unsentInquiry: bigint;
let closedInquiry: bigint;
let currencyId: bigint;
let costHeadId: bigint;
let nordicToken: string;
let balticToken: string;
let staffToken: string;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of [
    'agent_quote_comment',
    'agent_quote_line',
    'agent_quote_option',
    'agent_quote',
    'inquiry_party_contact',
    'inquiry_party',
    'inquiry_volume',
    'inquiry',
    'notification_setting',
    // Users reference agents, so they have to go first — the portal added a
    // foreign key that did not exist when these teardowns were written.
    '"user"',
    'role_permission',
    'role',
    'agent_pic',
    'agent',
    'customer',
    'industry_sector',
    'port',
    'inquiry_source',
    'cost_head',
    'cost_unit',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

function get(path: string, token: string) {
  return request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG);
}

async function agentToken(username: string): Promise<string> {
  const res = await request(app)
    .post('/api/tenant/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ username, password: PASSWORD })
    .expect(200);
  return res.body.data.accessToken as string;
}

/**
 * Gives an agent user the role that grants Agent Inquiry.
 *
 * An agent is an ordinary user now: the routes are behind
 * requirePermission('AGENT.INQUIRY.*'), so without a role they reach nothing —
 * which is the point, and which these fixtures have to honour like any other
 * user would.
 */
async function grantAgentRole(
  owner: { $queryRawUnsafe: (sql: string) => Promise<unknown>; [k: string]: unknown },
  tenantId: bigint,
  userIds: bigint[],
  code: string,
): Promise<void> {
  const db = owner as unknown as {
    role: { create: (a: unknown) => Promise<{ id: bigint }> };
    permission: { findMany: (a: unknown) => Promise<{ id: bigint }[]> };
    rolePermission: { createMany: (a: unknown) => Promise<unknown> };
    user: { updateMany: (a: unknown) => Promise<unknown> };
  };
  const role = await db.role.create({
    data: { tenantId, code, name: `${code} agent role` },
    select: { id: true },
  });
  const permissions = await db.permission.findMany({
    where: { key: { in: ['AGENT.INQUIRY.VIEW', 'AGENT.INQUIRY.QUOTE'] } },
    select: { id: true },
  });
  await db.rolePermission.createMany({
    data: permissions.map((p) => ({ tenantId, roleId: role.id, permissionId: p.id })),
  });
  await db.user.updateMany({ where: { id: { in: userIds } }, data: { roleId: role.id } });
}

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'Portal Inquiry Co', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  await owner.notificationSetting.create({
    data: { tenantId, priceTeamEmails: 'pricing@forwarder.test', updatedAt: new Date() },
  });

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
  nordic = await makeAgent('PIQ-N', 'Nordic Forwarding', 'nordic@agent.test');
  baltic = await makeAgent('PIQ-B', 'Baltic Lines', 'baltic@agent.test');

  const agentUsers = await owner.user.findMany({
    where: { tenantId, agentId: { not: null } },
    select: { id: true },
  });
  await grantAgentRole(owner as never, tenantId, agentUsers.map((u) => u.id), 'PIQ-ROLE');

  const staff = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-PIQ-S',
      username: 'piq-staff',
      email: 'staff@piq.test',
      passwordHash: await hashPassword(PASSWORD),
      isSuperadmin: true,
    },
    select: { id: true },
  });
  staffToken = await signAccessToken({
    sub: staff.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });

  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'PIQ-SEC', name: 'PIQ Sector' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'PIQ-CUS',
      name: 'Confidential Shipper Ltd',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const source = await owner.inquirySource.create({
    data: { tenantId, code: 'PIQ-SRC', name: 'PIQ Source' },
    select: { id: true },
  });
  const port = (code: string, country: string) =>
    owner.port.create({
      data: {
        tenantId,
        code,
        name: `${code} Harbour`,
        portCode: code,
        country,
        type: 'SEAPORT',
      },
      select: { id: true },
    });
  const pol = await port('PIQPOL', 'Bangladesh');
  const pod = await port('PIQPOD', 'Denmark');
  currencyId = (
    await owner.currency.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } })
  ).id;

  // A quotation prices cost heads now, so the fixture needs one to price.
  const costUnit = await owner.costUnit.create({
    data: { tenantId, code: 'PIQ-CU', name: 'Container' },
    select: { id: true },
  });
  costHeadId = (
    await owner.costHead.create({
      data: {
        tenantId,
        code: 'PIQ-CH',
        category: 'SERVICE',
        name: 'Ocean Freight',
        unitId: costUnit.id,
      },
      select: { id: true },
    })
  ).id;

  const inquiry = async (code: string, status: 'OPEN' | 'WON') =>
    (
      await owner.inquiry.create({
        data: {
          tenantId,
          code,
          seriesYear: 2026,
          inquiryDate: new Date('2026-08-23'),
          sourceId: source.id,
          shipmentType: 'SEA',
          customerId: customer.id,
          movementType: 'INBOUND',
          loadingType: 'FCL',
          polId: pol.id,
          podId: pod.id,
          status,
          // A staff note that names the customer. Nothing an agent sees may
          // carry it.
          remarks: 'Two 40ft for Confidential Shipper Ltd, ready next week.',
        },
        select: { id: true },
      })
    ).id;
  sharedInquiry = await inquiry('INQ-2026-PIQ001', 'OPEN');
  balticInquiry = await inquiry('INQ-2026-PIQ002', 'OPEN');
  unsentInquiry = await inquiry('INQ-2026-PIQ003', 'OPEN');
  closedInquiry = await inquiry('INQ-2026-PIQ004', 'WON');

  for (const [inquiryId, agentId] of [
    [sharedInquiry, nordic],
    [balticInquiry, baltic],
    [closedInquiry, nordic],
  ] as const) {
    await owner.inquiryParty.create({ data: { tenantId, inquiryId, agentId } });
  }

  await owner.inquiryVolume.create({
    data: {
      tenantId,
      inquiryId: sharedInquiry,
      volumeKind: 'FCL',
      quantity: 2,
      weightKg: 18000,
      containerTypeNote: '40HC',
      targetPrice: 1234.5678,
    },
  });

  nordicToken = await agentToken('nordic@agent.test');
  balticToken = await agentToken('baltic@agent.test');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the inquiry list', () => {
  it('shows only what this agent was sent', async () => {
    const res = await get('/api/tenant/agent/inquiries', nordicToken).expect(200);
    const codes = (res.body.data as { code: string }[]).map((i) => i.code);
    expect(codes.sort()).toEqual(['INQ-2026-PIQ001', 'INQ-2026-PIQ004']);
  });

  it('shows a different agent something different', async () => {
    const res = await get('/api/tenant/agent/inquiries', balticToken).expect(200);
    const codes = (res.body.data as { code: string }[]).map((i) => i.code);
    expect(codes).toEqual(['INQ-2026-PIQ002']);
  });

  it('carries no customer and no target price, at all', async () => {
    const res = await get('/api/tenant/agent/inquiries', nordicToken).expect(200);
    const body = JSON.stringify(res.body);
    // Not "the field is null" — the name never enters the response, and
    // neither does the figure the customer was willing to pay.
    expect(body).not.toContain('Confidential Shipper');
    expect(body).not.toContain('1234.5678');
    expect(body).not.toContain('customerId');
    expect(body).not.toContain('targetPrice');
    // Staff remarks are excluded outright — the field is not on the DTO and
    // not on the view, so there is nothing to sanitise at render time.
    expect(body).not.toContain('ready next week');
    // Checked on the inquiry object rather than the whole body: the agent's
    // OWN quote carries a remarks field, and that one is theirs to write.
    for (const inquiry of res.body.data as Record<string, unknown>[]) {
      expect(Object.hasOwn(inquiry, 'remarks')).toBe(false);
    }
  });

  it('renders the lane an agent needs to price it', async () => {
    const res = await get('/api/tenant/agent/inquiries', nordicToken).expect(200);
    const inquiry = (res.body.data as Record<string, unknown>[]).find(
      (i) => i['code'] === 'INQ-2026-PIQ001',
    )!;
    expect(inquiry['polName']).toBe('PIQPOL Harbour');
    expect(inquiry['podCountry']).toBe('Denmark');
    expect(inquiry['loadingType']).toBe('FCL');
    expect((inquiry['volumes'] as unknown[]).length).toBe(1);
    const volume = (inquiry['volumes'] as Record<string, unknown>[])[0]!;
    expect(volume['quantity']).toBe(2);
    expect(volume['containerTypeNote']).toBe('40HC');
    expect(volume).not.toHaveProperty('targetPrice');
  });

  it('refuses a staff token', async () => {
    await get('/api/tenant/agent/inquiries', staffToken).expect(403);
  });
});

describe('opening one inquiry', () => {
  it('returns the detail and records that it was read', async () => {
    await get(`/api/tenant/agent/inquiries/${sharedInquiry}`, nordicToken).expect(200);

    const viewed = await owner.auditLog.findMany({
      where: { tenantId, action: 'VIEW', tableName: 'inquiry' },
      select: { recordId: true, changedBy: true },
    });
    // The evidence behind "we sent it to them on Tuesday and they never
    // opened it".
    expect(viewed.some((v) => v.recordId === sharedInquiry)).toBe(true);
    expect(viewed[0]?.changedBy).not.toBeNull();
  });

  it('answers 404 for an inquiry belonging to another agent', async () => {
    // 404 rather than 403: a 403 would confirm the inquiry exists, which is
    // itself something this agent is not entitled to know.
    await get(`/api/tenant/agent/inquiries/${balticInquiry}`, nordicToken).expect(404);
  });

  it('answers 404 for an inquiry nobody was sent', async () => {
    await get(`/api/tenant/agent/inquiries/${unsentInquiry}`, nordicToken).expect(404);
  });
});

describe('submitting a quote', () => {
  const quote = (overrides: { unitPrice?: string; quantity?: string } = {}) =>
    quoteBody({ costHeadId, currencyId }, overrides);

  function post(path: string, token: string, body: object) {
    return request(app)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .send(body);
  }

  it('accepts one, and tells the price team', async () => {
    sent.length = 0;
    const res = await post(`/api/tenant/agent/inquiries/${sharedInquiry}/quote`, nordicToken, quote())
      .expect(201);
    // The figures live on the lines now; the header carries no single amount.
    expect(res.body.data.amount).toBe('');
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(res.body.data.options).toHaveLength(1);
    const [option] = res.body.data.options;
    expect(option.position).toBe(1);
    expect(option.transitDays).toBe(22);
    expect(option.via).toBe('Singapore');
    expect(option.podFreeDays).toBe(14);
    expect(option.lines).toHaveLength(1);
    expect(option.lines[0].unitPrice).toBe('1450.5');
    expect(option.lines[0].costHeadName).toBe('Ocean Freight');
    // Computed by the database, not sent by the client.
    expect(option.lines[0].totalAmount).toBe('1450.5');
    expect(option.totals).toEqual([
      expect.objectContaining({ amount: '1450.5' }),
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['pricing@forwarder.test']);
    expect(sent[0]?.subject).toContain('INQ-2026-PIQ001');
    expect(sent[0]?.subject).toContain('Nordic Forwarding');
    // The figure stays in the portal. Mail is not a channel this product
    // controls, and a forwarded thread should not carry an agent's price.
    expect(sent[0]?.text).not.toContain('1450');
  });

  it('files it against the right agent whatever the body says', async () => {
    const row = await owner.agentQuote.findFirstOrThrow({
      where: { tenantId, inquiryId: sharedInquiry },
      select: { agentId: true, submittedBy: true },
    });
    expect(row.agentId).toBe(nordic);
    expect(row.submittedBy).not.toBeNull();
  });

  it('shows the quote back on the inquiry', async () => {
    const res = await get(`/api/tenant/agent/inquiries/${sharedInquiry}`, nordicToken).expect(200);
    expect(res.body.data.quote.options[0].lines[0].unitPrice).toBe('1450.5');
    expect(res.body.data.quote.options[0].lines[0].currencyCode).toBeTruthy();
  });

  it('refuses a second quote on the same inquiry', async () => {
    await post(`/api/tenant/agent/inquiries/${sharedInquiry}/quote`, nordicToken, quote()).expect(409);
  });

  it('refuses to quote another agent inquiry', async () => {
    await post(`/api/tenant/agent/inquiries/${balticInquiry}/quote`, nordicToken, quote()).expect(404);
  });

  it('refuses to quote an inquiry that has been won', async () => {
    const res = await post(
      `/api/tenant/agent/inquiries/${closedInquiry}/quote`,
      nordicToken,
      quote(),
    ).expect(409);
    expect(res.body.error.code).toBe('INQUIRY_CLOSED');
  });

  it('refuses a quantity of zero', async () => {
    await post(
      `/api/tenant/agent/inquiries/${unsentInquiry}/quote`,
      nordicToken,
      quote({ quantity: '0' }),
    ).expect(400);
  });

  it('refuses an offer with no charge lines', async () => {
    // An option that prices nothing is not an offer, and the schema says so
    // before the database has to.
    await post(`/api/tenant/agent/inquiries/${unsentInquiry}/quote`, nordicToken, {
      options: [{ lines: [] }],
    }).expect(400);
  });

  it('refuses a quotation with no options at all', async () => {
    await post(`/api/tenant/agent/inquiries/${unsentInquiry}/quote`, nordicToken, {
      options: [],
    }).expect(400);
  });

  it('ignores a total the client tries to send', async () => {
    // Total Amount is generated. A client that sends its own has not been
    // trusted to multiply correctly, and here is not permitted to try.
    const body = quoteBody({ costHeadId, currencyId }, { unitPrice: '100', quantity: '3' });
    (body.options[0]!.lines![0] as unknown as Record<string, unknown>)['totalAmount'] = '1';
    const res = await post(
      `/api/tenant/agent/inquiries/${balticInquiry}/quote`,
      balticToken,
      body,
    ).expect(201);
    expect(res.body.data.options[0].lines[0].totalAmount).toBe('300');

    // Baltic having no quote is a precondition of later tests; put it back.
    const quoteId = BigInt(res.body.data.id as string);
    await owner.$executeRawUnsafe(
      `DELETE FROM agent_quote_line WHERE option_id IN
         (SELECT id FROM agent_quote_option WHERE quote_id = ${quoteId})`,
    );
    await owner.$executeRawUnsafe(
      `DELETE FROM agent_quote_option WHERE quote_id = ${quoteId}`,
    );
    await owner.$executeRawUnsafe(`DELETE FROM agent_quote WHERE id = ${quoteId}`);
  });

  it('keeps the exact figure, to four decimal places', async () => {
    // §4 rule 6: money is NUMERIC(18,4) and travels as a string. A JSON number
    // is a float, and 1450.50 would not survive the round trip intact.
    const rows = await owner.$queryRawUnsafe<{ unit_price: string; total_amount: string }[]>(
      `SELECT l.unit_price::text, l.total_amount::text
         FROM agent_quote_line l
         JOIN agent_quote_option o ON o.id = l.option_id
         JOIN agent_quote q ON q.id = o.quote_id
        WHERE q.inquiry_id = ${sharedInquiry}`,
    );
    expect(rows[0]?.unit_price).toBe('1450.5000');
    expect(rows[0]?.total_amount).toBe('1450.5000');
  });
});

describe('amending a quote', () => {
  function patch(path: string, token: string, body: object) {
    return request(app)
      .patch(path)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .send(body);
  }

  it('lets the agent change their own while the inquiry is open', async () => {
    const quote = await owner.agentQuote.findFirstOrThrow({
      where: { tenantId, inquiryId: sharedInquiry },
      select: { id: true },
    });
    const res = await patch(
      `/api/tenant/agent/quotes/${quote.id}`,
      nordicToken,
      quoteBody({ costHeadId, currencyId }, { unitPrice: '1399' }),
    ).expect(200);
    expect(res.body.data.options[0].lines[0].unitPrice).toBe('1399');
    // One live generation, not two: the previous offer was retired, not left
    // beside its replacement.
    expect(res.body.data.options).toHaveLength(1);

    const trail = await owner.auditLog.findMany({
      where: { tenantId, action: 'QUOTE_AMENDED' },
      select: { oldValues: true, newValues: true },
    });
    expect(trail.length).toBeGreaterThan(0);
  });

  it('keeps what was offered before, soft deleted', async () => {
    // §4 rule 3, earning its keep commercially: "you quoted 1450.50 last week"
    // is a thing both sides may need to point at.
    const retired = await owner.$queryRawUnsafe<{ unit_price: string }[]>(
      `SELECT l.unit_price::text
         FROM agent_quote_line l
         JOIN agent_quote_option o ON o.id = l.option_id
         JOIN agent_quote q ON q.id = o.quote_id
        WHERE q.inquiry_id = ${sharedInquiry} AND l.deleted_at IS NOT NULL`,
    );
    expect(retired.map((r) => r.unit_price)).toContain('1450.5000');
  });

  it('refuses to let another agent touch it', async () => {
    const quote = await owner.agentQuote.findFirstOrThrow({
      where: { tenantId, inquiryId: sharedInquiry },
      select: { id: true },
    });
    await patch(
      `/api/tenant/agent/quotes/${quote.id}`,
      balticToken,
      quoteBody({ costHeadId, currencyId }, { unitPrice: '1' }),
    ).expect(404);
  });

  it('stops once the inquiry is no longer open', async () => {
    const quote = await owner.agentQuote.findFirstOrThrow({
      where: { tenantId, inquiryId: sharedInquiry },
      select: { id: true },
    });
    await owner.inquiry.update({ where: { id: sharedInquiry }, data: { status: 'QUOTED' } });

    const res = await patch(
      `/api/tenant/agent/quotes/${quote.id}`,
      nordicToken,
      quoteBody({ costHeadId, currencyId }, { unitPrice: '1000' }),
    ).expect(409);
    expect(res.body.error.code).toBe('INQUIRY_CLOSED');

    await owner.inquiry.update({ where: { id: sharedInquiry }, data: { status: 'OPEN' } });
  });
});

describe('staff can see what agents sent', () => {
  it('keeps the quote visible to the forwarder', async () => {
    // The point of the whole feature: an agent writes a price and the
    // forwarder's own staff can read it. RLS makes the boundary one-way, not
    // opaque in both directions.
    const quotes = await owner.agentQuote.findMany({
      where: { tenantId },
      select: { code: true, agentId: true, options: { where: { deletedAt: null } } },
    });
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes[0]?.agentId).toBe(nordic);
    expect(quotes[0]?.options.length).toBeGreaterThan(0);
  });

  it('refuses an agent token at the staff inquiry screen', async () => {
    await get('/api/tenant/sales/inquiries', nordicToken).expect(403);
  });
});
