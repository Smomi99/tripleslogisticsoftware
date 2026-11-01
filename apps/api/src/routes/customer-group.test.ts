import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * CRM → Customer → custom groups (owner, 2026-11-01), through HTTP.
 *
 * Two workspaces, three customers each. A group filters the Customer list
 * and, through the same filter, the customers Bulk email writes to. Members
 * come and go; nothing is hard-deleted; and neither workspace can see, edit
 * or fill a group with the other's customers (§7A rule 4).
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'cgroup-alpha';
const SLUG_B = 'cgroup-beta';

interface World {
  tenantId: bigint;
  slug: string;
  superToken: string;
  /** CRM.CUSTOMER.VIEW only. */
  viewerToken: string;
  customers: { dhaka: string; ctg: string; sylhet: string };
}

let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of ['customer_group_member', 'customer_group', 'customer_pic', 'customer', 'industry_sector', 'user']) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string): Promise<World> {
  const bdt = (await owner.currency.findFirstOrThrow({ where: { tenantId: null, currency: { startsWith: 'BDT' } } })).id;
  const { id: tenantId } = await owner.tenant.create({ data: { name, slug, country: 'Bangladesh', currencyId: bdt }, select: { id: true } });
  const user = async (code: string, isSuperadmin: boolean, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x', isSuperadmin },
      select: { id: true },
    });
    return signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin, permissions, tokenVersion: 0 });
  };

  const sector = await owner.industrySector.create({ data: { tenantId, code: `ISC-${tag}`, name: `Garments ${tag}` }, select: { id: true } });
  const customer = async (n: number, city: string) => {
    const { id } = await owner.customer.create({
      data: { tenantId, code: `CUS-${tag}${n}`, name: `${city} Apparels ${tag}`, country: 'Bangladesh', customerType: 'EXPORTER', businessArea: 'BOTH', industrySectorId: sector.id },
      select: { id: true },
    });
    // An address, so Bulk email lists them.
    await owner.customerPic.create({ data: { tenantId, customerId: id, code: `CPC-${tag}${n}`, name: `PIC ${n}`, email: `pic${n}@${slug}.test` } });
    return id.toString();
  };

  return {
    tenantId,
    slug,
    superToken: await user(`USR-S${tag}`, true, []),
    viewerToken: await user(`USR-V${tag}`, false, ['CRM.CUSTOMER.VIEW']),
    customers: { dhaka: await customer(1, 'Dhaka'), ctg: await customer(2, 'Chattogram'), sylhet: await customer(3, 'Sylhet') },
  };
}

function api(world: World, token = world.superToken) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', world.slug);
  const at = (path: string) => `/api/tenant${path}`;
  return {
    get: (path: string) => wrap(request(app).get(at(path))),
    post: (path: string, body?: Record<string, unknown>) => wrap(request(app).post(at(path))).send(body ?? {}),
    put: (path: string, body: Record<string, unknown>) => wrap(request(app).put(at(path))).send(body),
    delete: (path: string) => wrap(request(app).delete(at(path))),
  };
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const listed = async (w: World, groupId: string) =>
  ids((await api(w).get(`/crm/customers?customerGroupId=${groupId}`)).body.data as { id: string }[]);

let groupId = '';

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Group Alpha', SLUG_A, 'GA');
  B = await makeWorld('Group Beta', SLUG_B, 'GB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('a custom group', () => {
  it('is created with a name and its customers, and numbered', async () => {
    const res = await api(A).post('/crm/customer-groups', { name: 'Key accounts', customerIds: [A.customers.dhaka, A.customers.ctg] });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'CGR-001', name: 'Key accounts', memberCount: 2 });
    groupId = res.body.data.id as string;

    const groups = await api(A).get('/crm/customer-groups');
    expect(groups.body.data).toEqual([expect.objectContaining({ id: groupId, name: 'Key accounts', memberCount: 2 })]);
  });

  it('filters the Customer list to its members', async () => {
    expect(await listed(A, groupId)).toEqual([A.customers.dhaka, A.customers.ctg].sort());
    // Beside the other filters, not instead of them.
    const searched = await api(A).get(`/crm/customers?customerGroupId=${groupId}&search=Dhaka`);
    expect(ids(searched.body.data as { id: string }[])).toEqual([A.customers.dhaka]);
  });

  it('is who Bulk email writes to', async () => {
    const res = await api(A).get(`/crm/customer-price-email/recipients?customerGroupId=${groupId}`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const parties = (res.body.data.recipients as { partyId: string }[]).map((r) => r.partyId).sort();
    expect(parties).toEqual([A.customers.dhaka, A.customers.ctg].sort());
  });

  it('refuses a name already taken whatever its case, and an empty group', async () => {
    const taken = await api(A).post('/crm/customer-groups', { name: 'KEY ACCOUNTS', customerIds: [A.customers.sylhet] });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toMatch(/already a group called/);
    const empty = await api(A).post('/crm/customer-groups', { name: 'Nobody', customerIds: [] });
    expect(empty.status).toBe(400);
  });

  it('is renamed and its members set on edit, keeping the removed ones on the record', async () => {
    const res = await api(A).put(`/crm/customer-groups/${groupId}`, { name: 'Top exporters', customerIds: [A.customers.ctg, A.customers.sylhet] });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Top exporters', memberCount: 2 });
    const detail = await api(A).get(`/crm/customer-groups/${groupId}`);
    expect([...(detail.body.data.customerIds as string[])].sort()).toEqual([A.customers.ctg, A.customers.sylhet].sort());
    expect(await listed(A, groupId)).toEqual([A.customers.ctg, A.customers.sylhet].sort());
    const retired = await owner.customerGroupMember.count({ where: { customerGroupId: BigInt(groupId), deletedAt: { not: null } } });
    expect(retired).toBe(1);
  });

  it('takes a customer out and puts one back', async () => {
    const out = await api(A).delete(`/crm/customer-groups/${groupId}/members/${A.customers.sylhet}`);
    expect(out.status, JSON.stringify(out.body.error ?? {})).toBe(200);
    expect(out.body.data.memberCount).toBe(1);
    expect(await listed(A, groupId)).toEqual([A.customers.ctg]);
    const again = await api(A).delete(`/crm/customer-groups/${groupId}/members/${A.customers.sylhet}`);
    expect(again.status).toBe(404);

    const back = await api(A).post(`/crm/customer-groups/${groupId}/members`, { customerIds: [A.customers.sylhet, A.customers.ctg] });
    expect(back.status, JSON.stringify(back.body.error ?? {})).toBe(200);
    // ctg was already in: added once, not twice.
    expect(back.body.data.memberCount).toBe(2);
  });

  it('does not stop a customer entered by mistake from being deleted', async () => {
    const extra = await owner.customer.create({
      data: { tenantId: A.tenantId, code: 'CUS-GA9', name: 'Typo Traders GA', country: 'Bangladesh', customerType: 'TRADER', businessArea: 'BOTH', industrySectorId: (await owner.industrySector.findFirstOrThrow({ where: { tenantId: A.tenantId } })).id },
      select: { id: true },
    });
    await api(A).post(`/crm/customer-groups/${groupId}/members`, { customerIds: [extra.id.toString()] });
    const res = await api(A).delete(`/crm/customers/${extra.id}`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    const groups = await api(A).get('/crm/customer-groups');
    expect(groups.body.data[0].memberCount).toBe(2);
  });

  it('is retired on delete, its customers untouched and its name free again', async () => {
    const res = await api(A).delete(`/crm/customer-groups/${groupId}`);
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    expect((await api(A).get(`/crm/customer-groups/${groupId}`)).status).toBe(404);
    expect(await listed(A, groupId)).toEqual([]);
    expect((await api(A).get('/crm/customers')).body.meta.total).toBe(3);
    expect(await owner.customerGroup.count({ where: { id: BigInt(groupId) } })).toBe(1);

    const reused = await api(A).post('/crm/customer-groups', { name: 'Top exporters', customerIds: [A.customers.dhaka] });
    expect(reused.status, JSON.stringify(reused.body.error ?? {})).toBe(201);
    expect(reused.body.data.code).toBe('CGR-002');
    groupId = reused.body.data.id as string;
  });
});

describe('access', () => {
  it('lets a viewer filter by a group and change nothing', async () => {
    expect((await api(A, A.viewerToken).get('/crm/customer-groups')).status).toBe(200);
    expect((await api(A, A.viewerToken).get(`/crm/customers?customerGroupId=${groupId}`)).status).toBe(200);
    expect((await api(A, A.viewerToken).post('/crm/customer-groups', { name: 'Mine', customerIds: [A.customers.dhaka] })).status).toBe(403);
    expect((await api(A, A.viewerToken).put(`/crm/customer-groups/${groupId}`, { name: 'Mine', customerIds: [] })).status).toBe(403);
    expect((await api(A, A.viewerToken).delete(`/crm/customer-groups/${groupId}/members/${A.customers.dhaka}`)).status).toBe(403);
    expect((await api(A, A.viewerToken).delete(`/crm/customer-groups/${groupId}`)).status).toBe(403);
    expect((await api(A, A.viewerToken).get('/crm/customer-groups/customers')).status).toBe(403);
  });

  it('keeps each workspace to its own groups and customers', async () => {
    const list = await api(B).get('/crm/customer-groups');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    expect((await api(B).get(`/crm/customer-groups/${groupId}`)).status).toBe(404);
    expect((await api(B).put(`/crm/customer-groups/${groupId}`, { name: 'Taken over', customerIds: [] })).status).toBe(404);
    expect((await api(B).post(`/crm/customer-groups/${groupId}/members`, { customerIds: [B.customers.dhaka] })).status).toBe(404);
    expect((await api(B).delete(`/crm/customer-groups/${groupId}`)).status).toBe(404);
    // A's group id filters B's list to nothing, and A's customers cannot go in B's group.
    expect(await listed(B, groupId)).toEqual([]);
    const borrowed = await api(B).post('/crm/customer-groups', { name: 'Borrowed', customerIds: [A.customers.dhaka] });
    expect(borrowed.status).toBe(400);
    const picker = await api(B).get('/crm/customer-groups/customers');
    expect(ids(picker.body.data as { id: string }[])).toEqual(Object.values(B.customers).sort());
    // B numbers its own groups from 1.
    const own = await api(B).post('/crm/customer-groups', { name: 'Top exporters', customerIds: [B.customers.dhaka] });
    expect(own.status, JSON.stringify(own.body.error ?? {})).toBe(201);
    expect(own.body.data.code).toBe('CGR-001');
  });
});
