import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type LookupOption,
  type VesselDto,
  vesselInputSchema,
  vesselListQuerySchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → Vessel (CLAUDE.md §5, client table: Table_Vessel).
 *
 * Tenant-owned, referencing the shared carrier list. The carrier reference is
 * a plain single-column FK rather than the composite one used between two
 * tenant-owned tables, because a shared carrier has no tenant_id to match on
 * (§7A rule 7) — visibility is enforced by RLS and by the check below.
 */
export const vesselRouter: Router = Router();

vesselRouter.use(authenticate);

const FEATURE = 'SETTING.VESSEL';

interface VesselRow {
  id: bigint;
  code: string;
  name: string;
  carrierId: bigint;
  isActive: boolean;
  carrier: { name: string };
}

function toDto(row: VesselRow): VesselDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    carrierId: row.carrierId.toString(),
    carrierName: row.carrier.name,
    isActive: row.isActive,
  };
}

const SELECT = {
  id: true,
  code: true,
  name: true,
  carrierId: true,
  isActive: true,
  carrier: { select: { name: true } },
} as const;

async function assertCarrierVisible(db: TenantDb, carrierId: bigint): Promise<void> {
  const carrier = await db.carrier.findFirst({
    where: { id: carrierId, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (carrier === null) throw HttpError.badRequest('That carrier is not available.');
}

/** GET /api/tenant/setting/vessels */
vesselRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = vesselListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.carrierId !== undefined ? { carrierId: BigInt(query.carrierId) } : {}),
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
      db.vessel.findMany({
        where,
        select: SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.vessel.count({ where }),
    ]);

    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<VesselDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** GET /api/tenant/setting/vessels/carriers — options for the carrier dropdown. */
vesselRouter.get('/carriers', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const carriers = await withTenant(auth.tenantId, (db) =>
    db.carrier.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  );

  const payload: ApiSuccess<LookupOption[]> = {
    success: true,
    data: carriers.map((c) => ({ id: c.id.toString(), name: c.name })),
  };
  res.json(payload);
});

/** POST /api/tenant/setting/vessels */
vesselRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = vesselInputSchema.parse(req.body);
  const carrierId = parseRefId(input.carrierId, 'carrier');

  const created = await withTenant(auth.tenantId, async (db) => {
    await assertCarrierVisible(db, carrierId);

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'vessel', CODE_PREFIX.vessel, auth.tenantId);
      try {
        return await db.vessel.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            carrierId,
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
      'Could not allocate a vessel code. Please try again.',
    );
  });

  const payload: ApiSuccess<VesselDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

/** PATCH /api/tenant/setting/vessels/:id */
vesselRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'vessel');
  const input = vesselInputSchema.parse(req.body);
  const carrierId = parseRefId(input.carrierId, 'carrier');

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.vessel.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Vessel not found.');
    await assertCarrierVisible(db, carrierId);

    return db.vessel.update({
      where: { id },
      data: { name: input.name, carrierId, updatedBy: auth.userId },
      select: SELECT,
    });
  });

  const payload: ApiSuccess<VesselDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

/** POST /api/tenant/setting/vessels/:id/toggle-status — §4 rule 3. */
vesselRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'vessel');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.vessel.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Vessel not found.');

      const updated = await db.vessel.update({
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
 * shared system row — so it only ever removes a vessel entered by mistake.
 */
vesselRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'vessel');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.vessel.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, name: true },
    });
    await assertRowDeletable(
      db,
      'vessel',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.name },
      'Vessel not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'vessel', id, auth.userId);

    await db.vessel.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});
