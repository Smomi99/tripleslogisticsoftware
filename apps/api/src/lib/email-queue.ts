import { logger } from './logger';
import { render, resolveTemplate } from './email-template';
import {
  loadSignatureLogos,
  OUTWARD_TEMPLATES,
  renderSignedHtml,
  type SignatureLogo,
} from './mail-signature';
import { parseAddressList, sendMail } from './mailer';
import { prisma } from './prisma';
import { withTenant } from './tenant-client';

/**
 * The outbox.
 *
 * Every message becomes a row before anything is sent, and a worker drains the
 * rows on a timer. Three things follow from that, and all three are the reason
 * the module spec calls email infrastructure rather than a side effect:
 *
 *   * Save & Send returns as fast as the database, not as fast as SMTP.
 *   * A failed send retries with backoff instead of vanishing.
 *   * "Did the customer get it?" has an answer, on the record.
 *
 * The queue is Postgres rather than Redis. The columns the spec asks for —
 * status, attempts, error, sent_at — already describe a queue row, and adding a
 * second service for a few messages per inquiry is a cost two people would go
 * on paying for years.
 */

/** How many messages one pass takes. Small: SMTP is the slow part, not the query. */
const BATCH_SIZE = 10;

/** A message held longer than this is assumed abandoned and reclaimed. */
const STALE_LOCK = '5 minutes';

/** Between passes. Mail is not interactive; a few seconds of latency is free. */
const TICK_MS = 5_000;

/** 1 min, 5, 25, 2h, 10h — long enough to outlast most outages. */
const BACKOFF_MINUTES = [1, 5, 25, 120, 600];

export interface QueueMailInput {
  tenantId: bigint;
  templateKey: string;
  to: string[];
  cc?: string[];
  /**
   * Blind copies for this message alone. The workspace's standing BCC is added
   * on top of these, so a caller never has to remember it.
   */
  bcc?: string[];
  /** Substituted into the template. */
  variables: Record<string, string | number | null | undefined>;
  /** What the message is about, for the record it will appear on. */
  relatedType?: string;
  relatedId?: bigint;
  /** Used when no template row exists — see resolveTemplate. */
  fallback: { subject: string; bodyText: string };
  actorId?: bigint | null;
}

export interface QueueMailResult {
  queued: boolean;
  id?: bigint;
  reason?: 'no-recipients';
}

/**
 * Writes a message to the outbox. Does not send it.
 *
 * Returns rather than throws, and every caller is something that has already
 * succeeded. An inquiry that saved correctly must not report an error because
 * its notification could not be composed.
 */
export async function queueMail(input: QueueMailInput): Promise<QueueMailResult> {
  const to = [...new Set(input.to.map((a) => a.trim()).filter((a) => a !== ''))];
  if (to.length === 0) {
    logger.info(
      { templateKey: input.templateKey },
      'mail not queued: no recipients',
    );
    return { queued: false, reason: 'no-recipients' };
  }
  const cc = [...new Set((input.cc ?? []).map((a) => a.trim()).filter((a) => a !== ''))];

  // Reading the template and writing the row share one transaction: both are
  // tenant-scoped, and the read is meaningless without a tenant in scope.
  const { row, usedTemplate } = await withTenant(input.tenantId, async (db) => {
    const template = await resolveTemplate(db, input.templateKey);

    /*
     * The workspace's standing blind copy, resolved here rather than at send
     * time so the outbox row records who the message actually went to. That
     * record is half the point of the feature: "did it send" is answered by
     * looking at what was sent, not by trusting that a setting was read later.
     *
     * Anyone already on To or Cc is dropped — a second copy of the same message
     * is noise, and to a recipient it looks like a mistake.
     */
    const setting = await db.notificationSetting.findFirst({
      select: { bccAddresses: true },
    });
    const visible = new Set([...to, ...cc].map((a) => a.toLowerCase()));
    const bcc = [
      ...new Set(
        [...(input.bcc ?? []), ...parseAddressList(setting?.bccAddresses ?? '')]
          .map((a) => a.trim())
          .filter((a) => a !== '' && !visible.has(a.toLowerCase())),
      ),
    ];
    const rendered =
      template === null
        ? { subject: input.fallback.subject, bodyText: input.fallback.bodyText, bodyHtml: null }
        : render(template, input.variables);

    const created = await db.emailLog.create({
      data: {
        tenantId: input.tenantId,
        templateKey: input.templateKey,
        toAddresses: to,
        ccAddresses: cc,
        bccAddresses: bcc,
        subject: rendered.subject,
        bodyText: rendered.bodyText,
        bodyHtml: rendered.bodyHtml,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        createdBy: input.actorId ?? null,
        updatedBy: input.actorId ?? null,
      },
      select: { id: true },
    });
    return { row: created, usedTemplate: template !== null };
  });

  if (!usedTemplate) {
    // A deployment fault, not a user error. The message still goes.
    logger.warn(
      { templateKey: input.templateKey, tenantId: input.tenantId.toString() },
      'no email template found; using the caller fallback',
    );
  }

  logger.info(
    { emailLogId: row.id.toString(), templateKey: input.templateKey, to: to.length },
    'mail queued',
  );
  return { queued: true, id: row.id };
}

interface ClaimedRow {
  id: bigint;
  tenant_id: bigint;
  template_key: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  subject: string;
  body_text: string;
  body_html: string | null;
  attempts: number;
  max_attempts: number;
}

/**
 * Takes the next due messages and marks them in flight.
 *
 * Goes through app_claim_email_batch, which is SECURITY DEFINER: the worker has
 * no session, so row level security hides every row in every workspace from it
 * — correctly, since hiding rows from sessionless callers is the whole job. The
 * function is the narrow way through and does one thing only.
 */
async function claim(batchSize: number): Promise<ClaimedRow[]> {
  return prisma.$queryRawUnsafe<ClaimedRow[]>(
    `SELECT * FROM app_claim_email_batch($1::int, $2::interval)`,
    batchSize,
    STALE_LOCK,
  );
}

function backoffFor(attempts: number): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] ?? 600;
  return new Date(Date.now() + minutes * 60_000);
}

/**
 * Sends one claimed message and records what happened.
 *
 * The update runs tenant-scoped, so the only privileged step in the whole
 * worker is the claim above.
 */
async function deliver(row: ClaimedRow): Promise<'sent' | 'retry' | 'failed'> {
  /*
   * The company's sign-off, resolved at send time rather than at queue time.
   *
   * A letter waiting in the outbox should go out under the letterhead the
   * company has now — if somebody replaced a logo an hour ago, the queued
   * message is not a reason to send the old one. Only the outward-facing
   * letters get it; an internal alert is a note between colleagues.
   */
  let logos: SignatureLogo[] = [];
  let html = row.body_html;
  if (OUTWARD_TEMPLATES.has(row.template_key)) {
    try {
      logos = await withTenant(row.tenant_id, (db) => loadSignatureLogos(db, row.tenant_id));
    } catch (error) {
      // A letterhead that cannot be read is not a reason to hold the letter.
      logger.warn({ err: error, emailLogId: row.id.toString() }, 'signature logos unavailable');
    }
    if (logos.length > 0 && html === null) {
      html = renderSignedHtml(row.body_text, logos);
    }
  }

  const result = await sendMail({
    to: row.to_addresses,
    subject: row.subject,
    text: row.body_text,
    ...(html === null ? {} : { html }),
    ...(logos.length > 0
      ? {
          inlineImages: logos.map((logo) => ({
            cid: logo.cid,
            content: logo.content,
            fileName: logo.fileName,
          })),
        }
      : {}),
    ...(row.cc_addresses.length > 0 ? { cc: row.cc_addresses } : {}),
    ...(row.bcc_addresses.length > 0 ? { bcc: row.bcc_addresses } : {}),
  });

  if (result.sent) {
    await withTenant(row.tenant_id, (db) =>
      db.emailLog.update({
        where: { id: row.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          error: null,
          lockedAt: null,
          // What actually went out, so the record and the recipient's copy
          // are the same document.
          ...(html === null ? {} : { bodyHtml: html }),
        },
      }),
    );
    return 'sent';
  }

  // Not configured is not a failure to retry against: a developer machine has
  // no SMTP server and never will, and burning five attempts to discover that
  // fills the log with noise. The message stays QUEUED and waits for a
  // deployment that can send it.
  if (result.reason === 'not-configured') {
    await withTenant(row.tenant_id, (db) =>
      db.emailLog.update({
        where: { id: row.id },
        data: {
          attempts: Math.max(0, row.attempts - 1),
          nextAttemptAt: new Date(Date.now() + 60_000),
          lockedAt: null,
          error: 'SMTP is not configured on this deployment.',
        },
      }),
    );
    return 'retry';
  }

  const exhausted = row.attempts >= row.max_attempts;
  await withTenant(row.tenant_id, (db) =>
    db.emailLog.update({
      where: { id: row.id },
      data: {
        status: exhausted ? 'FAILED' : 'QUEUED',
        error: `Delivery failed (attempt ${row.attempts} of ${row.max_attempts}).`,
        nextAttemptAt: exhausted ? new Date() : backoffFor(row.attempts),
        lockedAt: null,
      },
    }),
  );
  return exhausted ? 'failed' : 'retry';
}

/**
 * One pass of the outbox. Exported so a test can drive it without a timer.
 *
 * Never throws: a worker that dies on one bad row stops sending everything.
 */
export async function drainOutbox(batchSize = BATCH_SIZE): Promise<{
  claimed: number;
  sent: number;
  retry: number;
  failed: number;
}> {
  const tally = { claimed: 0, sent: 0, retry: 0, failed: 0 };
  let rows: ClaimedRow[];
  try {
    rows = await claim(batchSize);
  } catch (error) {
    logger.error({ err: error }, 'could not claim mail; will try again next tick');
    return tally;
  }

  tally.claimed = rows.length;
  for (const row of rows) {
    try {
      const outcome = await deliver(row);
      tally[outcome === 'sent' ? 'sent' : outcome === 'failed' ? 'failed' : 'retry'] += 1;
      if (outcome === 'failed') {
        logger.warn(
          { emailLogId: row.id.toString(), templateKey: row.template_key },
          'mail gave up after the last attempt',
        );
      }
    } catch (error) {
      // The row keeps its lock and is reclaimed once stale, so a crash here
      // costs minutes rather than the message.
      logger.error(
        { err: error, emailLogId: row.id.toString() },
        'mail delivery threw; the row will be reclaimed',
      );
    }
  }

  if (tally.claimed > 0) logger.info(tally, 'outbox pass');
  return tally;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the drain loop. Idempotent, so a double call cannot double-send. */
export function startMailWorker(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void drainOutbox();
  }, TICK_MS);
  // Does not hold the process open: a shutting-down API should shut down.
  timer.unref();
  logger.info({ everyMs: TICK_MS, batch: BATCH_SIZE }, 'mail worker started');
}

export function stopMailWorker(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
