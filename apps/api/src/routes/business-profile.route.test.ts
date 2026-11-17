import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Settings → Business Settings, through HTTP (owner request, 2026-11-17).
 *
 * Two workspaces, so what one saves is also checked to be invisible to the
 * other (CLAUDE.md §7A rule 4), and the saved details are followed onto a
 * printed page through lib/letterhead.ts.
 */

const { createApp } = await import('../app');
const { env } = await import('../config/env');
const { PrismaClient } = await import('../generated/prisma/client');
const { signAccessToken } = await import('../lib/jwt');
const { withTenant } = await import('../lib/tenant-client');
const { letterheadOf, logoOf } = await import('../lib/letterhead');
const { renderDeliveryOrderPdf } = await import('../lib/delivery-order-pdf');
const { extractPdfText } = await import('../lib/pdf-text');

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
const app = createApp();

const SLUG_A = 'business-alpha';
const SLUG_B = 'business-beta';

/** A 1×1 PNG: the smallest image the PDF renderer will read. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface World {
  tenantId: bigint;
  slug: string;
  editorToken: string;
  viewerToken: string;
  strangerToken: string;
}
let A: World;
let B: World;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug IN ('${SLUG_A}', '${SLUG_B}'))`;
  for (const table of ['business_profile', 'user']) {
    await owner.$executeRawUnsafe(`DELETE FROM "${table}" WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug IN (${SLUG_A}, ${SLUG_B})`;
}

async function makeWorld(name: string, slug: string, tag: string): Promise<World> {
  const { id: tenantId } = await owner.tenant.create({
    data: { name, slug, country: 'Bangladesh' },
    select: { id: true },
  });
  const token = async (code: string, permissions: string[]) => {
    const { id } = await owner.user.create({
      data: {
        tenantId,
        code,
        username: `${code.toLowerCase()}-${slug}`,
        email: `${code.toLowerCase()}@${slug}.test`,
        passwordHash: 'x',
      },
      select: { id: true },
    });
    return signAccessToken({
      sub: id.toString(),
      tenantId: tenantId.toString(),
      isSuperadmin: false,
      permissions,
      tokenVersion: 0,
    });
  };
  return {
    tenantId,
    slug,
    editorToken: await token(`USR-E${tag}`, ['SETTING.BUSINESS.VIEW', 'SETTING.BUSINESS.EDIT']),
    viewerToken: await token(`USR-V${tag}`, ['SETTING.BUSINESS.VIEW']),
    strangerToken: await token(`USR-S${tag}`, ['SETTING.NOTIFICATION.VIEW']),
  };
}

function api(world: World, token: string) {
  const wrap = (r: request.Test) => r.set('Authorization', `Bearer ${token}`).set('X-Tenant-Slug', world.slug);
  const base = '/api/tenant/setting/business';
  return {
    get: () => wrap(request(app).get(base)),
    put: (body: unknown) => wrap(request(app).put(base)).send(body as object),
    logo: () => wrap(request(app).get(`${base}/logo`)),
    upload: (content: Buffer, filename: string, contentType: string) =>
      wrap(request(app).post(`${base}/logo`)).attach('file', content, { filename, contentType }),
    removeLogo: () => wrap(request(app).delete(`${base}/logo`)),
  };
}

const PROFILE = {
  businessName: 'Alpha Freight Ltd',
  address: 'House 12, Road 5, Gulshan-1\nDhaka 1212, Bangladesh',
  phone: '+880 2 5501 2345',
  email: 'info@alpha.test',
  website: 'www.alpha.test',
  binNo: '000123456-0101',
  tinNo: '123456789012',
  tradeLicenceNo: 'TRAD/DNCC/012345/2026',
};

beforeAll(async () => {
  await cleanup();
  A = await makeWorld('Alpha Workspace', SLUG_A, 'BA');
  B = await makeWorld('Beta Workspace', SLUG_B, 'BB');
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

describe('Business Settings', () => {
  it('starts from the workspace name, with nothing else filled in', async () => {
    const res = await api(A, A.viewerToken).get();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      businessName: 'Alpha Workspace',
      address: '',
      phone: '',
      binNo: '',
      hasLogo: false,
      updatedAt: null,
    });
  });

  it('prints the workspace name alone until the screen is saved', async () => {
    const head = await withTenant(A.tenantId, (db) => letterheadOf(db, A.tenantId));
    expect(head).toEqual({ companyName: 'Alpha Workspace', companyDetails: [] });
  });

  it('is closed to a user without the permission, and read-only to a viewer', async () => {
    expect((await api(A, A.strangerToken).get()).status).toBe(403);
    expect((await api(A, A.viewerToken).put(PROFILE)).status).toBe(403);
    expect((await api(A, A.viewerToken).upload(PNG, 'logo.png', 'image/png')).status).toBe(403);
  });

  it('refuses a blank name and an address longer than four lines', async () => {
    expect((await api(A, A.editorToken).put({ ...PROFILE, businessName: '   ' })).status).toBe(400);
    expect((await api(A, A.editorToken).put({ ...PROFILE, address: 'a\nb\nc\nd\ne' })).status).toBe(400);
    expect((await api(A, A.editorToken).put({ ...PROFILE, email: 'not-an-address' })).status).toBe(400);
  });

  it('saves the details, and a second save updates the same row', async () => {
    const first = await api(A, A.editorToken).put(PROFILE);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject(PROFILE);
    expect(first.body.data.updatedAt).not.toBeNull();

    const second = await api(A, A.editorToken).put({ ...PROFILE, website: '' });
    expect(second.status).toBe(200);
    expect(second.body.data.website).toBe('');

    const rows = await owner.businessProfile.findMany({ where: { tenantId: A.tenantId } });
    expect(rows).toHaveLength(1);
    // Blank is stored as NULL: "not printed".
    expect(rows[0]!.website).toBeNull();
  });

  it('keeps one workspace’s details from the other', async () => {
    const res = await api(B, B.viewerToken).get();
    expect(res.status).toBe(200);
    expect(res.body.data.businessName).toBe('Beta Workspace');
    expect(res.body.data.address).toBe('');

    const head = await withTenant(B.tenantId, (db) => letterheadOf(db, B.tenantId));
    expect(head).toEqual({ companyName: 'Beta Workspace', companyDetails: [] });
  });

  it('builds the letterhead lines from what was saved, blank details left out', async () => {
    const head = await withTenant(A.tenantId, (db) => letterheadOf(db, A.tenantId));
    expect(head).toEqual({
      companyName: 'Alpha Freight Ltd',
      companyDetails: [
        'House 12, Road 5, Gulshan-1',
        'Dhaka 1212, Bangladesh',
        'Tel: +880 2 5501 2345  ·  Email: info@alpha.test',
        'BIN: 000123456-0101  ·  TIN: 123456789012  ·  Trade Licence: TRAD/DNCC/012345/2026',
      ],
    });
  });

  it('puts the name and the lines on the printed page', async () => {
    const head = await withTenant(A.tenantId, (db) => letterheadOf(db, A.tenantId));
    const pdf = await renderDeliveryOrderPdf({
      ...head,
      doNo: 'DO-0001',
      issueDate: '2026-11-17',
      addressee: 'The Manager',
      subject: 'Delivery order',
      body: null,
      bookingNo: 'BK-0001',
      hblNo: null,
      containers: [],
    });
    const text = extractPdfText(pdf);
    expect(text).toContain('Alpha Freight Ltd');
    expect(text).toContain('Dhaka 1212, Bangladesh');
    expect(text).toContain('BIN: 000123456-0101');
  });

  it('takes a PNG logo, serves it back, and refuses anything that is not an image', async () => {
    const refused = await api(A, A.editorToken).upload(Buffer.from('%PDF-1.4 x'), 'logo.png', 'image/png');
    expect(refused.status).toBe(400);

    const uploaded = await api(A, A.editorToken).upload(PNG, 'logo.png', 'image/png');
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.data.hasLogo).toBe(true);
    // The upload changes the logo only, never the saved text.
    expect(uploaded.body.data.businessName).toBe('Alpha Freight Ltd');

    const served = await api(A, A.viewerToken).logo();
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');

    const bytes = await withTenant(A.tenantId, (db) => logoOf(db, A.tenantId));
    expect(bytes?.equals(PNG)).toBe(true);

    // Workspace B has no logo, and cannot reach A's.
    expect((await api(B, B.viewerToken).logo()).status).toBe(404);
  });

  it('replaces the logo, then removes it from the documents', async () => {
    const before = await owner.businessProfile.findFirstOrThrow({ where: { tenantId: A.tenantId } });
    const replaced = await api(A, A.editorToken).upload(PNG, 'second.png', 'image/png');
    expect(replaced.status).toBe(201);
    const after = await owner.businessProfile.findFirstOrThrow({ where: { tenantId: A.tenantId } });
    expect(after.logoFile).not.toBe(before.logoFile);

    const removed = await api(A, A.editorToken).removeLogo();
    expect(removed.status).toBe(200);
    expect(removed.body.data.hasLogo).toBe(false);
    expect(await withTenant(A.tenantId, (db) => logoOf(db, A.tenantId))).toBeNull();
    expect((await api(A, A.viewerToken).logo()).status).toBe(404);
  });
});
