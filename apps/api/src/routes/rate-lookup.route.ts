import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  type ContainerSizeDto,
  containerSizeInputSchema,
  type GoodsTypeDto,
  goodsTypeInputSchema,
  type InquirySourceDto,
  inquirySourceInputSchema,
  listQuerySchema,
  type LookupOption,
  type RateMode,
  type RateTierDto,
  rateTierInputSchema,
  rateTierListQuerySchema,
  type RateTierUnit,
  type TosDto,
  tosInputSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { recordReplacement, repointReferences } from '../lib/customise';
import { HttpError } from '../lib/http-error';
import {
  type CodeHolder,
  codeHeldBy,
  excludeInactive,
  inactiveMasters,
} from '../lib/master-visibility';
import { assertDeletable } from '../lib/references';
import { parseId, parseRefId } from '../lib/request';
import {
  assertEditable,
  type DeletableLookupModel,
  deleteLookupRow,
  listSystemLookup,
  type LookupRow,
  type LookupTable,
  removeSharedRow,
  replaceSharedLookup,
  sharedRowOverride,
  type SimpleLookupModel,
  toggleSystemLookup,
} from '../lib/system-lookup';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → the five §3.1 Purchase & Sales lookups.
 *
 * Structurally the Sea-Air Port reference implementation, five times over, with
 * the shared parts factored into lib/system-lookup. Each is system-capable: a
 * workspace sees the seeded rows plus its own, may add its own, and may switch
 * any off for itself.
 *
 * Since 2026-09-25 it may also Edit and Delete a shared one, at the client's
 * request — without §7A rule 7 moving. Edit makes the workspace's own copy
 * (`/customise`), Delete takes the row off this workspace's list; the shared
 * row itself is never written by either.
 */
export const rateLookupRouter: Router = Router();

rateLookupRouter.use(authenticate);

const decimal = (value: unknown): string =>
  value instanceof Prisma.Decimal ? value.toFixed(2) : String(value ?? '0');

const optionalDecimal = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Prisma.Decimal(String(value)).toFixed(3);

/**
 * Codes are unique per tenant, and a workspace cannot shadow a shared code it
 * is still using.
 *
 * "Still using" is the part that was missing. A shared row the workspace has
 * switched off, or replaced with a customised copy, is gone from every picker
 * — and went on holding its code anyway, which left no way to replace a shared
 * row at all: deleting one is refused by design, so deactivating it is the only
 * route, and that was exactly what blocked the replacement.
 */
async function assertCodeFree(
  db: Parameters<typeof listSystemLookup>[0],
  model: { findMany: (args: never) => Promise<CodeHolder[]> },
  table: string,
  code: string,
  excludeId?: bigint,
): Promise<void> {
  const holders = await (
    model.findMany as unknown as (args: unknown) => Promise<CodeHolder[]>
  )({
    where: {
      code,
      deletedAt: null,
      ...(excludeId === undefined ? {} : { NOT: { id: excludeId } }),
    },
    select: { id: true, tenantId: true },
  });

  const held = codeHeldBy(holders, await inactiveMasters(db), table);
  if (held === null) return;

  throw HttpError.conflict(
    held.shared
      ? `Code ${code} belongs to a row shared with every workspace. ` +
          'Deactivate it here first, or customise it to make your own copy.'
      : `Code ${code} is already in use.`,
  );
}

/** An insert of a workspace's own row, with a code clash said in words. */
async function createOwn<T>(code: string, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (isUniqueViolation(error, 'code')) throw HttpError.conflict(`Code ${code} is already in use.`);
    throw error;
  }
}

/**
 * DELETE /…/:id for one lookup. The workspace's own row is soft-deleted; a
 * shared one is taken off this workspace's list. lib/system-lookup has why.
 */
function registerDelete(
  path: string,
  table: LookupTable,
  feature: string,
  noun: string,
  model: (db: TenantDb) => DeletableLookupModel,
  onSharedRemoval?: (db: TenantDb, tenantId: bigint, userId: bigint, id: bigint) => Promise<void>,
): void {
  rateLookupRouter.delete(`/${path}/:id`, requirePermission(`${feature}.DELETE`), async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, noun);

    await withTenant(auth.tenantId, (db) =>
      deleteLookupRow({
        db,
        tenantId: auth.tenantId,
        userId: auth.userId,
        table,
        model: model(db),
        id,
        notFoundMessage: `${noun.charAt(0).toUpperCase()}${noun.slice(1)} not found.`,
        ...(onSharedRemoval === undefined
          ? {}
          : { onSharedRemoval: () => onSharedRemoval(db, auth.tenantId, auth.userId, id) }),
      }),
    );

    const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
    res.json(payload);
  });
}

// ===========================================================================
// Goods Type
// ===========================================================================

const GOODS_FEATURE = 'SETTING.GOODS_TYPE';

rateLookupRouter.get('/goods-types', requirePermission(`${GOODS_FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = listQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, (db) =>
    listSystemLookup(db, auth.tenantId, 'goodsType', {
      search: query.search,
      isActive: query.isActive,
      page: query.page,
      limit: query.limit,
      orderBy: 'l.name ASC',
      extraColumns: 'l.description',
    }),
  );

  const payload: ApiSuccess<GoodsTypeDto[]> = {
    success: true,
    data: result.rows.map((r: LookupRow) => ({
      id: r.id.toString(),
      code: r.code,
      name: r.name,
      description: (r['description'] as string | null) ?? null,
      isActive: r.effective_is_active,
      isSystem: r.is_system,
    })),
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

rateLookupRouter.post('/goods-types', requirePermission(`${GOODS_FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = goodsTypeInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    await assertCodeFree(db, db.goodsType as never, 'goods_type', input.code);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      try {
        return await db.goodsType.create({
          data: {
            tenantId: auth.tenantId,
            code: input.code,
            name: input.name,
            description: input.description || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: { id: true, code: true, name: true, description: true, isActive: true },
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) {
          throw HttpError.conflict(`Code ${input.code} is already in use.`);
        }
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not create the goods type.');
  });

  const payload: ApiSuccess<GoodsTypeDto> = {
    success: true,
    data: { ...created, id: created.id.toString(), isSystem: false },
  };
  res.status(201).json(payload);
});

rateLookupRouter.patch('/goods-types/:id', requirePermission(`${GOODS_FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'goods type');
  const input = goodsTypeInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.goodsType.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true },
    });
    if (existing === null) throw HttpError.notFound('Goods type not found.');
    assertEditable(existing.tenantId, 'goods type');
    await assertCodeFree(db, db.goodsType as never, 'goods_type', input.code, id);

    return db.goodsType.update({
      where: { id },
      data: {
        code: input.code,
        name: input.name,
        description: input.description || null,
        updatedBy: auth.userId,
      },
      select: { id: true, code: true, name: true, description: true, isActive: true },
    });
  });

  const payload: ApiSuccess<GoodsTypeDto> = {
    success: true,
    data: { ...updated, id: updated.id.toString(), isSystem: false },
  };
  res.json(payload);
});

rateLookupRouter.post(
  '/goods-types/:id/toggle-status',
  requirePermission(`${GOODS_FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'goods type');
    const isActive = await withTenant(auth.tenantId, (db) =>
      toggleSystemLookup(db, auth.tenantId, auth.userId, 'goodsType', db.goodsType, id, 'Goods type not found.'),
    );
    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

/** Edit on a shared goods type: the workspace's own copy, with the changes. */
rateLookupRouter.post(
  '/goods-types/:id/customise',
  requirePermission(`${GOODS_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'goods type');
    const input = goodsTypeInputSchema.parse(req.body);

    const copyId = await withTenant(auth.tenantId, async (db) =>
      replaceSharedLookup({
        db,
        tenantId: auth.tenantId,
        userId: auth.userId,
        table: 'goodsType',
        id,
        shared: await db.goodsType.findFirst({
          where: { id, deletedAt: null },
          select: { tenantId: true, code: true, isActive: true },
        }),
        notFoundMessage: 'Goods type not found.',
        createCopy: async (isActive) => {
          await assertCodeFree(db, db.goodsType as never, 'goods_type', input.code, id);
          const copy = await createOwn(input.code, () =>
            db.goodsType.create({
              data: {
                tenantId: auth.tenantId,
                code: input.code,
                name: input.name,
                description: input.description || null,
                isActive,
                createdBy: auth.userId,
                updatedBy: auth.userId,
              },
              select: { id: true },
            }),
          );
          return copy.id;
        },
      }),
    );

    const payload: ApiSuccess<{ id: string }> = { success: true, data: { id: copyId.toString() } };
    res.status(201).json(payload);
  },
);

registerDelete(
  'goods-types',
  'goodsType',
  GOODS_FEATURE,
  'goods type',
  (db) => db.goodsType as unknown as DeletableLookupModel,
);

// ===========================================================================
// Container Size
// ===========================================================================

/** '' means the user left it blank, which is not the same as zero. */
const capacity = (value: string | undefined): string | null =>
  value === undefined || value.trim() === '' ? null : value.trim();

/** A stored capacity for reading. Null stays null — "not recorded" is a fact. */
const capacityOut = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Prisma.Decimal(String(value)).toFixed(2);

const CONTAINER_SELECT = {
  id: true,
  code: true,
  name: true,
  teuFactor: true,
  sortOrder: true,
  maxVolumeCbm: true,
  maxWeightKg: true,
  tareWeightKg: true,
  isActive: true,
} as const;

const CONTAINER_FEATURE = 'SETTING.CONTAINER_SIZE';

rateLookupRouter.get(
  '/container-sizes',
  requirePermission(`${CONTAINER_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const query = listQuerySchema.parse(req.query);

    const result = await withTenant(auth.tenantId, (db) =>
      listSystemLookup(db, auth.tenantId, 'containerSize', {
        search: query.search,
        isActive: query.isActive,
        page: query.page,
        limit: query.limit,
        orderBy: 'l.sort_order ASC, l.code ASC',
        extraColumns: 'l.teu_factor, l.sort_order, l.max_volume_cbm, l.max_weight_kg, l.tare_weight_kg',
      }),
    );

    const payload: ApiSuccess<ContainerSizeDto[]> = {
      success: true,
      data: result.rows.map((r) => ({
        id: r.id.toString(),
        code: r.code,
        name: r.name,
        teuFactor: decimal(r['teu_factor']),
        sortOrder: Number(r['sort_order'] ?? 0),
        maxVolumeCbm: capacityOut(r['max_volume_cbm']),
        maxWeightKg: capacityOut(r['max_weight_kg']),
        tareWeightKg: capacityOut(r['tare_weight_kg']),
        isActive: r.effective_is_active,
        isSystem: r.is_system,
      })),
      meta: buildMeta(query.page, query.limit, result.total),
    };
    res.json(payload);
  },
);

rateLookupRouter.post(
  '/container-sizes',
  requirePermission(`${CONTAINER_FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const input = containerSizeInputSchema.parse(req.body);

    const created = await withTenant(auth.tenantId, async (db) => {
      await assertCodeFree(db, db.containerSize as never, 'container_size', input.code);
      return db.containerSize.create({
        data: {
          tenantId: auth.tenantId,
          code: input.code,
          name: input.name,
          teuFactor: input.teuFactor,
          sortOrder: input.sortOrder === undefined || input.sortOrder === '' ? 0 : Number(input.sortOrder),
          maxVolumeCbm: capacity(input.maxVolumeCbm),
          maxWeightKg: capacity(input.maxWeightKg),
          tareWeightKg: capacity(input.tareWeightKg),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: CONTAINER_SELECT,
      });
    });

    const payload: ApiSuccess<ContainerSizeDto> = {
      success: true,
      data: {
        id: created.id.toString(),
        code: created.code,
        name: created.name,
        teuFactor: created.teuFactor.toFixed(2),
        sortOrder: created.sortOrder,
        maxVolumeCbm: capacityOut(created.maxVolumeCbm),
        maxWeightKg: capacityOut(created.maxWeightKg),
        tareWeightKg: capacityOut(created.tareWeightKg),
        isActive: created.isActive,
        isSystem: false,
      },
    };
    res.status(201).json(payload);
  },
);

rateLookupRouter.patch(
  '/container-sizes/:id',
  requirePermission(`${CONTAINER_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'container size');
    const input = containerSizeInputSchema.parse(req.body);

    const updated = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.containerSize.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, tenantId: true },
      });
      if (existing === null) throw HttpError.notFound('Container size not found.');
      assertEditable(existing.tenantId, 'container size');
      await assertCodeFree(db, db.containerSize as never, 'container_size', input.code, id);

      return db.containerSize.update({
        where: { id },
        data: {
          code: input.code,
          name: input.name,
          teuFactor: input.teuFactor,
          sortOrder: input.sortOrder === undefined || input.sortOrder === '' ? 0 : Number(input.sortOrder),
          maxVolumeCbm: capacity(input.maxVolumeCbm),
          maxWeightKg: capacity(input.maxWeightKg),
          tareWeightKg: capacity(input.tareWeightKg),
          updatedBy: auth.userId,
        },
        select: CONTAINER_SELECT,
      });
    });

    const payload: ApiSuccess<ContainerSizeDto> = {
      success: true,
      data: {
        id: updated.id.toString(),
        code: updated.code,
        name: updated.name,
        teuFactor: updated.teuFactor.toFixed(2),
        sortOrder: updated.sortOrder,
        maxVolumeCbm: capacityOut(updated.maxVolumeCbm),
        maxWeightKg: capacityOut(updated.maxWeightKg),
        tareWeightKg: capacityOut(updated.tareWeightKg),
        isActive: updated.isActive,
        isSystem: false,
      },
    };
    res.json(payload);
  },
);

rateLookupRouter.post(
  '/container-sizes/:id/toggle-status',
  requirePermission(`${CONTAINER_FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'container size');
    const isActive = await withTenant(auth.tenantId, (db) =>
      toggleSystemLookup(
        db,
        auth.tenantId,
        auth.userId,
        'containerSize',
        db.containerSize,
        id,
        'Container size not found.',
      ),
    );
    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

/**
 * The shared Sea FCL rate tiers built on a shared container size, which this
 * workspace has not already replaced or deleted for itself.
 */
async function sharedTiersOn(db: TenantDb, containerSizeId: bigint) {
  const tiers = await db.rateTier.findMany({
    where: { containerSizeId, tenantId: null, deletedAt: null },
    select: {
      id: true,
      code: true,
      mode: true,
      label: true,
      unit: true,
      minValue: true,
      maxValue: true,
      sortOrder: true,
      isActive: true,
    },
    orderBy: { id: 'asc' },
  });
  const live = [];
  for (const tier of tiers) {
    const override = await sharedRowOverride(db, 'rateTier', tier.id);
    if (override?.replacedBy != null || override?.removedAt != null) continue;
    live.push({ ...tier, isActiveHere: tier.isActive && (override?.isActive ?? true) });
  }
  return live;
}

/**
 * Editing a shared container size takes its shared rate tiers along.
 *
 * The quotation pull matches an inquiry's container to a rate by comparing
 * the volume's container_size_id with the tier's. The volumes move onto the
 * copy; the seeded FCL-20STD tier is shared and cannot, so without this every
 * 20STD rate this workspace holds would stop matching the moment it edited
 * 20STD. Each tier gets the same treatment as its container: an own copy
 * naming the new container, this workspace's rate lines moved onto it, and the
 * shared tier hidden here alone.
 *
 * One exception: a shared tier the workspace had switched off and then reused
 * the code of for its own. It is out of every picker already, and its code is
 * taken, so it is left where it is.
 */
async function carrySharedTiers(
  db: TenantDb,
  tenantId: bigint,
  userId: bigint,
  sharedContainerId: bigint,
  copyContainerId: bigint,
): Promise<void> {
  for (const tier of await sharedTiersOn(db, sharedContainerId)) {
    const clash = await db.rateTier.findFirst({
      where: { code: tier.code, tenantId: { not: null }, deletedAt: null },
      select: { id: true },
    });
    if (clash !== null) continue;

    const copy = await db.rateTier.create({
      data: {
        tenantId,
        code: tier.code,
        mode: tier.mode,
        label: tier.label,
        unit: tier.unit,
        minValue: tier.minValue,
        maxValue: tier.maxValue,
        sortOrder: tier.sortOrder,
        containerSizeId: copyContainerId,
        isActive: tier.isActiveHere,
        createdBy: userId,
        updatedBy: userId,
      },
      select: { id: true },
    });
    await repointReferences(db, 'rate_tier', tier.id, copy.id);
    await recordReplacement(db, tenantId, 'rate_tier', tier.id, copy.id, userId);
  }
}

/** Edit on a shared container size: the workspace's own copy, with the changes. */
rateLookupRouter.post(
  '/container-sizes/:id/customise',
  requirePermission(`${CONTAINER_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'container size');
    const input = containerSizeInputSchema.parse(req.body);

    const copyId = await withTenant(auth.tenantId, async (db) =>
      replaceSharedLookup({
        db,
        tenantId: auth.tenantId,
        userId: auth.userId,
        table: 'containerSize',
        id,
        shared: await db.containerSize.findFirst({
          where: { id, deletedAt: null },
          select: { tenantId: true, code: true, isActive: true },
        }),
        notFoundMessage: 'Container size not found.',
        createCopy: async (isActive) => {
          await assertCodeFree(db, db.containerSize as never, 'container_size', input.code, id);
          const copy = await createOwn(input.code, () =>
            db.containerSize.create({
              data: {
                tenantId: auth.tenantId,
                code: input.code,
                name: input.name,
                teuFactor: input.teuFactor,
                sortOrder:
                  input.sortOrder === undefined || input.sortOrder === '' ? 0 : Number(input.sortOrder),
                maxVolumeCbm: capacity(input.maxVolumeCbm),
                maxWeightKg: capacity(input.maxWeightKg),
                tareWeightKg: capacity(input.tareWeightKg),
                isActive,
                createdBy: auth.userId,
                updatedBy: auth.userId,
              },
              select: { id: true },
            }),
          );
          return copy.id;
        },
        afterRepoint: (copyId) => carrySharedTiers(db, auth.tenantId, auth.userId, id, copyId),
      }),
    );

    const payload: ApiSuccess<{ id: string }> = { success: true, data: { id: copyId.toString() } };
    res.status(201).json(payload);
  },
);

/*
  Deleting a shared container size takes its shared tiers off the list too —
  a 20STD column with no 20STD to pick is the same half-state the edit avoids.
  Refused if this workspace's rates use one of those tiers, with the tier
  named, because "used by 3 purchase rate lines" on a container is otherwise a
  puzzle.
*/
registerDelete(
  'container-sizes',
  'containerSize',
  CONTAINER_FEATURE,
  'container size',
  (db) => db.containerSize as unknown as DeletableLookupModel,
  async (db, tenantId, userId, id) => {
    const container = await db.containerSize.findFirst({ where: { id }, select: { code: true } });
    for (const tier of await sharedTiersOn(db, id)) {
      await assertDeletable(db, 'rate_tier', tier.id, `${container?.code ?? 'This container'}'s rate tier ${tier.code}`, {
        ownRowsOnly: true,
      });
      await removeSharedRow(db, tenantId, 'rate_tier', tier.id, userId);
    }
  },
);

// ===========================================================================
// Rate Tier — the table §2 exists for
// ===========================================================================

const TIER_FEATURE = 'SETTING.RATE_TIER';

rateLookupRouter.get('/rate-tiers', requirePermission(`${TIER_FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = rateTierListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, (db) =>
    listSystemLookup(db, auth.tenantId, 'rateTier', {
      search: query.search,
      isActive: query.isActive,
      page: query.page,
      limit: query.limit,
      orderBy: 'l.mode ASC, l.sort_order ASC',
      nameColumn: 'l.label',
      extraColumns:
        'l.mode, l.label, l.unit, l.min_value, l.max_value, l.sort_order, l.container_size_id, ct.name AS container_size_name',
      extraJoin: Prisma.sql`LEFT JOIN container_size ct ON ct.id = l.container_size_id`,
      searchColumns: ['l.label'],
      ...(query.mode === undefined
        ? {}
        : { extraConditions: [Prisma.sql`l.mode = ${query.mode}::rate_mode`] }),
    }),
  );

  const payload: ApiSuccess<RateTierDto[]> = {
    success: true,
    data: result.rows.map((r) => ({
      id: r.id.toString(),
      code: r.code,
      name: r.name,
      mode: r['mode'] as RateMode,
      label: r['label'] as string,
      unit: r['unit'] as RateTierUnit,
      minValue: optionalDecimal(r['min_value']),
      maxValue: optionalDecimal(r['max_value']),
      sortOrder: Number(r['sort_order'] ?? 0),
      containerSizeId: r['container_size_id'] === null ? null : String(r['container_size_id']),
      containerSizeName: (r['container_size_name'] as string | null) ?? null,
      isActive: r.effective_is_active,
      isSystem: r.is_system,
    })),
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** Container sizes for the Sea FCL tier form. */
rateLookupRouter.get(
  '/rate-tiers/container-options',
  requirePermission(`${TIER_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const rows = await withTenant(auth.tenantId, async (db) => {
      // See carrier.route.ts: a deactivated shared row is an override, not a flag.
      const inactive = await inactiveMasters(db);
      return db.containerSize.findMany({
        where: { ...excludeInactive(inactive, 'container_size'), deletedAt: null, isActive: true },
        select: { id: true, name: true, code: true },
        orderBy: { sortOrder: 'asc' },
      });
    });
    const payload: ApiSuccess<LookupOption[]> = {
      success: true,
      data: rows.map((r) => ({ id: r.id.toString(), name: `${r.code} — ${r.name}` })),
    };
    res.json(payload);
  },
);

/**
 * `name` is not a rate_tier column — the client shows a label. It is stored as
 * the label so the shared lookup helper, which selects code and name, works
 * unchanged across all five tables.
 */
function tierWriteData(input: ReturnType<typeof rateTierInputSchema.parse>, userId: bigint) {
  return {
    code: input.code,
    mode: input.mode,
    label: input.label,
    unit: input.unit,
    minValue: input.minValue === undefined || input.minValue === '' ? null : input.minValue,
    maxValue: input.maxValue === undefined || input.maxValue === '' ? null : input.maxValue,
    sortOrder: input.sortOrder === undefined || input.sortOrder === '' ? 0 : Number(input.sortOrder),
    updatedBy: userId,
  };
}

/** The container a new tier names: required for Sea FCL, and it has to exist. */
async function tierContainer(
  db: TenantDb,
  input: ReturnType<typeof rateTierInputSchema.parse>,
): Promise<bigint | null> {
  const containerSizeId =
    input.containerSizeId === undefined || input.containerSizeId === ''
      ? null
      : parseRefId(input.containerSizeId, 'container size');

  if (input.mode === 'SEA_FCL' && containerSizeId === null) {
    throw HttpError.badRequest('A Sea FCL tier must name a container size.');
  }
  if (containerSizeId !== null) {
    const container = await db.containerSize.findFirst({
      where: { id: containerSizeId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (container === null) throw HttpError.badRequest('That container size is not available.');
  }
  return containerSizeId;
}

rateLookupRouter.post('/rate-tiers', requirePermission(`${TIER_FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = rateTierInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    await assertCodeFree(db, db.rateTier as never, 'rate_tier', input.code);
    const containerSizeId = await tierContainer(db, input);

    return db.rateTier.create({
      data: {
        tenantId: auth.tenantId,
        ...tierWriteData(input, auth.userId),
        containerSizeId,
        createdBy: auth.userId,
      },
      select: {
        id: true,
        code: true,
        mode: true,
        label: true,
        unit: true,
        minValue: true,
        maxValue: true,
        sortOrder: true,
        containerSizeId: true,
        isActive: true,
        containerSize: { select: { name: true } },
      },
    });
  });

  const payload: ApiSuccess<RateTierDto> = {
    success: true,
    data: {
      id: created.id.toString(),
      code: created.code,
      name: created.label,
      mode: created.mode,
      label: created.label,
      unit: created.unit,
      minValue: created.minValue?.toFixed(3) ?? null,
      maxValue: created.maxValue?.toFixed(3) ?? null,
      sortOrder: created.sortOrder,
      containerSizeId: created.containerSizeId?.toString() ?? null,
      containerSizeName: created.containerSize?.name ?? null,
      isActive: created.isActive,
      isSystem: false,
    },
  };
  res.status(201).json(payload);
});

rateLookupRouter.patch('/rate-tiers/:id', requirePermission(`${TIER_FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'rate tier');
  const input = rateTierInputSchema.parse(req.body);
  const containerSizeId =
    input.containerSizeId === undefined || input.containerSizeId === ''
      ? null
      : parseRefId(input.containerSizeId, 'container size');

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.rateTier.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true },
    });
    if (existing === null) throw HttpError.notFound('Rate tier not found.');
    assertEditable(existing.tenantId, 'rate tier');
    await assertCodeFree(db, db.rateTier as never, 'rate_tier', input.code, id);

    if (input.mode === 'SEA_FCL' && containerSizeId === null) {
      throw HttpError.badRequest('A Sea FCL tier must name a container size.');
    }

    return db.rateTier.update({
      where: { id },
      data: { ...tierWriteData(input, auth.userId), containerSizeId },
      select: {
        id: true,
        code: true,
        mode: true,
        label: true,
        unit: true,
        minValue: true,
        maxValue: true,
        sortOrder: true,
        containerSizeId: true,
        isActive: true,
        containerSize: { select: { name: true } },
      },
    });
  });

  const payload: ApiSuccess<RateTierDto> = {
    success: true,
    data: {
      id: updated.id.toString(),
      code: updated.code,
      name: updated.label,
      mode: updated.mode,
      label: updated.label,
      unit: updated.unit,
      minValue: updated.minValue?.toFixed(3) ?? null,
      maxValue: updated.maxValue?.toFixed(3) ?? null,
      sortOrder: updated.sortOrder,
      containerSizeId: updated.containerSizeId?.toString() ?? null,
      containerSizeName: updated.containerSize?.name ?? null,
      isActive: updated.isActive,
      isSystem: false,
    },
  };
  res.json(payload);
});

rateLookupRouter.post(
  '/rate-tiers/:id/toggle-status',
  requirePermission(`${TIER_FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'rate tier');
    const isActive = await withTenant(auth.tenantId, (db) =>
      toggleSystemLookup(db, auth.tenantId, auth.userId, 'rateTier', db.rateTier, id, 'Rate tier not found.'),
    );
    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

/** Edit on a shared rate tier: the workspace's own copy, with the changes. */
rateLookupRouter.post(
  '/rate-tiers/:id/customise',
  requirePermission(`${TIER_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'rate tier');
    const input = rateTierInputSchema.parse(req.body);

    const copyId = await withTenant(auth.tenantId, async (db) =>
      replaceSharedLookup({
        db,
        tenantId: auth.tenantId,
        userId: auth.userId,
        table: 'rateTier',
        id,
        shared: await db.rateTier.findFirst({
          where: { id, deletedAt: null },
          select: { tenantId: true, code: true, isActive: true },
        }),
        notFoundMessage: 'Rate tier not found.',
        createCopy: async (isActive) => {
          await assertCodeFree(db, db.rateTier as never, 'rate_tier', input.code, id);
          const containerSizeId = await tierContainer(db, input);
          const copy = await createOwn(input.code, () =>
            db.rateTier.create({
              data: {
                tenantId: auth.tenantId,
                ...tierWriteData(input, auth.userId),
                containerSizeId,
                isActive,
                createdBy: auth.userId,
              },
              select: { id: true },
            }),
          );
          return copy.id;
        },
      }),
    );

    const payload: ApiSuccess<{ id: string }> = { success: true, data: { id: copyId.toString() } };
    res.status(201).json(payload);
  },
);

registerDelete(
  'rate-tiers',
  'rateTier',
  TIER_FEATURE,
  'rate tier',
  (db) => db.rateTier as unknown as DeletableLookupModel,
);

// ===========================================================================
// TOS and Inquiry Source — code + name only, so they share one shape
// ===========================================================================

function registerSimpleLookup(
  path: 'tos' | 'inquiry-sources' | 'modes',
  table: 'tos' | 'inquirySource' | 'mode',
  feature: string,
  noun: string,
  schema: typeof tosInputSchema,
  /** Only `tos` has a sort_order to read; the others go by code. */
  orderBy = 'l.code ASC',
): void {
  const model = (db: Parameters<typeof toggleSystemLookup>[0]): SimpleLookupModel => {
    const chosen = table === 'tos' ? db.tos : table === 'mode' ? db.mode : db.inquirySource;
    return chosen as unknown as SimpleLookupModel;
  };

  /*
    tenant_master_override records the DATABASE table name, and `table` above
    is the Prisma model key. For tos and mode the two spellings coincide, which
    is exactly why inquirySource was the only one to go wrong — it is stored as
    inquiry_source, so nothing matched and a row the workspace had switched off
    went on holding its code.
  */
  const overrideTable = table === 'inquirySource' ? 'inquiry_source' : table;

  rateLookupRouter.get(`/${path}`, requirePermission(`${feature}.VIEW`), async (req, res) => {
    const auth = req.auth!;
    const query = listQuerySchema.parse(req.query);
    const result = await withTenant(auth.tenantId, (db) =>
      listSystemLookup(db, auth.tenantId, table, {
        search: query.search,
        isActive: query.isActive,
        page: query.page,
        limit: query.limit,
        orderBy,
      }),
    );

    const payload: ApiSuccess<TosDto[] | InquirySourceDto[]> = {
      success: true,
      data: result.rows.map((r) => ({
        id: r.id.toString(),
        code: r.code,
        name: r.name,
        isActive: r.effective_is_active,
        isSystem: r.is_system,
      })),
      meta: buildMeta(query.page, query.limit, result.total),
    };
    res.json(payload);
  });

  rateLookupRouter.post(`/${path}`, requirePermission(`${feature}.CREATE`), async (req, res) => {
    const auth = req.auth!;
    const input = schema.parse(req.body);
    const created = await withTenant(auth.tenantId, async (db) => {
      await assertCodeFree(db, model(db) as never, overrideTable, input.code);
      return model(db).create({
        data: {
          tenantId: auth.tenantId,
          code: input.code,
          name: input.name,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: { id: true, code: true, name: true, isActive: true },
      });
    });

    const payload: ApiSuccess<TosDto> = {
      success: true,
      data: { ...created, id: created.id.toString(), isSystem: false },
    };
    res.status(201).json(payload);
  });

  rateLookupRouter.patch(`/${path}/:id`, requirePermission(`${feature}.EDIT`), async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, noun);
    const input = schema.parse(req.body);

    const updated = await withTenant(auth.tenantId, async (db) => {
      const existing = await model(db).findFirst({
        where: { id, deletedAt: null },
        select: { id: true, tenantId: true },
      });
      if (existing === null) throw HttpError.notFound(`${noun} not found.`);
      assertEditable(existing.tenantId, noun);
      await assertCodeFree(db, model(db) as never, overrideTable, input.code, id);

      return model(db).update({
        where: { id },
        data: { code: input.code, name: input.name, updatedBy: auth.userId },
        select: { id: true, code: true, name: true, isActive: true },
      });
    });

    const payload: ApiSuccess<TosDto> = {
      success: true,
      data: { ...updated, id: updated.id.toString(), isSystem: false },
    };
    res.json(payload);
  });

  rateLookupRouter.post(
    `/${path}/:id/toggle-status`,
    requirePermission(`${feature}.TOGGLE_STATUS`),
    async (req, res) => {
      const auth = req.auth!;
      const id = parseId(req.params.id, noun);
      const isActive = await withTenant(auth.tenantId, (db) =>
        toggleSystemLookup(db, auth.tenantId, auth.userId, table, model(db) as never, id, `${noun} not found.`),
      );
      const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
      res.json(payload);
    },
  );

  /** Edit on a shared row: the workspace's own copy, with the changes. */
  rateLookupRouter.post(
    `/${path}/:id/customise`,
    requirePermission(`${feature}.EDIT`),
    async (req, res) => {
      const auth = req.auth!;
      const id = parseId(req.params.id, noun);
      const input = schema.parse(req.body);

      const copyId = await withTenant(auth.tenantId, async (db) => {
        // EXW…DDP is read in order, so a TOS copy takes the shared row's place
        // in it rather than jumping to the top at 0.
        const sortOrder =
          table === 'tos'
            ? (await db.tos.findFirst({ where: { id }, select: { sortOrder: true } }))?.sortOrder
            : undefined;

        return replaceSharedLookup({
          db,
          tenantId: auth.tenantId,
          userId: auth.userId,
          table,
          id,
          shared: await model(db).findFirst({
            where: { id, deletedAt: null },
            select: { id: true, tenantId: true, code: true, isActive: true },
          }),
          notFoundMessage: `${noun} not found.`,
          createCopy: async (isActive) => {
            await assertCodeFree(db, model(db) as never, overrideTable, input.code, id);
            const copy = await createOwn(input.code, () =>
              model(db).create({
                data: {
                  tenantId: auth.tenantId,
                  code: input.code,
                  name: input.name,
                  ...(sortOrder === undefined ? {} : { sortOrder }),
                  isActive,
                  createdBy: auth.userId,
                  updatedBy: auth.userId,
                },
                select: { id: true, code: true, name: true, isActive: true },
              }),
            );
            return copy.id;
          },
        });
      });

      const payload: ApiSuccess<{ id: string }> = { success: true, data: { id: copyId.toString() } };
      res.status(201).json(payload);
    },
  );

  registerDelete(
    path,
    table,
    feature,
    noun.toLowerCase(),
    (db) => model(db) as unknown as DeletableLookupModel,
  );
}

// The screen is called TOS and the values are the eleven Incoterms. EXW…DDP is
// a sequence rather than an alphabet, so it reads in sort order.
registerSimpleLookup(
  'tos',
  'tos',
  'SETTING.TOS',
  'Incoterm',
  tosInputSchema,
  'l.sort_order ASC, l.code ASC',
);
// The screen is called Modes and the values are the CY/CY family. Same shape as
// TOS — a code and a name — so it shares the registrar rather than repeating it.
registerSimpleLookup('modes', 'mode', 'SETTING.MODE', 'Mode', tosInputSchema);
registerSimpleLookup(
  'inquiry-sources',
  'inquirySource',
  'SETTING.INQUIRY_SOURCE',
  'Inquiry source',
  inquirySourceInputSchema,
);
