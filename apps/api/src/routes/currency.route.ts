import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type CurrencyDto,
  currencyInputSchema,
  currencyListQuerySchema,
  type CurrencyRateDto,
  currencyRateInputSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, codeSortSql, isUniqueViolation, nextCode } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { parseId } from '../lib/request';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → Currency (CLAUDE.md §5, client table: Table_Currency).
 *
 * System-capable like Sea-Air Port, with one addition: §5 puts `conversion` on
 * the currency row, but a shared row is not tenant-editable (§7A rule 7). So
 * `conversion` is the system default and a workspace's own rate lives in the
 * tenant-owned currency_rate_history. The effective rate — what the workspace
 * actually books at — is its latest in-force rate, falling back to the default.
 */
export const currencyRouter: Router = Router();

currencyRouter.use(authenticate);

const FEATURE = 'SETTING.CURRENCY';

const SORT_COLUMNS = {
  code: codeSortSql('c.code'),
  currency: 'c.currency',
  conversion: 'c.conversion',
} as const;

interface CurrencyRow {
  id: bigint;
  code: string;
  currency: string;
  conversion: Prisma.Decimal;
  tenant_rate: Prisma.Decimal | null;
  effective_is_active: boolean;
  is_system: boolean;
}

function toDto(row: CurrencyRow): CurrencyDto {
  const conversion = row.conversion.toFixed(4);
  const tenantRate = row.tenant_rate === null ? null : row.tenant_rate.toFixed(4);
  return {
    id: row.id.toString(),
    code: row.code,
    currency: row.currency,
    conversion,
    tenantRate,
    effectiveRate: tenantRate ?? conversion,
    isActive: row.effective_is_active,
    isSystem: row.is_system,
  };
}

/** GET /api/tenant/setting/currencies */
currencyRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = currencyListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    /*
     * Raw SQL for the same reason as Port: the effective status depends on the
     * workspace's override, and the effective rate on a lateral lookup into
     * currency_rate_history. Neither is expressible as a Prisma `where` without
     * breaking the count and therefore the pager. RLS still constrains the rows.
     */
    const conditions: Prisma.Sql[] = [
      Prisma.sql`c.deleted_at IS NULL`,
      Prisma.sql`(c.tenant_id IS NULL OR c.tenant_id = ${auth.tenantId})`,
    ];

    if (query.search !== undefined) {
      const needle = `%${query.search}%`;
      conditions.push(Prisma.sql`(c.currency ILIKE ${needle} OR c.code ILIKE ${needle})`);
    }
    if (query.isActive !== undefined) {
      conditions.push(
        Prisma.sql`(c.is_active AND COALESCE(o.is_active, true)) = ${query.isActive}`,
      );
    }

    const where = Prisma.join(conditions, ' AND ');
    const joins = Prisma.sql`
      LEFT JOIN tenant_master_override o
        ON o.table_name = 'currency' AND o.record_id = c.id AND o.tenant_id = ${auth.tenantId}
      LEFT JOIN LATERAL (
        SELECT h.rate
        FROM currency_rate_history h
        WHERE h.currency_id = c.id
          AND h.tenant_id = ${auth.tenantId}
          AND h.deleted_at IS NULL
          AND h.is_active
          AND h.effective_from <= now()
          AND (h.effective_to IS NULL OR h.effective_to > now())
        ORDER BY h.effective_from DESC, h.id DESC
        LIMIT 1
      ) r ON true
    `;

    const totalRows = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM currency c ${joins} WHERE ${where}
    `;
    const total = Number(totalRows[0]?.count ?? 0n);

    const orderColumn = Prisma.raw(SORT_COLUMNS[query.sortBy]);
    const direction = Prisma.raw(query.sortOrder === 'desc' ? 'DESC' : 'ASC');

    const rows = await db.$queryRaw<CurrencyRow[]>`
      SELECT c.id, c.code, c.currency, c.conversion,
             r.rate AS tenant_rate,
             (c.is_active AND COALESCE(o.is_active, true)) AS effective_is_active,
             (c.tenant_id IS NULL) AS is_system
      FROM currency c ${joins}
      WHERE ${where}
      ORDER BY ${orderColumn} ${direction}, c.id ASC
      LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    `;

    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<CurrencyDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** POST /api/tenant/setting/currencies */
currencyRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = currencyInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    const clash = await db.currency.findFirst({
      where: { currency: input.currency, deletedAt: null },
      select: { id: true },
    });
    if (clash !== null) {
      throw HttpError.conflict(`${input.currency} is already in the list.`);
    }

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'currency', CODE_PREFIX.currency, auth.tenantId);
      try {
        return await db.currency.create({
          data: {
            tenantId: auth.tenantId,
            code,
            currency: input.currency,
            conversion: input.conversion,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: { id: true, code: true, currency: true, conversion: true, isActive: true },
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(
      409,
      'CODE_GENERATION_FAILED',
      'Could not allocate a currency code. Please try again.',
    );
  });

  const conversion = created.conversion.toFixed(4);
  const payload: ApiSuccess<CurrencyDto> = {
    success: true,
    data: {
      id: created.id.toString(),
      code: created.code,
      currency: created.currency,
      conversion,
      tenantRate: null,
      effectiveRate: conversion,
      isActive: created.isActive,
      isSystem: false,
    },
  };
  res.status(201).json(payload);
});

/** PATCH /api/tenant/setting/currencies/:id — own rows only (§7A rule 7). */
currencyRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'currency');
  const input = currencyInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.currency.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true },
    });
    if (existing === null) throw HttpError.notFound('Currency not found.');
    if (existing.tenantId === null) {
      throw HttpError.forbidden(
        'This is a shared currency. Set your own rate instead of editing it.',
      );
    }

    return db.currency.update({
      where: { id },
      data: {
        currency: input.currency,
        conversion: input.conversion,
        updatedBy: auth.userId,
      },
      select: { id: true, code: true, currency: true, conversion: true, isActive: true },
    });
  });

  const conversion = updated.conversion.toFixed(4);
  const payload: ApiSuccess<CurrencyDto> = {
    success: true,
    data: {
      id: updated.id.toString(),
      code: updated.code,
      currency: updated.currency,
      conversion,
      tenantRate: null,
      effectiveRate: conversion,
      isActive: updated.isActive,
      isSystem: false,
    },
  };
  res.json(payload);
});

/**
 * POST /api/tenant/setting/currencies/:id/rate
 *
 * Sets this workspace's rate. Works for a shared currency as well as its own —
 * this is how a workspace expresses a rate it cannot get by editing a shared
 * row. The previous in-force rate is closed off rather than overwritten, so the
 * history stays auditable (§5 currency_rate_history).
 */
currencyRouter.post('/:id/rate', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'currency');
  const input = currencyRateInputSchema.parse(req.body);

  const effectiveFrom = new Date(input.effectiveFrom);
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw HttpError.badRequest('That date is not valid.');
  }

  const created = await withTenant(auth.tenantId, async (db) => {
    const currency = await db.currency.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (currency === null) throw HttpError.notFound('Currency not found.');

    // Close the rate currently in force, so exactly one applies at any moment.
    await db.currencyRateHistory.updateMany({
      where: { currencyId: id, effectiveTo: null, deletedAt: null },
      data: { effectiveTo: effectiveFrom, updatedBy: auth.userId },
    });

    return db.currencyRateHistory.create({
      data: {
        tenantId: auth.tenantId,
        currencyId: id,
        rate: input.rate,
        effectiveFrom,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      },
      select: { id: true, rate: true, effectiveFrom: true, effectiveTo: true, isActive: true },
    });
  });

  const payload: ApiSuccess<CurrencyRateDto> = {
    success: true,
    data: {
      id: created.id.toString(),
      rate: created.rate.toFixed(4),
      effectiveFrom: created.effectiveFrom.toISOString(),
      effectiveTo: created.effectiveTo?.toISOString() ?? null,
      isActive: created.isActive,
    },
  };
  res.status(201).json(payload);
});

/** GET /api/tenant/setting/currencies/:id/rates — the §8 child screen. */
currencyRouter.get('/:id/rates', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'currency');

  const rates = await withTenant(auth.tenantId, (db) =>
    db.currencyRateHistory.findMany({
      where: { currencyId: id, deletedAt: null },
      select: { id: true, rate: true, effectiveFrom: true, effectiveTo: true, isActive: true },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    }),
  );

  const payload: ApiSuccess<CurrencyRateDto[]> = {
    success: true,
    data: rates.map((r) => ({
      id: r.id.toString(),
      rate: r.rate.toFixed(4),
      effectiveFrom: r.effectiveFrom.toISOString(),
      effectiveTo: r.effectiveTo?.toISOString() ?? null,
      isActive: r.isActive,
    })),
  };
  res.json(payload);
});

/** POST /api/tenant/setting/currencies/:id/toggle-status */
currencyRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'currency');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.currency.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, tenantId: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Currency not found.');

      if (existing.tenantId !== null) {
        const updated = await db.currency.update({
          where: { id },
          data: { isActive: !existing.isActive, updatedBy: auth.userId },
          select: { isActive: true },
        });
        return updated.isActive;
      }

      const override = await db.tenantMasterOverride.findFirst({
        where: { tableName: 'currency', recordId: id },
        select: { id: true, isActive: true },
      });

      if (override === null) {
        await db.tenantMasterOverride.create({
          data: {
            tenantId: auth.tenantId,
            tableName: 'currency',
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
 * DELETE /api/tenant/.../:id — CR-002.
 *
 * A soft delete: it sets `deleted_at`, so §4 rule 3 holds and every foreign key
 * survives. Refused when anything still references the row, and refused on a
 * shared system row — so it only ever removes a currency entered by mistake.
 */
currencyRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'currency');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.currency.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, currency: true },
    });
    await assertRowDeletable(
      db,
      'currency',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.currency },
      'Currency not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'currency', id, auth.userId);

    await db.currency.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});
