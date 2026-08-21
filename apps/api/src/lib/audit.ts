import { AuditAction } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';
import { logger } from './logger';
import { prisma } from './prisma';

/**
 * Recording events that are not data changes.
 *
 * Writes to the same table the triggers use. Two mechanisms, because there are
 * two kinds of event:
 *
 *   * A row changed — the database records it itself (see the audit_triggers
 *     migration). Nothing in application code can forget to.
 *   * Something happened — a sign-in, a sign-out, an agent opening an inquiry.
 *     There is no row change to hang those on, so they are recorded here,
 *     explicitly, from the route that knows about them.
 *
 * Deliberately does not use withTenant. A failed sign-in has no session, and the
 * whole point of recording it is that it happens before anyone is authenticated
 * — but audit_log still carries RLS, so the insert would be refused with no
 * tenant in scope. This opens its own short transaction and sets app.tenant_id
 * from the tenant the subdomain already resolved to, which is a fact about the
 * request rather than a claim by the caller.
 */

export interface AuditEvent {
  tenantId: bigint;
  action: AuditAction;
  /** The table the event concerns; `user` for a sign-in. */
  tableName: string;
  /** Null when there is no row — a sign-in for a username that does not exist. */
  recordId?: bigint | null;
  /** Who acted. Null for an unauthenticated attempt, recorded as SYSTEM. */
  actorId?: bigint | null;
  /** Context worth keeping. NEVER credentials — see below. */
  details?: Record<string, unknown>;
}

/**
 * Keys that must never reach the trail, whatever a caller passes.
 *
 * An audit table holding password hashes and live invite tokens is a second
 * place to steal them from, and it is the one place nobody thinks to lock down.
 * The database trigger strips the same names from row snapshots; this is the
 * matching guard on the explicit path.
 */
const NEVER_RECORD = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'token',
  'tokenHash',
  'token_hash',
  'refreshToken',
  'accessToken',
  'secret',
]);

function safeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (details === undefined) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (NEVER_RECORD.has(key)) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length === 0 ? null : clean;
}

/**
 * Records one event, and never throws.
 *
 * An audit write must not fail the action it describes: refusing a sign-in
 * because the trail was unwritable would turn a logging fault into an outage.
 * A failure is logged loudly instead — that is itself the signal that something
 * is wrong with the trail.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${event.tenantId.toString()}, true)`;
      await tx.auditLog.create({
        data: {
          tenantId: event.tenantId,
          tableName: event.tableName,
          recordId: event.recordId ?? null,
          action: event.action,
          actorType: event.actorId == null ? 'SYSTEM' : 'USER',
          changedBy: event.actorId ?? null,
          newValues: (safeDetails(event.details) ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    });
  } catch (error) {
    logger.error(
      { err: error, action: event.action, table: event.tableName },
      'AUDIT WRITE FAILED — the event happened but was not recorded',
    );
  }
}
