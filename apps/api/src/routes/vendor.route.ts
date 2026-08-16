import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  listQuerySchema,
  type LookupOption,
  type VendorDto,
  vendorInputSchema,
  vendorListQuerySchema,
  type VendorPicDto,
  vendorPicInputSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → Vendor, with its contact people (CLAUDE.md §5, §8).
 *
 * Both parent and child are tenant-owned — a forwarder's suppliers are its own
 * — so unlike Carrier there is no shared/own split and every row is editable.
 * The Prisma extension scopes every query, so no raw SQL is needed either.
 */
export const vendorRouter: Router = Router();

vendorRouter.use(authenticate);

const FEATURE = 'SETTING.VENDOR';

const VENDOR_SELECT = {
  id: true,
  code: true,
  name: true,
  country: true,
  address: true,
  serviceDescription: true,
  vendorTypeId: true,
  bankDetails: true,
  tinNo: true,
  vatNo: true,
  isActive: true,
  vendorType: { select: { name: true } },
  _count: { select: { pics: true } },
} as const;

interface VendorRow {
  id: bigint;
  code: string;
  name: string;
  country: string;
  address: string | null;
  serviceDescription: string | null;
  vendorTypeId: bigint;
  bankDetails: string | null;
  tinNo: string | null;
  vatNo: string | null;
  isActive: boolean;
  vendorType: { name: string };
  _count: { pics: number };
}

function toDto(row: VendorRow): VendorDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    country: row.country,
    address: row.address,
    serviceDescription: row.serviceDescription,
    vendorTypeId: row.vendorTypeId.toString(),
    vendorTypeName: row.vendorType.name,
    bankDetails: row.bankDetails,
    tinNo: row.tinNo,
    vatNo: row.vatNo,
    isActive: row.isActive,
    picCount: row._count.pics,
  };
}

async function assertVendorTypeVisible(db: TenantDb, id: bigint): Promise<void> {
  const type = await db.vendorType.findFirst({
    where: { id, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (type === null) throw HttpError.badRequest('That vendor type is not available.');
}

vendorRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = vendorListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.vendorTypeId !== undefined ? { vendorTypeId: BigInt(query.vendorTypeId) } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { code: { contains: query.search, mode: 'insensitive' as const } },
              { country: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.vendor.findMany({
        where,
        select: VENDOR_SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.vendor.count({ where }),
    ]);
    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<VendorDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

vendorRouter.get('/types', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const types = await withTenant(auth.tenantId, (db) =>
    db.vendorType.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { code: 'asc' },
    }),
  );
  const payload: ApiSuccess<LookupOption[]> = {
    success: true,
    data: types.map((t) => ({ id: t.id.toString(), name: t.name })),
  };
  res.json(payload);
});

vendorRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = vendorInputSchema.parse(req.body);
  const vendorTypeId = parseRefId(input.vendorTypeId, 'vendor type');

  const created = await withTenant(auth.tenantId, async (db) => {
    await assertVendorTypeVisible(db, vendorTypeId);

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'vendor', CODE_PREFIX.vendor, auth.tenantId);
      try {
        return await db.vendor.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            country: input.country,
            address: input.address || null,
            serviceDescription: input.serviceDescription || null,
            vendorTypeId,
            bankDetails: input.bankDetails || null,
            tinNo: input.tinNo || null,
            vatNo: input.vatNo || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: VENDOR_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(
      409,
      'CODE_GENERATION_FAILED',
      'Could not allocate a vendor code. Please try again.',
    );
  });

  const payload: ApiSuccess<VendorDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

vendorRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'vendor');
  const input = vendorInputSchema.parse(req.body);
  const vendorTypeId = parseRefId(input.vendorTypeId, 'vendor type');

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.vendor.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Vendor not found.');
    await assertVendorTypeVisible(db, vendorTypeId);

    return db.vendor.update({
      where: { id },
      data: {
        name: input.name,
        country: input.country,
        address: input.address || null,
        serviceDescription: input.serviceDescription || null,
        vendorTypeId,
        bankDetails: input.bankDetails || null,
        tinNo: input.tinNo || null,
        vatNo: input.vatNo || null,
        updatedBy: auth.userId,
      },
      select: VENDOR_SELECT,
    });
  });

  const payload: ApiSuccess<VendorDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

vendorRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'vendor');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.vendor.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Vendor not found.');
      const updated = await db.vendor.update({
        where: { id },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

// ===========================================================================
// Vendor → Contact person (§8 child screen)
// ===========================================================================

const PIC_SELECT = {
  id: true,
  code: true,
  name: true,
  department: true,
  designation: true,
  mobile: true,
  email: true,
  isActive: true,
} as const;

function picToDto(row: {
  id: bigint;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  mobile: string | null;
  email: string | null;
  isActive: boolean;
}): VendorPicDto {
  return { ...row, id: row.id.toString() };
}

async function findVendor(db: TenantDb, id: bigint) {
  const vendor = await db.vendor.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true },
  });
  if (vendor === null) throw HttpError.notFound('Vendor not found.');
  return vendor;
}

vendorRouter.get('/:id/summary', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'vendor');
  const vendor = await withTenant(auth.tenantId, (db) => findVendor(db, id));
  const payload: ApiSuccess<{ id: string; name: string }> = {
    success: true,
    data: { id: vendor.id.toString(), name: vendor.name },
  };
  res.json(payload);
});

vendorRouter.get('/:id/pics', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const vendorId = parseId(req.params.id, 'vendor');
  const query = listQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    await findVendor(db, vendorId);
    const where = {
      vendorId,
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.vendorPic.findMany({
        where,
        select: PIC_SELECT,
        orderBy: [{ name: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.vendorPic.count({ where }),
    ]);
    return { rows: rows.map(picToDto), total };
  });

  const payload: ApiSuccess<VendorPicDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

vendorRouter.post('/:id/pics', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const vendorId = parseId(req.params.id, 'vendor');
  const input = vendorPicInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    await findVendor(db, vendorId);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'vendorPic', CODE_PREFIX.vendorPic, auth.tenantId);
      try {
        return await db.vendorPic.create({
          data: {
            tenantId: auth.tenantId,
            code,
            vendorId,
            name: input.name,
            department: input.department || null,
            designation: input.designation || null,
            mobile: input.mobile || null,
            email: input.email || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: PIC_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(
      409,
      'CODE_GENERATION_FAILED',
      'Could not allocate a contact code. Please try again.',
    );
  });

  const payload: ApiSuccess<VendorPicDto> = { success: true, data: picToDto(created) };
  res.status(201).json(payload);
});

vendorRouter.patch('/:id/pics/:picId', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const vendorId = parseId(req.params.id, 'vendor');
  const picId = parseId(req.params.picId, 'contact');
  const input = vendorPicInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.vendorPic.findFirst({
      where: { id: picId, vendorId, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Contact not found.');

    return db.vendorPic.update({
      where: { id: picId },
      data: {
        name: input.name,
        department: input.department || null,
        designation: input.designation || null,
        mobile: input.mobile || null,
        email: input.email || null,
        updatedBy: auth.userId,
      },
      select: PIC_SELECT,
    });
  });

  const payload: ApiSuccess<VendorPicDto> = { success: true, data: picToDto(updated) };
  res.json(payload);
});

vendorRouter.post(
  '/:id/pics/:picId/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const vendorId = parseId(req.params.id, 'vendor');
    const picId = parseId(req.params.picId, 'contact');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.vendorPic.findFirst({
        where: { id: picId, vendorId, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Contact not found.');
      const updated = await db.vendorPic.update({
        where: { id: picId },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);
