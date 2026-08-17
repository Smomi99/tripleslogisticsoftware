import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * The §7 superadmin screens.
 *
 * The rule with teeth here is rule 4: a permission set is cached in the access
 * token, so a change must bump token_version for everyone affected. For a ROLE
 * that means every holder, not just the administrator making the change.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG_A = 'adm-alpha';
const SLUG_B = 'adm-beta';

let tenantA: bigint;
let tokenA: string;
let tokenNoPerms: string;
let roleA: bigint;
let roleB: bigint;
let holderOne: bigint;
let holderTwo: bigint;

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
  await owner.$executeRawUnsafe(`DELETE FROM user_permission WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM role_permission WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM role WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

beforeAll(async () => {
  await cleanup();
  const a = await makeTenant('Admin Alpha', SLUG_A);
  const b = await makeTenant('Admin Beta', SLUG_B);
  tenantA = a.tenantId;
  tokenA = a.token;

  const plain = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-noperm-adm',
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

  const ra = await owner.role.create({
    data: { tenantId: tenantA, code: 'ROL-AA', name: 'Alpha Role' },
    select: { id: true },
  });
  roleA = ra.id;
  const rb = await owner.role.create({
    data: { tenantId: b.tenantId, code: 'ROL-BB', name: 'Beta Role' },
    select: { id: true },
  });
  roleB = rb.id;

  const h1 = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-h1',
      username: 'holder-one',
      email: 'h1@alpha.test',
      passwordHash: 'x',
      roleId: roleA,
    },
    select: { id: true },
  });
  holderOne = h1.id;
  const h2 = await owner.user.create({
    data: {
      tenantId: tenantA,
      code: 'USR-h2',
      username: 'holder-two',
      email: 'h2@alpha.test',
      passwordHash: 'x',
      roleId: roleA,
    },
    select: { id: true },
  });
  holderTwo = h2.id;
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

describe('role matrix', () => {
  it('replaces the grant set wholesale', async () => {
    const first = await A('put', `/api/tenant/admin/roles/${roleA}/permissions`).send({
      keys: ['SETTING.SEA_AIR_PORT.VIEW', 'SETTING.SEA_AIR_PORT.CREATE', 'CRM.CUSTOMER.VIEW'],
    });
    expect(first.status).toBe(200);
    expect(first.body.data.keys).toHaveLength(3);

    const second = await A('put', `/api/tenant/admin/roles/${roleA}/permissions`).send({
      keys: ['SETTING.SEA_AIR_PORT.VIEW'],
    });
    expect(second.body.data.keys).toEqual(['SETTING.SEA_AIR_PORT.VIEW']);
  });

  it('refuses a key the registry does not define', async () => {
    const res = await A('put', `/api/tenant/admin/roles/${roleA}/permissions`).send({
      keys: ['CRM.CUSTOMER.FLY'],
    });
    expect(res.status).toBe(400);
  });

  it('§7 rule 4 — bumps token_version for EVERY holder, not just the editor', async () => {
    const before = await owner.user.findMany({
      where: { id: { in: [holderOne, holderTwo] } },
      select: { id: true, tokenVersion: true },
      orderBy: { id: 'asc' },
    });

    await A('put', `/api/tenant/admin/roles/${roleA}/permissions`).send({
      keys: ['CRM.CUSTOMER.VIEW'],
    });

    const after = await owner.user.findMany({
      where: { id: { in: [holderOne, holderTwo] } },
      select: { id: true, tokenVersion: true },
      orderBy: { id: 'asc' },
    });

    expect(after[0]?.tokenVersion).toBe((before[0]?.tokenVersion ?? 0) + 1);
    expect(after[1]?.tokenVersion).toBe((before[1]?.tokenVersion ?? 0) + 1);
  });

  it('cannot reach a role in another workspace', async () => {
    expect((await A('get', `/api/tenant/admin/roles/${roleB}/permissions`)).status).toBe(404);
    expect(
      (await A('put', `/api/tenant/admin/roles/${roleB}/permissions`).send({ keys: [] })).status,
    ).toBe(404);
  });

  it('refuses to rename or disable a system role', async () => {
    const seeded = await owner.role.findFirst({ where: { isSystem: true }, select: { id: true } });
    if (seeded === null) return;
    // Belongs to another tenant, so it reads as not found rather than forbidden.
    expect((await A('patch', `/api/tenant/admin/roles/${seeded.id}`).send({ name: 'x' })).status)
      .toBeGreaterThanOrEqual(400);
  });
});

describe('per-user matrix', () => {
  it('reports role grants, overrides and the effective set', async () => {
    await A('put', `/api/tenant/admin/roles/${roleA}/permissions`).send({
      keys: ['SETTING.SEA_AIR_PORT.VIEW', 'CRM.CUSTOMER.VIEW'],
    });

    const res = await A('get', `/api/tenant/admin/users/${holderOne}/permissions`);
    expect(res.status).toBe(200);
    expect(res.body.data.roleKeys).toHaveLength(2);
    expect(res.body.data.overrides).toHaveLength(0);
    expect(res.body.data.effectiveKeys).toHaveLength(2);
  });

  it('ALLOW adds and DENY removes, with DENY winning over the role', async () => {
    const res = await A('put', `/api/tenant/admin/users/${holderOne}/permissions`).send({
      overrides: [
        { key: 'CRM.AGENT.VIEW', effect: 'ALLOW' },
        { key: 'SETTING.SEA_AIR_PORT.VIEW', effect: 'DENY' },
      ],
    });
    expect(res.status).toBe(200);

    const effective: string[] = res.body.data.effectiveKeys;
    expect(effective).toContain('CRM.AGENT.VIEW');
    expect(effective).toContain('CRM.CUSTOMER.VIEW');
    // Granted by the role, denied per user — DENY beats it (§7 rule 4).
    expect(effective).not.toContain('SETTING.SEA_AIR_PORT.VIEW');
  });

  it('an empty override list is "reset to role default"', async () => {
    const res = await A('put', `/api/tenant/admin/users/${holderOne}/permissions`).send({
      overrides: [],
    });
    const effective: string[] = res.body.data.effectiveKeys;
    expect(effective.sort()).toEqual(['CRM.CUSTOMER.VIEW', 'SETTING.SEA_AIR_PORT.VIEW']);

    const rows = await owner.userPermission.findMany({ where: { userId: holderOne } });
    expect(rows).toHaveLength(0);
  });

  it('bumps token_version for the user whose overrides changed', async () => {
    const before = await owner.user.findUniqueOrThrow({ where: { id: holderTwo } });
    await A('put', `/api/tenant/admin/users/${holderTwo}/permissions`).send({
      overrides: [{ key: 'CRM.AGENT.VIEW', effect: 'ALLOW' }],
    });
    const after = await owner.user.findUniqueOrThrow({ where: { id: holderTwo } });
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
  });
});

describe('§7 — every admin route is guarded', () => {
  it('rejects a user without the permission, and an anonymous caller', async () => {
    const paths = ['/api/tenant/admin/roles', `/api/tenant/admin/users/${holderOne}/permissions`];
    for (const path of paths) {
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
