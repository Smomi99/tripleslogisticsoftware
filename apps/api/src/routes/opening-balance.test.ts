import { PrismaPg } from '@prisma/adapter-pg';
import { PERMISSIONS } from '@ff/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * The opening figures a party's ledger will start from, and Vendor's move to
 * CRM.
 *
 * §4 rule 6 requires a currency stored alongside every amount, and that is
 * asserted at both layers on purpose: the API so the operator is told which box
 * to fix, and a CHECK constraint so no future write path — an import, a script,
 * the Accounts module itself — can post a figure with no currency.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'ob-alpha';
let tenantId: bigint;
let token: string;
let currencyId: bigint;
let vendorTypeId: bigint;

function as(t = token) {
  return {
    get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
    post: (p: string) => request(app).post(p).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
  };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const t of ['agent_expert_area', 'agent_port_coverage', 'agent_network_member', 'agent', 'vendor', 'customer', '"user"']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'OB Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;
  const user = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-ob',
      username: 'admin-ob',
      email: 'admin@ob.test',
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  currencyId = (await owner.currency.findFirstOrThrow({ select: { id: true } })).id;
  vendorTypeId = (await owner.vendorType.findFirstOrThrow({ select: { id: true } })).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('Vendor moved to CRM', () => {
  it('is served under /crm and no longer under /setting', async () => {
    expect((await as().get('/api/tenant/crm/vendors?limit=5')).status).toBe(200);
    expect((await as().get('/api/tenant/setting/vendors?limit=5')).status).toBe(404);
  });

  it('carries CRM.VENDOR permissions, not SETTING.VENDOR', async () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(keys).toContain('CRM.VENDOR.VIEW');
    expect(keys.filter((k) => k.startsWith('SETTING.VENDOR.'))).toEqual([]);
  });

  it('refuses a user holding only the old feature', async () => {
    const limited = await owner.user.create({
      data: {
        tenantId,
        code: 'USR-ob-stale',
        username: 'stale-ob',
        email: 'stale@ob.test',
        passwordHash: 'x',
        isSuperadmin: false,
      },
      select: { id: true },
    });
    const stale = await signAccessToken({
      sub: limited.id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      // A grant that was never migrated would look exactly like this.
      permissions: ['SETTING.VENDOR.VIEW'],
      tokenVersion: 0,
    });
    expect((await as(stale).get('/api/tenant/crm/vendors?limit=5')).status).toBe(403);
  });
});

describe('opening balances', () => {
  it('stores a vendor balance and reads it back with its currency', async () => {
    const response = await as()
      .post('/api/tenant/crm/vendors')
      .send({
        name: 'OB Vendor',
        country: 'Bangladesh',
        vendorTypeId: vendorTypeId.toString(),
        // Signed: negative means we owe them.
        openingBalance: '-2500.7500',
        openingCurrencyId: currencyId.toString(),
      });

    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    expect(response.body.data.openingBalance).toBe('-2500.7500');
    expect(response.body.data.openingCurrencyId).toBe(currencyId.toString());
    expect(response.body.data.openingCurrencyCode).not.toBeNull();
  });

  it('refuses a balance with no currency', async () => {
    const response = await as()
      .post('/api/tenant/crm/vendors')
      .send({
        name: 'OB Vendor No Currency',
        country: 'Bangladesh',
        vendorTypeId: vendorTypeId.toString(),
        openingBalance: '100.0000',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.fields.openingCurrencyId).toBeDefined();
  });

  it('keeps the agent’s two sides apart rather than netting them', async () => {
    const response = await as()
      .post('/api/tenant/crm/agents')
      .send({
        name: 'OB Agent',
        country: 'Bangladesh',
        agentType: 'GENERAL',
        expertAreaIds: [],
        portCoverageIds: [],
        networkIds: [],
        weOwe: '1000.0000',
        agentOwe: '250.0000',
        openingCurrencyId: currencyId.toString(),
      });

    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    expect(response.body.data.weOwe).toBe('1000.0000');
    expect(response.body.data.agentOwe).toBe('250.0000');
  });

  it('leaves both figures null when neither is entered', async () => {
    const response = await as()
      .post('/api/tenant/crm/agents')
      .send({
        name: 'OB Agent Blank',
        country: 'Bangladesh',
        agentType: 'GENERAL',
        expertAreaIds: [],
        portCoverageIds: [],
        networkIds: [],
      });

    expect(response.status).toBe(201);
    // Blank is not zero: a zero opening balance is a real statement.
    expect(response.body.data.weOwe).toBeNull();
    expect(response.body.data.openingCurrencyId).toBeNull();
  });

  it('is refused by the database too, not only by the schema', async () => {
    // A vendor with no opening figures at all is perfectly legal...
    const plain = await as()
      .post('/api/tenant/crm/vendors')
      .send({
        name: 'OB Vendor Plain',
        country: 'Bangladesh',
        vendorTypeId: vendorTypeId.toString(),
      });
    expect(plain.status).toBe(201);

    // ...but putting a figure on it without a currency is not, and the CHECK
    // constraint refuses it even though this write bypasses the API entirely.
    await expect(
      owner.$executeRaw`UPDATE vendor SET opening_balance = 500 WHERE name = 'OB Vendor Plain'`,
    ).rejects.toThrow(/opening_needs_currency/);
  });
});
