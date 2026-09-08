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
import { isoCurrency } from '../lib/currency-label';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { recordAudit } from '../lib/audit';
import { baseCurrency, rebase, resolveRates } from '../lib/currency-rate';
import { assertCustomisable, recordReplacement, repointReferences } from '../lib/customise';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
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
  is_base: boolean;
  /** Whether the built-in defaults are in this workspace's base. */
  system_base: boolean;
}

/**
 * Rates read at 10 decimals, money at 4.
 *
 * A rate can be small — BDT is 0.00833 of a US dollar — and trimming that to
 * four would show 0.0083, which is a different number. The amounts it produces
 * are still money and still shown to 4.
 */
function toDto(row: CurrencyRow): CurrencyDto {
  const conversion = row.conversion.toFixed(10);
  const tenantRate = row.tenant_rate === null ? null : row.tenant_rate.toFixed(10);
  /*
    Resolved exactly as lib/currency-rate resolves it, because a screen that
    shows a rate the server would refuse to convert with is worse than one that
    shows nothing. The base is 1 by definition; then the workspace's own rate;
    then the built-in default, and ONLY while that default is in this
    workspace's base. Otherwise there is no rate here yet, and the screen says
    so rather than printing a figure from another axis.
  */
  const effectiveRate = row.is_base
    ? '1.0000000000'
    : (tenantRate ?? (row.system_base ? conversion : null));
  return {
    id: row.id.toString(),
    code: row.code,
    currency: row.currency,
    conversion,
    tenantRate,
    effectiveRate,
    isBase: row.is_base,
    usingSystemDefault: !row.is_base && tenantRate === null && row.system_base,
    systemRateComparable: row.system_base,
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
      // CR-003: a shared row this workspace has REPLACED is gone from its
      // list entirely, not merely shown as inactive. Leaving it visible is
      // exactly the two-Chittagongs confusion customising exists to end.
      Prisma.sql`o.replaced_by IS NULL`,
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
      CROSS JOIN (
        SELECT t.currency_id, bc.conversion AS base_conversion
          FROM tenant t
          LEFT JOIN currency bc ON bc.id = t.currency_id
         WHERE t.id = ${auth.tenantId}
      ) b
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
             (c.tenant_id IS NULL) AS is_system,
             (c.id = b.currency_id) AS is_base,
             -- The built-in defaults are expressed against whichever shared
             -- currency sits at 1. They are comparable only while this
             -- workspace still books in that currency.
             COALESCE(b.base_conversion = 1, false) AS system_base
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


/**
 * POST /api/tenant/setting/currencies/:id/set-base
 *
 * Declares this workspace's base currency — client request, 2026-09-08.
 *
 * Changing it is not a label change. Every rate on file means "units of the
 * base per one unit of this currency", so a new base re-expresses all of them:
 * if USD was 120 of the old base, then in USD terms everything divides by 120.
 * Every ratio between two currencies survives, which is what makes it safe.
 *
 * Three things this deliberately does:
 *
 *   - writes an explicit workspace rate for EVERY currency it can see, even
 *     ones that were riding on the built-in default, because after the switch
 *     that default is in the wrong base and must never be fallen back to;
 *   - leaves every issued document alone. A quotation froze its rate when it
 *     was sent (§2.2) and restating a price a customer is holding would be
 *     worse than any rounding;
 *   - runs in one transaction. A half-applied rebase is a ledger where two
 *     currencies disagree about what the base is.
 */
currencyRouter.post(
  '/:id/set-base',
  // Not EDIT — §7's SET_BASE, because this re-expresses every rate the
  // workspace holds rather than correcting one of them.
  requirePermission(`${FEATURE}.SET_BASE`),
  async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'currency');

  const data = await withTenant(auth.tenantId, async (db) => {
    const target = await db.currency.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, code: true, currency: true, isActive: true },
    });
    if (target === null) throw HttpError.notFound('Currency not found.');

    // A workspace cannot book in a currency it has switched off for itself.
    const hidden = await inactiveMasters(db);
    const off = (hidden.get('currency') ?? []).some((x) => x === id);
    if (!target.isActive || off) {
      throw HttpError.conflict(
        `${target.currency} is switched off for this workspace. Turn it back on before making it the base.`,
      );
    }

    const current = await baseCurrency(db, auth.tenantId);
    if (current !== null && current.id === id) {
      // Nothing to do, and rebasing by 1 would write a pointless history row
      // against every currency.
      return { changed: false, base: target, rebased: 0 };
    }

    /*
     * Every currency this workspace can see, priced in the OLD base. Anything
     * it cannot price is excluded rather than assumed: a currency with no rate
     * has no position to move.
     */
    const visible = await db.currency.findMany({
      where: { deletedAt: null, ...excludeInactive(hidden, 'currency') },
      select: { id: true },
    });
    const ids = visible.map((c) => c.id);
    const before = await resolveRates(db, auth.tenantId, ids);

    const newBaseRate = before.get(id.toString());
    if (newBaseRate === undefined) {
      throw new HttpError(
        409,
        'RATE_NOT_SET',
        `There is no rate on file for ${target.currency}, so nothing can be expressed against it. ` +
          'Set its rate first, then make it the base.',
      );
    }

    const rows = rebase(
      ids
        .filter((cid) => before.has(cid.toString()))
        .map((cid) => ({ id: cid, rateInOldBase: before.get(cid.toString())!.rate })),
      id,
      newBaseRate.rate,
    );

    const now = new Date();
    for (const row of rows) {
      // Close whatever was in force, so exactly one rate applies at any moment
      // — the same rule POST /:id/rate keeps.
      await db.currencyRateHistory.updateMany({
        where: { currencyId: row.currencyId, effectiveTo: null, deletedAt: null },
        data: { effectiveTo: now, updatedBy: auth.userId },
      });
      await db.currencyRateHistory.create({
        data: {
          tenantId: auth.tenantId,
          currencyId: row.currencyId,
          rate: row.rate,
          effectiveFrom: now,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
      });
    }

    await db.tenant.update({ where: { id: auth.tenantId }, data: { currencyId: id } });

    return { changed: true, base: target, rebased: rows.length };
  });

  await recordAudit({
    tenantId: auth.tenantId,
    action: 'UPDATE',
    tableName: 'tenant',
    recordId: auth.tenantId,
    actorId: auth.userId,
    details: { baseCurrency: data.base.currency, rebasedRates: data.rebased },
  });

  const payload: ApiSuccess<{ baseCurrency: string; rebased: number; changed: boolean }> = {
    success: true,
    data: {
      baseCurrency: data.base.currency,
      rebased: data.rebased,
      changed: data.changed,
    },
  };
  res.json(payload);
});

/**
 * GET /api/tenant/setting/currencies/base — what this workspace books in.
 *
 * Its own endpoint because screens well outside Settings need it: every money
 * label in the product should say the workspace's currency rather than a
 * hardcoded dollar sign.
 */
currencyRouter.get('/base', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const base = await withTenant(auth.tenantId, (db) => baseCurrency(db, auth.tenantId));

  const payload: ApiSuccess<{ id: string; code: string; currency: string; iso: string } | null> = {
    success: true,
    data:
      base === null
        ? null
        : {
            id: base.id.toString(),
            code: base.code,
            currency: base.currency,
            iso: isoCurrency(base.currency),
          },
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

  const conversion = created.conversion.toFixed(10);
  const payload: ApiSuccess<CurrencyDto> = {
    success: true,
    data: {
      id: created.id.toString(),
      code: created.code,
      currency: created.currency,
      conversion,
      tenantRate: null,
      effectiveRate: conversion,
      // Newly added or just renamed: not the base, and no workspace rate yet.
      isBase: false,
      usingSystemDefault: true,
      // Freshly written by this workspace, so it is in whatever base they book
      // in — the list refreshes with the resolved answer either way.
      systemRateComparable: true,
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

  const conversion = updated.conversion.toFixed(10);
  const payload: ApiSuccess<CurrencyDto> = {
    success: true,
    data: {
      id: updated.id.toString(),
      code: updated.code,
      currency: updated.currency,
      conversion,
      tenantRate: null,
      effectiveRate: conversion,
      // Newly added or just renamed: not the base, and no workspace rate yet.
      isBase: false,
      usingSystemDefault: true,
      // Freshly written by this workspace, so it is in whatever base they book
      // in — the list refreshes with the resolved answer either way.
      systemRateComparable: true,
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

/**
 * POST /api/tenant/.../:id/customise — CR-003.
 *
 * §7A rule 7 forbids editing a shared row, and that stands: this copies it into
 * a row this workspace owns, moves the workspace's own references onto the
 * copy, and hides the original here alone. The shared row is never touched, so
 * every other workspace still sees it exactly as before.
 *
 * Repointing the references is the part that matters. Without it the copy would
 * begin life used by nothing while existing records still pointed at the shared
 * row — a second currency with the same name, which is the very problem this
 * is meant to end.
 */
currencyRouter.post(
  '/:id/customise',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'currency');

    const copyId = await withTenant(auth.tenantId, async (db) => {
      const shared = await db.currency.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, tenantId: true, currency: true, conversion: true },
      });
      await assertCustomisable(
        db,
        'currency',
        id,
        shared === null ? null : { tenantId: shared.tenantId, name: shared.currency },
        'Currency not found.',
      );
      if (shared === null) throw HttpError.notFound('Currency not found.');

      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
        const code = await nextCode(db, 'currency', CODE_PREFIX.currency, auth.tenantId);
        try {
          const copy = await db.currency.create({
            data: {
              tenantId: auth.tenantId,
              code,
              currency: shared.currency, conversion: shared.conversion,
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: { id: true },
          });

          await repointReferences(db, 'currency', id, copy.id);
          await recordReplacement(db, auth.tenantId, 'currency', id, copy.id, auth.userId);
          return copy.id;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new HttpError(500, 'CODE_EXHAUSTED', 'Could not allocate a code. Try again.');
    });

    const payload: ApiSuccess<{ id: string }> = { success: true, data: { id: copyId.toString() } };
    res.status(201).json(payload);
  },
);
