import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  isoCurrency,
  type TariffDto,
  tariffListQuerySchema,
  type TariffListRow,
  type TariffOptionsDto,
  tariffSaveSchema,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { parseId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';

/**
 * Purchase → Price List → Tariff (docs/DESIGN-UPDATE-2026-10-04.md §5).
 *
 * A master screen in the §8 pattern — list, a form on its own page (a header
 * and a grid is more than eight fields), Edit and Active/Inactive — over a
 * header and its lines. Saving replaces the lines: the old ones are retired,
 * not edited, so the audit trail shows the charges as they were.
 */

export const tariffRouter: Router = Router();
tariffRouter.use(authenticate);

const FEATURE = 'PURCHASE.TARIFF';

const TARIFF_SELECT = {
  id: true,
  code: true,
  country: true,
  movementType: true,
  tariffType: true,
  isActive: true,
  pol: { select: { id: true, name: true, portCode: true } },
} as const;

type TariffRecord = Prisma.TariffGetPayload<{ select: typeof TARIFF_SELECT }>;

function listRow(row: TariffRecord, lineCount: number): TariffListRow {
  return {
    id: row.id.toString(),
    code: row.code,
    country: row.country,
    polId: row.pol.id.toString(),
    polName: row.pol.name,
    polCode: row.pol.portCode,
    movementType: row.movementType,
    tariffType: row.tariffType,
    lineCount,
    isActive: row.isActive,
  };
}

tariffRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = tariffListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const where: Prisma.TariffWhereInput = {
      deletedAt: null,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.movementType === undefined ? {} : { movementType: query.movementType }),
      ...(query.tariffType === undefined ? {} : { tariffType: query.tariffType }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { country: { contains: query.search, mode: 'insensitive' } },
              { pol: { name: { contains: query.search, mode: 'insensitive' } } },
              { pol: { portCode: { contains: query.search, mode: 'insensitive' } } },
            ],
          }),
    };
    const sortable: Record<string, Prisma.TariffOrderByWithRelationInput> = {
      code: { code: query.sortOrder },
      pol: { pol: { name: query.sortOrder } },
      country: { country: query.sortOrder },
    };
    const [found, counted] = await Promise.all([
      db.tariff.findMany({
        where,
        orderBy: [sortable[query.sortBy ?? 'code'] ?? { code: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: { ...TARIFF_SELECT, _count: { select: { lines: { where: { deletedAt: null } } } } },
      }),
      db.tariff.count({ where }),
    ]);
    return { rows: found.map((r) => listRow(r, r._count.lines)), total: counted };
  });

  const payload: ApiSuccess<TariffListRow[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

/** The pickers, each narrowed to what this workspace may use (§7A rule 7). */
tariffRouter.get(
  '/options',
  requireAnyPermission(`${FEATURE}.CREATE`, `${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const data = await withTenant(auth.tenantId, async (db): Promise<TariffOptionsDto> => {
      const inactive = await inactiveMasters(db);
      const [ports, costHeads, containerSizes, costUnits, currencies] = await Promise.all([
        db.port.findMany({
          where: { ...excludeInactive(inactive, 'port'), deletedAt: null, isActive: true },
          select: { id: true, name: true, portCode: true, country: true },
          orderBy: { name: 'asc' },
        }),
        db.costHead.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        db.containerSize.findMany({
          where: { ...excludeInactive(inactive, 'container_size'), deletedAt: null, isActive: true },
          select: { id: true, code: true },
          orderBy: { sortOrder: 'asc' },
        }),
        db.costUnit.findMany({
          where: { ...excludeInactive(inactive, 'cost_unit'), deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        db.currency.findMany({
          where: { ...excludeInactive(inactive, 'currency'), deletedAt: null, isActive: true },
          select: { id: true, code: true, currency: true },
          orderBy: { code: 'asc' },
        }),
      ]);
      return {
        ports: ports.map((p) => ({ id: p.id.toString(), name: `${p.name} (${p.portCode})`, country: p.country, portCode: p.portCode })),
        costHeads: costHeads.map((h) => ({ id: h.id.toString(), name: h.name })),
        containerSizes: containerSizes.map((c) => ({ id: c.id.toString(), name: c.code })),
        costUnits: costUnits.map((u) => ({ id: u.id.toString(), name: u.name })),
        currencies: currencies.map((c) => ({ id: c.id.toString(), name: isoCurrency(c.currency) })),
      };
    });
    const payload: ApiSuccess<TariffOptionsDto> = { success: true, data };
    res.json(payload);
  },
);

async function loadTariff(db: TenantDb, id: bigint): Promise<TariffDto> {
  const row = await db.tariff.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...TARIFF_SELECT,
      lines: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          unitPrice: true,
          costHead: { select: { id: true, name: true } },
          containerSize: { select: { id: true, code: true } },
          costUnit: { select: { id: true, name: true } },
          currency: { select: { id: true, currency: true } },
        },
      },
    },
  });
  if (row === null) throw HttpError.notFound('Tariff not found.');
  return {
    ...listRow(row, row.lines.length),
    lines: row.lines.map((l) => ({
      id: l.id.toString(),
      costHeadId: l.costHead.id.toString(),
      costHeadName: l.costHead.name,
      containerSizeId: l.containerSize?.id.toString() ?? null,
      containerSizeName: l.containerSize?.code ?? null,
      costUnitId: l.costUnit.id.toString(),
      unitName: l.costUnit.name,
      unitPrice: l.unitPrice.toFixed(4),
      currencyId: l.currency.id.toString(),
      currencyCode: isoCurrency(l.currency.currency),
    })),
  };
}

tariffRouter.get('/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'tariff');
  const data = await withTenant(auth.tenantId, (db) => loadTariff(db, id));
  const payload: ApiSuccess<TariffDto> = { success: true, data };
  res.json(payload);
});

type SaveInput = ReturnType<typeof tariffSaveSchema.parse>;

/**
 * Every id the form sent must be a row this workspace can see and has not
 * switched off — the same narrowing the pickers apply, asked again on the way
 * in, because a request is not a form.
 *
 * The id and excludeInactive() both set `id`, so they sit in an AND. Spread
 * into one object, the `notIn` replaced the `in`: once a workspace had switched
 * off any shared container size, every save counted all the sizes it had left
 * and refused the tariff — and the POL lookup returned whichever port came first.
 */
async function checkReferences(db: TenantDb, input: SaveInput): Promise<{ country: string }> {
  const inactive = await inactiveMasters(db);
  const unique = (ids: (string | null)[]) => [...new Set(ids.filter((v): v is string => v !== null))].map((v) => BigInt(v));

  const port = await db.port.findFirst({
    where: { AND: [{ id: BigInt(input.polId) }, excludeInactive(inactive, 'port')], deletedAt: null, isActive: true },
    select: { country: true },
  });
  if (port === null) throw HttpError.badRequest('That POL is not available.');

  const checks: [string, number, Promise<number>][] = [];
  const heads = unique(input.lines.map((l) => l.costHeadId));
  checks.push(['cost head', heads.length, db.costHead.count({ where: { id: { in: heads }, deletedAt: null, isActive: true } })]);
  const sizes = unique(input.lines.map((l) => l.containerSizeId));
  checks.push([
    'container size',
    sizes.length,
    db.containerSize.count({
      where: { AND: [{ id: { in: sizes } }, excludeInactive(inactive, 'container_size')], deletedAt: null, isActive: true },
    }),
  ]);
  const units = unique(input.lines.map((l) => l.costUnitId));
  checks.push([
    'unit',
    units.length,
    db.costUnit.count({ where: { AND: [{ id: { in: units } }, excludeInactive(inactive, 'cost_unit')], deletedAt: null, isActive: true } }),
  ]);
  const currencies = unique(input.lines.map((l) => l.currencyId));
  checks.push([
    'currency',
    currencies.length,
    db.currency.count({
      where: { AND: [{ id: { in: currencies } }, excludeInactive(inactive, 'currency')], deletedAt: null, isActive: true },
    }),
  ]);
  for (const [what, wanted, found] of checks) {
    if ((await found) !== wanted) throw HttpError.badRequest(`A ${what} on one of the charges is not available.`);
  }
  return { country: port.country };
}

async function writeLines(db: TenantDb, tenantId: bigint, userId: bigint, tariffId: bigint, input: SaveInput): Promise<void> {
  await db.tariffLine.createMany({
    data: input.lines.map((line, index) => ({
      tenantId,
      tariffId,
      sortOrder: index,
      costHeadId: BigInt(line.costHeadId),
      containerSizeId: line.containerSizeId === null ? null : BigInt(line.containerSizeId),
      costUnitId: BigInt(line.costUnitId),
      unitPrice: new Prisma.Decimal(line.unitPrice),
      currencyId: BigInt(line.currencyId),
      createdBy: userId,
      updatedBy: userId,
    })),
  });
}

tariffRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = tariffSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const { country } = await checkReferences(db, input);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'tariff', CODE_PREFIX.tariff, auth.tenantId);
      try {
        const created = await db.tariff.create({
          data: {
            tenantId: auth.tenantId,
            code,
            country,
            polId: BigInt(input.polId),
            movementType: input.movementType,
            tariffType: input.tariffType,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: { id: true },
        });
        await writeLines(db, auth.tenantId, auth.userId, created.id, input);
        return loadTariff(db, created.id);
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a tariff code.');
  });

  const payload: ApiSuccess<TariffDto> = { success: true, data };
  res.status(201).json(payload);
});

tariffRouter.put('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'tariff');
  const input = tariffSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.tariff.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (existing === null) throw HttpError.notFound('Tariff not found.');
    const { country } = await checkReferences(db, input);
    await db.tariff.update({
      where: { id },
      data: {
        country,
        polId: BigInt(input.polId),
        movementType: input.movementType,
        tariffType: input.tariffType,
        updatedBy: auth.userId,
      },
    });
    // Retired rather than edited: the audit trail keeps the old charges.
    await db.tariffLine.updateMany({
      where: { tariffId: id, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
    await writeLines(db, auth.tenantId, auth.userId, id, input);
    return loadTariff(db, id);
  });

  const payload: ApiSuccess<TariffDto> = { success: true, data };
  res.json(payload);
});

tariffRouter.post('/:id/toggle-status', requirePermission(`${FEATURE}.TOGGLE_STATUS`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'tariff');
  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.tariff.findFirst({ where: { id, deletedAt: null }, select: { isActive: true } });
    if (existing === null) throw HttpError.notFound('Tariff not found.');
    await db.tariff.update({ where: { id }, data: { isActive: !existing.isActive, updatedBy: auth.userId } });
    return loadTariff(db, id);
  });
  const payload: ApiSuccess<TariffDto> = { success: true, data };
  res.json(payload);
});
