import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';
import { hashPassword } from '../lib/password';
import { resetAllLimits } from '../lib/rate-limit';

/**
 * Phase 2 of the agent portal: the two doors.
 *
 * The thing being proved here is not "an agent can log in". It is that a
 * credential only works at the door it was issued for, that the session's agent
 * identity comes from the database rather than the token, and that the invite
 * that creates an external account never hands anyone at the forwarder the
 * agent's password.
 */

// Mail is captured rather than sent. The invite link only exists in the email —
// that is the design — so this is also how the test gets hold of it, exactly as
// an agent would.
const sent: { to: string[]; subject: string; text: string }[] = [];
vi.mock('../lib/mailer', () => ({
  sendMail: (mail: { to: string[]; subject: string; text: string }) => {
    sent.push(mail);
    return Promise.resolve({ sent: true });
  },
  parseAddressList: (raw: string | null | undefined) =>
    raw == null ? [] : raw.split(/[,;\n]/).map((a) => a.trim()).filter((a) => a !== ''),
}));

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'ptl-alpha';
const PASSWORD = 'Correct-Horse-Battery';

let tenantId: bigint;
let agentId: bigint;
let otherAgentId: bigint;
let picId: bigint;
let picNoEmailId: bigint;
let superadminId: bigint;
let superToken: string;
let staffToken: string;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of ['user_credential_token', 'agent_quote', '"user"', 'agent_pic', 'agent']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

/** The most recent invite or reset link, taken out of the email body. */
function linkToken(): string {
  const last = sent.at(-1);
  if (last === undefined) throw new Error('no mail was sent');
  const match = /token=([^\s&]+)/.exec(last.text);
  if (match === null) throw new Error(`no token in mail: ${last.text}`);
  return decodeURIComponent(match[1]!);
}

function portalLogin(username: string, password: string) {
  return request(app)
    .post('/api/portal/auth/login')
    .set('X-Tenant-Slug', SLUG)
    .send({ username, password });
}

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'Portal Alpha Freight', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const [a, b] = await Promise.all([
    owner.agent.create({
      data: {
        tenantId,
        code: 'PTL-A',
        name: 'Nordic Forwarding',
        country: 'Denmark',
        agentType: 'GENERAL',
      },
      select: { id: true },
    }),
    owner.agent.create({
      data: {
        tenantId,
        code: 'PTL-B',
        name: 'Baltic Lines',
        country: 'Denmark',
        agentType: 'GENERAL',
      },
      select: { id: true },
    }),
  ]);
  agentId = a.id;
  otherAgentId = b.id;

  picId = (
    await owner.agentPic.create({
      data: {
        tenantId,
        code: 'PTL-PIC1',
        agentId,
        name: 'Mette Sorensen',
        email: 'mette@nordic.test',
      },
      select: { id: true },
    })
  ).id;
  picNoEmailId = (
    await owner.agentPic.create({
      data: { tenantId, code: 'PTL-PIC2', agentId, name: 'No Address' },
      select: { id: true },
    })
  ).id;

  const superadmin = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-ptl-super',
      username: 'ptl-super',
      email: 'super@ptl.test',
      passwordHash: await hashPassword(PASSWORD),
      isSuperadmin: true,
    },
    select: { id: true },
  });
  superadminId = superadmin.id;
  const staff = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-ptl-staff',
      username: 'ptl-staff',
      email: 'staff@ptl.test',
      passwordHash: await hashPassword(PASSWORD),
    },
    select: { id: true },
  });

  superToken = await signAccessToken({
    sub: superadminId.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  staffToken = await signAccessToken({
    sub: staff.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: [],
    tokenVersion: 0,
  });
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

beforeEach(() => {
  resetAllLimits();
});

describe('inviting an agent contact', () => {
  it('refuses anyone who is not a superadmin', async () => {
    await request(app)
      .post(`/api/tenant/crm/agents/${agentId}/portal-users`)
      .set('Authorization', `Bearer ${staffToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ agentPicId: picId.toString() })
      .expect(403);
  });

  it('refuses a contact with no email address', async () => {
    const res = await request(app)
      .post(`/api/tenant/crm/agents/${agentId}/portal-users`)
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ agentPicId: picNoEmailId.toString() })
      .expect(400);
    expect(res.body.error.code).toBe('CONTACT_HAS_NO_EMAIL');
  });

  it('creates a dormant account and emails a link', async () => {
    sent.length = 0;
    const res = await request(app)
      .post(`/api/tenant/crm/agents/${agentId}/portal-users`)
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ agentPicId: picId.toString() })
      .expect(201);

    expect(res.body.data.username).toBe('mette@nordic.test');
    // Dormant: the account exists but cannot be signed into yet.
    expect(res.body.data.isActive).toBe(false);
    expect(res.body.data.invitePending).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(['mette@nordic.test']);
    expect(sent[0]?.text).toContain('/portal/accept-invite?token=');
  });

  it('never stores the link it sent', async () => {
    const token = linkToken();
    const rows = await owner.userCredentialToken.findMany({
      where: { tenantId, purpose: 'INVITE' },
      select: { tokenHash: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // A salted argon2 hash, not the token and not a hash anyone can reverse
      // by hashing a guess without the salt.
      expect(row.tokenHash).not.toContain(token);
      expect(row.tokenHash.startsWith('$argon2id$')).toBe(true);
    }
  });

  it('cannot sign in until the invite is accepted', async () => {
    await portalLogin('mette@nordic.test', PASSWORD).expect(401);
  });

  it('refuses a second invite for the same contact', async () => {
    await request(app)
      .post(`/api/tenant/crm/agents/${agentId}/portal-users`)
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Tenant-Slug', SLUG)
      .send({ agentPicId: picId.toString() })
      .expect(409);
  });

  it('lets the agent set their own password', async () => {
    const token = linkToken();
    await request(app)
      .post('/api/portal/auth/accept-invite')
      .set('X-Tenant-Slug', SLUG)
      .send({ token, password: PASSWORD })
      .expect(200);

    const user = await owner.user.findFirstOrThrow({
      where: { tenantId, username: 'mette@nordic.test' },
      select: { isActive: true, agentId: true, isSuperadmin: true, roleId: true },
    });
    expect(user.isActive).toBe(true);
    expect(user.agentId).toBe(agentId);
    // The CHECK guarantees this, but an invite path that quietly set either
    // would be caught here rather than in a security review.
    expect(user.isSuperadmin).toBe(false);
    expect(user.roleId).toBeNull();
  });

  it('will not accept the same invite twice', async () => {
    const token = linkToken();
    const res = await request(app)
      .post('/api/portal/auth/accept-invite')
      .set('X-Tenant-Slug', SLUG)
      .send({ token, password: 'Another-Password-Entirely' })
      .expect(400);
    expect(res.body.error.code).toBe('INVITE_INVALID');
  });

  it('refuses a link with the right shape and the wrong secret', async () => {
    const token = linkToken();
    const forged = `${token.split('.')[0]}.${'A'.repeat(43)}`;
    await request(app)
      .post('/api/portal/auth/accept-invite')
      .set('X-Tenant-Slug', SLUG)
      .send({ token: forged, password: PASSWORD })
      .expect(400);
  });
});

describe('the two doors are separate', () => {
  it('signs the agent in at the portal', async () => {
    const res = await portalLogin('mette@nordic.test', PASSWORD).expect(200);
    expect(res.body.data.user.agentId).toBe(agentId.toString());
    expect(res.body.data.user.agentName).toBe('Nordic Forwarding');
    // No permission list and no superadmin flag: an agent holds neither, and a
    // response that carried them would invite code that reads them.
    expect(res.body.data.user.permissions).toBeUndefined();
    expect(res.body.data.user.isSuperadmin).toBeUndefined();
  });

  it('sets a portal cookie, not the staff one', async () => {
    const res = await portalLogin('mette@nordic.test', PASSWORD).expect(200);
    const raw = res.get('set-cookie');
    const cookies: string[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const portal = cookies.find((c) => c.startsWith('ff_portal_refresh='));
    expect(portal).toBeDefined();
    expect(portal).toContain('Path=/api/portal/auth');
    expect(portal).toContain('HttpOnly');
    expect(cookies.some((c) => c.startsWith('ff_refresh='))).toBe(false);
  });

  it('refuses the agent at the staff login', async () => {
    // Not "rejected after a check" — the staff query cannot return an agent row.
    await request(app)
      .post('/api/tenant/auth/login')
      .set('X-Tenant-Slug', SLUG)
      .send({ username: 'mette@nordic.test', password: PASSWORD })
      .expect(401);
  });

  it('refuses staff at the portal login', async () => {
    await portalLogin('ptl-staff', PASSWORD).expect(401);
  });

  it('refuses an agent token at a staff route', async () => {
    const login = await portalLogin('mette@nordic.test', PASSWORD).expect(200);
    const agentToken: string = login.body.data.accessToken;

    for (const path of [
      '/api/tenant/setting/ports',
      '/api/tenant/crm/agents',
      '/api/tenant/sales/inquiries',
      '/api/tenant/purchase/rates',
      '/api/tenant/admin/roles',
    ]) {
      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${agentToken}`)
        .set('X-Tenant-Slug', SLUG);
      expect(res.status, path).toBe(403);
    }
  });

  it('refuses a staff token at a portal route', async () => {
    await request(app)
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(403);
  });
});

describe('the session agent comes from the database', () => {
  it('rejects a token that names a different agent', async () => {
    const user = await owner.user.findFirstOrThrow({
      where: { tenantId, username: 'mette@nordic.test' },
      select: { id: true, tokenVersion: true },
    });
    // Correctly signed by the server's own key — this is not a forged
    // signature, it is a valid token with a claim that disagrees with the row.
    const impersonating = await signAccessToken({
      sub: user.id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      permissions: [],
      tokenVersion: user.tokenVersion,
      agentId: otherAgentId.toString(),
    });

    await request(app)
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${impersonating}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(401);
  });

  it('rejects an agent token that claims to be staff', async () => {
    const user = await owner.user.findFirstOrThrow({
      where: { tenantId, username: 'mette@nordic.test' },
      select: { id: true, tokenVersion: true },
    });
    const pretending = await signAccessToken({
      sub: user.id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: true,
      permissions: [],
      tokenVersion: user.tokenVersion,
      agentId: null,
    });

    // The claim says staff-and-superadmin; the row says agent. Dropping the
    // claim is not a way to become staff.
    await request(app)
      .get('/api/tenant/setting/ports')
      .set('Authorization', `Bearer ${pretending}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(401);
  });

  it('reports the agent through /me', async () => {
    const login = await portalLogin('mette@nordic.test', PASSWORD).expect(200);
    const res = await request(app)
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);
    expect(res.body.data.agentId).toBe(agentId.toString());
  });
});

describe('losing access', () => {
  it('cuts the session the moment the account is switched off', async () => {
    const login = await portalLogin('mette@nordic.test', PASSWORD).expect(200);
    const token: string = login.body.data.accessToken;
    await request(app)
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);

    const user = await owner.user.findFirstOrThrow({
      where: { tenantId, username: 'mette@nordic.test' },
      select: { id: true },
    });
    await request(app)
      .post(`/api/tenant/crm/agents/${agentId}/portal-users/${user.id}/toggle-status`)
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);

    // Not in fifteen minutes when the access token would have expired anyway.
    await request(app)
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(401);

    await request(app)
      .post(`/api/tenant/crm/agents/${agentId}/portal-users/${user.id}/toggle-status`)
      .set('Authorization', `Bearer ${superToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(200);
  });

  it('takes the login down with the agent company', async () => {
    await owner.agent.update({ where: { id: agentId }, data: { isActive: false } });
    await portalLogin('mette@nordic.test', PASSWORD).expect(401);
    await owner.agent.update({ where: { id: agentId }, data: { isActive: true } });
    await portalLogin('mette@nordic.test', PASSWORD).expect(200);
  });
});

describe('resetting a forgotten password', () => {
  it('answers the same for an address that does not exist', async () => {
    sent.length = 0;
    await request(app)
      .post('/api/portal/auth/request-reset')
      .set('X-Tenant-Slug', SLUG)
      .send({ email: 'nobody@nowhere.test' })
      .expect(200);
    // Who a forwarder works with is commercially sensitive quite apart from
    // being an enumeration hole, so the response cannot differ — and no mail
    // goes anywhere.
    expect(sent).toHaveLength(0);
  });

  it('sends a link for an address that does', async () => {
    sent.length = 0;
    await request(app)
      .post('/api/portal/auth/request-reset')
      .set('X-Tenant-Slug', SLUG)
      .send({ email: 'mette@nordic.test' })
      .expect(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('/portal/reset?token=');
  });

  it('changes the password and ends every open session', async () => {
    const before = await portalLogin('mette@nordic.test', PASSWORD).expect(200);
    const oldToken: string = before.body.data.accessToken;

    await request(app)
      .post('/api/portal/auth/complete-reset')
      .set('X-Tenant-Slug', SLUG)
      .send({ token: linkToken(), password: 'A-Brand-New-Password' })
      .expect(200);

    // Whoever had the old password no longer does — including any session they
    // already had open.
    await request(app)
      .get('/api/portal/auth/me')
      .set('Authorization', `Bearer ${oldToken}`)
      .set('X-Tenant-Slug', SLUG)
      .expect(401);

    await portalLogin('mette@nordic.test', PASSWORD).expect(401);
    await portalLogin('mette@nordic.test', 'A-Brand-New-Password').expect(200);
  });

  it('will not reuse the reset link', async () => {
    const res = await request(app)
      .post('/api/portal/auth/complete-reset')
      .set('X-Tenant-Slug', SLUG)
      .send({ token: linkToken(), password: 'Yet-Another-Password' })
      .expect(400);
    expect(res.body.error.code).toBe('RESET_INVALID');
  });

  it('cancels the previous link when a second is asked for', async () => {
    sent.length = 0;
    await request(app)
      .post('/api/portal/auth/request-reset')
      .set('X-Tenant-Slug', SLUG)
      .send({ email: 'mette@nordic.test' })
      .expect(200);
    const first = linkToken();

    resetAllLimits();
    await request(app)
      .post('/api/portal/auth/request-reset')
      .set('X-Tenant-Slug', SLUG)
      .send({ email: 'mette@nordic.test' })
      .expect(200);
    const second = linkToken();
    expect(second).not.toBe(first);

    // The older link is what an attacker would have if they intercepted the
    // first mail; asking again is how the real owner takes it away.
    await request(app)
      .post('/api/portal/auth/complete-reset')
      .set('X-Tenant-Slug', SLUG)
      .send({ token: first, password: 'Should-Not-Work-At-All' })
      .expect(400);
    await request(app)
      .post('/api/portal/auth/complete-reset')
      .set('X-Tenant-Slug', SLUG)
      .send({ token: second, password: PASSWORD })
      .expect(200);
  });
});

describe('the public door is rate limited', () => {
  it('locks out after repeated failures, then lets the real password through', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await portalLogin('mette@nordic.test', `wrong-${attempt}`).expect(401);
    }

    // Now locked: even the correct password is refused, so a botnet grinding
    // through a wordlist does not get a hit the moment it guesses right.
    const locked = await portalLogin('mette@nordic.test', PASSWORD).expect(401);
    expect(locked.body.error.message).toContain('Too many attempts');

    resetAllLimits();
    await portalLogin('mette@nordic.test', PASSWORD).expect(200);
  });

  it('records the failures it refused', async () => {
    const rows = await owner.auditLog.findMany({
      where: { tenantId, action: 'LOGIN_FAILURE' },
      select: { newValues: true },
    });
    const reasons = rows.map((r) => (r.newValues as Record<string, unknown>)['reason']);
    expect(reasons).toContain('bad-password');
    expect(reasons).toContain('rate-limited');
    // The attempted passwords are never kept, under any key.
    expect(JSON.stringify(rows)).not.toContain('wrong-0');
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });
});
