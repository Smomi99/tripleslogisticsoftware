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
import { HttpError } from '../lib/http-error';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { parseId, parseRefId } from '../lib/request';
import {
  assertEditable,
  listSystemLookup,
  type LookupRow,
  type SimpleLookupModel,
  toggleSystemLookup,
} from '../lib/system-lookup';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → the five §3.1 Purchase & Sales lookups.
 *
 * Structurally the Sea-Air Port reference implementation, five times over, with
 * the shared parts factored into lib/system-lookup. Each is system-capable: a
 * workspace sees the seeded rows plus its own, may add its own, may switch any
 * off for itself, and may never edit a shared one.
 */
export const rateLookupRouter: Router = Router();

rateLookupRouter.use(authenticate);

const decimal = (value: unknown): string =>
  value instanceof Prisma.Decimal ? value.toFixed(2) : String(value ?? '0');

const optionalDecimal = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Prisma.Decimal(String(value)).toFixed(3);

/** Codes are unique per tenant, but a workspace also cannot shadow a shared code. */
async function assertCodeFree(
  db: Parameters<typeof listSystemLookup>[0],
  model: { findFirst: (args: never) => Promise<{ id: bigint } | null> },
  code: string,
  excludeId?: bigint,
): Promise<void> {
  const clash = await (model.findFirst as unknown as (args: unknown) => Promise<{ id: bigint } | null>)({
    where: {
      code,
      deletedAt: null,
      ...(excludeId === undefined ? {} : { NOT: { id: excludeId } }),
    },
    select: { id: true },
  });
  void db;
  if (clash !== null) throw HttpError.conflict(`Code ${code} is already in use.`);
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
    await assertCodeFree(db, db.goodsType as never, input.code);
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
    await assertCodeFree(db, db.goodsType as never, input.code, id);

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

// ===========================================================================
// Container Size
// ===========================================================================

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
        extraColumns: 'l.teu_factor, l.sort_order',
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
      await assertCodeFree(db, db.containerSize as never, input.code);
      return db.containerSize.create({
        data: {
          tenantId: auth.tenantId,
          code: input.code,
          name: input.name,
          teuFactor: input.teuFactor,
          sortOrder: input.sortOrder === undefined || input.sortOrder === '' ? 0 : Number(input.sortOrder),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: { id: true, code: true, name: true, teuFactor: true, sortOrder: true, isActive: true },
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
      await assertCodeFree(db, db.containerSize as never, input.code, id);

      return db.containerSize.update({
        where: { id },
        data: {
          code: input.code,
          name: input.name,
          teuFactor: input.teuFactor,
          sortOrder: input.sortOrder === undefined || input.sortOrder === '' ? 0 : Number(input.sortOrder),
          updatedBy: auth.userId,
        },
        select: { id: true, code: true, name: true, teuFactor: true, sortOrder: true, isActive: true },
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

rateLookupRouter.post('/rate-tiers', requirePermission(`${TIER_FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = rateTierInputSchema.parse(req.body);
  const containerSizeId =
    input.containerSizeId === undefined || input.containerSizeId === ''
      ? null
      : parseRefId(input.containerSizeId, 'container size');

  const created = await withTenant(auth.tenantId, async (db) => {
    await assertCodeFree(db, db.rateTier as never, input.code);

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
    await assertCodeFree(db, db.rateTier as never, input.code, id);

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
      await assertCodeFree(db, model(db) as never, input.code);
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
      await assertCodeFree(db, model(db) as never, input.code, id);

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
