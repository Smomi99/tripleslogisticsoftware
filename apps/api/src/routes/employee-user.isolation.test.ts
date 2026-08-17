import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/** Per-module isolation for CRM → Employee and User (CLAUDE.md §7A rule 4). */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'emp-alpha';
const SLUG_B = 'emp-beta';

let tenantA: bigint;
let tokenA: string;
let tokenNoPerms: string;
let employeeA: bigint;
let employeeB: bigint;
let userB: bigint;

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
  return { tenantId: tenant.id, userId: user.id, token };
}

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  await owner.$executeRawUnsafe(`DELETE FROM employee_salary WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM employee_cv WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM employee WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();
  const a = await makeTenant('Employee Alpha', SLUG_A);
  const b = await makeTenant('Employee Beta', SLUG_B);
  tenantA = a.tenantId;
  tokenA = a.token;

  const plain = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-noperm-emp',
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

  const ea = await owner.employee.create({
    data: { tenantId: tenantA, code: 'EMP-A', name: 'Alpha Staff', country: 'Bangladesh' },
    select: { id: true },
  });
  employeeA = ea.id;
  const eb = await owner.employee.create({
    data: { tenantId: b.tenantId, code: 'EMP-B', name: 'Beta Staff', country: 'Bangladesh' },
    select: { id: true },
  });
  employeeB = eb.id;
  userB = b.userId;
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function A(method: 'get' | 'post' | 'patch' | 'put', path: string) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${tokenA}`)
    .set('X-Tenant-Slug', SLUG_A);
}

describe('employee isolation', () => {
  it('lists only tenant A employees', async () => {
    const res = await A('get', '/api/tenant/crm/employees?limit=100');
    expect(res.status).toBe(200);
    const names = res.body.data.map((r: { name: string }) => r.name);
    expect(names).toContain('Alpha Staff');
    expect(names).not.toContain('Beta Staff');
  });

  it('cannot reach another tenant employee, CV or salary', async () => {
    expect((await A('get', `/api/tenant/crm/employees/${employeeB}`)).status).toBe(404);
    expect((await A('get', `/api/tenant/crm/employees/${employeeB}/cv`)).status).toBe(404);
    expect((await A('get', `/api/tenant/crm/employees/${employeeB}/salary`)).status).toBe(404);
    expect((await A('put', `/api/tenant/crm/employees/${employeeB}/cv`).send({})).status).toBe(404);
  });

  it('treats CV as 1:1 — a second write replaces rather than duplicates', async () => {
    await A('put', `/api/tenant/crm/employees/${employeeA}/cv`).send({ fatherName: 'First' });
    await A('put', `/api/tenant/crm/employees/${employeeA}/cv`).send({ fatherName: 'Second' });

    const rows = await owner.employeeCv.findMany({ where: { employeeId: employeeA } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fatherName).toBe('Second');
  });
});

describe('§6 — gross_salary is generated, never stored by hand', () => {
  it('computes the total from its six components', async () => {
    const res = await A('put', `/api/tenant/crm/employees/${employeeA}/salary`).send({
      basicSalary: '50000',
      homeRent: '20000',
      medical: '5000',
      mobileBill: '1000',
      insurance: '2000',
      incentive: '3000',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.grossSalary).toBe('81000.0000');
  });

  it('ignores a gross_salary supplied by the client', async () => {
    const res = await A('put', `/api/tenant/crm/employees/${employeeA}/salary`).send({
      basicSalary: '60000',
      homeRent: '20000',
      medical: '5000',
      mobileBill: '1000',
      insurance: '2000',
      incentive: '3000',
      grossSalary: '999999',
    });
    expect(res.status).toBe(200);
    // The shared schema has no such field, and Postgres would refuse it anyway.
    expect(res.body.data.grossSalary).toBe('91000.0000');
  });

  it('is rejected outright at the database', async () => {
    // Postgres 428C9: "column can only be updated to DEFAULT". Even the owner
    // connection, which bypasses RLS, cannot write a GENERATED ALWAYS column.
    await expect(
      owner.$executeRaw`UPDATE employee_salary SET gross_salary = 1 WHERE employee_id = ${employeeA}`,
    ).rejects.toThrow(/can only be updated to DEFAULT/i);
  });
});

describe('user isolation and §7 rule 4', () => {
  it('lists only tenant A users', async () => {
    const res = await A('get', '/api/tenant/crm/users?limit=100');
    expect(res.status).toBe(200);
    const usernames = res.body.data.map((r: { username: string }) => r.username);
    expect(usernames).toContain(`admin-${SLUG_A}`);
    expect(usernames).not.toContain(`admin-${SLUG_B}`);
  });

  it('cannot edit or toggle another tenant user', async () => {
    expect(
      (await A('post', `/api/tenant/crm/users/${userB}/toggle-status`)).status,
    ).toBe(404);
    const untouched = await owner.user.findUnique({ where: { id: userB } });
    expect(untouched?.isActive).toBe(true);
  });

  it('normalises the username and refuses a duplicate in the same workspace', async () => {
    const created = await A('post', '/api/tenant/crm/users').send({
      employeeId: employeeA.toString(),
      username: 'MixedCase',
      email: 'mixed@alpha.test',
      password: 'correcthorsebattery',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.username).toBe('mixedcase');

    const duplicate = await A('post', '/api/tenant/crm/users').send({
      employeeId: employeeA.toString(),
      username: 'MIXEDCASE',
      email: 'other@alpha.test',
      password: 'correcthorsebattery',
    });
    expect(duplicate.status).toBe(409);
  });

  it('bumps token_version when access changes, so old tokens die immediately', async () => {
    const created = await A('post', '/api/tenant/crm/users').send({
      employeeId: employeeA.toString(),
      username: 'bumpme',
      email: 'bumpme@alpha.test',
      password: 'correcthorsebattery',
    });
    const id = BigInt(created.body.data.id);

    const before = await owner.user.findUniqueOrThrow({ where: { id } });

    // Granting superadmin changes what they may reach.
    await A('patch', `/api/tenant/crm/users/${id}`).send({
      employeeId: employeeA.toString(),
      username: 'bumpme',
      email: 'bumpme@alpha.test',
      isSuperadmin: true,
    });

    const after = await owner.user.findUniqueOrThrow({ where: { id } });
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
  });

  it('refuses to let a user deactivate their own account', async () => {
    const me = await owner.user.findFirstOrThrow({
      where: { tenantId: tenantA, username: `admin-${SLUG_A}` },
      select: { id: true },
    });
    const res = await A('post', `/api/tenant/crm/users/${me.id}/toggle-status`);
    expect(res.status).toBe(400);
  });

  it('guards every route with a permission', async () => {
    for (const path of ['/api/tenant/crm/employees', '/api/tenant/crm/users']) {
      const noPerm = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${tokenNoPerms}`)
        .set('X-Tenant-Slug', SLUG_A);
      expect(noPerm.status, path).toBe(403);

      const anon = await request(app).get(path).set('X-Tenant-Slug', SLUG_A);
      expect(anon.status, path).toBe(401);
    }
  });
});
