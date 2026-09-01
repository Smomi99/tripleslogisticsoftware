import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Delete on the four PIC screens (customer, agent, carrier, vendor).
 *
 * Asked for on 2026-09-01: the contact lists offered Edit and Deactivate only,
 * so a contact typed in twice, or typed in wrong, stayed on the screen for
 * good. Delete is CR-002's answer to that and carries CR-002's conditions —
 * it is soft (§4 rule 3), it is permission-gated, it stops at the workspace
 * boundary, and it refuses outright the moment anything points at the row.
 *
 * That last one is what makes the pair safe to put side by side: Deactivate
 * retires a contact who was real, Delete removes one who never was, and the
 * server, not the operator, decides which is which.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'pic-alpha';
const SLUG_B = 'pic-beta';

let tenantA: bigint;
let tokenA: string;
let tokenB: string;
/** Holds every customer permission except DELETE. */
let tokenNoDelete: string;

/** The four parents, by the path segment that reaches them. */
const PARENTS = {
  customer: { path: 'crm/customers', table: 'customer_pic' },
  agent: { path: 'crm/agents', table: 'agent_pic' },
  carrier: { path: 'setting/carriers', table: 'carrier_pic' },
  vendor: { path: 'crm/vendors', table: 'vendor_pic' },
} as const;
type ParentKind = keyof typeof PARENTS;

const parentId = {} as Record<ParentKind, bigint>;
/** A port the inquiry in the "in use" test needs at both ends. */
let portId: bigint;

function as(token: string, slug: string) {
  return {
    get: (path: string) =>
      request(app).get(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    post: (path: string) =>
      request(app).post(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
    del: (path: string) =>
      request(app).delete(path).set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug),
  };
}

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

/** Every parent a PIC can hang off, in one workspace. */
async function makeParents(tenantId: bigint, tag: string): Promise<Record<ParentKind, bigint>> {
  const sector = await owner.industrySector.create({
    data: { tenantId, code: `PIC-SEC-${tag}`, name: 'Pic Sector' },
    select: { id: true },
  });
  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  const vendorType = await owner.vendorType.findFirstOrThrow({ select: { id: true } });

  const customer = await owner.customer.create({
    data: {
      tenantId,
      code: `PIC-CUS-${tag}`,
      name: 'Pic Customer',
      country: 'Bangladesh',
      customerType: 'IMPORTER',
      businessArea: 'BOTH',
      industrySectorId: sector.id,
    },
    select: { id: true },
  });
  const agent = await owner.agent.create({
    data: {
      tenantId,
      code: `PIC-AGT-${tag}`,
      name: 'Pic Agent',
      country: 'Bangladesh',
      agentType: 'GENERAL',
    },
    select: { id: true },
  });
  const carrier = await owner.carrier.create({
    data: { tenantId, code: `PIC-CAR-${tag}`, name: 'Pic Line', typeId: carrierType.id },
    select: { id: true },
  });
  const vendor = await owner.vendor.create({
    data: {
      tenantId,
      code: `PIC-VEN-${tag}`,
      name: 'Pic Vendor',
      country: 'Bangladesh',
      vendorTypeId: vendorType.id,
    },
    select: { id: true },
  });

  return { customer: customer.id, agent: agent.id, carrier: carrier.id, vendor: vendor.id };
}

/** A contact on the named parent, through the API the screen uses. */
async function addPic(kind: ParentKind, name: string): Promise<string> {
  const body: Record<string, string> = { name, department: 'Ops', designation: 'Manager' };
  // Only the carrier contact spells its phone columns out separately (§5).
  if (kind === 'carrier') body.mobileNo = '01700000000';
  else body.mobile = '01700000000';

  const res = await as(tokenA, SLUG_A)
    .post(`/api/tenant/${PARENTS[kind].path}/${parentId[kind]}/pics`)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String((res.body as { data: { id: string } }).data.id);
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of [
    'inquiry_party_contact',
    'inquiry',
    'customer_pic',
    'agent_pic',
    'carrier_pic',
    'vendor_pic',
    'customer',
    'agent',
    'carrier',
    'vendor',
    'industry_sector',
    'port',
    '"user"',
  ]) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();

  const a = await makeTenant('Pic Alpha', SLUG_A);
  const b = await makeTenant('Pic Beta', SLUG_B);
  tenantA = a.tenantId;
  tokenA = a.token;
  tokenB = b.token;

  Object.assign(parentId, await makeParents(tenantA, 'A'));

  const limited = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-pic-limited',
      username: 'limited-pic',
      email: 'limited@pic.test',
      passwordHash: 'x',
      isSuperadmin: false,
    },
    select: { id: true },
  });
  tokenNoDelete = await signAccessToken({
    sub: limited.id.toString(),
    tenantId: tenantA.toString(),
    isSuperadmin: false,
    permissions: [
      'CRM.CUSTOMER.VIEW',
      'CRM.CUSTOMER.CREATE',
      'CRM.CUSTOMER.EDIT',
      'CRM.CUSTOMER.TOGGLE_STATUS',
    ],
    tokenVersion: 0,
  });

  portId = (
    await owner.port.create({
      data: {
        tenantId: tenantA,
        code: 'PIC-PORT',
        name: 'Pic Port',
        portCode: 'ZZPIC',
        country: 'Bangladesh',
        type: 'SEAPORT',
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe.each(Object.keys(PARENTS) as ParentKind[])('DELETE a %s contact', (kind) => {
  const { path, table } = PARENTS[kind];

  it('removes one nothing points at', async () => {
    const picId = await addPic(kind, 'Typed By Mistake');

    const res = await as(tokenA, SLUG_A).del(`/api/tenant/${path}/${parentId[kind]}/pics/${picId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const list = await as(tokenA, SLUG_A).get(`/api/tenant/${path}/${parentId[kind]}/pics`);
    const names = (list.body as { data: { name: string }[] }).data.map((r) => r.name);
    expect(names).not.toContain('Typed By Mistake');
  });

  it('is a SOFT delete — the row survives with its id (§4 rule 3)', async () => {
    const picId = await addPic(kind, 'Soft Deleted');
    await as(tokenA, SLUG_A).del(`/api/tenant/${path}/${parentId[kind]}/pics/${picId}`);

    const rows = await owner.$queryRawUnsafe<{ deleted_at: Date | null; is_active: boolean }[]>(
      `SELECT deleted_at, is_active FROM ${table} WHERE id = $1`,
      BigInt(picId),
    );
    // Still there, so every foreign key that ever pointed at it still resolves.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at).not.toBeNull();
    expect(rows[0]?.is_active).toBe(false);
  });

  it('stays gone — a second delete is a 404, not a second success', async () => {
    const picId = await addPic(kind, 'Deleted Twice');
    await as(tokenA, SLUG_A).del(`/api/tenant/${path}/${parentId[kind]}/pics/${picId}`);

    const again = await as(tokenA, SLUG_A).del(
      `/api/tenant/${path}/${parentId[kind]}/pics/${picId}`,
    );
    expect(again.status).toBe(404);
  });

  it('cannot reach another workspace', async () => {
    const picId = await addPic(kind, 'Not Yours');

    // Tenant B asks for tenant A's row, on the path tenant B can see.
    const res = await as(tokenB, SLUG_B).del(`/api/tenant/${path}/${parentId[kind]}/pics/${picId}`);
    expect([403, 404]).toContain(res.status);

    const rows = await owner.$queryRawUnsafe<{ deleted_at: Date | null }[]>(
      `SELECT deleted_at FROM ${table} WHERE id = $1`,
      BigInt(picId),
    );
    expect(rows[0]?.deleted_at).toBeNull();
  });
});

describe('the permission gate', () => {
  it('refuses a user who holds every other customer permission', async () => {
    const picId = await addPic('customer', 'Gated');

    const res = await as(tokenNoDelete, SLUG_A).del(
      `/api/tenant/crm/customers/${parentId.customer}/pics/${picId}`,
    );
    expect(res.status).toBe(403);

    const rows = await owner.$queryRaw<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM customer_pic WHERE id = ${BigInt(picId)}`;
    expect(rows[0]?.deleted_at).toBeNull();
  });
});

describe('a contact that is actually in use', () => {
  it('refuses to delete it, and names what is using it', async () => {
    const picId = await addPic('carrier', 'On A Rate Request');

    // An inquiry with its rate request addressed to that contact — the row
    // inquiry_party_contact keeps as the record of who was asked.
    const source = await owner.inquirySource.findFirstOrThrow({ select: { id: true } });
    const inquiry = await owner.$queryRawUnsafe<{ id: bigint }[]>(
      `INSERT INTO inquiry
         (tenant_id, code, series_year, inquiry_date, source_id, shipment_type, customer_id,
          movement_type, pol_id, pod_id, status, updated_at)
       VALUES ($1, 'PIC-INQ-1', 2026, current_date, $2, 'SEA', $3,
               'OUTBOUND', $4, $4, 'OPEN', now())
       RETURNING id`,
      tenantA,
      source.id,
      parentId.customer,
      portId,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO inquiry_party_contact (tenant_id, inquiry_id, carrier_pic_id)
       VALUES ($1, $2, $3)`,
      tenantA,
      inquiry[0]!.id,
      BigInt(picId),
    );

    const res = await as(tokenA, SLUG_A).del(
      `/api/tenant/setting/carriers/${parentId.carrier}/pics/${picId}`,
    );
    expect(res.status).toBe(409);

    // The message has to say what is in the way. A dead end with no reason is
    // what operators file tickets about, and Deactivate is the way out.
    const message = (res.body as { error: { message: string } }).error.message;
    expect(message).toMatch(/rate request/i);
    expect(message).toMatch(/deactivate/i);

    const rows = await owner.$queryRaw<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM carrier_pic WHERE id = ${BigInt(picId)}`;
    expect(rows[0]?.deleted_at).toBeNull();
  });
});
