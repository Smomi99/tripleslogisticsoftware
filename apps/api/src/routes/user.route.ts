import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type LookupOption,
  normalizeUsername,
  userCreateSchema,
  type UserDto,
  userInputSchema,
  userListQuerySchema,
  userPasswordSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { hashPassword } from '../lib/password';
import { bumpTokenVersion } from '../lib/permissions';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * CRM → User (CLAUDE.md §6 lists it under CRM; §7 gives its fields).
 *
 * Every write that could change what a user may reach — role, superadmin flag,
 * deactivation — bumps token_version, because §7 rule 4 requires a permission
 * change to take effect *immediately* and an access token caches the resolved
 * set for up to fifteen minutes. Without the bump the change would appear to
 * work and then not apply until the token expired.
 */
export const userRouter: Router = Router();

userRouter.use(authenticate);

const FEATURE = 'CRM.USER';

const SELECT = {
  id: true,
  code: true,
  username: true,
  email: true,
  employeeId: true,
  agentId: true,
  customerId: true,
  vendorId: true,
  roleId: true,
  isSuperadmin: true,
  isActive: true,
  lastLoginAt: true,
  employee: { select: { name: true } },
  agent: { select: { name: true } },
  customer: { select: { name: true } },
  vendor: { select: { name: true } },
  role: { select: { name: true } },
} as const;

type UserRow = {
  id: bigint;
  code: string;
  username: string;
  email: string;
  employeeId: bigint | null;
  agentId: bigint | null;
  customerId: bigint | null;
  vendorId: bigint | null;
  roleId: bigint | null;
  isSuperadmin: boolean;
  isActive: boolean;
  lastLoginAt: Date | null;
  employee: { name: string } | null;
  agent: { name: string } | null;
  customer: { name: string } | null;
  vendor: { name: string } | null;
  role: { name: string } | null;
};

function toDto(row: UserRow): UserDto {
  return {
    id: row.id.toString(),
    code: row.code,
    username: row.username,
    email: row.email,
    // The link decides the type: there is no separate column, and no way for
    // the two to disagree. The CHECK allows at most one, so the order of these
    // tests cannot matter.
    userType:
      row.agentId !== null
        ? 'AGENT'
        : row.customerId !== null
          ? 'CUSTOMER'
          : row.vendorId !== null
            ? 'VENDOR'
            : 'EMPLOYEE',
    employeeId: row.employeeId?.toString() ?? null,
    agentId: row.agentId?.toString() ?? null,
    agentName: row.agent?.name ?? null,
    customerId: row.customerId?.toString() ?? null,
    customerName: row.customer?.name ?? null,
    vendorId: row.vendorId?.toString() ?? null,
    vendorName: row.vendor?.name ?? null,
    employeeName: row.employee?.name ?? null,
    roleId: row.roleId?.toString() ?? null,
    roleName: row.role?.name ?? null,
    isSuperadmin: row.isSuperadmin,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  };
}

async function assertEmployeeVisible(db: TenantDb, id: bigint): Promise<void> {
  const employee = await db.employee.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (employee === null) throw HttpError.badRequest('That employee is not available.');
}

/**
 * The company must exist, be active, and not already have a login.
 *
 * One login per company is the client's rule for all three kinds. Partial
 * unique indexes enforce it, so this exists to say WHY rather than to be the
 * guarantee — a bare constraint violation reads as a bug rather than as a rule.
 */
async function assertLinkFree(
  db: TenantDb,
  links: { agentId: bigint | null; customerId: bigint | null; vendorId: bigint | null },
  excludeUserId?: bigint,
): Promise<void> {
  const kinds = [
    { label: 'agent', id: links.agentId, find: db.agent, column: 'agentId' as const },
    { label: 'customer', id: links.customerId, find: db.customer, column: 'customerId' as const },
    { label: 'vendor', id: links.vendorId, find: db.vendor, column: 'vendorId' as const },
  ];

  for (const kind of kinds) {
    if (kind.id === null) continue;

    const company = (await (
      kind.find as unknown as {
        findFirst: (a: unknown) => Promise<{ name: string } | null>;
      }
    ).findFirst({
      where: { id: kind.id, deletedAt: null, isActive: true },
      select: { name: true },
    })) as { name: string } | null;
    if (company === null) throw HttpError.badRequest(`That ${kind.label} is not available.`);

    const existing = await db.user.findFirst({
      where: {
        [kind.column]: kind.id,
        deletedAt: null,
        ...(excludeUserId === undefined ? {} : { id: { not: excludeUserId } }),
      },
      select: { username: true },
    });
    if (existing !== null) {
      throw HttpError.conflict(
        `${company.name} already has a login (${existing.username}). Each ${kind.label} has one, shared by their contacts.`,
      );
    }
  }
}

/**
 * Which link a user row carries, from the type the form chose.
 *
 * Exactly one is non-null, and the database CHECK says the same thing — this is
 * where the form's answer becomes that row. Sending the others as null matters:
 * changing a user's type must clear the link it used to have, or the row would
 * claim two companies and the CHECK would refuse the write.
 */
function resolveLinks(input: {
  userType: 'EMPLOYEE' | 'AGENT' | 'CUSTOMER' | 'VENDOR';
  employeeId?: string | undefined;
  agentId?: string | undefined;
  customerId?: string | undefined;
  vendorId?: string | undefined;
}): {
  employeeId: bigint | null;
  agentId: bigint | null;
  customerId: bigint | null;
  vendorId: bigint | null;
} {
  const empty = { employeeId: null, agentId: null, customerId: null, vendorId: null };
  switch (input.userType) {
    case 'AGENT':
      return { ...empty, agentId: parseRefId(input.agentId ?? '', 'agent') };
    case 'CUSTOMER':
      return { ...empty, customerId: parseRefId(input.customerId ?? '', 'customer') };
    case 'VENDOR':
      return { ...empty, vendorId: parseRefId(input.vendorId ?? '', 'vendor') };
    default:
      return { ...empty, employeeId: parseRefId(input.employeeId ?? '', 'employee') };
  }
}

async function assertRoleVisible(db: TenantDb, id: bigint): Promise<void> {
  const role = await db.role.findFirst({
    where: { id, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (role === null) throw HttpError.badRequest('That role is not available.');
}

userRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = userListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.roleId !== undefined ? { roleId: BigInt(query.roleId) } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { username: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
              { code: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.user.findMany({
        where,
        select: SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.user.count({ where }),
    ]);
    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<UserDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** Employees not yet linked to an account, plus roles — for the form. */
userRouter.get('/options', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const options = await withTenant(auth.tenantId, async (db) => {
    const [employees, agents, customers, vendors, roles] = await Promise.all([
      db.employee.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      // Only agents that do not already have one: the rule is one login per
      // agent, so offering a company that has one is offering a dead end.
      db.agent.findMany({
        where: { deletedAt: null, isActive: true, users: { none: { deletedAt: null } } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.customer.findMany({
        where: { deletedAt: null, isActive: true, users: { none: { deletedAt: null } } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.vendor.findMany({
        where: { deletedAt: null, isActive: true, users: { none: { deletedAt: null } } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.role.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      employees: employees.map((e) => ({ id: e.id.toString(), name: e.name })),
      agents: agents.map((a) => ({ id: a.id.toString(), name: a.name })),
      customers: customers.map((c) => ({ id: c.id.toString(), name: c.name })),
      vendors: vendors.map((v) => ({ id: v.id.toString(), name: v.name })),
      roles: roles.map((r) => ({ id: r.id.toString(), name: r.name })),
    };
  });

  const payload: ApiSuccess<{
    employees: LookupOption[];
    agents: LookupOption[];
    customers: LookupOption[];
    vendors: LookupOption[];
    roles: LookupOption[];
  }> = {
    success: true,
    data: options,
  };
  res.json(payload);
});

userRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = userCreateSchema.parse(req.body);
  const username = normalizeUsername(input.username);
  // The schema already refuses the wrong combination; `?? ''` keeps the types
  // honest and makes parseRefId produce the same message either way.
  const links = resolveLinks(input);
  const { employeeId, agentId, customerId, vendorId } = links;
  const roleId = input.roleId === undefined ? null : parseRefId(input.roleId, 'role');

  const created = await withTenant(auth.tenantId, async (db) => {
    if (employeeId !== null) await assertEmployeeVisible(db, employeeId);
    await assertLinkFree(db, links);
    if (roleId !== null) await assertRoleVisible(db, roleId);

    // §4 rule 9: username and email are unique per tenant, not globally — two
    // companies may employ the same person.
    const clash = await db.user.findFirst({
      where: { OR: [{ username }, { email: input.email }], deletedAt: null },
      select: { username: true, email: true },
    });
    if (clash !== null) {
      throw HttpError.conflict(
        clash.username === username
          ? `Username ${username} is already taken in this workspace.`
          : `Email ${input.email} is already in use in this workspace.`,
      );
    }

    const passwordHash = await hashPassword(input.password);

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'user', CODE_PREFIX.user, auth.tenantId);
      try {
        return await db.user.create({
          data: {
            tenantId: auth.tenantId,
            code,
            username,
            email: input.email,
            passwordHash,
            employeeId,
            agentId,
            customerId,
            vendorId,
            roleId,
            isSuperadmin: input.isSuperadmin ?? false,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a user code.');
  });

  const payload: ApiSuccess<UserDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

userRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'user');
  const input = userInputSchema.parse(req.body);
  const username = normalizeUsername(input.username);
  // The schema already refuses the wrong combination; `?? ''` keeps the types
  // honest and makes parseRefId produce the same message either way.
  const links = resolveLinks(input);
  const { employeeId, agentId, customerId, vendorId } = links;
  const roleId = input.roleId === undefined ? null : parseRefId(input.roleId, 'role');

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        roleId: true,
        agentId: true,
        customerId: true,
        vendorId: true,
        isSuperadmin: true,
      },
    });
    if (existing === null) throw HttpError.notFound('User not found.');

    if (employeeId !== null) await assertEmployeeVisible(db, employeeId);
    await assertLinkFree(db, links, id);
    if (roleId !== null) await assertRoleVisible(db, roleId);

    const clash = await db.user.findFirst({
      where: {
        OR: [{ username }, { email: input.email }],
        deletedAt: null,
        NOT: { id },
      },
      select: { username: true },
    });
    if (clash !== null) {
      throw HttpError.conflict('That username or email is already in use in this workspace.');
    }

    const row = await db.user.update({
      where: { id },
      data: {
        username,
        email: input.email,
        employeeId,
        agentId,
        customerId,
        vendorId,
        roleId,
        isSuperadmin: input.isSuperadmin ?? false,
        updatedBy: auth.userId,
      },
      select: SELECT,
    });

    // §7 rule 4: if what this user may reach changed, every token already
    // issued to them must stop working now rather than in fifteen minutes.
    // Changing which agent a login belongs to changes what it can see just as
    // surely as changing its role, and the session claim would otherwise
    // disagree with the row on the next request.
    const accessChanged =
      existing.roleId !== roleId ||
      existing.agentId !== agentId ||
      existing.customerId !== customerId ||
      existing.vendorId !== vendorId ||
      existing.isSuperadmin !== (input.isSuperadmin ?? false);
    if (accessChanged) await bumpTokenVersion(db, [id]);

    return row;
  });

  const payload: ApiSuccess<UserDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

/** §7: reset password. Invalidates every session that user has open. */
userRouter.post('/:id/password', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'user');
  const input = userPasswordSchema.parse(req.body);

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('User not found.');

    await db.user.update({
      where: { id },
      data: { passwordHash: await hashPassword(input.password), updatedBy: auth.userId },
    });
    // A password reset must end the old sessions, or a stolen token outlives it.
    await bumpTokenVersion(db, [id]);
  });

  const payload: ApiSuccess<{ reset: true }> = { success: true, data: { reset: true } };
  res.json(payload);
});

userRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'user');

    if (id === auth.userId) {
      // Deactivating yourself locks you out of the workspace you are using.
      throw HttpError.badRequest('You cannot deactivate your own account.');
    }

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.user.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('User not found.');

      const updated = await db.user.update({
        where: { id },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      // §7 rule 5: an inactive user has no access, effective immediately.
      await bumpTokenVersion(db, [id]);
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

/**
 * DELETE /api/tenant/.../:id — CR-002.
 *
 * A soft delete: it sets `deleted_at`, so §4 rule 3 holds and every foreign key
 * survives. Refused when anything still references the row, and refused on a
 * shared system row — so it only ever removes a user entered by mistake.
 */
userRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'user');

  // Deleting your own account soft-deletes the row your session resolves
  // against: the next request cannot find you and you are locked out of the
  // workspace with no way back in from the UI.
  if (id === auth.userId) {
    throw new HttpError(
      409,
      'SELF_DELETE',
      'You cannot delete your own account. Ask another superadmin to do it.',
    );
  }

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, username: true },
    });
    await assertRowDeletable(
      db,
      'user',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.username },
      'User not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'user', id, auth.userId);

    await db.user.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});
