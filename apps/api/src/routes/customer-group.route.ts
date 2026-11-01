import { Router } from 'express';

import {
  type ApiSuccess,
  CODE_PREFIX,
  customerGroupAddMembersSchema,
  customerGroupCreateSchema,
  type CustomerGroupCustomerOption,
  type CustomerGroupDetailDto,
  type CustomerGroupDto,
  customerGroupUpdateSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, inSavepoint, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { parseId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';

/**
 * CRM → Customer → custom groups (owner, 2026-11-01).
 *
 * A named set of customers, picked by hand. The Customer list filters by one
 * (customerFilterWhere), and Bulk email writes to what the list shows, so a
 * group is also a mailing list. Removing a customer, or deleting a group,
 * retires the row; nothing is hard-deleted (§4 rule 3).
 *
 * The Customer screen's permissions: VIEW lists the groups, CREATE makes one,
 * EDIT renames it and changes its members, DELETE retires it.
 */

export const customerGroupRouter: Router = Router();
customerGroupRouter.use(authenticate);

const FEATURE = 'CRM.CUSTOMER';

/** A member counts while it and its customer are both live. */
const LIVE_MEMBER = { deletedAt: null, customer: { deletedAt: null } } as const;

const GROUP_SELECT = {
  id: true,
  code: true,
  name: true,
  _count: { select: { members: { where: LIVE_MEMBER } } },
} as const;

function toDto(group: { id: bigint; code: string; name: string; _count: { members: number } }): CustomerGroupDto {
  return { id: group.id.toString(), code: group.code, name: group.name, memberCount: group._count.members };
}

async function loadGroup(db: TenantDb, id: bigint): Promise<CustomerGroupDto> {
  const group = await db.customerGroup.findFirst({ where: { id, deletedAt: null }, select: GROUP_SELECT });
  if (group === null) throw HttpError.notFound('That group no longer exists.');
  return toDto(group);
}

async function assertGroup(db: TenantDb, id: bigint): Promise<void> {
  const found = await db.customerGroup.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (found === null) throw HttpError.notFound('That group no longer exists.');
}

/** Every customer must be one of this workspace's, and not deleted. Asked again on the way in, because a request is not a form. */
async function assertCustomers(db: TenantDb, ids: bigint[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await db.customer.count({ where: { id: { in: ids }, deletedAt: null } });
  if (found !== ids.length) throw HttpError.badRequest('One of those customers is not available. Reload the list and choose again.');
}

async function assertNameFree(db: TenantDb, name: string, exceptId?: bigint): Promise<void> {
  const taken = await db.customerGroup.findFirst({
    where: {
      deletedAt: null,
      name: { equals: name.trim(), mode: 'insensitive' },
      ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (taken !== null) throw HttpError.conflict(`There is already a group called "${name.trim()}". Choose another name.`);
}

/** Adds the customers not already in the group; returns how many were added. */
async function addMembers(db: TenantDb, tenantId: bigint, userId: bigint, groupId: bigint, ids: bigint[]): Promise<number> {
  const existing = await db.customerGroupMember.findMany({
    where: { customerGroupId: groupId, customerId: { in: ids }, deletedAt: null },
    select: { customerId: true },
  });
  const have = new Set(existing.map((m) => m.customerId.toString()));
  const fresh = ids.filter((id) => !have.has(id.toString()));
  if (fresh.length === 0) return 0;
  await db.customerGroupMember.createMany({
    data: fresh.map((customerId) => ({
      tenantId,
      customerGroupId: groupId,
      customerId,
      createdBy: userId,
      updatedBy: userId,
    })),
  });
  return fresh.length;
}

const conflictOnName = (error: unknown): never => {
  if (isUniqueViolation(error, 'name')) throw HttpError.conflict('There is already a group with that name. Choose another name.');
  throw error;
};

/** The groups, for the filter and the manage list. */
customerGroupRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const data = await withTenant(auth.tenantId, async (db) => {
    const groups = await db.customerGroup.findMany({
      where: { deletedAt: null },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: GROUP_SELECT,
    });
    return groups.map(toDto);
  });
  const payload: ApiSuccess<CustomerGroupDto[]> = { success: true, data };
  res.json(payload);
});

/** The customers a group can hold — the picker on create and edit. */
customerGroupRouter.get(
  '/customers',
  requireAnyPermission(`${FEATURE}.CREATE`, `${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const data = await withTenant(auth.tenantId, async (db) => {
      const customers = await db.customer.findMany({
        where: { deletedAt: null },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, code: true, name: true, isActive: true },
      });
      return customers.map<CustomerGroupCustomerOption>((c) => ({
        id: c.id.toString(),
        name: `${c.name} (${c.code})`,
        isActive: c.isActive,
      }));
    });
    const payload: ApiSuccess<CustomerGroupCustomerOption[]> = { success: true, data };
    res.json(payload);
  },
);

customerGroupRouter.get('/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'group');
  const data = await withTenant(auth.tenantId, async (db): Promise<CustomerGroupDetailDto> => {
    const group = await loadGroup(db, id);
    const members = await db.customerGroupMember.findMany({
      where: { customerGroupId: id, ...LIVE_MEMBER },
      orderBy: { id: 'asc' },
      select: { customerId: true },
    });
    return { ...group, customerIds: members.map((m) => m.customerId.toString()) };
  });
  const payload: ApiSuccess<CustomerGroupDetailDto> = { success: true, data };
  res.json(payload);
});

customerGroupRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = customerGroupCreateSchema.parse(req.body);
  const ids = input.customerIds.map((v) => BigInt(v));

  const data = await withTenant(auth.tenantId, async (db) => {
    await assertCustomers(db, ids);
    await assertNameFree(db, input.name);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'customerGroup', CODE_PREFIX.customerGroup, auth.tenantId);
      try {
        const created = await inSavepoint(db, () =>
          db.customerGroup.create({
            data: { tenantId: auth.tenantId, code, name: input.name, createdBy: auth.userId, updatedBy: auth.userId },
            select: { id: true },
          }),
        );
        await addMembers(db, auth.tenantId, auth.userId, created.id, ids);
        return loadGroup(db, created.id);
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        return conflictOnName(error);
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a group code.');
  });

  const payload: ApiSuccess<CustomerGroupDto> = { success: true, data };
  res.status(201).json(payload);
});

/** Rename, and set the members to exactly this list: the ones left out are removed, the new ones added. */
customerGroupRouter.put('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'group');
  const input = customerGroupUpdateSchema.parse(req.body);
  const wanted = input.customerIds.map((v) => BigInt(v));

  const data = await withTenant(auth.tenantId, async (db) => {
    await assertGroup(db, id);
    await assertCustomers(db, wanted);
    await assertNameFree(db, input.name, id);
    try {
      await inSavepoint(db, () =>
        db.customerGroup.update({ where: { id }, data: { name: input.name, updatedBy: auth.userId }, select: { id: true } }),
      );
    } catch (error) {
      conflictOnName(error);
    }
    const keep = new Set(wanted.map(String));
    const current = await db.customerGroupMember.findMany({
      where: { customerGroupId: id, deletedAt: null },
      select: { id: true, customerId: true },
    });
    const leaving = current.filter((m) => !keep.has(m.customerId.toString())).map((m) => m.id);
    if (leaving.length > 0) {
      await db.customerGroupMember.updateMany({
        where: { id: { in: leaving } },
        data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
      });
    }
    await addMembers(db, auth.tenantId, auth.userId, id, wanted);
    return loadGroup(db, id);
  });

  const payload: ApiSuccess<CustomerGroupDto> = { success: true, data };
  res.json(payload);
});

/** Add customers — from the list, or putting back one just removed. */
customerGroupRouter.post('/:id/members', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'group');
  const input = customerGroupAddMembersSchema.parse(req.body);
  const ids = input.customerIds.map((v) => BigInt(v));

  const data = await withTenant(auth.tenantId, async (db) => {
    await assertGroup(db, id);
    await assertCustomers(db, ids);
    await addMembers(db, auth.tenantId, auth.userId, id, ids);
    return loadGroup(db, id);
  });

  const payload: ApiSuccess<CustomerGroupDto> = { success: true, data };
  res.json(payload);
});

customerGroupRouter.delete('/:id/members/:customerId', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'group');
  const customerId = parseId(req.params.customerId, 'customer');

  const data = await withTenant(auth.tenantId, async (db) => {
    await assertGroup(db, id);
    const retired = await db.customerGroupMember.updateMany({
      where: { customerGroupId: id, customerId, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
    if (retired.count === 0) throw HttpError.notFound('That customer is not in this group.');
    return loadGroup(db, id);
  });

  const payload: ApiSuccess<CustomerGroupDto> = { success: true, data };
  res.json(payload);
});

/** Retires the group and its memberships. The customers themselves are untouched. */
customerGroupRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'group');

  await withTenant(auth.tenantId, async (db) => {
    await assertGroup(db, id);
    const now = new Date();
    await db.customerGroupMember.updateMany({
      where: { customerGroupId: id, deletedAt: null },
      data: { deletedAt: now, isActive: false, updatedBy: auth.userId },
    });
    await db.customerGroup.update({
      where: { id },
      data: { deletedAt: now, isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});
