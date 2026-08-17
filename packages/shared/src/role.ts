import { z } from 'zod';

import { listQuerySchema } from './api';

/**
 * Role and the §7 permission matrix.
 *
 * §7 gives role templates for speed while per-user overrides always win. These
 * are the shapes the two matrix screens bind to.
 */

export const roleInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the role name.').max(100, 'Name is too long.'),
  description: z.string().trim().max(2000, 'Description is too long.').optional(),
});

export type RoleInput = z.input<typeof roleInputSchema>;

export const ROLE_SORT_FIELDS = ['code', 'name'] as const;
export type RoleSortField = (typeof ROLE_SORT_FIELDS)[number];

export const roleListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(ROLE_SORT_FIELDS).default('name'),
});

export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** Seeded template role — cannot be renamed or switched off. */
  isSystem: boolean;
  isActive: boolean;
  permissionCount: number;
  userCount: number;
}

/** The role matrix: which permission keys this role grants. */
export const rolePermissionsSchema = z.object({
  keys: z.array(z.string().min(1)).default([]),
});

export type RolePermissionsInput = z.input<typeof rolePermissionsSchema>;

export interface RolePermissionsDto {
  roleId: string;
  roleName: string;
  keys: string[];
}

// ---------------------------------------------------------------- overrides

/**
 * A cell in the per-user matrix has three states (§7 superadmin screen 3):
 *   INHERIT — no override; whatever the role says
 *   ALLOW   — granted explicitly, even if the role does not
 *   DENY    — refused explicitly, and DENY beats everything except superadmin
 */
export const OVERRIDE_STATES = ['INHERIT', 'ALLOW', 'DENY'] as const;
export type OverrideState = (typeof OVERRIDE_STATES)[number];

export const userPermissionsSchema = z.object({
  overrides: z
    .array(
      z.object({
        key: z.string().min(1),
        effect: z.enum(['ALLOW', 'DENY']),
      }),
    )
    .default([]),
});

export type UserPermissionsInput = z.input<typeof userPermissionsSchema>;

export interface UserPermissionsDto {
  userId: string;
  username: string;
  isSuperadmin: boolean;
  roleId: string | null;
  roleName: string | null;
  /** What the role grants — the grey checks in the matrix. */
  roleKeys: string[];
  /** Explicit per-user rows, keyed by permission. */
  overrides: { key: string; effect: 'ALLOW' | 'DENY' }[];
  /** What actually resolves after §7's five steps, for the summary line. */
  effectiveKeys: string[];
}

/** Mirrors §7 steps 2–4 so the matrix can preview without a round trip. */
export function resolveCellState(
  key: string,
  roleKeys: ReadonlySet<string>,
  overrides: ReadonlyMap<string, 'ALLOW' | 'DENY'>,
): { state: OverrideState; effective: boolean } {
  const override = overrides.get(key);
  if (override === 'DENY') return { state: 'DENY', effective: false };
  if (override === 'ALLOW') return { state: 'ALLOW', effective: true };
  return { state: 'INHERIT', effective: roleKeys.has(key) };
}
