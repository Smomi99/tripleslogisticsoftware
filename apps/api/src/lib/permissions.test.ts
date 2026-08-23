import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FEATURES, PERMISSIONS, isPermissionKey, isScreenFeature } from '@ff/shared';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { hashPassword, verifyPassword } from './password';
import {
  bumpTokenVersion,
  hasPermission,
  loadAccount,
  resolvePermissions,
} from './permissions';
import { withTenant } from './tenant-client';

/**
 * The §7 resolution order, tested step by step:
 *   1. superadmin -> everything, always
 *   2. union of the role's permissions
 *   3. user_permission: ALLOW adds, DENY removes
 *   4. DENY beats everything except superadmin
 *   5. inactive user or inactive role -> no access
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const SLUG = 'test-rbac';
const VIEW = 'CRM.CUSTOMER.VIEW';
const EDIT = 'CRM.CUSTOMER.EDIT';
const EXPORT = 'CRM.CUSTOMER.EXPORT';

let tenantId: bigint;
let roleId: bigint;
let permIds: Record<string, bigint>;

/** Creates a user and returns its id. */
async function makeUser(opts: {
  username: string;
  isSuperadmin?: boolean;
  isActive?: boolean;
  withRole?: boolean;
}): Promise<bigint> {
  const user = await owner.user.create({
    data: {
      tenantId,
      code: `USR-${opts.username}`,
      username: opts.username,
      email: `${opts.username}@test.local`,
      passwordHash: 'x',
      isSuperadmin: opts.isSuperadmin ?? false,
      isActive: opts.isActive ?? true,
      roleId: opts.withRole === false ? null : roleId,
    },
    select: { id: true },
  });
  return user.id;
}

async function resolve(userId: bigint): Promise<{
  isSuperadmin: boolean;
  permissions: Set<string>;
}> {
  return withTenant(tenantId, async (db) => {
    const account = await loadAccount(db, userId);
    if (account === null) throw new Error('account not found');
    const access = await resolvePermissions(db, account);
    return { isSuperadmin: access.isSuperadmin, permissions: access.permissions };
  });
}

async function cleanup(): Promise<void> {
  await owner.$executeRaw`DELETE FROM user_permission WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = ${SLUG})`;
  await owner.$executeRaw`DELETE FROM role_permission WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = ${SLUG})`;
  await owner.$executeRaw`DELETE FROM "user" WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = ${SLUG})`;
  await owner.$executeRaw`DELETE FROM role WHERE tenant_id IN (SELECT id FROM tenant WHERE slug = ${SLUG})`;
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();

  const tenant = await owner.tenant.create({
    data: { name: 'RBAC Test Co', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const role = await owner.role.create({
    data: { tenantId, code: 'ROL-TEST', name: 'Operations', description: 'Test role' },
    select: { id: true },
  });
  roleId = role.id;

  const rows = await owner.permission.findMany({
    where: { key: { in: [VIEW, EDIT, EXPORT] } },
    select: { id: true, key: true },
  });
  permIds = Object.fromEntries(rows.map((r) => [r.key, r.id]));

  // The role grants VIEW and EDIT, but not EXPORT.
  await owner.rolePermission.createMany({
    data: [
      { tenantId, roleId, permissionId: permIds[VIEW]! },
      { tenantId, roleId, permissionId: permIds[EDIT]! },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the registry', () => {
  it('derives every permission key from a feature', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(0);
    for (const p of PERMISSIONS) {
      expect(p.key).toBe(`${p.feature}.${p.action}`);
      expect(isPermissionKey(p.key)).toBe(true);
    }
  });

  it('rejects a key it does not define', () => {
    expect(isPermissionKey('CRM.CUSTOMER.FLY')).toBe(false);
    expect(isPermissionKey('NOPE.NOPE.VIEW')).toBe(false);
  });

  /**
   * CR-002 gave DELETE a job, and the boundary is the whole point of it.
   * Master data — a carrier typed twice — can be removed; a quotation, a
   * booking or an invoice never can, because it is business history retired by
   * its own status. This asserts the boundary rather than the count, so adding
   * a Settings screen does not break it but adding DELETE to Accounts does.
   *
   * It is still not a hard delete anywhere: the routes set `deleted_at`, and
   * §4 rule 3 holds.
   */
  it('grants DELETE to master data only, never to transactional records', () => {
    const withDelete = FEATURES.filter((f) => f.actions.includes('DELETE'));

    expect(withDelete.length).toBeGreaterThan(0);
    const wrongModule = withDelete.filter(
      (f) => f.module !== 'SETTING' && f.module !== 'CRM',
    );
    expect(wrongModule.map((f) => f.feature)).toEqual([]);
  });

  it('keeps DELETE off every transactional module', () => {
    const transactional = FEATURES.filter((f) =>
      ['PURCHASE', 'SALES', 'CUSTOMER_SERVICE', 'OPERATION', 'DOCUMENTATION', 'ACCOUNTS'].includes(
        f.module,
      ),
    );
    expect(transactional.length).toBeGreaterThan(20);
    expect(transactional.filter((f) => f.actions.includes('DELETE')).map((f) => f.feature)).toEqual(
      [],
    );
  });

  it('gives every screen feature a VIEW, since the sidebar keys off it', () => {
    const missing = FEATURES.filter(
      (f) => isScreenFeature(f) && !f.actions.includes('VIEW'),
    );
    expect(missing.map((f) => f.feature)).toEqual([]);
  });

  it('gives column-level features no VIEW, so none can reach the sidebar', () => {
    const stray = FEATURES.filter((f) => !isScreenFeature(f) && f.actions.includes('VIEW'));
    expect(stray.map((f) => f.feature)).toEqual([]);
  });
});

describe('§7 resolution order', () => {
  it('step 1 — a superadmin holds everything without any grants', async () => {
    const id = await makeUser({ username: 'super', isSuperadmin: true, withRole: false });
    const access = await resolve(id);

    expect(access.isSuperadmin).toBe(true);
    // The set is empty; hasPermission short-circuits on the flag instead.
    expect(access.permissions.size).toBe(0);
    expect(hasPermission({ ...access, userId: id, tokenVersion: 0, agentId: null }, 'ACCOUNTS.BALANCE_SHEET.VIEW')).toBe(true);
    expect(hasPermission({ ...access, userId: id, tokenVersion: 0, agentId: null }, 'ANYTHING.AT.ALL')).toBe(true);
  });

  it('step 2 — starts from the union of the role permissions', async () => {
    const id = await makeUser({ username: 'plain' });
    const access = await resolve(id);

    expect([...access.permissions].sort()).toEqual([EDIT, VIEW].sort());
    expect(access.permissions.has(EXPORT)).toBe(false);
  });

  it('step 3 — an ALLOW override adds a permission the role lacks', async () => {
    const id = await makeUser({ username: 'allowed' });
    await owner.userPermission.create({
      data: { tenantId, userId: id, permissionId: permIds[EXPORT]!, effect: 'ALLOW' },
    });

    const access = await resolve(id);
    expect(access.permissions.has(EXPORT)).toBe(true);
    expect(access.permissions.has(VIEW)).toBe(true);
  });

  it('step 3 — a DENY override removes one the role grants', async () => {
    const id = await makeUser({ username: 'denied' });
    await owner.userPermission.create({
      data: { tenantId, userId: id, permissionId: permIds[EDIT]!, effect: 'DENY' },
    });

    const access = await resolve(id);
    expect(access.permissions.has(EDIT)).toBe(false);
    expect(access.permissions.has(VIEW)).toBe(true);
  });

  it('cannot store ALLOW and DENY for the same user and permission', async () => {
    // UNIQUE(tenant_id, user_id, permission_id) means the two effects can never
    // coexist, so "DENY beats ALLOW" is unreachable as stored data. The order in
    // resolvePermissions — every ALLOW applied, then every DENY — is defence in
    // depth against that constraint being relaxed later.
    const id = await makeUser({ username: 'conflicted' });
    await owner.userPermission.create({
      data: { tenantId, userId: id, permissionId: permIds[EXPORT]!, effect: 'ALLOW' },
    });

    await expect(
      owner.userPermission.create({
        data: { tenantId, userId: id, permissionId: permIds[EXPORT]!, effect: 'DENY' },
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('step 4 — DENY removes a permission the role grants', async () => {
    const id = await makeUser({ username: 'denied-over-role' });
    await owner.userPermission.create({
      data: { tenantId, userId: id, permissionId: permIds[VIEW]!, effect: 'DENY' },
    });

    const access = await resolve(id);
    expect(access.permissions.has(VIEW)).toBe(false);
    // The rest of the role's grants survive.
    expect(access.permissions.has(EDIT)).toBe(true);
  });

  it('step 4 — DENY does NOT beat superadmin', async () => {
    const id = await makeUser({ username: 'superdenied', isSuperadmin: true });
    await owner.userPermission.create({
      data: { tenantId, userId: id, permissionId: permIds[VIEW]!, effect: 'DENY' },
    });

    const access = await resolve(id);
    expect(access.isSuperadmin).toBe(true);
    expect(hasPermission({ ...access, userId: id, tokenVersion: 0, agentId: null }, VIEW)).toBe(true);
  });

  it('step 5 — an inactive user holds nothing, superadmin or not', async () => {
    const normal = await makeUser({ username: 'inactive', isActive: false });
    expect((await resolve(normal)).permissions.size).toBe(0);

    const superadmin = await makeUser({
      username: 'inactivesuper',
      isActive: false,
      isSuperadmin: true,
    });
    const access = await resolve(superadmin);
    expect(access.isSuperadmin).toBe(false);
    expect(access.permissions.size).toBe(0);
  });

  it('step 5 — an inactive role revokes everything, including ALLOW overrides', async () => {
    const deadRole = await owner.role.create({
      data: { tenantId, code: 'ROL-DEAD', name: 'Retired', isActive: false },
      select: { id: true },
    });
    const id = await owner.user.create({
      data: {
        tenantId,
        code: 'USR-deadrole',
        username: 'deadrole',
        email: 'deadrole@test.local',
        passwordHash: 'x',
        roleId: deadRole.id,
      },
      select: { id: true },
    });
    await owner.userPermission.create({
      data: { tenantId, userId: id.id, permissionId: permIds[EXPORT]!, effect: 'ALLOW' },
    });

    const access = await resolve(id.id);
    expect(access.permissions.size).toBe(0);
  });

  it('a user with no role at all still gets their ALLOW overrides', async () => {
    const id = await makeUser({ username: 'roleless', withRole: false });
    await owner.userPermission.create({
      data: { tenantId, userId: id, permissionId: permIds[VIEW]!, effect: 'ALLOW' },
    });

    const access = await resolve(id);
    expect([...access.permissions]).toEqual([VIEW]);
  });
});

describe('token invalidation (§7 rule 4)', () => {
  it('bumping the version invalidates tokens already issued', async () => {
    const id = await makeUser({ username: 'bumped' });

    const before = await withTenant(tenantId, async (db) => {
      const account = await loadAccount(db, id);
      return account!.tokenVersion;
    });

    await withTenant(tenantId, (db) => bumpTokenVersion(db, [id]));

    const after = await withTenant(tenantId, async (db) => {
      const account = await loadAccount(db, id);
      return account!.tokenVersion;
    });

    expect(after).toBe(before + 1);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('treats a malformed hash as a wrong password, not an error', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
  });
});
