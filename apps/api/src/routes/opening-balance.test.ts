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
 * Every party keeps the agent's two columns — We owe (Dr) and <party> owe
 * (Cr) — since the client asked on 2026-09-27 for customer and vendor to lose
 * their single signed Opening Balance (MODULE_ACCOUNTS §14.14).
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
let sectorId: bigint;

function as(t = token) {
  return {
    get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
    post: (p: string) => request(app).post(p).set('Authorization', `Bearer ${t}`).set('X-Tenant-Slug', SLUG),
  };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const t of ['agent_expert_area', 'agent_port_coverage', 'agent_network_member', 'agent', 'vendor', 'customer', 'industry_sector', '"user"']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();
  // In the base currency, so the list can put a figure in its base columns
  // without a rate — a workspace with no base marks every opening rateMissing.
  currencyId = (
    await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } }, select: { id: true } })
  ).id;
  const tenant = await owner.tenant.create({
    data: { name: 'OB Alpha', slug: SLUG, country: 'Bangladesh', currencyId },
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
  vendorTypeId = (await owner.vendorType.findFirstOrThrow({ select: { id: true } })).id;
  sectorId = (
    await owner.industrySector.create({ data: { tenantId, code: 'ISC-ob', name: 'OB Garments' }, select: { id: true } })
  ).id;
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
  it('stores a vendor’s two sides and reads them back with their currency', async () => {
    const response = await as()
      .post('/api/tenant/crm/vendors')
      .send({
        name: 'OB Vendor',
        country: 'Bangladesh',
        vendorTypeId: vendorTypeId.toString(),
        // What we owe them is typed as it is said — no minus sign.
        weOwe: '2500.7500',
        openingCurrencyId: currencyId.toString(),
      });

    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    expect(response.body.data.weOwe).toBe('2500.7500');
    expect(response.body.data.vendorOwe).toBeNull();
    expect(response.body.data.openingCurrencyId).toBe(currencyId.toString());
    expect(response.body.data.openingCurrencyCode).not.toBeNull();
    expect(response.body.data).not.toHaveProperty('openingBalance');
  });

  it('keeps a customer’s two sides apart rather than netting them', async () => {
    const response = await as()
      .post('/api/tenant/crm/customers')
      .send({
        name: 'OB Customer',
        country: 'Bangladesh',
        customerType: 'EXPORTER',
        businessArea: 'OUTBOUND',
        industrySectorId: sectorId.toString(),
        weOwe: '300.0000',
        customerOwe: '1200.0000',
        openingCurrencyId: currencyId.toString(),
      });

    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    expect(response.body.data.weOwe).toBe('300.0000');
    expect(response.body.data.customerOwe).toBe('1200.0000');
  });

  it('puts each side on its own column of the Receivable-Payable list', async () => {
    const list = await as().get('/api/tenant/accounts/receivable-payable?limit=100');
    expect(list.status, JSON.stringify(list.body.error ?? {})).toBe(200);
    const byName = new Map(list.body.data.map((r: { partyName: string }) => [r.partyName, r]));

    // What we owe the vendor is payable — never money owed to us.
    const vendor = byName.get('OB Vendor') as Record<string, string>;
    expect(vendor.receivableBase).toBe('0.0000');
    expect(vendor.payableBase).toBe('2500.7500');

    // A customer owing us on one account while we owe them on another shows both.
    const customer = byName.get('OB Customer') as Record<string, string>;
    expect(customer.receivableBase).toBe('1200.0000');
    expect(customer.payableBase).toBe('300.0000');
  });

  it('refuses a negative figure — each column already names its side', async () => {
    const response = await as()
      .post('/api/tenant/crm/vendors')
      .send({
        name: 'OB Vendor Negative',
        country: 'Bangladesh',
        vendorTypeId: vendorTypeId.toString(),
        vendorOwe: '-100',
        openingCurrencyId: currencyId.toString(),
      });
    expect(response.status).toBe(400);
    expect(response.body.error.fields.vendorOwe).toBeDefined();
  });

  it('refuses a figure with no currency', async () => {
    const response = await as()
      .post('/api/tenant/crm/vendors')
      .send({
        name: 'OB Vendor No Currency',
        country: 'Bangladesh',
        vendorTypeId: vendorTypeId.toString(),
        vendorOwe: '100.0000',
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
      owner.$executeRaw`UPDATE vendor SET vendor_owe = 500 WHERE name = 'OB Vendor Plain'`,
    ).rejects.toThrow(/opening_needs_currency/);
    await expect(
      owner.$executeRaw`UPDATE customer SET we_owe = -1, opening_currency_id = ${currencyId} WHERE name = 'OB Customer'`,
    ).rejects.toThrow(/opening_not_negative/);
  });
});
