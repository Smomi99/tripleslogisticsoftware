import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  isPermissionKey,
  type RoleDto,
  roleInputSchema,
  roleListQuerySchema,
  rolePermissionsSchema,
  type RolePermissionsDto,
  userPermissionsSchema,
  type UserPermissionsDto,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { bumpTokenVersion, loadAccount, resolvePermissions, usersWithRole } from '../lib/permissions';
import { parseId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * The §7 superadmin screens: Roles and the two permission matrices.
 *
 * The rule that makes these dangerous to get wrong: a permission set is cached
 * in the access token for up to fifteen minutes (§7 rule 4). So every write
 * here bumps token_version for everyone affected — and for a ROLE that means
 * every user holding it, not just the editor. Miss that and an administrator
 * revokes a permission, sees it saved, and the user keeps it until their token
 * happens to expire.
 */
export const adminRouter: Router = Router();

adminRouter.use(authenticate);

const ROLE_FEATURE = 'ADMIN.ROLE';
const MATRIX_FEATURE = 'ADMIN.USER_PERMISSION';

const ROLE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  isSystem: true,
  isActive: true,
  _count: { select: { permissions: true, users: true } },
} as const;

function roleToDto(row: {
  id: bigint;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  _count: { permissions: number; users: number };
}): RoleDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    isActive: row.isActive,
    permissionCount: row._count.permissions,
    userCount: row._count.users,
  };
}

/** Turns permission keys into ids, refusing any key the registry does not define. */
async function keysToPermissionIds(db: TenantDb, keys: string[]): Promise<bigint[]> {
  const unique = [...new Set(keys)];
  const unknown = unique.filter((key) => !isPermissionKey(key));
  if (unknown.length > 0) {
    throw HttpError.badRequest(`Unknown permission: ${unknown[0]}.`);
  }
  if (unique.length === 0) return [];

  const rows = await db.permission.findMany({
    where: { key: { in: unique } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ===========================================================================
// Roles
// ===========================================================================

adminRouter.get('/roles', requirePermission(`${ROLE_FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = roleListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { code: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.role.findMany({
        where,
        select: ROLE_SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.role.count({ where }),
    ]);
    return { rows: rows.map(roleToDto), total };
  });

  const payload: ApiSuccess<RoleDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

adminRouter.post('/roles', requirePermission(`${ROLE_FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = roleInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    const clash = await db.role.findFirst({
      where: { name: input.name, deletedAt: null },
      select: { id: true },
    });
    if (clash !== null) throw HttpError.conflict(`A role called ${input.name} already exists.`);

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'role', CODE_PREFIX.role, auth.tenantId);
      try {
        return await db.role.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            description: input.description || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: ROLE_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a role code.');
  });

  const payload: ApiSuccess<RoleDto> = { success: true, data: roleToDto(created) };
  res.status(201).json(payload);
});

adminRouter.patch('/roles/:id', requirePermission(`${ROLE_FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'role');
  const input = roleInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.role.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, isSystem: true },
    });
    if (existing === null) throw HttpError.notFound('Role not found.');
    if (existing.isSystem) {
      throw HttpError.forbidden('This is a system role. Its name cannot be changed.');
    }

    const clash = await db.role.findFirst({
      where: { name: input.name, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (clash !== null) throw HttpError.conflict(`A role called ${input.name} already exists.`);

    return db.role.update({
      where: { id },
      data: { name: input.name, description: input.description || null, updatedBy: auth.userId },
      select: ROLE_SELECT,
    });
  });

  const payload: ApiSuccess<RoleDto> = { success: true, data: roleToDto(updated) };
  res.json(payload);
});

adminRouter.post(
  '/roles/:id/toggle-status',
  requirePermission(`${ROLE_FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'role');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.role.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true, isSystem: true },
      });
      if (existing === null) throw HttpError.notFound('Role not found.');
      if (existing.isSystem) {
        throw HttpError.forbidden('This is a system role and cannot be switched off.');
      }

      const updated = await db.role.update({
        where: { id },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });

      // §7 rule 5: an inactive role removes access from everyone holding it,
      // so their cached tokens must stop working now.
      await bumpTokenVersion(db, await usersWithRole(db, id));
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

// ===========================================================================
// Role permission matrix
// ===========================================================================

adminRouter.get(
  '/roles/:id/permissions',
  requirePermission(`${ROLE_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'role');

    const data = await withTenant(auth.tenantId, async (db) => {
      const role = await db.role.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, name: true },
      });
      if (role === null) throw HttpError.notFound('Role not found.');

      const rows = await db.rolePermission.findMany({
        where: { roleId: id },
        select: { permission: { select: { key: true } } },
      });
      return { role, keys: rows.map((r) => r.permission.key) };
    });

    const payload: ApiSuccess<RolePermissionsDto> = {
      success: true,
      data: {
        roleId: data.role.id.toString(),
        roleName: data.role.name,
        keys: data.keys,
      },
    };
    res.json(payload);
  },
);

adminRouter.put(
  '/roles/:id/permissions',
  requirePermission(`${ROLE_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'role');
    const input = rolePermissionsSchema.parse(req.body);

    const keys = await withTenant(auth.tenantId, async (db) => {
      const role = await db.role.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (role === null) throw HttpError.notFound('Role not found.');

      const permissionIds = await keysToPermissionIds(db, input.keys ?? []);

      // Replace wholesale. These are join rows with no state to preserve, which
      // is why DELETE is granted on this table and nowhere business-shaped.
      await db.$executeRaw`DELETE FROM role_permission WHERE role_id = ${id} AND tenant_id = ${auth.tenantId}`;
      if (permissionIds.length > 0) {
        await db.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({
            tenantId: auth.tenantId,
            roleId: id,
            permissionId,
            createdBy: auth.userId,
          })),
        });
      }

      // §7 rule 4. Everyone holding this role is affected, not just the editor.
      await bumpTokenVersion(db, await usersWithRole(db, id));

      const rows = await db.rolePermission.findMany({
        where: { roleId: id },
        select: { permission: { select: { key: true } } },
      });
      return rows.map((r) => r.permission.key);
    });

    const payload: ApiSuccess<{ keys: string[] }> = { success: true, data: { keys } };
    res.json(payload);
  },
);

// ===========================================================================
// Per-user permission matrix (§7 superadmin screen 3)
// ===========================================================================

adminRouter.get(
  '/users/:id/permissions',
  requirePermission(`${MATRIX_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'user');

    const data = await withTenant(auth.tenantId, async (db) => {
      const user = await db.user.findFirst({
        where: { id, deletedAt: null },
        select: {
          id: true,
          username: true,
          isSuperadmin: true,
          roleId: true,
          role: { select: { name: true } },
        },
      });
      if (user === null) throw HttpError.notFound('User not found.');

      const roleRows =
        user.roleId === null
          ? []
          : await db.rolePermission.findMany({
              where: { roleId: user.roleId },
              select: { permission: { select: { key: true } } },
            });

      const overrideRows = await db.userPermission.findMany({
        where: { userId: id },
        select: { effect: true, permission: { select: { key: true } } },
      });

      // The effective set comes from the same resolver the guards use, rather
      // than being recomputed here — two implementations would drift.
      const account = await loadAccount(db, id);
      const access = account === null ? null : await resolvePermissions(db, account);

      return { user, roleRows, overrideRows, access };
    });

    const payload: ApiSuccess<UserPermissionsDto> = {
      success: true,
      data: {
        userId: data.user.id.toString(),
        username: data.user.username,
        isSuperadmin: data.user.isSuperadmin,
        roleId: data.user.roleId?.toString() ?? null,
        roleName: data.user.role?.name ?? null,
        roleKeys: data.roleRows.map((r) => r.permission.key),
        overrides: data.overrideRows.map((r) => ({
          key: r.permission.key,
          effect: r.effect,
        })),
        effectiveKeys: data.access === null ? [] : [...data.access.permissions],
      },
    };
    res.json(payload);
  },
);

adminRouter.put(
  '/users/:id/permissions',
  requirePermission(`${MATRIX_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'user');
    const input = userPermissionsSchema.parse(req.body);
    const overrides = input.overrides ?? [];

    await withTenant(auth.tenantId, async (db) => {
      const user = await db.user.findFirst({
        where: { id, deletedAt: null },
        select: { id: true },
      });
      if (user === null) throw HttpError.notFound('User not found.');

      const unknown = overrides.filter((o) => !isPermissionKey(o.key));
      if (unknown.length > 0) {
        throw HttpError.badRequest(`Unknown permission: ${unknown[0]?.key}.`);
      }

      const byKey = new Map(overrides.map((o) => [o.key, o.effect]));
      const permissions =
        byKey.size === 0
          ? []
          : await db.permission.findMany({
              where: { key: { in: [...byKey.keys()] } },
              select: { id: true, key: true },
            });

      // "Reset to role default" is simply an empty override list.
      await db.$executeRaw`DELETE FROM user_permission WHERE user_id = ${id} AND tenant_id = ${auth.tenantId}`;
      if (permissions.length > 0) {
        await db.userPermission.createMany({
          data: permissions.map((permission) => ({
            tenantId: auth.tenantId,
            userId: id,
            permissionId: permission.id,
            effect: byKey.get(permission.key) ?? 'ALLOW',
            createdBy: auth.userId,
          })),
        });
      }

      await bumpTokenVersion(db, [id]);
    });

    // Re-read through the same path the GET uses, so the client sees exactly
    // what the guards will enforce.
    const refreshed = await withTenant(auth.tenantId, async (db) => {
      const account = await loadAccount(db, id);
      return account === null ? [] : [...(await resolvePermissions(db, account)).permissions];
    });

    const payload: ApiSuccess<{ effectiveKeys: string[] }> = {
      success: true,
      data: { effectiveKeys: refreshed },
    };
    res.json(payload);
  },
);
