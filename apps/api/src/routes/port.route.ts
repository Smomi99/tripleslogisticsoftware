import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type PortDto,
  portInputSchema,
  portListQuerySchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { Prisma } from '../generated/prisma/client';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → Sea-Air Port (CLAUDE.md §5, §8).
 *
 * The reference implementation every other master screen copies. Two things
 * here are specific to a system-capable table (§7A rule 7) and will NOT apply
 * to a plain tenant-owned one like Customer:
 *
 *   - the list returns shared system rows (tenant_id IS NULL) alongside the
 *     workspace's own;
 *   - a system row cannot be edited, only switched off for this workspace,
 *     which writes tenant_master_override rather than port.is_active.
 */
export const portRouter: Router = Router();

portRouter.use(authenticate);

const FEATURE = 'SETTING.SEA_AIR_PORT';

/** Whitelisted sort columns — the value never reaches SQL unmapped. */
const SORT_COLUMNS = {
  code: 'p.code',
  name: 'p.name',
  portCode: 'p.port_code',
  country: 'p.country',
  type: 'p.type',
} as const;

interface PortRow {
  id: bigint;
  code: string;
  name: string;
  port_code: string;
  country: string;
  type: 'SEAPORT' | 'AIRPORT';
  effective_is_active: boolean;
  is_system: boolean;
}

function toDto(row: PortRow): PortDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    portCode: row.port_code,
    country: row.country,
    type: row.type,
    isActive: row.effective_is_active,
    isSystem: row.is_system,
  };
}

/**
 * GET /api/tenant/setting/ports
 * §9: every list endpoint supports page, limit, search, sortBy, sortOrder, isActive.
 */
portRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = portListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    /*
     * Raw SQL rather than the Prisma extension, because a system row's
     * effective status is port.is_active AND the workspace's override — which
     * cannot be expressed as a Prisma `where` without breaking the count and
     * therefore the pagination.
     *
     * The tenant boundary still holds: this runs inside withTenant, so
     * app.tenant_id is set and the RLS policy on port already restricts the
     * rows to (tenant_id IS NULL OR tenant_id = current). The predicates below
     * are a second layer, not the only one.
     */
    const conditions: Prisma.Sql[] = [
      Prisma.sql`p.deleted_at IS NULL`,
      Prisma.sql`(p.tenant_id IS NULL OR p.tenant_id = ${auth.tenantId})`,
    ];

    if (query.search !== undefined) {
      const needle = `%${query.search}%`;
      conditions.push(
        Prisma.sql`(p.name ILIKE ${needle} OR p.port_code ILIKE ${needle} OR p.country ILIKE ${needle} OR p.code ILIKE ${needle})`,
      );
    }
    if (query.type !== undefined) {
      conditions.push(Prisma.sql`p.type = ${query.type}::port_type`);
    }
    if (query.isActive !== undefined) {
      conditions.push(
        Prisma.sql`(p.is_active AND COALESCE(o.is_active, true)) = ${query.isActive}`,
      );
    }

    const where = Prisma.join(conditions, ' AND ');
    const joinOverride = Prisma.sql`
      LEFT JOIN tenant_master_override o
        ON o.table_name = 'port'
       AND o.record_id = p.id
       AND o.tenant_id = ${auth.tenantId}
    `;

    const totalRows = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM port p ${joinOverride} WHERE ${where}
    `;
    const total = Number(totalRows[0]?.count ?? 0n);

    const orderColumn = Prisma.raw(SORT_COLUMNS[query.sortBy]);
    const direction = Prisma.raw(query.sortOrder === 'desc' ? 'DESC' : 'ASC');
    const offset = (query.page - 1) * query.limit;

    const rows = await db.$queryRaw<PortRow[]>`
      SELECT p.id, p.code, p.name, p.port_code, p.country, p.type,
             (p.is_active AND COALESCE(o.is_active, true)) AS effective_is_active,
             (p.tenant_id IS NULL) AS is_system
      FROM port p ${joinOverride}
      WHERE ${where}
      ORDER BY ${orderColumn} ${direction}, p.id ASC
      LIMIT ${query.limit} OFFSET ${offset}
    `;

    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<PortDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** POST /api/tenant/setting/ports */
portRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = portInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    // A workspace may not reuse a port code that is already visible to it,
    // whether that is its own row or a shared system one.
    const clash = await db.port.findFirst({
      where: { portCode: input.portCode, deletedAt: null },
      select: { id: true },
    });
    if (clash !== null) {
      throw HttpError.conflict(`Port code ${input.portCode} is already in use.`);
    }

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'port', CODE_PREFIX.port, auth.tenantId);
      try {
        return await db.port.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            portCode: input.portCode,
            country: input.country,
            type: input.type,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: {
            id: true,
            code: true,
            name: true,
            portCode: true,
            country: true,
            type: true,
            isActive: true,
          },
        });
      } catch (error) {
        // Lost the code race — recompute and try again (see lib/codes.ts).
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(
      409,
      'CODE_GENERATION_FAILED',
      'Could not allocate a port code. Please try again.',
    );
  });

  const payload: ApiSuccess<PortDto> = {
    success: true,
    data: {
      id: created.id.toString(),
      code: created.code,
      name: created.name,
      portCode: created.portCode,
      country: created.country,
      type: created.type,
      isActive: created.isActive,
      isSystem: false,
    },
  };
  res.status(201).json(payload);
});

/** PATCH /api/tenant/setting/ports/:id */
portRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id);
  const input = portInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.port.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true },
    });
    if (existing === null) throw HttpError.notFound('Port not found.');
    // §7A rule 7: a shared row may be switched off for a workspace, never edited.
    if (existing.tenantId === null) {
      throw HttpError.forbidden(
        'This is a shared port. You can deactivate it for your workspace, but not edit it.',
      );
    }

    const clash = await db.port.findFirst({
      where: { portCode: input.portCode, deletedAt: null, NOT: { id } },
      select: { id: true },
    });
    if (clash !== null) {
      throw HttpError.conflict(`Port code ${input.portCode} is already in use.`);
    }

    return db.port.update({
      where: { id },
      data: {
        name: input.name,
        portCode: input.portCode,
        country: input.country,
        type: input.type,
        updatedBy: auth.userId,
      },
      select: {
        id: true,
        code: true,
        name: true,
        portCode: true,
        country: true,
        type: true,
        isActive: true,
      },
    });
  });

  const payload: ApiSuccess<PortDto> = {
    success: true,
    data: {
      id: updated.id.toString(),
      code: updated.code,
      name: updated.name,
      portCode: updated.portCode,
      country: updated.country,
      type: updated.type,
      isActive: updated.isActive,
      isSystem: false,
    },
  };
  res.json(payload);
});

/**
 * POST /api/tenant/setting/ports/:id/toggle-status
 * §4 rule 3: never hard-delete. Active/Inactive is the only removal there is.
 */
portRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id);

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.port.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, tenantId: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Port not found.');

      if (existing.tenantId !== null) {
        const updated = await db.port.update({
          where: { id },
          data: { isActive: !existing.isActive, updatedBy: auth.userId },
          select: { isActive: true },
        });
        return updated.isActive;
      }

      // Shared row: the workspace's own view of it lives in the override table.
      const override = await db.tenantMasterOverride.findFirst({
        where: { tableName: 'port', recordId: id },
        select: { id: true, isActive: true },
      });

      if (override === null) {
        await db.tenantMasterOverride.create({
          data: {
            tenantId: auth.tenantId,
            tableName: 'port',
            recordId: id,
            isActive: false,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
        });
        return false;
      }

      const updated = await db.tenantMasterOverride.update({
        where: { id: override.id },
        data: { isActive: !override.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive && existing.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

/**
 * Express 5 types a route param as string | string[] — a repeated `:id` yields
 * an array. Anything that is not a single run of digits is rejected rather than
 * coerced, so no malformed value reaches BigInt().
 */
function parseId(raw: string | string[] | undefined): bigint {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw HttpError.badRequest('Invalid port id.');
  }
  return BigInt(raw);
}
