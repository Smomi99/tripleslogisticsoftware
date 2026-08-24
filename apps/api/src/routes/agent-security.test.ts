import { PrismaPg } from '@prisma/adapter-pg';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { PERMISSIONS, userFormSchema } from '@ff/shared';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { hashPassword } from '../lib/password';
import { quoteBody } from '../lib/test-quote';

/**
 * The production gate for agent accounts.
 *
 * Agents became ordinary users of the workspace: same sign-in, a role like
 * anyone else. That traded one structural guarantee for a configurable one, and
 * this file exists to prove the trade was safe. Every test here is written from
 * the attacker's side — what can an outside company reach if somebody ticks the
 * wrong box, guesses an id, or reads the wire?
 *
 * The worst case is deliberate: one agent is given a role holding EVERY
 * permission in the registry.
 */

vi.mock('../lib/mailer', () => ({
  sendMail: () => Promise.resolve({ sent: true }),
  parseAddressList: () => [],
}));

// Recorded at registration so the route sweep can rebuild full paths; Express 5
// does not fill layer.path until a request matches.
const mounts = new Map<unknown, string>();
{
  const proto = (express.Router as unknown as { prototype: Record<string, unknown> }).prototype;
  const original = proto['use'] as (...args: unknown[]) => unknown;
  proto['use'] = function patched(this: unknown, ...args: unknown[]) {
    const [first, ...handlers] = args;
    if (typeof first === 'string') {
      for (const handler of handlers) {
        if (typeof handler === 'function' && 'stack' in handler) mounts.set(handler, first);
      }
    }
    return original.apply(this, args);
  };
}
const { createApp } = await import('../app');

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'sec-alpha';
const PASSWORD = 'Correct-Horse-Battery';
const CUSTOMER = 'SENTINELCUSTOMER-Dhaka-Apparels';
const TARGET_PRICE = '987654.4321';
const STAFF_REMARK = 'SENTINELREMARK internal note';

let tenantId: bigint;
let nordic: bigint;
let baltic: bigint;
let nordicInquiry: bigint;
let balticInquiry: bigint;
let currencyId: bigint;
let costHeadId: bigint;
let balticQuoteId: bigint;

/** Agent holding EVERY permission there is. The worst case. */
let godAgentToken: string;
/** Agent holding only AGENT.INQUIRY.VIEW — no QUOTE. */
let readOnlyAgentToken: string;
/** Baltic's own login, to prove one agent cannot reach another's. */
let balticToken: string;
/** Staff who have been granted the agent permissions by mistake. */
let confusedStaffToken: string;
/** Customer and vendor logins, which have no module of their own yet. */
let customerToken: string;
let vendorToken: string;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  await owner.$executeRawUnsafe(
    `UPDATE "user" SET agent_id = NULL, role_id = NULL WHERE tenant_id IN ${scope}`,
  );
  for (const table of [
    'email_log',
    'agent_quote_comment',
    'agent_quote_line',
    'agent_quote_option',
    'agent_quote',
    'inquiry_rate',
    'inquiry_party_contact',
    'inquiry_party',
    'inquiry_volume',
    'inquiry',
    'rate_local_charge',
    'freight_rate_line',
    'freight_rate',
    'role_permission',
    'user_permission',
    '"user"',
    'role',
    'agent_pic',
    'agent',
    'vendor',
    'vendor_type',
    'customer',
    'industry_sector',
    'port',
    'carrier',
    'goods_type',
    'inquiry_source',
    'cost_head',
    'cost_unit',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

/** Creates a role carrying the given permission keys, and returns its id. */
async function roleWith(code: string, keys: string[]): Promise<bigint> {
  const role = await owner.role.create({
    data: { tenantId, code, name: `${code} role` },
    select: { id: true },
  });
  const permissions = await owner.permission.findMany({
    where: { key: { in: keys } },
    select: { id: true },
  });
  await owner.rolePermission.createMany({
    data: permissions.map((p) => ({ tenantId, roleId: role.id, permissionId: p.id })),
  });
  return role.id;
}

async function signIn(username: string): Promise<string> {
  const res = await request(app)
    .post('/api/tenant/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ username, password: PASSWORD })
    .expect(200);
  return res.body.data.accessToken as string;
}

const get = (path: string, token: string) =>
  request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', SLUG);
const post = (path: string, token: string, body: object) =>
  request(app)
    .post(path)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Slug', SLUG)
    .send(body);

beforeAll(async () => {
  await cleanup();
  tenantId = (
    await owner.tenant.create({
      data: { name: 'Sec Alpha', slug: SLUG, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  const makeAgent = async (code: string, name: string) =>
    (
      await owner.agent.create({
        data: { tenantId, code, name, country: 'Denmark', agentType: 'GENERAL' },
        select: { id: true },
      })
    ).id;
  nordic = await makeAgent('SEC-N', 'Nordic Forwarding');
  baltic = await makeAgent('SEC-B', 'Baltic Lines');
  const readOnlyAgent = await makeAgent('SEC-R', 'Read Only Lines');

  // Every permission the registry defines. If an agent can be widened by a
  // role, this is the role that would do it.
  const everything = await roleWith(
    'SEC-GOD',
    PERMISSIONS.map((p) => p.key),
  );
  const viewOnly = await roleWith('SEC-RO', ['AGENT.INQUIRY.VIEW']);
  const agentBoth = await roleWith('SEC-AG', ['AGENT.INQUIRY.VIEW', 'AGENT.INQUIRY.QUOTE']);

  const makeUser = async (
    code: string,
    username: string,
    agentId: bigint | null,
    roleId: bigint | null,
  ) =>
    owner.user.create({
      data: {
        tenantId,
        code,
        username,
        email: `${username}@sec.test`,
        passwordHash: await hashPassword(PASSWORD),
        agentId,
        roleId,
        isActive: true,
      },
      select: { id: true },
    });

  await makeUser('USR-god', 'god-agent', nordic, everything);
  await makeUser('USR-ro', 'ro-agent', readOnlyAgent, viewOnly);
  await makeUser('USR-bal', 'baltic-agent', baltic, agentBoth);
  // Staff wrongly given the agent permissions. They must gain nothing.
  await makeUser('USR-conf', 'confused-staff', null, everything);

  // Data an agent must never see.
  const sector = await owner.industrySector.create({
    data: { tenantId, code: 'SEC-SEC', name: 'Sec Sector' },
    select: { id: true },
  });
  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: 'SEC-CUS',
      name: CUSTOMER,
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const source = await owner.inquirySource.create({
    data: { tenantId, code: 'SEC-SRC', name: 'Sec Source' },
    select: { id: true },
  });
  const port = (code: string, country: string) =>
    owner.port.create({
      data: { tenantId, code, name: `${code} Port`, portCode: code, country, type: 'SEAPORT' },
      select: { id: true },
    });
  const pol = await port('SECPOL', 'Bangladesh');
  const pod = await port('SECPOD', 'Denmark');
  currencyId = (
    await owner.currency.findFirstOrThrow({ where: { tenantId: null }, select: { id: true } })
  ).id;

  const makeInquiry = async (code: string, agentId: bigint) => {
    const inquiry = await owner.inquiry.create({
      data: {
        tenantId,
        code,
        seriesYear: 2026,
        inquiryDate: new Date('2026-08-24'),
        sourceId: source.id,
        shipmentType: 'SEA',
        customerId: customer.id,
        movementType: 'INBOUND',
        loadingType: 'FCL',
        polId: pol.id,
        podId: pod.id,
        remarks: STAFF_REMARK,
      },
      select: { id: true },
    });
    await owner.inquiryParty.create({ data: { tenantId, inquiryId: inquiry.id, agentId } });
    await owner.inquiryVolume.create({
      data: {
        tenantId,
        inquiryId: inquiry.id,
        volumeKind: 'FCL',
        quantity: 2,
        targetPrice: TARGET_PRICE,
      },
    });
    return inquiry.id;
  };
  nordicInquiry = await makeInquiry('INQ-2026-SEC001', nordic);
  balticInquiry = await makeInquiry('INQ-2026-SEC002', baltic);

  // A bought rate — the forwarder's buying position.
  const carrier = await owner.carrier.create({
    data: {
      tenantId,
      code: 'SEC-CAR',
      name: 'Sec Line',
      typeId: (await owner.carrierType.findFirstOrThrow({ select: { id: true } })).id,
    },
    select: { id: true },
  });
  const goods = await owner.goodsType.create({
    data: { tenantId, code: 'SEC-GT', name: 'Sec Goods' },
    select: { id: true },
  });
  const rate = await owner.freightRate.create({
    data: {
      tenantId,
      code: 'RATE-SEC-1',
      mode: 'SEA_FCL',
      polId: pol.id,
      podId: pod.id,
      carrierId: carrier.id,
      goodsTypeId: goods.id,
      purchaseSourceType: 'CARRIER',
      purchaseCarrierId: carrier.id,
      currencyId,
      validFrom: new Date('2026-08-01'),
      validTo: new Date('2026-12-31'),
      status: 'PUBLISHED',
    },
    select: { id: true },
  });
  const tier = await owner.rateTier.findFirstOrThrow({
    where: { mode: 'SEA_FCL' },
    select: { id: true },
  });
  await owner.freightRateLine.create({
    data: { tenantId, rateId: rate.id, tierId: tier.id, buyPrice: 900, profitType: 'FLAT', profitValue: 100 },
  });

  // Customer and vendor logins, each carrying the all-permissions role. They
  // have no screens at all yet, so every route must refuse them.
  const customerCompany = await owner.customer.create({
    data: {
      tenantId,
      code: 'SEC-CUS2',
      name: 'Sec Customer Co',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'BOTH',
      industrySectorId: (
        await owner.industrySector.findFirstOrThrow({ where: { tenantId }, select: { id: true } })
      ).id,
    },
    select: { id: true },
  });
  const vendorType = await owner.vendorType.create({
    data: { tenantId, code: 'SEC-VT', name: 'Sec Vendor Type' },
    select: { id: true },
  });
  const vendorCompany = await owner.vendor.create({
    data: {
      tenantId,
      code: 'SEC-VEN',
      name: 'Sec Vendor Co',
      country: 'Bangladesh',
      vendorTypeId: vendorType.id,
    },
    select: { id: true },
  });
  await owner.user.create({
    data: {
      tenantId,
      code: 'USR-cus',
      username: 'cus-user',
      email: 'cus-user@sec.test',
      passwordHash: await hashPassword(PASSWORD),
      customerId: customerCompany.id,
      roleId: everything,
      isActive: true,
    },
  });
  await owner.user.create({
    data: {
      tenantId,
      code: 'USR-ven',
      username: 'ven-user',
      email: 'ven-user@sec.test',
      passwordHash: await hashPassword(PASSWORD),
      vendorId: vendorCompany.id,
      roleId: everything,
      isActive: true,
    },
  });

  godAgentToken = await signIn('god-agent');
  customerToken = await signIn('cus-user');
  vendorToken = await signIn('ven-user');
  readOnlyAgentToken = await signIn('ro-agent');
  balticToken = await signIn('baltic-agent');
  confusedStaffToken = await signIn('confused-staff');

  // A cost head to price against.
  const costUnit = await owner.costUnit.create({
    data: { tenantId, code: 'SEC-CU', name: 'Container' },
    select: { id: true },
  });
  costHeadId = (
    await owner.costHead.create({
      data: {
        tenantId,
        code: 'SEC-CH',
        category: 'SERVICE',
        name: 'Ocean Freight',
        unitId: costUnit.id,
      },
      select: { id: true },
    })
  ).id;

  // Baltic quotes their own inquiry, so there is a foreign quote to try to reach.
  const quoted = await post(
    `/api/tenant/agent/inquiries/${balticInquiry}/quote`,
    balticToken,
    quoteBody({ costHeadId, currencyId }, { unitPrice: '1502' }),
  ).expect(201);
  balticQuoteId = BigInt(quoted.body.data.id as string);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

/* ------------------------------------------------------------------ */

describe('an agent holding EVERY permission in the registry', () => {
  it('is still refused by every staff route', async () => {
    interface Layer {
      route?: { path: string; methods: Record<string, boolean> };
      handle?: { stack?: Layer[] };
    }
    const found: { method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string }[] = [];
    const walk = (stack: Layer[], prefix: string): void => {
      for (const layer of stack) {
        if (layer.route !== undefined) {
          for (const method of Object.keys(layer.route.methods)) {
            if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
            const template = `${prefix}${layer.route.path}`
              .replace(/\/+/g, '/')
              .replace(/(.)\/$/, '$1');
            found.push({
              method: method as 'get',
              path: template.replace(/:[A-Za-z0-9_]+/g, '1'),
            });
          }
          continue;
        }
        const nested = layer.handle?.stack;
        if (nested !== undefined) walk(nested, `${prefix}${mounts.get(layer.handle) ?? ''}`);
      }
    };
    walk((app as unknown as { router: { stack: Layer[] } }).router.stack, '');

    const open: string[] = [];
    let checked = 0;
    for (const endpoint of found) {
      if (!endpoint.path.startsWith('/api/tenant')) continue;
      // Its own module, and the one endpoint that serves both kinds.
      if (endpoint.path.startsWith('/api/tenant/agent/')) continue;
      if (endpoint.path === '/api/tenant/auth/me') continue;
      if (endpoint.path.startsWith('/api/tenant/auth/')) continue;
      if (endpoint.path === '/api/tenant/context') continue;
      checked += 1;
      const res = await request(app)
        [endpoint.method](endpoint.path)
        .set('Authorization', `Bearer ${godAgentToken}`)
        .set('X-Tenant-Slug', SLUG)
        .send({});
      if (res.status !== 403) open.push(`${endpoint.method} ${endpoint.path} -> ${res.status}`);
    }

    // The claim in one assertion: a role cannot widen an agent, because the
    // kind check sits above the permission check.
    expect(checked).toBeGreaterThan(100);
    expect(open, `staff routes an all-permissions agent reached: ${open.join(', ')}`).toEqual([]);
  });

  it('still sees only the inquiries it was selected for', async () => {
    // Holding SALES.INQUIRY.VIEW_ALL changes nothing: row level security is not
    // a permission check, and withAgent scopes the transaction regardless.
    const res = await get('/api/tenant/agent/inquiries', godAgentToken).expect(200);
    const codes = (res.body.data as { code: string }[]).map((i) => i.code);
    expect(codes).toEqual(['INQ-2026-SEC001']);
  });

  it('cannot open another agent inquiry by id', async () => {
    await get(`/api/tenant/agent/inquiries/${balticInquiry}`, godAgentToken).expect(404);
  });

  it('cannot read another agent quote', async () => {
    const res = await get(`/api/tenant/agent/inquiries/${nordicInquiry}`, godAgentToken).expect(200);
    expect(JSON.stringify(res.body)).not.toContain('1502');
    expect(JSON.stringify(res.body)).not.toContain('Baltic');
  });
});

describe('staff wrongly granted the agent permissions', () => {
  it('gain nothing: the agent routes refuse a staff session', async () => {
    // The mirror of the rule above. AGENT.INQUIRY.VIEW is not a key to the
    // agent screens — being an agent is.
    for (const path of [
      '/api/tenant/agent/inquiries',
      `/api/tenant/agent/inquiries/${nordicInquiry}`,
      '/api/tenant/agent/currencies',
    ]) {
      const res = await get(path, confusedStaffToken);
      expect(res.status, path).toBe(403);
    }
  });
});

describe('AGENT.INQUIRY.QUOTE', () => {
  it('cannot quote an inquiry the agent was not sent', async () => {
    const res = await post(
      `/api/tenant/agent/inquiries/${balticInquiry}/quote`,
      godAgentToken,
      quoteBody({ costHeadId, currencyId }, { unitPrice: '1' }),
    );
    // 404, not 403: confirming it exists is itself a leak.
    expect(res.status).toBe(404);
  });

  it('cannot amend another agent quote', async () => {
    const res = await request(app)
      .patch(`/api/tenant/agent/quotes/${balticQuoteId}`)
      .set('Authorization', `Bearer ${godAgentToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send(quoteBody({ costHeadId, currencyId }, { unitPrice: '1' }));
    expect(res.status).toBe(404);
  });

  it('is refused to an agent whose role holds VIEW but not QUOTE', async () => {
    // The reason QUOTE is a separate action: a forwarder can give a junior at
    // the agent read-only access.
    const res = await post(
      `/api/tenant/agent/inquiries/${nordicInquiry}/quote`,
      readOnlyAgentToken,
      quoteBody({ costHeadId, currencyId }, { unitPrice: '1000' }),
    );
    expect(res.status).toBe(403);
  });

  it('lets the right agent quote its own inquiry', async () => {
    await post(
      `/api/tenant/agent/inquiries/${nordicInquiry}/quote`,
      godAgentToken,
      quoteBody({ costHeadId, currencyId }, { unitPrice: '1450.50' }),
    ).expect(201);
  });
});

/*
 * The Status thread is a two-way channel to an outside company, which makes it
 * the newest piece of attack surface in the product. These are the questions
 * worth asking of it.
 */
describe('the Status thread', () => {
  it('does not let an agent read the thread on another agent quote', async () => {
    const res = await get(`/api/tenant/agent/quotes/${balticQuoteId}/comments`, godAgentToken);
    expect(res.status).toBe(404);
  });

  it('does not let an agent post into another agent thread', async () => {
    const res = await post(
      `/api/tenant/agent/quotes/${balticQuoteId}/comments`,
      godAgentToken,
      { body: 'SENTINELINTRUSION' },
    );
    expect(res.status).toBe(404);

    const rows = await owner.agentQuoteComment.findMany({
      where: { tenantId, quoteId: balticQuoteId },
      select: { body: true },
    });
    expect(rows.map((r) => r.body).join(' ')).not.toContain('SENTINELINTRUSION');
  });

  it('never names the member of staff who wrote a message', async () => {
    // The forwarder speaks as a company. Which of their people typed it is the
    // same class of fact as created_by, which agent_inquiry_v omits.
    const own = await owner.agentQuote.findFirstOrThrow({
      where: { tenantId, agentId: nordic },
      select: { id: true },
    });
    const staffUser = await owner.user.findFirstOrThrow({
      where: { tenantId, username: 'confused-staff' },
      select: { id: true },
    });
    await owner.agentQuoteComment.create({
      data: {
        tenantId,
        quoteId: own.id,
        authorId: staffUser.id,
        body: 'We can move on this if you sharpen the 40HC.',
      },
    });

    const res = await get(`/api/tenant/agent/quotes/${own.id}/comments`, godAgentToken).expect(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('sharpen the 40HC');
    expect(body).not.toContain('confused-staff');
    expect(body).not.toContain('@sec.test');
  });

  it('cannot be rewritten, even by the workspace role the API runs as', async () => {
    // Append-only is a privilege, not a convention: ff_app holds SELECT and
    // INSERT on this table and nothing else.
    const grants = await owner.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'ff_app' AND table_name = 'agent_quote_comment' ORDER BY 1`,
    );
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
  });

  it('refuses an empty message', async () => {
    const own = await owner.agentQuote.findFirstOrThrow({
      where: { tenantId, agentId: nordic },
      select: { id: true },
    });
    const res = await post(`/api/tenant/agent/quotes/${own.id}/comments`, godAgentToken, {
      body: '   ',
    });
    expect(res.status).toBe(400);
  });
});

describe('what an agent can never read', () => {
  it('finds no customer, target price or staff remarks anywhere in its own data', async () => {
    const list = await get('/api/tenant/agent/inquiries', godAgentToken).expect(200);
    const detail = await get(
      `/api/tenant/agent/inquiries/${nordicInquiry}`,
      godAgentToken,
    ).expect(200);

    for (const [label, body] of [
      ['list', JSON.stringify(list.body)],
      ['detail', JSON.stringify(detail.body)],
    ] as const) {
      expect(body, label).not.toContain(CUSTOMER);
      expect(body, label).not.toContain('987654');
      expect(body, label).not.toContain('SENTINELREMARK');
      expect(body, label).not.toContain('customerId');
      expect(body, label).not.toContain('targetPrice');
    }
  });

  it('cannot reach the buying rates through any agent route', async () => {
    // freight_rate is closed to agents by RLS and has no agent route at all.
    // Both facts are asserted, because either alone could regress.
    for (const path of [
      '/api/tenant/purchase/rates?mode=SEA_FCL',
      '/api/tenant/purchase/rate-options?mode=SEA_FCL',
    ]) {
      expect((await get(path, godAgentToken)).status, path).toBe(403);
    }
    const detail = await get(
      `/api/tenant/agent/inquiries/${nordicInquiry}`,
      godAgentToken,
    ).expect(200);
    expect(JSON.stringify(detail.body)).not.toContain('RATE-SEC-1');
    expect(JSON.stringify(detail.body)).not.toContain('900');
  });

  it('reads its own quote and nobody else', async () => {
    const res = await get(`/api/tenant/agent/inquiries/${nordicInquiry}`, godAgentToken).expect(200);
    expect(res.body.data.quote.options[0].lines[0].unitPrice).toBe('1450.5');
    // Baltic quoted 1502 on their own inquiry. Not a digit of it here.
    expect(JSON.stringify(res.body)).not.toContain('1502');
  });
});

/* ------------------------------------------------------------------ */

describe('the Add User form schema', () => {
  const base = {
    username: 'someone',
    email: 'someone@example.com',
    password: 'Correct-Horse-Battery',
    isSuperadmin: false,
  };

  it('accepts a user with no role, which a blank select sends as an empty string', () => {
    // The regression this covers: `.regex(/^\d+$/).optional()` refuses '',
    // because optional means the KEY may be absent, not that the value may be
    // blank. Adding any user without a role failed on "Choose a role" — a
    // message for a field that is not required.
    const staff = userFormSchema.safeParse({
      ...base,
      userType: 'EMPLOYEE',
      employeeId: '7',
      agentId: '',
      roleId: '',
    });
    expect(staff.success).toBe(true);

    const agent = userFormSchema.safeParse({
      ...base,
      userType: 'AGENT',
      employeeId: '',
      agentId: '9',
      roleId: '',
    });
    expect(agent.success).toBe(true);
  });

  it('still requires the link that matches the type', () => {
    const noEmployee = userFormSchema.safeParse({
      ...base,
      userType: 'EMPLOYEE',
      employeeId: '',
      agentId: '',
      roleId: '',
    });
    expect(noEmployee.success).toBe(false);

    const noAgent = userFormSchema.safeParse({
      ...base,
      userType: 'AGENT',
      employeeId: '',
      agentId: '',
      roleId: '',
    });
    expect(noAgent.success).toBe(false);
  });

  it('refuses an agent superadmin before the database has to', () => {
    const result = userFormSchema.safeParse({
      ...base,
      userType: 'AGENT',
      agentId: '9',
      employeeId: '',
      roleId: '',
      isSuperadmin: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('customer and vendor logins', () => {
  it('exist and can sign in', () => {
    // The client asked for these "as employee, nothing more": the account is
    // real, it just has nowhere to go yet.
    expect(customerToken.length).toBeGreaterThan(20);
    expect(vendorToken.length).toBeGreaterThan(20);
  });

  it('reach no staff route, even holding every permission', async () => {
    // The reason the session gate had to change with them. Until it did, "no
    // agent id" meant "is staff" — so a customer login would have BEEN a staff
    // login the day the column was added.
    for (const [label, token] of [
      ['customer', customerToken],
      ['vendor', vendorToken],
    ] as const) {
      for (const path of [
        '/api/tenant/crm/customers',
        '/api/tenant/crm/vendors',
        '/api/tenant/crm/users',
        '/api/tenant/setting/ports',
        '/api/tenant/sales/inquiries',
        '/api/tenant/purchase/rates?mode=SEA_FCL',
        '/api/tenant/admin/roles',
      ]) {
        expect((await get(path, token)).status, `${label} at ${path}`).toBe(403);
      }
    }
  });

  it('reach the agent module no more than a staff user does', async () => {
    // Being external is not the same as being an agent. Only an agent link
    // opens Agent Inquiry.
    for (const token of [customerToken, vendorToken]) {
      expect((await get('/api/tenant/agent/inquiries', token)).status).toBe(403);
    }
  });

  it('can still ask who they are', async () => {
    // /auth/me is the one endpoint serving every kind, or the browser could not
    // restore a session on page load.
    const res = await get('/api/tenant/auth/me', customerToken).expect(200);
    expect(res.body.data.isExternal).toBe(true);
    expect(res.body.data.agentId).toBeNull();
    expect(res.body.data.name).toBe('Sec Customer Co');
  });
});

describe('one company, one login', () => {
  it('refuses a second login for the same customer', async () => {
    const customer = await owner.customer.findFirstOrThrow({
      where: { tenantId, code: 'SEC-CUS2' },
      select: { id: true },
    });
    await expect(
      owner.user.create({
        data: {
          tenantId,
          code: 'USR-cus2',
          username: 'cus-user-2',
          email: 'cus2@sec.test',
          passwordHash: 'x',
          customerId: customer.id,
        },
      }),
    ).rejects.toThrow(/user_one_login_per_customer|Unique constraint/i);
  });

  it('refuses a login that is two companies at once', async () => {
    const customer = await owner.customer.findFirstOrThrow({
      where: { tenantId, code: 'SEC-CUS' },
      select: { id: true },
    });
    // No answer to "whose data is this?", so the row cannot exist.
    await expect(
      owner.user.create({
        data: {
          tenantId,
          code: 'USR-both',
          username: 'both',
          email: 'both@sec.test',
          passwordHash: 'x',
          agentId: baltic,
          customerId: customer.id,
        },
      }),
    ).rejects.toThrow(/user_external_is_not_staff/);
  });

  it('refuses an external login that is also superadmin', async () => {
    const vendor = await owner.vendor.findFirstOrThrow({
      where: { tenantId, code: 'SEC-VEN' },
      select: { id: true },
    });
    await expect(
      owner.user.create({
        data: {
          tenantId,
          code: 'USR-sup',
          username: 'sup',
          email: 'sup@sec.test',
          passwordHash: 'x',
          vendorId: vendor.id,
          isSuperadmin: true,
        },
      }),
    ).rejects.toThrow(/user_external_is_not_staff/);
  });
});
