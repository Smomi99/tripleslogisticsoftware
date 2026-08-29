import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/** Per-module isolation for CRM → Customer (CLAUDE.md §7A rule 4). */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'cust-alpha';
const SLUG_B = 'cust-beta';

let tenantA: bigint;
let tokenA: string;
let tokenNoPerms: string;
let sectorA: bigint;
let sectorB: bigint;
let customerB: bigint;

async function makeTenant(name: string, slug: string) {
  const tenant = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh' },
    select: { id: true },
  });
  const user = await owner.user.create({
    data: {
      tenantId: tenant.id,
      code: `USR-${slug}`,
      username: `admin-${slug}`,
      email: `admin@${slug}.test`,
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  const token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenant.id.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  return { tenantId: tenant.id, token };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  await owner.$executeRawUnsafe(`DELETE FROM customer_pic WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM customer WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM industry_sector WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  // The salesman tests give these workspaces employees of their own.
  await owner.$executeRawUnsafe(`DELETE FROM employee WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();
  const a = await makeTenant('Customer Alpha', SLUG_A);
  const b = await makeTenant('Customer Beta', SLUG_B);
  tenantA = a.tenantId;
  tokenA = a.token;

  const plain = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-noperm-cust',
      username: `noperm-${SLUG_A}`,
      email: `noperm@${SLUG_A}.test`,
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenNoPerms = await signAccessToken({
    sub: plain.id.toString(),
    tenantId: tenantA.toString(),
    isSuperadmin: false,
    permissions: [],
    tokenVersion: 0,
  });

  const sa = await owner.industrySector.create({
    data: { tenantId: tenantA, code: 'ISC-CA', name: 'Alpha Sector' },
    select: { id: true },
  });
  sectorA = sa.id;
  const sb = await owner.industrySector.create({
    data: { tenantId: b.tenantId, code: 'ISC-CB', name: 'Beta Sector' },
    select: { id: true },
  });
  sectorB = sb.id;

  await owner.customer.create({
    data: {
      tenantId: tenantA,
      code: 'CUS-CA',
      name: 'Alpha Customer',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sectorA,
    },
  });
  const cb = await owner.customer.create({
    data: {
      tenantId: b.tenantId,
      code: 'CUS-CB',
      name: 'Beta Customer',
      country: 'Bangladesh',
      customerType: 'IMPORTER',
      businessArea: 'INBOUND',
      industrySectorId: sectorB,
    },
    select: { id: true },
  });
  customerB = cb.id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function A(method: 'get' | 'post' | 'patch', path: string) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${tokenA}`)
    .set('X-Tenant-Slug', SLUG_A);
}

describe('customer isolation', () => {
  it('lists only tenant A customers', async () => {
    const res = await A('get', '/api/tenant/crm/customers?limit=100');
    expect(res.status).toBe(200);
    const names = res.body.data.map((r: { name: string }) => r.name);
    expect(names).toContain('Alpha Customer');
    expect(names).not.toContain('Beta Customer');
  });

  it('cannot read, edit or toggle a tenant B customer', async () => {
    expect((await A('get', `/api/tenant/crm/customers/${customerB}`)).status).toBe(404);
    expect((await A('get', `/api/tenant/crm/customers/${customerB}/pics`)).status).toBe(404);
    expect((await A('post', `/api/tenant/crm/customers/${customerB}/toggle-status`)).status).toBe(404);

    const untouched = await owner.customer.findUnique({ where: { id: customerB } });
    expect(untouched?.name).toBe('Beta Customer');
    expect(untouched?.isActive).toBe(true);
  });

  it('refuses a commodity category belonging to another tenant', async () => {
    const res = await A('post', '/api/tenant/crm/customers').send({
      name: 'Smuggled',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sectorB.toString(),
    });
    // The category is invisible to tenant A, so it reads as unavailable.
    expect(res.status).toBe(400);
  });

  it('stores volumes at NUMERIC(18,4) precision (§4 rule 6)', async () => {
    const created = await A('post', '/api/tenant/crm/customers').send({
      name: 'Precision Ltd',
      country: 'Bangladesh',
      customerType: 'TRADER',
      businessArea: 'BOTH',
      industrySectorId: sectorA.toString(),
      exSeaVolumeTeuMonth: '1234.5678',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.exSeaVolumeTeuMonth).toBe('1234.5678');
  });

  it('records the notes and the assigned salesman', async () => {
    /*
     * Both asked for by the client on 2026-08-29 and neither in §6. The
     * salesman is a real foreign key to an employee of this workspace rather
     * than a typed name, so "whose account is this" survives somebody leaving.
     */
    const employee = await owner.employee.create({
      data: { tenantId: tenantA, code: 'EMP-CT', name: 'Tanjila Sathi', country: 'Bangladesh' },
      select: { id: true },
    });

    const created = await A('post', '/api/tenant/crm/customers').send({
      name: 'Noted Ltd',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sectorA.toString(),
      notes: 'Pays on 30 days. Always asks for a 40HC.',
      salesmanId: employee.id.toString(),
    });
    expect(created.status, JSON.stringify(created.body.error ?? {})).toBe(201);
    expect(created.body.data.notes).toBe('Pays on 30 days. Always asks for a 40HC.');
    expect(created.body.data.salesmanId).toBe(employee.id.toString());
    expect(created.body.data.salesmanName).toBe('Tanjila Sathi');
  });

  it('leaves both blank when they are not given', async () => {
    // Every customer already in production has neither, so blank has to be a
    // perfectly ordinary state rather than an error.
    const created = await A('post', '/api/tenant/crm/customers').send({
      name: 'Unassigned Ltd',
      country: 'Bangladesh',
      customerType: 'IMPORTER',
      businessArea: 'INBOUND',
      industrySectorId: sectorA.toString(),
    });
    expect(created.status).toBe(201);
    expect(created.body.data.notes).toBeNull();
    expect(created.body.data.salesmanId).toBeNull();
    expect(created.body.data.salesmanName).toBeNull();
  });

  it('refuses a salesman from another workspace', async () => {
    // §4 rule 10. The key is composite, so this cannot resolve at all.
    const other = await owner.customer.findUniqueOrThrow({
      where: { id: customerB },
      select: { tenantId: true },
    });
    const theirs = await owner.employee.create({
      data: {
        tenantId: other.tenantId,
        code: 'EMP-CTB',
        name: 'Someone Else',
        country: 'Bangladesh',
      },
      select: { id: true },
    });
    const res = await A('post', '/api/tenant/crm/customers').send({
      name: 'Cross Tenant Ltd',
      country: 'Bangladesh',
      customerType: 'TRADER',
      businessArea: 'BOTH',
      industrySectorId: sectorA.toString(),
      salesmanId: theirs.id.toString(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const leaked = await owner.customer.findFirst({
      where: { tenantId: tenantA, name: 'Cross Tenant Ltd' },
    });
    expect(leaked).toBeNull();
  });

  it('filters the list by commodity', async () => {
    // The client calls the commodity category "commodity"; it is the industry
    // sector the form already asks for.
    const res = await A(
      'get',
      `/api/tenant/crm/customers?limit=100&industrySectorId=${sectorA.toString()}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row.industrySectorId).toBe(sectorA.toString());
    }
  });

  it('filters by type and commodity together', async () => {
    const res = await A(
      'get',
      `/api/tenant/crm/customers?limit=100&customerType=EXPORTER&industrySectorId=${sectorA.toString()}`,
    );
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row.customerType).toBe('EXPORTER');
      expect(row.industrySectorId).toBe(sectorA.toString());
    }
  });

  it('offers the workspace its own salesmen, and nobody else\'s', async () => {
    const res = await A('get', '/api/tenant/crm/customers/salesmen');
    expect(res.status).toBe(200);
    const names = res.body.data.map((r: { name: string }) => r.name);
    expect(names).not.toContain('Someone Else');
  });

  it('guards every route with a permission', async () => {
    const noPerm = await request(app)
      .get('/api/tenant/crm/customers')
      .set('Authorization', `Bearer ${tokenNoPerms}`)
      .set('X-Tenant-Slug', SLUG_A);
    expect(noPerm.status).toBe(403);

    const anon = await request(app)
      .get('/api/tenant/crm/customers')
      .set('X-Tenant-Slug', SLUG_A);
    expect(anon.status).toBe(401);
  });
});
