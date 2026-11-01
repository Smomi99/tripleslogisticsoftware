import { z } from 'zod';

/**
 * CRM → Customer → custom groups (owner, 2026-11-01).
 *
 * "Create custom group": name a group, pick the customers in it. The group
 * then appears as a filter on the Customer list, and Bulk email writes to
 * whatever the list is filtered to — so a group is also who a letter goes to.
 * Members are added and removed at any time; a group is shared by everyone in
 * the workspace.
 *
 * Permissions are the Customer screen's own: VIEW to filter by a group,
 * CREATE to make one, EDIT to rename it or change who is in it, DELETE to
 * retire it.
 */

/** A group holds at most this many customers per save. */
export const CUSTOMER_GROUP_MAX_MEMBERS = 5000;

const customerId = z.string().regex(/^\d+$/, 'Choose customers from the list.');

const customerIds = z
  .array(customerId)
  .max(CUSTOMER_GROUP_MAX_MEMBERS, `A group holds up to ${CUSTOMER_GROUP_MAX_MEMBERS} customers.`)
  .refine((ids) => new Set(ids).size === ids.length, 'Each customer goes in the group once.');

const name = z
  .string()
  .trim()
  .min(1, 'Name the group.')
  .max(100, 'A group name is at most 100 characters.');

/** Create: a name and the customers it starts with. */
export const customerGroupCreateSchema = z.object({
  name,
  customerIds: customerIds.refine((ids) => ids.length > 0, 'Choose at least one customer for the group.'),
});
export type CustomerGroupCreateInput = z.input<typeof customerGroupCreateSchema>;

/** Edit: the name and the whole member list as it should now stand. A group may be emptied. */
export const customerGroupUpdateSchema = z.object({ name, customerIds });
export type CustomerGroupUpdateInput = z.input<typeof customerGroupUpdateSchema>;

/** Add customers to a group, or put one back. */
export const customerGroupAddMembersSchema = z.object({
  customerIds: customerIds.refine((ids) => ids.length > 0, 'Choose at least one customer to add.'),
});
export type CustomerGroupAddMembersInput = z.input<typeof customerGroupAddMembersSchema>;

/** A group as the filter and the manage list show it. */
export interface CustomerGroupDto {
  id: string;
  code: string;
  name: string;
  /** Customers in it now, not counting any deleted since. */
  memberCount: number;
}

/** A group being edited: who is in it. */
export interface CustomerGroupDetailDto extends CustomerGroupDto {
  customerIds: string[];
}

/** A customer the group picker offers. */
export interface CustomerGroupCustomerOption {
  id: string;
  /** "Dhaka Apparels Ltd (CUS-004)". */
  name: string;
  isActive: boolean;
}
