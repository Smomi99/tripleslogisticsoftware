import type { TenantDb } from './tenant-client';

/**
 * Permission resolution (CLAUDE.md §7).
 *
 * The order is fixed and implemented exactly:
 *   1. is_superadmin  -> everything, always. Never check further.
 *   2. start from the union of the role's permissions
 *   3. apply user_permission: ALLOW adds, DENY removes
 *   4. DENY beats everything except superadmin
 *   5. inactive user or inactive role -> nothing
 */

export interface ResolvedAccess {
  userId: bigint;
  isSuperadmin: boolean;
  /** Empty for a superadmin — step 1 short-circuits before this matters. */
  permissions: Set<string>;
  tokenVersion: number;
  /** Set on an agent account, so a refreshed token keeps the claim. */
  agentId: bigint | null;
  /**
   * True when this login belongs to an outside company — an agent, a customer
   * or a vendor. The session gate reads this rather than checking three
   * columns, so adding a fourth kind later cannot leave a router behind.
   */
  isExternal: boolean;
}

export interface AccountRow {
  id: bigint;
  isActive: boolean;
  isSuperadmin: boolean;
  tokenVersion: number;
  roleId: bigint | null;
  roleIsActive: boolean | null;
  /** Any external link at all. See ResolvedAccess.isExternal. */
  isExternal: boolean;
  /**
   * Set on an external account — an agent's own login. This is the ONLY
   * authoritative source for it: the same value travels in the token so the web
   * app can route, but authenticate compares the two and rejects a mismatch.
   */
  agentId: bigint | null;
}

/**
 * Loads the account plus the flags step 5 needs, in one query.
 * Returns null when the user does not exist, is soft-deleted, or is inactive.
 */
export async function loadAccount(db: TenantDb, userId: bigint): Promise<AccountRow | null> {
  const user = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      isActive: true,
      isSuperadmin: true,
      tokenVersion: true,
      roleId: true,
      agentId: true,
      customerId: true,
      vendorId: true,
      role: { select: { isActive: true, deletedAt: true } },
    },
  });

  if (user === null) return null;

  return {
    id: user.id,
    isActive: user.isActive,
    isSuperadmin: user.isSuperadmin,
    tokenVersion: user.tokenVersion,
    roleId: user.roleId,
    agentId: user.agentId,
    isExternal:
      user.agentId !== null || user.customerId !== null || user.vendorId !== null,
    roleIsActive:
      user.role === null ? null : user.role.isActive && user.role.deletedAt === null,
  };
}

export async function resolvePermissions(
  db: TenantDb,
  account: AccountRow,
): Promise<ResolvedAccess> {
  // isSuperadmin starts false and is granted only by the step 1 branch below.
  // Carrying the column value through would mean a deactivated superadmin still
  // short-circuits every check in hasPermission — step 5 must beat step 1.
  const base: ResolvedAccess = {
    userId: account.id,
    isSuperadmin: false,
    permissions: new Set<string>(),
    tokenVersion: account.tokenVersion,
    // Carried so a refreshed token keeps the claim; authenticate compares it
    // against the row and rejects a mismatch.
    agentId: account.agentId,
    isExternal: account.isExternal,
  };

  // Step 5 — an inactive user gets nothing, superadmin or not.
  if (!account.isActive) return base;

  // Step 1 — superadmin short-circuits. No role lookup, no overrides.
  if (account.isSuperadmin) {
    return { ...base, isSuperadmin: true };
  }

  // Step 5 again — "inactive user OR inactive role -> no access". A deactivated
  // role revokes everything, including permissions granted by a per-user ALLOW.
  // Overrides win over the *role's* grants, not over the account being switched
  // off. A user with no role at all is a different case: their overrides stand.
  if (account.roleId !== null && account.roleIsActive !== true) {
    return base;
  }

  // Step 2 — the union of the role's permissions.
  const granted = new Set<string>();
  if (account.roleId !== null) {
    const rolePermissions = await db.rolePermission.findMany({
      where: { roleId: account.roleId },
      select: { permission: { select: { key: true } } },
    });
    for (const row of rolePermissions) {
      granted.add(row.permission.key);
    }
  }

  // Step 3 — per-user overrides.
  const overrides = await db.userPermission.findMany({
    where: { userId: account.id },
    select: { effect: true, permission: { select: { key: true } } },
  });

  // Step 4 — DENY wins, so apply every ALLOW first and every DENY after.
  // Order matters: a key both allowed and denied must end up denied.
  for (const row of overrides) {
    if (row.effect === 'ALLOW') granted.add(row.permission.key);
  }
  for (const row of overrides) {
    if (row.effect === 'DENY') granted.delete(row.permission.key);
  }

  return { ...base, permissions: granted };
}

/** The check every guard reduces to. */
export function hasPermission(access: ResolvedAccess, key: string): boolean {
  return access.isSuperadmin || access.permissions.has(key);
}

/**
 * Invalidates every access token already issued to these users (§7 rule 4).
 * Call inside the same transaction as any role or user-permission change.
 */
export async function bumpTokenVersion(db: TenantDb, userIds: bigint[]): Promise<void> {
  if (userIds.length === 0) return;
  await db.user.updateMany({
    where: { id: { in: userIds } },
    data: { tokenVersion: { increment: 1 } },
  });
}

/** Every user affected by a change to this role. */
export async function usersWithRole(db: TenantDb, roleId: bigint): Promise<bigint[]> {
  const rows = await db.user.findMany({ where: { roleId }, select: { id: true } });
  return rows.map((r) => r.id);
}
