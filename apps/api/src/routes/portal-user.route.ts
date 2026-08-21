import { Router } from 'express';

import {
  type ApiSuccess,
  CODE_PREFIX,
  normalizeUsername,
  portalInviteSchema,
  type PortalUserDto,
} from '@ff/shared';

import { recordAudit } from '../lib/audit';
import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { issueCredentialToken } from '../lib/credential-token';
import { HttpError } from '../lib/http-error';
import { hashPassword } from '../lib/password';
import { sendInviteMail } from '../lib/portal-mail';
import { parseId } from '../lib/request';
import { randomBytes } from 'node:crypto';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requireSuperadmin } from '../middleware/require-superadmin';

/**
 * CRM → Agent → Portal access (docs/AGENT_PORTAL_DESIGN.md §2.4).
 *
 * Superadmin only, and deliberately not behind a §7 permission key — see
 * require-superadmin.ts for why.
 *
 * Mounted after agentRouter on the same path, so an agent request pays for one
 * authenticate rather than two; only the rarer portal-user calls fall through.
 */
export const portalUserRouter: Router = Router();

portalUserRouter.use(authenticate);
portalUserRouter.use(requireSuperadmin);

const USER_SELECT = {
  id: true,
  username: true,
  email: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

interface UserRow {
  id: bigint;
  username: string;
  email: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

function toDto(
  row: UserRow,
  extras: { contactName: string | null; invitePending: boolean },
): PortalUserDto {
  return {
    id: row.id.toString(),
    username: row.username,
    email: row.email,
    contactName: extras.contactName,
    isActive: row.isActive,
    invitePending: extras.invitePending,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 404 rather than 403 for another workspace's agent — it does not exist here. */
async function findAgent(db: TenantDb, agentId: bigint) {
  const agent = await db.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (agent === null) throw HttpError.notFound('That agent no longer exists.');
  return agent;
}

/** GET /api/tenant/crm/agents/:id/portal-users */
portalUserRouter.get('/:id/portal-users', async (req, res) => {
  const auth = req.auth!;
  const agentId = parseId(req.params.id, 'agent');

  const rows = await withTenant(auth.tenantId, async (db) => {
    await findAgent(db, agentId);
    const users = await db.user.findMany({
      where: { agentId, deletedAt: null },
      select: USER_SELECT,
      orderBy: { id: 'asc' },
    });
    const live = await db.userCredentialToken.findMany({
      where: {
        userId: { in: users.map((u) => u.id) },
        purpose: 'INVITE',
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { userId: true },
    });
    const pending = new Set(live.map((t) => t.userId.toString()));

    // The contact is matched by address rather than stored as a foreign key:
    // a PIC may be deleted or re-added, and the login must outlive that.
    const contacts = await db.agentPic.findMany({
      where: { agentId, deletedAt: null },
      select: { name: true, email: true },
    });
    const byEmail = new Map(
      contacts.filter((c) => c.email !== null).map((c) => [c.email!.toLowerCase(), c.name]),
    );

    return users.map((u) =>
      toDto(u, {
        contactName: byEmail.get(u.email.toLowerCase()) ?? null,
        invitePending: pending.has(u.id.toString()),
      }),
    );
  });

  const payload: ApiSuccess<PortalUserDto[]> = { success: true, data: rows };
  res.json(payload);
});

/**
 * POST /api/tenant/crm/agents/:id/portal-users
 *
 * Creates a dormant account for one of the agent's contacts and emails them a
 * link to set their own password. The forwarder never chooses it: a password
 * your staff typed is a password your staff knows.
 */
portalUserRouter.post('/:id/portal-users', async (req, res) => {
  const auth = req.auth!;
  const agentId = parseId(req.params.id, 'agent');
  const input = portalInviteSchema.parse(req.body);
  const agentPicId = BigInt(input.agentPicId);

  const created = await withTenant(auth.tenantId, async (db) => {
    const agent = await findAgent(db, agentId);

    const contact = await db.agentPic.findFirst({
      where: { id: agentPicId, agentId, deletedAt: null },
      select: { id: true, name: true, email: true },
    });
    if (contact === null) throw HttpError.notFound('That contact no longer exists.');
    if (contact.email === null || contact.email.trim() === '') {
      throw new HttpError(
        400,
        'CONTACT_HAS_NO_EMAIL',
        `${contact.name} has no email address. Add one to the contact first.`,
      );
    }

    const email = contact.email.trim().toLowerCase();
    const username = normalizeUsername(email);

    const existing = await db.user.findFirst({
      where: { OR: [{ username }, { email }], deletedAt: null },
      select: { id: true, agentId: true },
    });
    if (existing !== null) {
      throw HttpError.conflict(
        existing.agentId === null
          ? 'That address already belongs to a staff account.'
          : 'That contact already has portal access.',
      );
    }

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'user', CODE_PREFIX.user, auth.tenantId);
      try {
        const user = await db.user.create({
          data: {
            tenantId: auth.tenantId,
            code,
            agentId,
            username,
            email,
            // A placeholder nobody holds. The column is NOT NULL and the real
            // password is set by the agent when they accept; hashing random
            // bytes means there is no interim value anyone could guess or reuse.
            passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
            // Dormant until the invite is accepted.
            isActive: false,
            // employeeId, roleId and isSuperadmin are all left at their
            // defaults — the CHECK constraint would refuse the row otherwise.
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: USER_SELECT,
        });

        const credential = await issueCredentialToken(db, {
          tenantId: auth.tenantId,
          userId: user.id,
          purpose: 'INVITE',
          issuedBy: auth.userId,
        });

        const forwarder = await db.tenant.findFirst({
          where: { id: auth.tenantId },
          select: { name: true },
        });

        return {
          user,
          contactName: contact.name,
          credential,
          agentName: agent.name,
          forwarderName: forwarder?.name ?? 'Your forwarder',
        };
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a user code.');
  });

  await recordAudit({
    tenantId: auth.tenantId,
    action: 'INVITE_ISSUED',
    tableName: 'user',
    recordId: created.user.id,
    actorId: auth.userId,
    // The address is recorded; the link never is.
    details: { email: created.user.email, agentId: agentId.toString() },
  });

  // After the transaction, and never fails it — an unreachable mail server must
  // not roll back an account that was created correctly. The superadmin can
  // resend.
  await sendInviteMail({
    to: created.user.email,
    agentName: created.agentName,
    forwarderName: created.forwarderName,
    token: created.credential.token,
    expiresAt: created.credential.expiresAt,
  });

  const payload: ApiSuccess<PortalUserDto> = {
    success: true,
    data: toDto(created.user, { contactName: created.contactName, invitePending: true }),
  };
  res.status(201).json(payload);
});

/** POST /api/tenant/crm/agents/:id/portal-users/:userId/reinvite */
portalUserRouter.post('/:id/portal-users/:userId/reinvite', async (req, res) => {
  const auth = req.auth!;
  const agentId = parseId(req.params.id, 'agent');
  const userId = parseId(req.params.userId, 'user');

  const reissued = await withTenant(auth.tenantId, async (db) => {
    const agent = await findAgent(db, agentId);
    const user = await db.user.findFirst({
      where: { id: userId, agentId, deletedAt: null },
      select: { id: true, email: true },
    });
    if (user === null) throw HttpError.notFound('That portal user no longer exists.');

    // Supersedes any live invite, so an older link stops working.
    const credential = await issueCredentialToken(db, {
      tenantId: auth.tenantId,
      userId: user.id,
      purpose: 'INVITE',
      issuedBy: auth.userId,
    });
    const forwarder = await db.tenant.findFirst({
      where: { id: auth.tenantId },
      select: { name: true },
    });
    return {
      user,
      credential,
      agentName: agent.name,
      forwarderName: forwarder?.name ?? 'Your forwarder',
    };
  });

  await recordAudit({
    tenantId: auth.tenantId,
    action: 'INVITE_ISSUED',
    tableName: 'user',
    recordId: reissued.user.id,
    actorId: auth.userId,
    details: { email: reissued.user.email, agentId: agentId.toString(), resent: true },
  });

  await sendInviteMail({
    to: reissued.user.email,
    agentName: reissued.agentName,
    forwarderName: reissued.forwarderName,
    token: reissued.credential.token,
    expiresAt: reissued.credential.expiresAt,
  });

  const payload: ApiSuccess<{ resent: true }> = { success: true, data: { resent: true } };
  res.json(payload);
});

/** POST /api/tenant/crm/agents/:id/portal-users/:userId/toggle-status */
portalUserRouter.post('/:id/portal-users/:userId/toggle-status', async (req, res) => {
  const auth = req.auth!;
  const agentId = parseId(req.params.id, 'agent');
  const userId = parseId(req.params.userId, 'user');

  const updated = await withTenant(auth.tenantId, async (db) => {
    const user = await db.user.findFirst({
      where: { id: userId, agentId, deletedAt: null },
      select: { id: true, isActive: true, tokenVersion: true },
    });
    if (user === null) throw HttpError.notFound('That portal user no longer exists.');

    return db.user.update({
      where: { id: user.id },
      data: {
        isActive: !user.isActive,
        // Cutting access has to take effect now, not in fifteen minutes when
        // the access token happens to expire.
        tokenVersion: user.tokenVersion + 1,
        updatedBy: auth.userId,
      },
      select: USER_SELECT,
    });
  });

  const payload: ApiSuccess<PortalUserDto> = {
    success: true,
    data: toDto(updated, { contactName: null, invitePending: false }),
  };
  res.json(payload);
});
