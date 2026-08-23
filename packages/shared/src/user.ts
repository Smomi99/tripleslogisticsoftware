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

/**
 * Who this login belongs to.
 *
 * EMPLOYEE is a member of staff, linked to their employee record. AGENT is an
 * outside company: one login per agent, shared by its contacts, reaching only
 * the Agent Inquiry screen. Customer and Vendor will join this list on the same
 * shape when their screens exist.
 */
export const USER_TYPES = ['EMPLOYEE', 'AGENT', 'CUSTOMER', 'VENDOR'] as const;
export type UserType = (typeof USER_TYPES)[number];

/**
 * How each kind is named to the operator, with the article that reads correctly
 * in front of it. "Choose a agent" shipped once; it does not get to twice.
 */
export const USER_TYPE_LABEL: Record<UserType, string> = {
  EMPLOYEE: 'Employee',
  AGENT: 'Agent',
  CUSTOMER: 'Customer',
  VENDOR: 'Vendor',
};

export const USER_TYPE_ARTICLE: Record<UserType, string> = {
  EMPLOYEE: 'an',
  AGENT: 'an',
  CUSTOMER: 'a',
  VENDOR: 'a',
};

/**
 * An id from a `<select>`, where "not chosen" arrives as an empty string.
 *
 * A plain `.regex(/^\d+$/).optional()` refuses '' — optional means the KEY may
 * be absent, not that the value may be blank. The form always sends the key, so
 * leaving Role blank failed validation with "Choose a role" on a field that is
 * not required. The refinements below decide which of these must be filled.
 */
const optionalId = (message: string) =>
  z
    .string()
    .regex(/^\d*$/, message)
    .optional();

export const userInputSchema = z
  .object({
    userType: z.enum(USER_TYPES).default('EMPLOYEE'),
    /** Required for EMPLOYEE, absent for AGENT. */
    employeeId: optionalId('Choose an employee.'),
    /** Required for AGENT, absent for EMPLOYEE. */
    agentId: optionalId('Choose an agent.'),
    /** Required for CUSTOMER. */
    customerId: optionalId('Choose a customer.'),
    /** Required for VENDOR. */
    vendorId: optionalId('Choose a vendor.'),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Use at least 3 characters.')
    .max(100, 'Username is too long.')
    .regex(/^[a-z0-9._-]+$/, 'Use letters, digits, dot, underscore or hyphen only.'),
  email: z.email('Enter a valid email address.').max(255, 'Email is too long.'),
    roleId: optionalId('Choose a role.'),
    isSuperadmin: z.boolean().default(false),
  })
  .refine((v) => v.userType !== 'EMPLOYEE' || (v.employeeId ?? '') !== '', {
    message: 'Choose an employee.',
    path: ['employeeId'],
  })
  .refine((v) => v.userType !== 'AGENT' || (v.agentId ?? '') !== '', {
    message: 'Choose an agent.',
    path: ['agentId'],
  })
  .refine((v) => v.userType !== 'CUSTOMER' || (v.customerId ?? '') !== '', {
    message: 'Choose a customer.',
    path: ['customerId'],
  })
  .refine((v) => v.userType !== 'VENDOR' || (v.vendorId ?? '') !== '', {
    message: 'Choose a vendor.',
    path: ['vendorId'],
  })
  // The database CHECK refuses this outright; saying so here means the operator
  // hears it from the form rather than as a constraint violation.
  .refine((v) => v.userType === 'EMPLOYEE' || v.isSuperadmin !== true, {
    message: 'An account for an outside company cannot be a superadmin.',
    path: ['isSuperadmin'],
  });

/** True for the user types that belong to an outside company. */
export function isExternalUserType(type: UserType): boolean {
  return type !== 'EMPLOYEE';
}

export type UserInput = z.input<typeof userInputSchema>;

/** Password is separate: set on create, and changed through its own action. */
export const userCreateSchema = z
  .object({ password: passwordSchema })
  .and(userInputSchema);
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
export const userFormSchema = z
  .object({
    password: z
      .string()
      .max(200, 'That password is too long.')
      .refine((value) => value === '' || value.length >= 12, 'Use at least 12 characters.')
      .optional(),
  })
  .and(userInputSchema);

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
  userType: UserType;
  employeeId: string | null;
  employeeName: string | null;
  /** Set on an external account: the company this login belongs to. */
  agentId: string | null;
  agentName: string | null;
  customerId: string | null;
  customerName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  roleId: string | null;
  roleName: string | null;
  isSuperadmin: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
}

export { normalizeUsername };
