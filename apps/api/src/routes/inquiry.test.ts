import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { formatInquiryNo } from '../lib/inquiry-no';
import { signAccessToken } from '../lib/jwt';

/**
 * Sales — inquiry capture (docs/MODULE_PURCHASE_SALES.md §3.3, §5.4, §9 Q9,
 * §4 rules 10 and 11, CLAUDE.md §7A rule 4).
 *
 * The row-scope assertions matter most. §4 rule 10 says a salesman sees their
 * own inquiries by default — that is a visibility rule, so the tests check what
 * a second salesman actually receives, not what the UI would render.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const app = createApp();

const SLUG_A = 'inq-alpha';
const SLUG_B = 'inq-beta';
const PREFIX = 'INQTEST-';

const BASE_PERMS = ['SALES.INQUIRY.VIEW', 'SALES.INQUIRY.CREATE'];

let tenantA: bigint;
let tenantB: bigint;
let tokenAdmin: string;
/** A salesman: sees only inquiries recorded against their employee record. */
let tokenSalesOne: string;
let salesOneEmployeeId: bigint;
/** A second salesman, to prove the first one's rows are not visible. */
let tokenSalesTwo: string;
let salesTwoEmployeeId: bigint;
/** A manager: same permissions plus VIEW_ALL. */
let tokenManager: string;

let sourceId: bigint;
let customerId: bigint;
let seaPolId: bigint;
let seaPodId: bigint;
let airPolId: bigint;
let airPodId: bigint;
let containerSizeId: bigint;
let inquiryBId: bigint;

async function makeEmployee(tenantId: bigint, suffix: string): Promise<bigint> {
  const employee = await owner.employee.create({
    data: {
      tenantId,
      code: `EMP-${suffix}`,
      name: `Sales ${suffix}`,
      country: 'Bangladesh',
    },
    select: { id: true },
  });
  return employee.id;
}

async function makeUser(
  tenantId: bigint,
  suffix: string,
  permissions: string[],
  employeeId: bigint | null,
  isSuperadmin = false,
): Promise<string> {
  const user = await owner.user.create({
    data: {
      tenantId,
      code: `USR-${suffix}`,
      username: `user-${suffix}`,
      email: `${suffix}@inq.test`,
      passwordHash: 'x',
      isSuperadmin,
      ...(employeeId === null ? {} : { employeeId }),
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
    'sales_lead',
    '"user"',
    'employee',
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
      data: { name: 'Inquiry Alpha', slug: SLUG_A, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;
  tenantB = (
    await owner.tenant.create({
      data: { name: 'Inquiry Beta', slug: SLUG_B, country: 'Bangladesh' },
      select: { id: true },
    })
  ).id;

  salesOneEmployeeId = await makeEmployee(tenantA, `one-${SLUG_A}`);
  salesTwoEmployeeId = await makeEmployee(tenantA, `two-${SLUG_A}`);
  const managerEmployeeId = await makeEmployee(tenantA, `mgr-${SLUG_A}`);

  tokenAdmin = await makeUser(tenantA, `super-${SLUG_A}`, [], null, true);
  tokenSalesOne = await makeUser(tenantA, `s1-${SLUG_A}`, BASE_PERMS, salesOneEmployeeId);
  tokenSalesTwo = await makeUser(tenantA, `s2-${SLUG_A}`, BASE_PERMS, salesTwoEmployeeId);
  tokenManager = await makeUser(
    tenantA,
    `mgr-${SLUG_A}`,
    [...BASE_PERMS, 'SALES.INQUIRY.VIEW_ALL'],
    managerEmployeeId,
  );

  sourceId = (
    await owner.inquirySource.create({
      data: { code: `${PREFIX}SRC`, name: 'Inquiry Test Source' },
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

  seaPolId = await mkPort('SPOL', 'Inq Seaport A', 'IQSEA1', 'SEAPORT');
  seaPodId = await mkPort('SPOD', 'Inq Seaport B', 'IQSEA2', 'SEAPORT');
  airPolId = await mkPort('APOL', 'Inq Airport A', 'IQAIR1', 'AIRPORT');
  airPodId = await mkPort('APOD', 'Inq Airport B', 'IQAIR2', 'AIRPORT');

  const sector = await owner.industrySector.create({
    data: { tenantId: tenantA, code: `ISC-${PREFIX}`, name: 'Inq Garments' },
    select: { id: true },
  });
  customerId = (
    await owner.customer.create({
      data: {
        tenantId: tenantA,
        code: `CUS-${PREFIX}`,
        name: 'Inquiry Test Customer',
        country: 'Bangladesh',
        customerType: 'EXPORTER',
        businessArea: 'OUTBOUND',
        industrySectorId: sector.id,
      },
      select: { id: true },
    })
  ).id;

  containerSizeId = (
    await owner.containerSize.findFirstOrThrow({
      where: { tenantId: null },
      select: { id: true },
    })
  ).id;

  // Tenant B's inquiry, which tenant A must never see.
  const sectorB = await owner.industrySector.create({
    data: { tenantId: tenantB, code: `ISC-B-${PREFIX}`, name: 'Beta Garments' },
    select: { id: true },
  });
  const customerB = await owner.customer.create({
    data: {
      tenantId: tenantB,
      code: `CUS-B-${PREFIX}`,
      name: 'Beta Customer',
      country: 'Bangladesh',
      customerType: 'EXPORTER',
      businessArea: 'OUTBOUND',
      industrySectorId: sectorB.id,
    },
    select: { id: true },
  });
  inquiryBId = (
    await owner.inquiry.create({
      data: {
        tenantId: tenantB,
        code: 'INQ-2026-999999',
        seriesYear: 2026,
        inquiryDate: new Date('2026-01-01'),
        sourceId,
        shipmentType: 'SEA',
    loadingType: 'FCL',
        customerId: customerB.id,
        movementType: 'OUTBOUND',
        polId: seaPolId,
        podId: seaPodId,
      },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  const t = `SELECT id FROM tenant WHERE slug = '${SLUG_A}'`;
  await owner.$executeRawUnsafe(`DELETE FROM inquiry_volume WHERE tenant_id IN (${t})`);
  await owner.$executeRawUnsafe(`DELETE FROM inquiry WHERE tenant_id IN (${t})`);
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
  };
}

function inquiryBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inquiryDate: '2026-03-15',
    sourceId: sourceId.toString(),
    shipmentType: 'SEA',
    loadingType: 'FCL',
    customerId: customerId.toString(),
    movementType: 'OUTBOUND',
    polId: seaPolId.toString(),
    podId: seaPodId.toString(),
    volumes: [],
    ...over,
  };
}

const create = (token: string, over: Record<string, unknown> = {}) =>
  as(token).post('/api/tenant/sales/inquiries').send(inquiryBody(over));

describe('§9 Q9 — the Inquiry No is per tenant, per year', () => {
  it('starts a year at 000001', async () => {
    const response = await create(tokenAdmin);
    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    expect(response.body.data.code).toBe('INQ-2026-000001');
    expect(response.body.data.seriesYear).toBe(2026);
  });

  it('increments within the year', async () => {
    await create(tokenAdmin);
    const second = await create(tokenAdmin);
    expect(second.body.data.code).toBe('INQ-2026-000002');
  });

  it('restarts the sequence in a new year', async () => {
    await create(tokenAdmin, { inquiryDate: '2026-12-31' });
    const next = await create(tokenAdmin, { inquiryDate: '2027-01-02' });

    expect(next.body.data.code).toBe('INQ-2027-000001');
    expect(next.body.data.seriesYear).toBe(2027);
  });

  it('takes the year from the inquiry date, not from today', async () => {
    const response = await create(tokenAdmin, { inquiryDate: '2029-06-01' });
    expect(response.body.data.code).toBe(formatInquiryNo(2029, 1));
  });

  it('never reuses a number after one is raised in another year', async () => {
    await create(tokenAdmin, { inquiryDate: '2026-05-01' });
    await create(tokenAdmin, { inquiryDate: '2027-05-01' });
    const third = await create(tokenAdmin, { inquiryDate: '2026-06-01' });
    expect(third.body.data.code).toBe('INQ-2026-000002');
  });
});

describe('§5.4 — what the form captures', () => {
  it('stores the whole record, including the volume grid', async () => {
    const response = await create(tokenAdmin, {
      placeOfReceipt: 'Dhaka ICD',
      hsCode: '6109.10',
      currencyId: (await owner.currency.findFirstOrThrow({ select: { id: true } })).id.toString(),
      expectedShipmentDate: '2026-04-01',
      validTo: '2026-03-31',
      remarks: 'Needs weekly sailing',
      salesmanId: salesOneEmployeeId.toString(),
      volumes: [
        {
          volumeKind: 'FCL',
          containerSizeId: containerSizeId.toString(),
          quantity: '3',
          // Target price and the container note live in the grid now, per size.
          targetPrice: '1800.5000',
          containerSizeNote: 'Reefer, -18C',
          // Weight is per size now too, not one figure for the inquiry.
          weightKg: '12500.500',
        },
        // Blank row: the grid always renders every container size, and empty
        // ones must not become zero-quantity records.
        { volumeKind: 'FCL', containerSizeId: containerSizeId.toString(), quantity: '' },
      ],
    });

    expect(response.status, JSON.stringify(response.body.error ?? {})).toBe(201);
    const data = response.body.data;
    expect(data.placeOfReceipt).toBe('Dhaka ICD');
    expect(data.hsCode).toBe('6109.10');
    expect(data.volumes[0].targetPrice).toBe('1800.5000');
    expect(data.volumes[0].containerSizeNote).toBe('Reefer, -18C');
    expect(data.volumes[0].weightKg).toBe('12500.500');
    expect(data.salesmanName).toBe(`Sales one-${SLUG_A}`);
    expect(data.status).toBe('OPEN');
    expect(data.volumes).toHaveLength(1);
    expect(data.volumes[0].quantity).toBe(3);
  });

  it('refuses a target price with no currency', async () => {
    // The price sits in the grid now, so the currency becomes required as soon
    // as any single column carries one.
    const response = await create(tokenAdmin, {
      volumes: [
        {
          volumeKind: 'FCL',
          containerSizeId: containerSizeId.toString(),
          quantity: '1',
          targetPrice: '1000.0000',
        },
      ],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.fields.currencyId).toBeDefined();
  });

  it('refuses a Sea inquiry that does not say FCL or LCL', async () => {
    const response = await create(tokenAdmin, { shipmentType: 'SEA', loadingType: undefined });
    expect(response.status).toBe(400);
    expect(response.body.error.fields.loadingType).toBeDefined();
  });

  it('refuses the same port at both ends', async () => {
    const response = await create(tokenAdmin, { podId: seaPolId.toString() });
    expect(response.status).toBe(400);
  });

  it('refuses an inquiry that expires before it was raised', async () => {
    const response = await create(tokenAdmin, {
      inquiryDate: '2026-03-15',
      validTo: '2026-03-01',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a sea inquiry routed through an airport', async () => {
    const response = await create(tokenAdmin, { podId: airPodId.toString() });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/seaports/i);
  });

  it('refuses an air inquiry routed through a seaport', async () => {
    const response = await create(tokenAdmin, {
      shipmentType: 'AIR',
      polId: airPolId.toString(),
      podId: seaPodId.toString(),
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/airports/i);
  });

  it('accepts an air inquiry between two airports', async () => {
    const response = await create(tokenAdmin, {
      shipmentType: 'AIR',
      polId: airPolId.toString(),
      podId: airPodId.toString(),
      volumes: [{ volumeKind: 'AIR', weightKg: '850.000' }],
    });
    expect(response.status).toBe(201);
    expect(response.body.data.volumes[0].weightKg).toBe('850.000');
  });
});

describe('§4 rule 10 — a salesman sees their own inquiries by default', () => {
  beforeEach(async () => {
    await create(tokenAdmin, { salesmanId: salesOneEmployeeId.toString() });
    await create(tokenAdmin, { salesmanId: salesTwoEmployeeId.toString() });
  });

  it('shows a salesman only their own', async () => {
    const response = await as(tokenSalesOne).get('/api/tenant/sales/inquiries?limit=100');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].salesmanId).toBe(salesOneEmployeeId.toString());
  });

  it('shows the second salesman a different row, not the same one', async () => {
    // Without this the previous test would pass on a scope that simply
    // returned the first row to everybody.
    const one = await as(tokenSalesOne).get('/api/tenant/sales/inquiries?limit=100');
    const two = await as(tokenSalesTwo).get('/api/tenant/sales/inquiries?limit=100');

    expect(two.body.data).toHaveLength(1);
    expect(two.body.data[0].salesmanId).toBe(salesTwoEmployeeId.toString());
    expect(two.body.data[0].id).not.toBe(one.body.data[0].id);
  });

  it('does not widen the scope just because the client asked', async () => {
    const response = await as(tokenSalesOne).get(
      '/api/tenant/sales/inquiries?limit=100&scope=ALL',
    );
    expect(response.status).toBe(200);
    // Asking for ALL without VIEW_ALL must not grant it.
    expect(response.body.data).toHaveLength(1);
  });

  it('shows the whole team to a manager holding VIEW_ALL', async () => {
    const response = await as(tokenManager).get(
      '/api/tenant/sales/inquiries?limit=100&scope=ALL',
    );
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('still defaults a manager to their own rows until they ask', async () => {
    const response = await as(tokenManager).get('/api/tenant/sales/inquiries?limit=100');
    expect(response.body.data).toHaveLength(0);
  });

  it('refuses another salesman inquiry by id', async () => {
    const theirs = await owner.inquiry.findFirstOrThrow({
      where: { tenantId: tenantA, salesmanId: salesTwoEmployeeId },
      select: { id: true },
    });
    const response = await as(tokenSalesOne).get(`/api/tenant/sales/inquiries/${theirs.id}`);
    expect(response.status).toBe(404);
  });

  it('lets a manager read any inquiry by id', async () => {
    const theirs = await owner.inquiry.findFirstOrThrow({
      where: { tenantId: tenantA, salesmanId: salesTwoEmployeeId },
      select: { id: true },
    });
    const response = await as(tokenManager).get(`/api/tenant/sales/inquiries/${theirs.id}`);
    expect(response.status).toBe(200);
  });
});

describe('§7A rule 4 — no inquiry leaks across workspaces', () => {
  it('never returns another workspace inquiry', async () => {
    await create(tokenAdmin);
    const response = await as(tokenAdmin).get('/api/tenant/sales/inquiries?limit=100&scope=ALL');
    const codes: string[] = response.body.data.map((i: { code: string }) => i.code);
    expect(codes).not.toContain('INQ-2026-999999');
  });

  it('cannot read another workspace inquiry by id', async () => {
    const response = await as(tokenAdmin).get(`/api/tenant/sales/inquiries/${inquiryBId}`);
    expect(response.status).toBe(404);
  });

  it('numbers each workspace independently', async () => {
    // Tenant B already holds INQ-2026-999999; tenant A must still start at 1.
    const response = await create(tokenAdmin);
    expect(response.body.data.code).toBe('INQ-2026-000001');
  });
});

describe('§4 rule 11 — a lapsed inquiry is reported as such', () => {
  it('flags an OPEN inquiry past its validity', async () => {
    const created = await create(tokenAdmin, {
      inquiryDate: '2020-01-01',
      validTo: '2020-12-31',
    });
    expect(created.body.data.isLapsed).toBe(true);
  });

  it('does not flag one still inside its window', async () => {
    const created = await create(tokenAdmin, {
      inquiryDate: '2026-03-15',
      validTo: '2035-12-31',
    });
    expect(created.body.data.isLapsed).toBe(false);
  });
});

describe('§7 — the inquiry routes are permission guarded', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await request(app)
      .get('/api/tenant/sales/inquiries')
      .set('X-Tenant-Slug', SLUG_A);
    expect(response.status).toBe(401);
  });

  it('rejects a user with no inquiry permission', async () => {
    const token = await makeUser(tenantA, `none-${SLUG_A}`, [], null);
    const response = await as(token).get('/api/tenant/sales/inquiries');
    expect(response.status).toBe(403);
  });

  it('rejects creating without CREATE', async () => {
    const token = await makeUser(tenantA, `readonly-${SLUG_A}`, ['SALES.INQUIRY.VIEW'], null);
    const response = await as(token).post('/api/tenant/sales/inquiries').send(inquiryBody());
    expect(response.status).toBe(403);
  });
});

describe('§5.4 — the form options', () => {
  it('separates sea and air ports, and defaults the salesman to the caller', async () => {
    const response = await as(tokenSalesOne).get('/api/tenant/sales/inquiry-options');
    expect(response.status).toBe(200);

    const sea: string[] = response.body.data.seaPorts.map((p: { name: string }) => p.name);
    const air: string[] = response.body.data.airPorts.map((p: { name: string }) => p.name);
    expect(sea.some((n) => n.includes('IQSEA1'))).toBe(true);
    expect(sea.some((n) => n.includes('IQAIR1'))).toBe(false);
    expect(air.some((n) => n.includes('IQAIR1'))).toBe(true);

    expect(response.body.data.defaultSalesmanId).toBe(salesOneEmployeeId.toString());
    expect(response.body.data.canViewAll).toBe(false);
  });

  it('reports VIEW_ALL for a manager', async () => {
    const response = await as(tokenManager).get('/api/tenant/sales/inquiry-options');
    expect(response.body.data.canViewAll).toBe(true);
  });

  it('carries each commodity HS code so the form can prefill it', async () => {
    const response = await as(tokenAdmin).get('/api/tenant/sales/inquiry-options');
    expect(Array.isArray(response.body.data.commodities)).toBe(true);
    for (const item of response.body.data.commodities) {
      expect(item).toHaveProperty('hsCode');
    }
  });
});
