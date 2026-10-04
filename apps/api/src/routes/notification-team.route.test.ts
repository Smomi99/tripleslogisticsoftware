import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Settings → Notification → Teams, through HTTP — DESIGN-UPDATE-2026-10-04 §7.
 * Two workspaces, so what one saves is also checked to be invisible to the
 * other (CLAUDE.md §7A rule 4).
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'teams-alpha';
const SLUG_B = 'teams-beta';

interface World {
  slug: string;
  editorToken: string;
  viewerToken: string;
}
let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of ['notification_team_setting', 'notification_setting', 'user']) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string): Promise<World> {
  const { id: tenantId } = await owner.tenant.create({ data: { name, slug, country: 'Bangladesh' }, select: { id: true } });
  const token = async (code: string, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: { tenantId, code, username: `${code.toLowerCase()}-${slug}`, email: `${code.toLowerCase()}@${slug}.test`, passwordHash: 'x' },
      select: { id: true },
    });
    return signAccessToken({ sub: id.toString(), tenantId: tenantId.toString(), isSuperadmin: false, permissions, tokenVersion: 0 });
  };
  return {
    slug,
    editorToken: await token(`USR-E${tag}`, ['SETTING.NOTIFICATION.VIEW', 'SETTING.NOTIFICATION.EDIT']),
    viewerToken: await token(`USR-V${tag}`, ['SETTING.NOTIFICATION.VIEW']),
  };
}

function api(token: string, slug: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', slug);
  return {
    get: () => wrap(request(app).get('/api/tenant/setting/notifications/teams')),
    put: (body: unknown) => wrap(request(app).put('/api/tenant/setting/notifications/teams')).send(body as object),
  };
}

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Teams Alpha', SLUG_A, 'TA');
  B = await makeWorld('Teams Beta', SLUG_B, 'TB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('Notification teams', () => {
  it('offers all five teams blank before anything is saved', async () => {
    const res = await api(A.viewerToken, A.slug).get();
    expect(res.status).toBe(200);
    expect(res.body.data.sendAsTeam).toBe(false);
    expect(res.body.data.teams.map((t: { team: string }) => t.team)).toEqual(['PRICE', 'CS_DOC', 'OPS', 'ACCOUNTS', 'SALES']);
    expect(res.body.data.teams.every((t: { senderEmail: string }) => t.senderEmail === '')).toBe(true);
  });

  it('saves a team, keeps blanks as not set, and refuses an address that is not one', async () => {
    const saved = await api(A.editorToken, A.slug).put({
      sendAsTeam: true,
      teams: [{ team: 'ACCOUNTS', senderEmail: 'accounts@example.test', replyTo: '', signature: 'Accounts desk' }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.sendAsTeam).toBe(true);
    const accounts = saved.body.data.teams.find((t: { team: string }) => t.team === 'ACCOUNTS');
    expect(accounts).toEqual({ team: 'ACCOUNTS', senderEmail: 'accounts@example.test', replyTo: '', signature: 'Accounts desk' });
    const row = await owner.notificationTeamSetting.findFirstOrThrow({ where: { team: 'ACCOUNTS', tenant: { slug: SLUG_A } } });
    expect(row.replyTo).toBeNull();

    const bad = await api(A.editorToken, A.slug).put({
      sendAsTeam: false,
      teams: [{ team: 'SALES', senderEmail: 'not an address', replyTo: '', signature: '' }],
    });
    expect(bad.status).toBe(400);
  });

  it('lets a viewer read but not change, and keeps each workspace to itself', async () => {
    const denied = await api(A.viewerToken, A.slug).put({ sendAsTeam: false, teams: [] });
    expect(denied.status).toBe(403);

    const other = await api(B.editorToken, B.slug).get();
    expect(other.body.data.sendAsTeam).toBe(false);
    expect(other.body.data.teams.every((t: { senderEmail: string }) => t.senderEmail === '')).toBe(true);
  });
});
