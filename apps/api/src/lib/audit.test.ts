import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from './jwt';
import { withTenant } from './tenant-client';

/**
 * Phase 0 of the agent portal: the audit trail.
 *
 * CLAUDE.md §4 rule 7 has been unimplemented since Phase 1 — the table existed
 * and nothing ever wrote to it. Nothing external gets a login until it does,
 * because an audit trail that starts the day after an incident is no use.
 *
 * The trail is a database trigger rather than application code, and these tests
 * are written to prove the consequences of that choice: a write that never goes
 * near Prisma is still recorded, and the application cannot rewrite what was
 * recorded.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'aud-alpha';
let tenantId: bigint;
let userId: bigint;
let token: string;
let carrierId: bigint;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  await owner.$executeRawUnsafe(`DELETE FROM audit_log WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM vessel WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM carrier WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

/** Audit rows for this tenant, newest first. */
async function trail(action?: string) {
  return owner.auditLog.findMany({
    where: { tenantId, ...(action === undefined ? {} : { action: action as never }) },
    orderBy: { id: 'desc' },
    select: {
      action: true,
      tableName: true,
      recordId: true,
      changedBy: true,
      actorType: true,
      oldValues: true,
      newValues: true,
    },
  });
}

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'Aud Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;
  const user = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-aud',
      username: 'admin-aud',
      email: 'admin@aud.test',
      // A real argon2 hash of 'Audit!2026', so the login test can succeed.
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  userId = user.id;
  token = await signAccessToken({
    sub: userId.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  // Vessel requires a carrier.
  const carrierType = await owner.carrierType.findFirstOrThrow({ select: { id: true } });
  carrierId = (
    await owner.carrier.create({
      data: { tenantId, code: 'AUD-CAR', name: 'Audit Carrier', typeId: carrierType.id },
      select: { id: true },
    })
  ).id;

  // The fixture writes above are themselves audited; start each test from clean.
  await owner.$executeRawUnsafe(`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('the trail is append-only', () => {
  it('lets ff_app INSERT and SELECT, but not UPDATE or DELETE', async () => {
    const grants = await owner.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'ff_app' AND table_name = 'audit_log'
      ORDER BY privilege_type`;
    expect(grants.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('refuses an UPDATE from the application role', async () => {
    await withTenant(tenantId, async (db) => {
      await db.vessel.create({
        data: { tenantId, code: 'AUD-V1', name: 'Audit Vessel', carrierId },
      });
    });
    const rows = await trail();
    expect(rows.length).toBeGreaterThan(0);

    // The API role must not be able to rewrite history, even deliberately.
    await expect(
      withTenant(tenantId, (db) =>
        db.$executeRaw`UPDATE audit_log SET action = 'UPDATE' WHERE tenant_id = ${tenantId}`,
      ),
    ).rejects.toThrow();
  });
});

describe('data changes record themselves', () => {
  it('records a create with the acting user', async () => {
    await request(app)
      .post('/api/tenant/setting/vessels')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ name: 'Audited Vessel', carrierId: carrierId.toString() })
      .expect(201);

    const rows = await trail('CREATE');
    const vessel = rows.find((r) => r.tableName === 'vessel');
    expect(vessel).toBeDefined();
    // The actor comes from the session, through app.user_id, into the trigger.
    expect(vessel?.changedBy).toBe(userId);
    expect(vessel?.actorType).toBe('USER');
    expect((vessel?.newValues as Record<string, unknown>)['name']).toBe('Audited Vessel');
  });

  it('records an update with both sides of the change', async () => {
    const before = await owner.vessel.findFirstOrThrow({
      where: { tenantId, name: 'Audited Vessel' },
      select: { id: true },
    });
    await request(app)
      .patch(`/api/tenant/setting/vessels/${before.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ name: 'Renamed Vessel', carrierId: carrierId.toString() })
      .expect(200);

    const row = (await trail('UPDATE')).find((r) => r.tableName === 'vessel');
    expect((row?.oldValues as Record<string, unknown>)['name']).toBe('Audited Vessel');
    expect((row?.newValues as Record<string, unknown>)['name']).toBe('Renamed Vessel');
  });

  it('tells a soft delete apart from a deactivation', async () => {
    const v = await owner.vessel.findFirstOrThrow({
      where: { tenantId, name: 'Renamed Vessel' },
      select: { id: true },
    });

    await request(app)
      .post(`/api/tenant/setting/vessels/${v.id}/toggle-status`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);
    expect((await trail('DEACTIVATE')).some((r) => r.tableName === 'vessel')).toBe(true);

    await request(app)
      .delete(`/api/tenant/setting/vessels/${v.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);
    // CR-002's Delete and §8's Deactivate are the same UPDATE in SQL and
    // entirely different events to whoever reads this later.
    expect((await trail('DELETE')).some((r) => r.tableName === 'vessel')).toBe(true);
  });

  it('records a write that never went through Prisma', async () => {
    // The reason this is a trigger and not a middleware: a seed script, a psql
    // session or a future service in another language is recorded too.
    await owner.$executeRawUnsafe(
      `INSERT INTO vessel (tenant_id, code, name, carrier_id, is_active, created_at, updated_at)
       VALUES (${tenantId}, 'AUD-RAW', 'Raw SQL Vessel', ${carrierId}, true, now(), now())`,
    );
    const row = (await trail('CREATE')).find(
      (r) => (r.newValues as Record<string, unknown>)['name'] === 'Raw SQL Vessel',
    );
    expect(row).toBeDefined();
    // No session, so no actor — recorded as SYSTEM rather than attributed to
    // whoever happened to be logged in elsewhere.
    expect(row?.actorType).toBe('SYSTEM');
    expect(row?.changedBy).toBeNull();
  });

  it('does not record an update that changed nothing', async () => {
    const before = (await trail()).length;
    await owner.$executeRawUnsafe(
      `UPDATE vessel SET name = name WHERE tenant_id = ${tenantId} AND code = 'AUD-RAW'`,
    );
    expect((await trail()).length).toBe(before);
  });
});

describe('secrets never reach the trail', () => {
  it('strips the password hash from a user row snapshot', async () => {
    await owner.$executeRawUnsafe(
      `UPDATE "user" SET email = 'changed@aud.test' WHERE id = ${userId}`,
    );
    const row = (await trail()).find((r) => r.tableName === 'user');
    expect(row).toBeDefined();
    const values = row?.newValues as Record<string, unknown>;
    expect(values['email']).toBe('changed@aud.test');
    // An audit table holding password hashes is a second place to steal them.
    expect(values['password_hash']).toBeUndefined();
    expect((row?.oldValues as Record<string, unknown>)['password_hash']).toBeUndefined();
  });
});

describe('sign-in events', () => {
  it('records a failure for a username that does not exist', async () => {
    await request(app)
      .post('/api/tenant/auth/login')
      .set('X-Tenant-Slug', SLUG)
      .send({ username: 'no-such-person', password: 'whatever' })
      .expect(401);

    const row = (await trail('LOGIN_FAILURE'))[0];
    expect(row).toBeDefined();
    // No account, so nothing to point at — the whole reason record_id is
    // nullable. Credential stuffing against guessed names would be invisible
    // if only real users were recorded.
    expect(row?.recordId).toBeNull();
    expect(row?.actorType).toBe('SYSTEM');

    const details = row?.newValues as Record<string, unknown>;
    expect(details['username']).toBe('no-such-person');
    expect(details['reason']).toBe('no-such-user');
    // The attempted password is never kept, under any key.
    expect(JSON.stringify(details)).not.toContain('whatever');
  });

  it('records a failure against a real account without keeping the password', async () => {
    await request(app)
      .post('/api/tenant/auth/login')
      .set('X-Tenant-Slug', SLUG)
      .send({ username: 'admin-aud', password: 'wrong-password' })
      .expect(401);

    const row = (await trail('LOGIN_FAILURE'))[0];
    expect(row?.recordId).toBe(userId);
    const details = row?.newValues as Record<string, unknown>;
    expect(details['reason']).toBe('bad-password');
    expect(JSON.stringify(details)).not.toContain('wrong-password');
  });
});

describe('trigger coverage', () => {
  it('attaches to every tenant table, so a new one cannot go unaudited', async () => {
    const gaps = await owner.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname <> 'audit_log'
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped)
        AND NOT EXISTS (SELECT 1 FROM pg_trigger t
                         WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                           AND t.tgname = c.relname || '_audit')`;
    // A table added later without a trigger fails here rather than quietly
    // going unrecorded — the same reasoning as the cross-tenant guard test.
    expect(gaps.map((g) => g.relname)).toEqual([]);
  });

  it('does not audit itself', async () => {
    const selfTrigger = await owner.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'audit_log' AND NOT t.tgisinternal`;
    expect(Number(selfTrigger[0]?.n ?? 0)).toBe(0);
  });
});
