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
let costHeadId: bigint;
let staffToken: string;
let nordicToken: string;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  await owner.$executeRawUnsafe(`UPDATE "user" SET agent_id = NULL WHERE tenant_id IN ${scope}`);
  for (const table of [
    'email_log',
    'agent_quote_comment',
    'agent_quote_line',
    'agent_quote_option',
    'agent_quote',
    'inquiry_party_contact',
    'inquiry_party',
    'inquiry_volume',
    'inquiry',
    'agent_pic',
    'agent',
    '"user"',
    'role_permission',
    'role',
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

const staff = (path: string) =>
  request(app).get(path).set('Authorization', `Bearer ${staffToken}`).set('X-Tenant-Slug', SLUG);

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

  const agentUsers = await owner.user.findMany({
    where: { tenantId, agentId: { not: null } },
    select: { id: true },
  });
  await grantAgentRole(owner as never, tenantId, agentUsers.map((u) => u.id), 'AQV-ROLE');

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

  // A quotation prices cost heads now, so the fixture needs one to price.
  const costUnit = await owner.costUnit.create({
    data: { tenantId, code: 'AQV-CU', name: 'Container' },
    select: { id: true },
  });
  costHeadId = (
    await owner.costHead.create({
      data: {
        tenantId,
        code: 'AQV-CH',
        category: 'SERVICE',
        name: 'Ocean Freight',
        unitId: costUnit.id,
      },
      select: { id: true },
    })
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
    .post('/api/tenant/auth/login')
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
      .post(`/api/tenant/agent/inquiries/${inquiryId}/quote`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send(quoteBody({ costHeadId, currencyId }, { unitPrice: '1450.50' }))
      .expect(201);

    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    expect(res.body.data).toHaveLength(1);
    const quote = res.body.data[0];
    expect(quote.agentName).toBe('Nordic Forwarding');
    expect(quote.submittedByName).toBe('nordic@aqv.test');
    // The breakdown reaches the forwarder whole: every line, and a total per
    // currency rather than one number that pretends the currencies are alike.
    expect(quote.options).toHaveLength(1);
    expect(quote.options[0].lines[0].unitPrice).toBe('1450.5');
    expect(quote.options[0].lines[0].costHeadName).toBe('Ocean Freight');
    expect(quote.options[0].totals[0].amount).toBe('1450.5');
    // The ISO code, not the CUR-001 business code.
    expect(quote.options[0].lines[0].currencyCode).toMatch(/^[A-Z]{3}$/);
    expect(quote.options[0].remarks).toBe('Subject to space.');
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
      .patch(`/api/tenant/agent/quotes/${quoteId}`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send(
        quoteBody(
          { costHeadId, currencyId },
          { unitPrice: '1399', option: { transitDays: 19 } },
        ),
      )
      .expect(200);

    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const history = res.body.data[0].history;
    // Newest first, so the amendment leads.
    expect(history[0].kind).toBe('AMENDED');

    /*
     * An amendment retires the whole set of offers and writes a new one, so the
     * movement is recovered by comparing the set that stood with the set that
     * replaced it. The number a forwarder is watching for still lands: 1450.50
     * became 1399.
     */
    const total = history[0].changes.find((c: { field: string }) =>
      c.field.startsWith('Total'),
    );
    expect(total.from).toBe('1450.5');
    expect(total.to).toBe('1399');
  });

  it('lists only what actually moved', async () => {
    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const fields = res.body.data[0].history[0].changes.map((c: { field: string }) => c.field);
    // The option count did not change, so it is not mentioned.
    expect(fields).not.toContain('Options offered');
    expect(fields).toHaveLength(1);
  });

  it('keeps the retired offer, so both sides can point at it', async () => {
    const rows = await owner.$queryRawUnsafe<{ unit_price: string }[]>(
      `SELECT l.unit_price::text FROM agent_quote_line l WHERE l.deleted_at IS NOT NULL
         AND l.tenant_id = ${tenantId}`,
    );
    expect(rows.map((r) => r.unit_price)).toContain('1450.5000');
  });
});

describe('a quote from before the breakdown existed', () => {
  /*
   * There is one of these in the field: a quote submitted under the old
   * single-price form, carrying an amount and no options.
   *
   * The migration deliberately kept the column rather than backfilling those
   * rows into options — rewriting a commercial record to fit a new shape is not
   * a migration, it is a forgery. So both shapes have to render, and this is
   * the test that says so.
   */
  it('still reaches staff, with its headline figure intact', async () => {
    const agent = await owner.agent.create({
      data: {
        tenantId,
        code: 'AGT-LEGACY',
        name: 'Legacy Lines',
        country: 'Denmark',
        agentType: 'GENERAL',
      },
      select: { id: true },
    });
    await owner.inquiryParty.create({
      data: { tenantId, inquiryId, agentId: agent.id },
    });
    await owner.agentQuote.create({
      data: {
        tenantId,
        code: 'AQ-LEGACY',
        inquiryId,
        agentId: agent.id,
        amount: '21212',
        currencyId,
        transitDays: 30,
        remarks: 'Quoted before the breakdown existed.',
        updatedAt: new Date(),
      } as never,
    });

    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const legacy = res.body.data.find((q: { code: string }) => q.code === 'AQ-LEGACY');
    expect(legacy).toBeDefined();
    expect(legacy.amount).toBe('21212');
    expect(legacy.options).toEqual([]);
    expect(legacy.transitDays).toBe(30);
    // And it is not mistaken for a settled one.
    expect(legacy.status).toBe('SUBMITTED');

    // Put the inquiry back as the rest of this file expects to find it: two
    // agents, two quotes.
    await owner.$executeRawUnsafe(
      `DELETE FROM agent_quote WHERE tenant_id = ${tenantId} AND code = 'AQ-LEGACY'`,
    );
    await owner.$executeRawUnsafe(
      `DELETE FROM inquiry_party WHERE tenant_id = ${tenantId} AND agent_id = ${agent.id}`,
    );
    await owner.$executeRawUnsafe(
      `DELETE FROM agent WHERE tenant_id = ${tenantId} AND id = ${agent.id}`,
    );
  });
});

describe('who may see it', () => {
  it('shows every agent quote to staff, not just one', async () => {
    const login = await request(app)
      .post('/api/tenant/auth/login')
      .set('X-Tenant-Slug', SLUG)
      .send({ username: 'baltic@aqv.test', password: PASSWORD })
      .expect(200);
    await request(app)
      .post(`/api/tenant/agent/inquiries/${inquiryId}/quote`)
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send(quoteBody({ costHeadId, currencyId }, { unitPrice: '1502' }))
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
      .get(`/api/tenant/agent/inquiries/${inquiryId}`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);
    expect(res.body.data.quote.options[0].lines[0].unitPrice).toBe('1399');
    expect(JSON.stringify(res.body)).not.toContain('1502');
    expect(JSON.stringify(res.body)).not.toContain('Baltic');
  });
});

describe('answering an agent', () => {
  const decide = (quoteId: bigint, decision: 'WON' | 'LOST', comment?: string) =>
    request(app)
      .post(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes/${quoteId}/decision`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Tenant-Slug', SLUG)
      // A loss must carry a reason, so the default supplies one. The rule
      // itself is proved below.
      .send({
        decision,
        ...(comment !== undefined
          ? { comment }
          : decision === 'LOST'
            ? { comment: 'Business LOST, your price was not competitive' }
            : {}),
      });

  const quoteOf = async (agentId: bigint) =>
    (
      await owner.agentQuote.findFirstOrThrow({
        where: { tenantId, agentId },
        select: { id: true },
      })
    ).id;

  it('accepts one', async () => {
    await decide(await quoteOf(nordic), 'WON').expect(200);
    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const nordicQuote = res.body.data.find(
      (q: { agentName: string }) => q.agentName === 'Nordic Forwarding',
    );
    expect(nordicQuote.status).toBe('WON');
  });

  it('leaves the other agents alone', async () => {
    // Whether accepting one settles the rest is a rule nobody has stated, and a
    // forwarder may take two offers for different equipment.
    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const baltic = res.body.data.find(
      (q: { agentName: string }) => q.agentName === 'Baltic Lines',
    );
    expect(baltic.status).toBe('SUBMITTED');
  });

  it('stops the agent amending an answered quote', async () => {
    const quoteId = await quoteOf(nordic);
    await request(app)
      .patch(`/api/tenant/agent/quotes/${quoteId}`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send(quoteBody({ costHeadId, currencyId }, { unitPrice: '1' }))
      .expect(409);
  });

  it('can be reversed while the inquiry is live', async () => {
    // Accept and Decline are one mis-click apart, and the agent can no longer
    // amend — a one-way door would strand them behind someone else's mistake.
    const quoteId = await quoteOf(nordic);
    await decide(quoteId, 'LOST').expect(200);
    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const nordicQuote = res.body.data.find(
      (q: { agentName: string }) => q.agentName === 'Nordic Forwarding',
    );
    expect(nordicQuote.status).toBe('LOST');
  });

  it('reads a decision as ours, not as the agent repricing', async () => {
    // An accept is an UPDATE like any other. Without separating it, the
    // forwarder's own answer appears in the history as though the agent had
    // moved their price — and gets counted as an amendment on screen.
    const res = await staff(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes`).expect(200);
    const nordicQuote = res.body.data.find(
      (q: { agentName: string }) => q.agentName === 'Nordic Forwarding',
    );
    const kinds = nordicQuote.history.map((h: { kind: string }) => h.kind);
    expect(kinds).toContain('DECIDED');
    // Every decision entry moves the status and nothing else — that IS what
    // makes it a decision rather than a reprice.
    for (const entry of nordicQuote.history.filter(
      (h: { kind: string }) => h.kind === 'DECIDED',
    )) {
      expect(entry.changes).toHaveLength(1);
      expect(entry.changes[0].field).toBe('Status');
    }
    // And an amendment never is.
    for (const entry of nordicQuote.history.filter(
      (h: { kind: string }) => h.kind === 'AMENDED',
    )) {
      expect(entry.changes.map((c: { field: string }) => c.field)).not.toEqual(['Status']);
    }
  });

  it('records the decision as a decision, not as a status change', async () => {
    const trail = await owner.auditLog.findMany({
      where: { tenantId, action: { in: ['QUOTE_ACCEPTED', 'QUOTE_DECLINED'] } },
      select: { action: true, changedBy: true },
    });
    // A trail read six months later should say who declined it, not that a
    // column moved between two enum values.
    expect(trail.map((r) => r.action).sort()).toEqual(['QUOTE_ACCEPTED', 'QUOTE_DECLINED']);
    for (const row of trail) expect(row.changedBy).not.toBeNull();
  });

  it('refuses a loss with no reason', async () => {
    /*
     * "You lost" and nothing else is the answer that makes an agent stop
     * pricing you sharply. The client wrote the wording they wanted; the schema
     * makes sure something gets written.
     */
    const res = await request(app)
      .post(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes/${await quoteOf(nordic)}/decision`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ decision: 'LOST' })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/why they lost/i);
  });

  it('puts the outcome in the thread the agent reads', async () => {
    const quoteId = await quoteOf(nordic);
    await decide(quoteId, 'LOST', 'Business LOST, your price was not competitive').expect(200);

    // The agent's own door onto the same conversation.
    const res = await request(app)
      .get(`/api/tenant/agent/quotes/${quoteId}/comments`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      
      .expect(200);

    const outcome = res.body.data.find((c: { outcome: string | null }) => c.outcome !== null);
    expect(outcome.outcome).toBe('LOST');
    expect(outcome.body).toBe('Business LOST, your price was not competitive');
    expect(outcome.authorSide).toBe('FORWARDER');
    // The forwarder speaks as a company. Which member of staff typed it is not
    // an outside company's business — the same boundary that keeps created_by
    // out of agent_inquiry_v.
    expect(outcome.authorName).not.toContain('@');
    expect(outcome.authorName).not.toBe('staff');
  });

  it('refuses a decision from an agent token', async () => {
    const quoteId = await quoteOf(baltic);
    await request(app)
      .post(`/api/tenant/sales/inquiries/${inquiryId}/agent-quotes/${quoteId}/decision`)
      .set('Authorization', `Bearer ${nordicToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ decision: 'WON' })
      .expect(403);
  });

  it('refuses once the inquiry is settled', async () => {
    await owner.inquiry.update({ where: { id: inquiryId }, data: { status: 'WON' } });
    await decide(await quoteOf(baltic), 'WON').expect(409);
    await owner.inquiry.update({ where: { id: inquiryId }, data: { status: 'OPEN' } });
  });
});

describe('the count on the inquiry row', () => {
  const listInquiry = async () => {
    const res = await staff('/api/tenant/sales/inquiries?limit=50').expect(200);
    return (res.body.data as { id: string; agentQuoteCount: number }[]).find(
      (row) => row.id === inquiryId.toString(),
    );
  };

  it('counts the agents that have priced it', async () => {
    // Two agents quoted earlier in this file.
    expect((await listInquiry())?.agentQuoteCount).toBe(2);
  });

  it('does not count a quote the agent withdrew', async () => {
    // A withdrawn quote is one the agent took back — there is nothing on the
    // row to read, so it must not raise the number that says there is.
    await owner.agentQuote.updateMany({
      where: { tenantId, agentId: baltic },
      data: { status: 'WITHDRAWN' },
    });
    expect((await listInquiry())?.agentQuoteCount).toBe(1);

    await owner.agentQuote.updateMany({
      where: { tenantId, agentId: baltic },
      data: { status: 'SUBMITTED' },
    });
  });

  it('is zero on an inquiry nobody has priced', async () => {
    const bare = await owner.inquiry.findFirstOrThrow({
      where: { tenantId, code: 'INQ-2026-AQV001' },
      select: { sourceId: true, customerId: true, polId: true, podId: true },
    });
    const quiet = await owner.inquiry.create({
      data: {
        tenantId,
        code: 'INQ-2026-AQV002',
        seriesYear: 2026,
        inquiryDate: new Date('2026-08-23'),
        sourceId: bare.sourceId,
        shipmentType: 'SEA',
        customerId: bare.customerId,
        movementType: 'INBOUND',
        loadingType: 'FCL',
        polId: bare.polId,
        podId: bare.podId,
      },
      select: { id: true },
    });

    const res = await staff('/api/tenant/sales/inquiries?limit=50').expect(200);
    const row = (res.body.data as { id: string; agentQuoteCount: number }[]).find(
      (r) => r.id === quiet.id.toString(),
    );
    expect(row?.agentQuoteCount).toBe(0);
  });
});
