import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  BUSINESS_PORT_ONE_SIDE,
  businessPortAccepts,
  businessPortPairs,
  businessPortSummary,
  CODE_PREFIX,
  type CommodityBusinessPortDto,
  commodityBusinessPortInputSchema,
  type CommodityItemDto,
  commodityItemInputSchema,
  type IndustrySectorDto,
  industrySectorInputSchema,
  industrySectorListQuerySchema,
  listQuerySchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { HttpError } from '../lib/http-error';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { parseId, parseRefId } from '../lib/request';
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
  /*
    The lane, rendered on the list because the client asked to see it there.
    Ports rather than a count: "CGP, NGB -> JEA" tells you what the category
    trades on, where "2 business ports" tells you only that somebody filled
    the screen in.
  */
  businessPorts: {
    where: { deletedAt: null },
    select: {
      polId: true,
      podId: true,
      pol: { select: { name: true, portCode: true } },
      pod: { select: { name: true, portCode: true } },
    },
  },
} as const;

type SectorRow = {
  id: bigint;
  code: string;
  name: string;
  isActive: boolean;
  _count: { items: number };
  businessPorts: {
    pol: { name: string; portCode: string | null } | null;
    pod: { name: string; portCode: string | null } | null;
  }[];
};

function sectorToDto(row: SectorRow): IndustrySectorDto {
  const lanes = row.businessPorts.map((bp) => ({
    polName: bp.pol?.name ?? '',
    polCode: bp.pol?.portCode ?? null,
    podName: bp.pod?.name ?? '',
    podCode: bp.pod?.portCode ?? null,
  }));
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    itemCount: row._count.items,
    businessPortCount: row.businessPorts.length,
    businessPortSummary: businessPortSummary(lanes),
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

/**
 * DELETE /api/tenant/.../:id — CR-002.
 *
 * A soft delete: it sets `deleted_at`, so §4 rule 3 holds and every foreign key
 * survives. Refused when anything still references the row, and refused on a
 * shared system row — so it only ever removes a commodity category entered by mistake.
 */
commodityRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'commodity category');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.industrySector.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, name: true },
    });
    await assertRowDeletable(
      db,
      'industry_sector',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.name },
      'Commodity category not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'industry_sector', id, auth.userId);

    await db.industrySector.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});

// ---------------------------------------------------------- Business Port
/*
  The lanes a category is traded on (client, 2026-09-12).

  A child list in the §8 shape, with one rule laid over the whole set: many
  loading ports into one discharge port, or one loading port out to many, never
  both. It spans rows, so no CHECK constraint can hold it and these handlers
  are where it lives.
*/

const BUSINESS_PORT_SELECT = {
  id: true,
  code: true,
  polId: true,
  podId: true,
  isActive: true,
  pol: { select: { name: true, portCode: true } },
  pod: { select: { name: true, portCode: true } },
} as const;

function businessPortToDto(row: {
  id: bigint;
  code: string;
  polId: bigint;
  podId: bigint;
  isActive: boolean;
  pol: { name: string; portCode: string | null } | null;
  pod: { name: string; portCode: string | null } | null;
}): CommodityBusinessPortDto {
  return {
    id: row.id.toString(),
    code: row.code,
    polId: row.polId.toString(),
    polName: row.pol?.name ?? '—',
    polCode: row.pol?.portCode ?? null,
    podId: row.podId.toString(),
    podName: row.pod?.name ?? '—',
    podCode: row.pod?.portCode ?? null,
    isActive: row.isActive,
  };
}

/*
  Ports for the two pickers, served from this route rather than from
  /setting/ports so the screen needs only the commodity permission — somebody
  who maintains category lanes has no business needing the port master's VIEW.
*/
commodityRouter.get(
  '/business-port-options',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const ports = await withTenant(auth.tenantId, async (db) => {
      // §7A rule 7: a shared row a workspace switched off is not offered.
      const inactive = await inactiveMasters(db);
      return db.port.findMany({
        where: { deletedAt: null, isActive: true, ...excludeInactive(inactive, 'port') },
        select: { id: true, name: true, portCode: true },
        orderBy: [{ name: 'asc' }],
      });
    });

    const payload: ApiSuccess<{ ports: { id: string; name: string; portCode: string | null }[] }> = {
      success: true,
      data: {
        ports: ports.map((p) => ({
          id: p.id.toString(),
          name: p.name,
          portCode: p.portCode,
        })),
      },
    };
    res.json(payload);
  },
);

commodityRouter.get(
  '/:id/business-ports',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const sectorId = parseId(req.params.id, 'category');

    const rows = await withTenant(auth.tenantId, async (db) => {
      await findSector(db, sectorId);
      return db.commodityBusinessPort.findMany({
        where: { industrySectorId: sectorId, deletedAt: null },
        select: BUSINESS_PORT_SELECT,
        orderBy: [{ id: 'asc' }],
      });
    });

    // Unpaged on purpose: a lane is a handful of ports, and the screen needs
    // the whole set in hand to know which side is still selectable.
    const payload: ApiSuccess<CommodityBusinessPortDto[]> = {
      success: true,
      data: rows.map(businessPortToDto),
    };
    res.json(payload);
  },
);

commodityRouter.post(
  '/:id/business-ports',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const sectorId = parseId(req.params.id, 'category');
    const input = commodityBusinessPortInputSchema.parse(req.body);

    const polIds = input.polIds.map((v) => parseRefId(v, 'port'));
    const podIds = input.podIds.map((v) => parseRefId(v, 'port'));

    /*
      The lane is chosen in one go — several loading ports against one
      discharge port, or the other way round — and saved as the pairs it
      stands for. A port on both sides is dropped rather than refused: it is
      the one combination of an otherwise sensible selection that cannot mean
      anything, and failing the whole save over it would be unkind.
    */
    const pairs = businessPortPairs(
      polIds.map((v) => v.toString()),
      podIds.map((v) => v.toString()),
    );
    if (pairs.length === 0) {
      throw HttpError.badRequest('The loading and discharge ports must be different.');
    }

    const created = await withTenant(auth.tenantId, async (db) => {
      await findSector(db, sectorId);

      const wanted = [...new Set([...polIds, ...podIds])];
      const ports = await db.port.findMany({
        where: { id: { in: wanted }, deletedAt: null },
        select: { id: true },
      });
      if (ports.length < wanted.length) throw HttpError.notFound('That port no longer exists.');

      const existing = await db.commodityBusinessPort.findMany({
        where: { industrySectorId: sectorId, deletedAt: null },
        select: { polId: true, podId: true },
      });
      const onFile = existing.map((r) => ({
        polId: r.polId.toString(),
        podId: r.podId.toString(),
      }));

      // The whole selection judged against what is already there, not pair by
      // pair — half a lane saved and half refused is nobody's idea of a lane.
      if (!businessPortAccepts(onFile, pairs)) {
        throw HttpError.badRequest(BUSINESS_PORT_ONE_SIDE);
      }

      const already = new Set(onFile.map((r) => `${r.polId}:${r.podId}`));
      const rows: Awaited<ReturnType<typeof createOne>>[] = [];

      async function createOne(polId: bigint, podId: bigint) {
        for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
          const code = await nextCode(
            db,
            'commodityBusinessPort',
            CODE_PREFIX.commodityBusinessPort,
            auth.tenantId,
          );
          try {
            return await db.commodityBusinessPort.create({
              data: {
                tenantId: auth.tenantId,
                code,
                industrySectorId: sectorId,
                polId,
                podId,
                createdBy: auth.userId,
                updatedBy: auth.userId,
              },
              select: BUSINESS_PORT_SELECT,
            });
          } catch (error) {
            if (isUniqueViolation(error, 'code')) continue;
            throw error;
          }
        }
        throw new HttpError(
          409,
          'CODE_GENERATION_FAILED',
          'Could not allocate a business port code. Please try again.',
        );
      }

      for (const pair of pairs) {
        // Re-adding a pair that is already on file is a no-op, not an error.
        if (already.has(`${pair.polId}:${pair.podId}`)) continue;
        rows.push(await createOne(BigInt(pair.polId), BigInt(pair.podId)));
      }
      return rows;
    });

    const payload: ApiSuccess<CommodityBusinessPortDto[]> = {
      success: true,
      data: created.map(businessPortToDto),
    };
    res.status(201).json(payload);
  },
);

commodityRouter.post(
  '/:id/business-ports/:bpId/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const sectorId = parseId(req.params.id, 'category');
    const bpId = parseId(req.params.bpId, 'business port');

    const updated = await withTenant(auth.tenantId, async (db) => {
      await findSector(db, sectorId);
      const row = await db.commodityBusinessPort.findFirst({
        where: { id: bpId, industrySectorId: sectorId, deletedAt: null },
        select: { isActive: true },
      });
      if (row === null) throw HttpError.notFound('That business port is not on this category.');

      return db.commodityBusinessPort.update({
        where: { id: bpId },
        data: { isActive: !row.isActive, updatedBy: auth.userId },
        select: BUSINESS_PORT_SELECT,
      });
    });

    const payload: ApiSuccess<CommodityBusinessPortDto> = {
      success: true,
      data: businessPortToDto(updated),
    };
    res.json(payload);
  },
);

commodityRouter.delete(
  '/:id/business-ports/:bpId',
  requirePermission(`${FEATURE}.DELETE`),
  async (req, res) => {
    const auth = req.auth!;
    const sectorId = parseId(req.params.id, 'category');
    const bpId = parseId(req.params.bpId, 'business port');

    await withTenant(auth.tenantId, async (db) => {
      await findSector(db, sectorId);
      const row = await db.commodityBusinessPort.findFirst({
        where: { id: bpId, industrySectorId: sectorId, deletedAt: null },
        select: { id: true },
      });
      if (row === null) throw HttpError.notFound('That business port is not on this category.');

      await db.commodityBusinessPort.update({
        where: { id: bpId },
        data: { deletedAt: new Date(), updatedBy: auth.userId },
      });
    });

    res.json({ success: true, data: { id: bpId.toString() } });
  },
);
