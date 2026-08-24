import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The outbox: queue, drain, retry, and the tenant boundary around it.
 *
 * The module spec calls email infrastructure rather than a side effect, and
 * these are the properties that make that true. A message becomes a row before
 * anything is sent, so nothing about SMTP can delay or roll back the thing it
 * describes; a failure comes back rather than disappearing; and one workspace
 * can never see or send another's mail.
 *
 * SMTP is stubbed, and the stub is programmable — the interesting cases are the
 * failures, and a real server will not fail on request.
 */

let behaviour: 'ok' | 'fail' | 'unconfigured' = 'ok';
const sent: { to: string[]; subject: string; text: string; html?: string }[] = [];

vi.mock('./mailer', () => ({
  sendMail: (mail: { to: string[]; subject: string; text: string; html?: string }) => {
    if (behaviour === 'fail') return Promise.resolve({ sent: false, reason: 'failed' });
    if (behaviour === 'unconfigured') {
      return Promise.resolve({ sent: false, reason: 'not-configured' });
    }
    sent.push(mail);
    return Promise.resolve({ sent: true });
  },
  parseAddressList: (raw: string | null | undefined) =>
    raw == null ? [] : raw.split(/[,;\n]/).map((a) => a.trim()).filter((a) => a !== ''),
}));

const { drainOutbox, queueMail } = await import('./email-queue');
const { fill, render } = await import('./email-template');

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const SLUG_A = 'mail-alpha';
const SLUG_B = 'mail-beta';
let tenantA: bigint;
let tenantB: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of ['audit_log', 'email_log', 'email_template']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRawUnsafe(
    `DELETE FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}')`,
  );
}

beforeAll(async () => {
  await cleanup();
  const make = async (name: string, slug: string) =>
    (
      await owner.tenant.create({
        data: { name, slug, country: 'Bangladesh' },
        select: { id: true },
      })
    ).id;
  tenantA = await make('Mail Alpha', SLUG_A);
  tenantB = await make('Mail Beta', SLUG_B);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

beforeEach(async () => {
  behaviour = 'ok';
  sent.length = 0;
  // Each test starts from an empty outbox for these two workspaces; other
  // suites may have queued their own and the drain is global.
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  await owner.$executeRawUnsafe(`DELETE FROM email_log WHERE tenant_id IN ${scope}`);
});

/**
 * Drains until this workspace's outbox is settled.
 *
 * drainOutbox is deliberately global — one worker serves every tenant — and it
 * takes a bounded batch. Other suites queue real mail, so a single pass is not
 * guaranteed to reach the row a test just wrote. Looping until nothing of ours
 * is left QUEUED tests the worker rather than the batch size.
 */
async function drainMine(tenantId: bigint, passes = 12): Promise<void> {
  for (let i = 0; i < passes; i += 1) {
    const pending = await owner.emailLog.count({ where: { tenantId, status: 'QUEUED' } });
    if (pending === 0) return;
    const tally = await drainOutbox();
    if (tally.claimed === 0) return;
  }
}

/** Only this workspace's mail — the drain is global, other suites are noisy. */
const outbox = (tenantId: bigint) =>
  owner.emailLog.findMany({ where: { tenantId }, orderBy: { id: 'asc' } });

const queueOne = (tenantId: bigint, over: Record<string, unknown> = {}) =>
  queueMail({
    tenantId,
    templateKey: 'TEST_TEMPLATE',
    to: ['ops@example.test'],
    variables: { code: 'INQ-1' },
    relatedType: 'inquiry',
    relatedId: 42n,
    fallback: { subject: 'Fallback subject', bodyText: 'Fallback body' },
    ...over,
  });

describe('queueing', () => {
  it('writes a row and sends nothing', async () => {
    const result = await queueOne(tenantA);
    expect(result.queued).toBe(true);
    // The whole point: Save & Send returns at database speed, not SMTP speed.
    expect(sent).toHaveLength(0);

    const rows = await outbox(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('QUEUED');
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.sentAt).toBeNull();
    expect(rows[0]?.relatedType).toBe('inquiry');
    expect(rows[0]?.relatedId).toBe(42n);
  });

  it('refuses a message with nobody to send it to', async () => {
    const result = await queueOne(tenantA, { to: ['', '   '] });
    expect(result.queued).toBe(false);
    expect(result.reason).toBe('no-recipients');
    expect(await outbox(tenantA)).toHaveLength(0);
  });

  it('deduplicates recipients', async () => {
    await queueOne(tenantA, { to: ['a@x.test', 'a@x.test', ' a@x.test '] });
    const rows = await outbox(tenantA);
    expect(rows[0]?.toAddresses).toEqual(['a@x.test']);
  });

  it('falls back to the caller wording when no template exists', async () => {
    await queueOne(tenantA);
    const rows = await outbox(tenantA);
    // A missing template is a deployment fault, and it must not silence a
    // notification somebody is waiting on.
    expect(rows[0]?.subject).toBe('Fallback subject');
    expect(rows[0]?.bodyText).toBe('Fallback body');
  });

  it('renders the workspace template when there is one', async () => {
    await owner.emailTemplate.create({
      data: {
        tenantId: tenantA,
        code: 'EMT-T1',
        key: 'TEST_TEMPLATE',
        name: 'Test',
        subject: 'About {{code}}',
        bodyText: 'Inquiry {{code}} needs a price.',
      },
    });
    await queueOne(tenantA);
    const rows = await outbox(tenantA);
    expect(rows[0]?.subject).toBe('About INQ-1');
    expect(rows[0]?.bodyText).toBe('Inquiry INQ-1 needs a price.');

    await owner.emailTemplate.deleteMany({ where: { tenantId: tenantA } });
  });
});

describe('draining', () => {
  it('sends a queued message and records that it went', async () => {
    await queueOne(tenantA);
    await drainMine(tenantA);

    const rows = await outbox(tenantA);
    expect(rows[0]?.status).toBe('SENT');
    expect(rows[0]?.sentAt).not.toBeNull();
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.lockedAt).toBeNull();
    expect(sent.map((m) => m.subject)).toContain('Fallback subject');
  });

  it('does not send the same message twice', async () => {
    await queueOne(tenantA);
    await drainMine(tenantA);
    sent.length = 0;
    await drainMine(tenantA);
    expect(sent).toHaveLength(0);
  });

  it('keeps a failed message and backs off rather than losing it', async () => {
    await queueOne(tenantA);
    behaviour = 'fail';
    await drainMine(tenantA);

    const rows = await outbox(tenantA);
    expect(rows[0]?.status).toBe('QUEUED');
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.error).toContain('attempt 1');
    // Not due again immediately, which is what makes it a backoff.
    expect(rows[0]?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it('gives up only after the last attempt, and says so', async () => {
    await queueOne(tenantA);
    behaviour = 'fail';
    const row = (await outbox(tenantA))[0]!;
    // Walk it to the edge rather than waiting out five real backoffs.
    await owner.emailLog.update({
      where: { id: row.id },
      data: { attempts: row.maxAttempts - 1 },
    });
    await drainMine(tenantA);

    const after = (await outbox(tenantA))[0]!;
    expect(after.attempts).toBe(after.maxAttempts);
    expect(after.status).toBe('FAILED');
    expect(after.sentAt).toBeNull();
  });

  it('does not burn attempts when SMTP is simply not configured', async () => {
    // A developer machine has no mail server and never will. Spending five
    // retries to discover that fills the log and marks real messages FAILED.
    await queueOne(tenantA);
    behaviour = 'unconfigured';
    await drainMine(tenantA);

    const rows = await outbox(tenantA);
    expect(rows[0]?.status).toBe('QUEUED');
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.error).toContain('not configured');
  });
});

describe('the tenant boundary', () => {
  it('drains both workspaces without mixing them up', async () => {
    await queueOne(tenantA, { to: ['alpha@x.test'] });
    await queueOne(tenantB, { to: ['beta@x.test'] });
    await drainMine(tenantA);
    await drainMine(tenantB);

    const a = await outbox(tenantA);
    const b = await outbox(tenantB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.toAddresses).toEqual(['alpha@x.test']);
    expect(b[0]?.toAddresses).toEqual(['beta@x.test']);
    expect(a[0]?.status).toBe('SENT');
    expect(b[0]?.status).toBe('SENT');
  });

  it('hides one workspace outbox from another', async () => {
    await queueOne(tenantA, { to: ['alpha@x.test'] });
    await queueOne(tenantB, { to: ['beta@x.test'] });

    const { withTenant } = await import('./tenant-client');
    const seenByA = await withTenant(tenantA, (db) =>
      db.emailLog.findMany({ select: { toAddresses: true } }),
    );
    // An outbox names customers and carries prices. It is not shared.
    expect(seenByA.flatMap((r) => r.toAddresses)).toEqual(['alpha@x.test']);
  });
});

describe('template rendering', () => {
  it('substitutes with or without spaces in the braces', () => {
    expect(fill('Hi {{name}} and {{ name }}', { name: 'Nordic' }).text).toBe(
      'Hi Nordic and Nordic',
    );
  });

  it('leaves nothing behind for a value it was not given', () => {
    // "ETA {{eta}}" on a customer's screen says we send machine mail badly.
    // "ETA" says nothing, which is the better failure.
    const result = fill('ETA {{eta}}', {});
    expect(result.text).toBe('ETA ');
    expect(result.missing).toEqual(['eta']);
  });

  it('renders subject, text and html together', () => {
    const out = render(
      {
        key: 'X',
        subject: '  {{code}} ready  ',
        bodyText: 'Text {{code}}',
        bodyHtml: '<p>Html {{code}}</p>',
      },
      { code: 'Q-1' },
    );
    expect(out.subject).toBe('Q-1 ready');
    expect(out.bodyText).toBe('Text Q-1');
    expect(out.bodyHtml).toBe('<p>Html Q-1</p>');
  });
});
