import { z } from 'zod';

import { listQuerySchema } from './api';
import { normalizeUsername } from './auth';

/**
 * User (CLAUDE.md §6 lists it under CRM; §7 gives its fields).
 *
 * The auth account, linked to an employee record. Creating one is also a §7B
 * seat-limit decision later, which is why the API owns the check rather than
 * the form.
 */

/**
 * Passwords: length beats composition rules, which mostly teach people to write
 * "Password1!" on a sticky note. argon2id does the rest (§2).
 */
const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(200, 'That password is too long.');

export const userInputSchema = z.object({
  employeeId: z.string().regex(/^\d+$/, 'Choose an employee.'),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Use at least 3 characters.')
    .max(100, 'Username is too long.')
    .regex(/^[a-z0-9._-]+$/, 'Use letters, digits, dot, underscore or hyphen only.'),
  email: z.email('Enter a valid email address.').max(255, 'Email is too long.'),
  roleId: z.string().regex(/^\d+$/, 'Choose a role.').optional(),
  isSuperadmin: z.boolean().default(false),
});

export type UserInput = z.input<typeof userInputSchema>;

/** Password is separate: set on create, and changed through its own action. */
export const userCreateSchema = userInputSchema.extend({ password: passwordSchema });
export type UserCreateInput = z.input<typeof userCreateSchema>;

export const userPasswordSchema = z.object({ password: passwordSchema });
export type UserPasswordInput = z.input<typeof userPasswordSchema>;

/**
 * What the Add/Edit form binds to.
 *
 * One schema for both modes: password is optional, because the edit form does
 * not show it, but is still length-checked when supplied. Requiring it on
 * create is the API's job — userCreateSchema stays strict, so a client that
 * omits it is rejected server-side regardless of what the form allows.
 *
 * Two schemas here instead would mean two different resolver output types on
 * one useForm, which does not typecheck.
 */
export const userFormSchema = userInputSchema.extend({
  password: z
    .string()
    .max(200, 'That password is too long.')
    .refine((value) => value === '' || value.length >= 12, 'Use at least 12 characters.')
    .optional(),
});

export type UserFormInput = z.input<typeof userFormSchema>;

export const USER_SORT_FIELDS = ['code', 'username', 'email'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export const userListQuerySchema = listQuerySchema.extend({
  sortBy: z.enum(USER_SORT_FIELDS).default('username'),
  roleId: z.string().regex(/^\d+$/).optional(),
});

export interface UserDto {
  id: string;
  code: string;
  username: string;
  email: string;
  employeeId: string | null;
  employeeName: string | null;
  roleId: string | null;
  roleName: string | null;
  isSuperadmin: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
}

export { normalizeUsername };
