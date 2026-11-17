import { Router } from 'express';

import { type ApiSuccess, type BusinessProfileDto, businessProfileSchema } from '@ff/shared';

import { HttpError } from '../lib/http-error';
import { logoKeyOf } from '../lib/letterhead';
import { contentTypeOf, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * Settings → Business Settings (owner request, 2026-11-17).
 *
 * The company's name, logo, address, contact and registration numbers, read
 * by every printed document through lib/letterhead.ts. One row per workspace,
 * so there is no list and no code: it is read, and it is saved — the
 * Notifications screen's shape.
 *
 * Until the first save there is no row, and the screen is offered the
 * workspace's own name to start from; documents print that name meanwhile.
 */

export const businessProfileRouter: Router = Router();
businessProfileRouter.use(authenticate);

const FEATURE = 'SETTING.BUSINESS';

/** A logo travels inside every PDF; anything bigger only makes them heavy. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const PROFILE_SELECT = {
  businessName: true,
  address: true,
  phone: true,
  email: true,
  website: true,
  binNo: true,
  tinNo: true,
  tradeLicenceNo: true,
  logoFile: true,
  updatedAt: true,
} as const;

async function profileDto(db: TenantDb, tenantId: bigint): Promise<BusinessProfileDto> {
  const [row, tenant, logoKey] = await Promise.all([
    db.businessProfile.findFirst({ select: PROFILE_SELECT }),
    db.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
    logoKeyOf(db, tenantId),
  ]);
  return {
    businessName: row?.businessName ?? tenant?.name ?? '',
    address: row?.address ?? '',
    phone: row?.phone ?? '',
    email: row?.email ?? '',
    website: row?.website ?? '',
    binNo: row?.binNo ?? '',
    tinNo: row?.tinNo ?? '',
    tradeLicenceNo: row?.tradeLicenceNo ?? '',
    hasLogo: logoKey !== null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/**
 * The workspace's row, made on first use.
 *
 * Made from the tenant row — its name, and its logo if the platform ever set
 * one — so the first save on this screen never drops a logo the documents
 * were already printing.
 */
async function ensureProfile(
  db: TenantDb,
  tenantId: bigint,
  userId: bigint,
): Promise<{ id: bigint; logoFile: string | null }> {
  const existing = await db.businessProfile.findFirst({ select: { id: true, logoFile: true } });
  if (existing !== null) return existing;
  const tenant = await db.tenant.findFirst({
    where: { id: tenantId },
    select: { name: true, logoFile: true },
  });
  return db.businessProfile.create({
    data: {
      tenantId,
      businessName: tenant?.name ?? 'Freight Forwarder',
      logoFile: tenant?.logoFile ?? null,
      createdBy: userId,
      updatedBy: userId,
    },
    select: { id: true, logoFile: true },
  });
}

/**
 * The key to delete from storage now that it is no longer the logo, or null.
 * The tenant row's own logo belongs to the platform record and stays.
 */
async function deletableLogo(db: TenantDb, tenantId: bigint, key: string | null): Promise<string | null> {
  if (key === null || key === '') return null;
  const tenant = await db.tenant.findFirst({ where: { id: tenantId }, select: { logoFile: true } });
  return tenant?.logoFile === key ? null : key;
}

/** PNG or JPEG by their first bytes — the only images the PDF renderer reads. */
function isPngOrJpeg(buffer: Buffer): boolean {
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return png || jpeg;
}

businessProfileRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const data = await withTenant(auth.tenantId, (db) => profileDto(db, auth.tenantId));
  const payload: ApiSuccess<BusinessProfileDto> = { success: true, data };
  res.json(payload);
});

businessProfileRouter.put('/', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const input = businessProfileSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    // Blank is "not printed", stored as NULL.
    const fields = {
      businessName: input.businessName,
      address: input.address || null,
      phone: input.phone || null,
      email: input.email || null,
      website: input.website || null,
      binNo: input.binNo || null,
      tinNo: input.tinNo || null,
      tradeLicenceNo: input.tradeLicenceNo || null,
      updatedBy: auth.userId,
    };
    const { id } = await ensureProfile(db, auth.tenantId, auth.userId);
    await db.businessProfile.update({ where: { id }, data: fields });
    return profileDto(db, auth.tenantId);
  });

  const payload: ApiSuccess<BusinessProfileDto> = { success: true, data };
  res.json(payload);
});

// ===========================================================================
// The logo
// ===========================================================================

businessProfileRouter.get('/logo', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const key = await withTenant(auth.tenantId, (db) => logoKeyOf(db, auth.tenantId));
  if (key === null) throw HttpError.notFound('No logo has been uploaded.');

  const file = await openFile(auth.tenantId, key);
  res.setHeader('Content-Type', contentTypeOf(key));
  res.setHeader('Content-Length', String(file.sizeBytes));
  res.setHeader('Cache-Control', 'private, no-cache');
  file.stream.pipe(res);
});

businessProfileRouter.post(
  '/logo',
  requirePermission(`${FEATURE}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose an image to upload.');
    if (!(file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') || !isPngOrJpeg(file.buffer)) {
      throw HttpError.badRequest('The logo has to be a PNG or a JPG.');
    }
    if (file.size > MAX_LOGO_BYTES) {
      throw HttpError.badRequest('Keep the logo under 2 MB. It goes into every printed document.');
    }

    const stored = await putFile(auth.tenantId, 'business', file);
    const { data, replaced } = await withTenant(auth.tenantId, async (db) => {
      const profile = await ensureProfile(db, auth.tenantId, auth.userId);
      const old = profile.logoFile;
      await db.businessProfile.update({
        where: { id: profile.id },
        data: { logoFile: stored.key, updatedBy: auth.userId },
      });
      return {
        data: await profileDto(db, auth.tenantId),
        replaced: await deletableLogo(db, auth.tenantId, old),
      };
    });

    // Removed after the row stopped pointing at it, so a failure here never
    // leaves a record referencing a file that has gone.
    if (replaced !== null) await removeFile(auth.tenantId, replaced).catch(() => undefined);

    const payload: ApiSuccess<BusinessProfileDto> = { success: true, data };
    res.status(201).json(payload);
  },
);

businessProfileRouter.delete('/logo', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const { data, removed } = await withTenant(auth.tenantId, async (db) => {
    const profile = await ensureProfile(db, auth.tenantId, auth.userId);
    const old = profile.logoFile;
    await db.businessProfile.update({
      where: { id: profile.id },
      data: { logoFile: null, updatedBy: auth.userId },
    });
    return {
      data: await profileDto(db, auth.tenantId),
      removed: await deletableLogo(db, auth.tenantId, old),
    };
  });

  if (removed !== null) await removeFile(auth.tenantId, removed).catch(() => undefined);

  const payload: ApiSuccess<BusinessProfileDto> = { success: true, data };
  res.json(payload);
});
