import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type CommodityItemDto,
  commodityItemInputSchema,
  type IndustrySectorDto,
  industrySectorInputSchema,
  industrySectorListQuerySchema,
  listQuerySchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { parseId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → Commodity Category (CLAUDE.md §5, §8).
 *   industry_sector  Table_Commodity_Class            e.g. Garments
 *   commodity_item   Table_Industry_Sector_Item_List  [child]
 *
 * Both tenant-owned. industry_sector is also referenced by Customer (§6), so
 * deactivating one must not break existing customers — which is exactly why
 * §4 rule 3 forbids deletion and the Action column offers only a status toggle.
 */
export const commodityRouter: Router = Router();

commodityRouter.use(authenticate);

const FEATURE = 'SETTING.COMMODITY_CATEGORY';

const SECTOR_SELECT = {
  id: true,
  code: true,
  name: true,
  isActive: true,
  _count: { select: { items: true } },
} as const;

function sectorToDto(row: {
  id: bigint;
  code: string;
  name: string;
  isActive: boolean;
  _count: { items: number };
}): IndustrySectorDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    itemCount: row._count.items,
  };
}

commodityRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = industrySectorListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { code: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.industrySector.findMany({
        where,
        select: SECTOR_SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.industrySector.count({ where }),
    ]);
    return { rows: rows.map(sectorToDto), total };
  });

  const payload: ApiSuccess<IndustrySectorDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

commodityRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = industrySectorInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'industrySector', CODE_PREFIX.industrySector, auth.tenantId);
      try {
        return await db.industrySector.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: SECTOR_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(
      409,
      'CODE_GENERATION_FAILED',
      'Could not allocate a category code. Please try again.',
    );
  });

  const payload: ApiSuccess<IndustrySectorDto> = { success: true, data: sectorToDto(created) };
  res.status(201).json(payload);
});

commodityRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'category');
  const input = industrySectorInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.industrySector.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Category not found.');
    return db.industrySector.update({
      where: { id },
      data: { name: input.name, updatedBy: auth.userId },
      select: SECTOR_SELECT,
    });
  });

  const payload: ApiSuccess<IndustrySectorDto> = { success: true, data: sectorToDto(updated) };
  res.json(payload);
});

commodityRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'category');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.industrySector.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Category not found.');
      const updated = await db.industrySector.update({
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
// Category → Item (§8 child screen)
// ===========================================================================

const ITEM_SELECT = { id: true, code: true, name: true, hsCode: true, isActive: true } as const;

function itemToDto(row: {
  id: bigint;
  code: string;
  name: string;
  hsCode: string | null;
  isActive: boolean;
}): CommodityItemDto {
  return { ...row, id: row.id.toString() };
}

async function findSector(db: TenantDb, id: bigint) {
  const sector = await db.industrySector.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true },
  });
  if (sector === null) throw HttpError.notFound('Category not found.');
  return sector;
}

commodityRouter.get('/:id/summary', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'category');
  const sector = await withTenant(auth.tenantId, (db) => findSector(db, id));
  const payload: ApiSuccess<{ id: string; name: string }> = {
    success: true,
    data: { id: sector.id.toString(), name: sector.name },
  };
  res.json(payload);
});

commodityRouter.get('/:id/items', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const sectorId = parseId(req.params.id, 'category');
  const query = listQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    await findSector(db, sectorId);
    const where = {
      industrySectorId: sectorId,
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { hsCode: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.commodityItem.findMany({
        where,
        select: ITEM_SELECT,
        orderBy: [{ name: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.commodityItem.count({ where }),
    ]);
    return { rows: rows.map(itemToDto), total };
  });

  const payload: ApiSuccess<CommodityItemDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

commodityRouter.post('/:id/items', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const sectorId = parseId(req.params.id, 'category');
  const input = commodityItemInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    await findSector(db, sectorId);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'commodityItem', CODE_PREFIX.commodityItem, auth.tenantId);
      try {
        return await db.commodityItem.create({
          data: {
            tenantId: auth.tenantId,
            code,
            industrySectorId: sectorId,
            name: input.name,
            hsCode: input.hsCode || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: ITEM_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(
      409,
      'CODE_GENERATION_FAILED',
      'Could not allocate an item code. Please try again.',
    );
  });

  const payload: ApiSuccess<CommodityItemDto> = { success: true, data: itemToDto(created) };
  res.status(201).json(payload);
});

commodityRouter.patch(
  '/:id/items/:itemId',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const sectorId = parseId(req.params.id, 'category');
    const itemId = parseId(req.params.itemId, 'item');
    const input = commodityItemInputSchema.parse(req.body);

    const updated = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.commodityItem.findFirst({
        where: { id: itemId, industrySectorId: sectorId, deletedAt: null },
        select: { id: true },
      });
      if (existing === null) throw HttpError.notFound('Item not found.');
      return db.commodityItem.update({
        where: { id: itemId },
        data: { name: input.name, hsCode: input.hsCode || null, updatedBy: auth.userId },
        select: ITEM_SELECT,
      });
    });

    const payload: ApiSuccess<CommodityItemDto> = { success: true, data: itemToDto(updated) };
    res.json(payload);
  },
);

commodityRouter.post(
  '/:id/items/:itemId/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const sectorId = parseId(req.params.id, 'category');
    const itemId = parseId(req.params.itemId, 'item');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.commodityItem.findFirst({
        where: { id: itemId, industrySectorId: sectorId, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Item not found.');
      const updated = await db.commodityItem.update({
        where: { id: itemId },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);
