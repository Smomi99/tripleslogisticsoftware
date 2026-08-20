import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type CostHeadDto,
  costHeadInputSchema,
  costHeadListQuerySchema,
  type LookupOption,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → Cost Head (CLAUDE.md §5, client table: Table_Cost_Head).
 *
 * Same shape as Sea-Air Port, minus the system-capable handling: cost_head is
 * plain tenant-owned, so the tenant extension scopes every query on its own and
 * no raw SQL or override table is involved. Its `unit` reference points at the
 * shared cost_unit lookup.
 */
export const costHeadRouter: Router = Router();

costHeadRouter.use(authenticate);

const FEATURE = 'SETTING.COST_HEAD';

interface CostHeadRow {
  id: bigint;
  code: string;
  name: string;
  category: 'SERVICE' | 'ADMINISTRATIVE';
  unitId: bigint;
  isActive: boolean;
  unit: { name: string };
}

function toDto(row: CostHeadRow): CostHeadDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    category: row.category,
    unitId: row.unitId.toString(),
    unitName: row.unit.name,
    isActive: row.isActive,
  };
}

const SELECT = {
  id: true,
  code: true,
  name: true,
  category: true,
  unitId: true,
  isActive: true,
  unit: { select: { name: true } },
} as const;

/** The referenced unit must be one this workspace can actually see. */
async function assertUnitVisible(db: TenantDb, unitId: bigint): Promise<void> {
  const unit = await db.costUnit.findFirst({
    where: { id: unitId, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (unit === null) throw HttpError.badRequest('That unit is not available.');
}

/** GET /api/tenant/setting/cost-heads */
costHeadRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = costHeadListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.category !== undefined ? { category: query.category } : {}),
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
      db.costHead.findMany({
        where,
        select: SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.costHead.count({ where }),
    ]);

    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<CostHeadDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** GET /api/tenant/setting/cost-heads/units — options for the unit dropdown. */
costHeadRouter.get('/units', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const units = await withTenant(auth.tenantId, async (db) => {
    // See carrier.route.ts: a deactivated shared row is an override, not a flag.
    const inactive = await inactiveMasters(db);
    return db.costUnit.findMany({
      where: { ...excludeInactive(inactive, 'cost_unit'), deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { code: 'asc' },
    });
  });

  const payload: ApiSuccess<LookupOption[]> = {
    success: true,
    data: units.map((u) => ({ id: u.id.toString(), name: u.name })),
  };
  res.json(payload);
});

/** POST /api/tenant/setting/cost-heads */
costHeadRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = costHeadInputSchema.parse(req.body);
  const unitId = parseRefId(input.unitId, 'unit');

  const created = await withTenant(auth.tenantId, async (db) => {
    await assertUnitVisible(db, unitId);

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'costHead', CODE_PREFIX.costHead, auth.tenantId);
      try {
        return await db.costHead.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            category: input.category,
            unitId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(
      409,
      'CODE_GENERATION_FAILED',
      'Could not allocate a cost head code. Please try again.',
    );
  });

  const payload: ApiSuccess<CostHeadDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

/** PATCH /api/tenant/setting/cost-heads/:id */
costHeadRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'cost head');
  const input = costHeadInputSchema.parse(req.body);
  const unitId = parseRefId(input.unitId, 'unit');

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.costHead.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Cost head not found.');
    await assertUnitVisible(db, unitId);

    return db.costHead.update({
      where: { id },
      data: {
        name: input.name,
        category: input.category,
        unitId,
        updatedBy: auth.userId,
      },
      select: SELECT,
    });
  });

  const payload: ApiSuccess<CostHeadDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

/** POST /api/tenant/setting/cost-heads/:id/toggle-status — §4 rule 3. */
costHeadRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'cost head');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.costHead.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Cost head not found.');

      const updated = await db.costHead.update({
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

/**
 * DELETE /api/tenant/.../:id — CR-002.
 *
 * A soft delete: it sets `deleted_at`, so §4 rule 3 holds and every foreign key
 * survives. Refused when anything still references the row, and refused on a
 * shared system row — so it only ever removes a cost head entered by mistake.
 */
costHeadRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'cost head');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.costHead.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, name: true },
    });
    await assertRowDeletable(
      db,
      'cost_head',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.name },
      'Cost head not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'cost_head', id, auth.userId);

    await db.costHead.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});
