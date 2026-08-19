import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type CarrierDto,
  carrierInputSchema,
  type CarrierLanePorts,
  carrierListQuerySchema,
  type CarrierPicDto,
  carrierPicInputSchema,
  type CarrierPortPairDto,
  carrierPortPairInputSchema,
  carrierPortPairListQuerySchema,
  type CarrierServicePortDto,
  carrierServicePortInputSchema,
  listQuerySchema,
  type LookupOption,
} from '@ff/shared';

import { type CodeTable, CODE_RETRY_LIMIT, codeSortSql, isUniqueViolation, nextCode } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { assertCustomisable, recordReplacement, repointReferences } from '../lib/customise';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { parseId, parseRefId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Settings → Carrier, with its PIC and Service Port children (CLAUDE.md §5, §8).
 *
 * The shape that makes this different from every screen so far: the parent is
 * shared (system-capable, §7A rule 7) while both children are tenant-owned. A
 * workspace therefore adds contacts and lane rankings to a carrier row it
 * cannot itself edit. Child writes check that the parent is VISIBLE, not that
 * it is owned — the usual ownership check would wrongly refuse every shared
 * carrier.
 */
export const carrierRouter: Router = Router();

carrierRouter.use(authenticate);

const FEATURE = 'SETTING.CARRIER';

const SORT_COLUMNS = { code: codeSortSql('c.code'), name: 'c.name' } as const;

interface CarrierRow {
  id: bigint;
  code: string;
  name: string;
  type_id: bigint;
  type_name: string;
  office_address: string | null;
  effective_is_active: boolean;
  is_system: boolean;
  pic_count: bigint;
  service_port_count: bigint;
}

function toDto(row: CarrierRow): CarrierDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    typeId: row.type_id.toString(),
    typeName: row.type_name,
    officeAddress: row.office_address,
    isActive: row.effective_is_active,
    isSystem: row.is_system,
    picCount: Number(row.pic_count),
    servicePortCount: Number(row.service_port_count),
  };
}

/** Resolves a carrier the workspace can see — shared or its own. */
async function findVisibleCarrier(db: TenantDb, id: bigint) {
  const carrier = await db.carrier.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true, tenantId: true },
  });
  if (carrier === null) throw HttpError.notFound('Carrier not found.');
  return carrier;
}

/** Allocates a code, retrying if another writer took the same number. */
async function createWithCode<T>(
  db: TenantDb,
  table: CodeTable,
  prefix: string,
  tenantId: bigint,
  create: (code: string) => Promise<T>,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
    const code = await nextCode(db, table, prefix, tenantId);
    try {
      return await create(code);
    } catch (error) {
      if (isUniqueViolation(error, 'code')) continue;
      throw error;
    }
  }
  throw new HttpError(
    409,
    'CODE_GENERATION_FAILED',
    `Could not allocate a ${label} code. Please try again.`,
  );
}

// ===========================================================================
// Carrier
// ===========================================================================

carrierRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = carrierListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    // Raw SQL for the same reason as Port and Currency: the effective status
    // depends on the workspace's override, and the child counts must be scoped
    // to this workspace. RLS still constrains which rows are reachable.
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
      conditions.push(Prisma.sql`(c.name ILIKE ${needle} OR c.code ILIKE ${needle})`);
    }
    if (query.typeId !== undefined) {
      conditions.push(Prisma.sql`c.type_id = ${BigInt(query.typeId)}`);
    }
    if (query.isActive !== undefined) {
      conditions.push(
        Prisma.sql`(c.is_active AND COALESCE(o.is_active, true)) = ${query.isActive}`,
      );
    }
    const where = Prisma.join(conditions, ' AND ');

    const joins = Prisma.sql`
      JOIN carrier_type t ON t.id = c.type_id
      LEFT JOIN tenant_master_override o
        ON o.table_name = 'carrier' AND o.record_id = c.id AND o.tenant_id = ${auth.tenantId}
    `;

    const totalRows = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM carrier c ${joins} WHERE ${where}
    `;
    const total = Number(totalRows[0]?.count ?? 0n);

    const orderColumn = Prisma.raw(SORT_COLUMNS[query.sortBy]);
    const direction = Prisma.raw(query.sortOrder === 'desc' ? 'DESC' : 'ASC');

    const rows = await db.$queryRaw<CarrierRow[]>`
      SELECT c.id, c.code, c.name, c.type_id, t.name AS type_name, c.office_address,
             (c.is_active AND COALESCE(o.is_active, true)) AS effective_is_active,
             (c.tenant_id IS NULL) AS is_system,
             (SELECT count(*) FROM carrier_pic p
               WHERE p.carrier_id = c.id AND p.tenant_id = ${auth.tenantId} AND p.deleted_at IS NULL)::bigint AS pic_count,
             (SELECT count(*) FROM carrier_service_port s
               WHERE s.carrier_id = c.id AND s.tenant_id = ${auth.tenantId} AND s.deleted_at IS NULL)::bigint AS service_port_count
      FROM carrier c ${joins}
      WHERE ${where}
      ORDER BY ${orderColumn} ${direction}, c.id ASC
      LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    `;

    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<CarrierDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** Options for the carrier-type dropdown. */
carrierRouter.get('/types', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const types = await withTenant(auth.tenantId, (db) =>
    db.carrierType.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true },
      orderBy: { code: 'asc' },
    }),
  );
  const payload: ApiSuccess<LookupOption[]> = {
    success: true,
    data: types.map((t) => ({ id: t.id.toString(), name: t.name })),
  };
  res.json(payload);
});

carrierRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = carrierInputSchema.parse(req.body);
  const typeId = parseRefId(input.typeId, 'carrier type');

  const created = await withTenant(auth.tenantId, async (db) => {
    const type = await db.carrierType.findFirst({
      where: { id: typeId, deletedAt: null, isActive: true },
      select: { id: true, name: true },
    });
    if (type === null) throw HttpError.badRequest('That carrier type is not available.');

    return createWithCode(
      db,
      'carrier',
      CODE_PREFIX.carrier,
      auth.tenantId,
      (code) =>
        db.carrier.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            typeId,
            officeAddress: input.officeAddress ?? null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: {
            id: true,
            code: true,
            name: true,
            typeId: true,
            officeAddress: true,
            isActive: true,
            type: { select: { name: true } },
          },
        }),
      'carrier',
    );
  });

  const payload: ApiSuccess<CarrierDto> = {
    success: true,
    data: {
      id: created.id.toString(),
      code: created.code,
      name: created.name,
      typeId: created.typeId.toString(),
      typeName: created.type.name,
      officeAddress: created.officeAddress,
      isActive: created.isActive,
      isSystem: false,
      picCount: 0,
      servicePortCount: 0,
    },
  };
  res.status(201).json(payload);
});

carrierRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'carrier');
  const input = carrierInputSchema.parse(req.body);
  const typeId = parseRefId(input.typeId, 'carrier type');

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await findVisibleCarrier(db, id);
    if (existing.tenantId === null) {
      throw HttpError.forbidden(
        'This is a shared carrier. You can add your own contacts and service ports to it, but not edit it.',
      );
    }
    const type = await db.carrierType.findFirst({
      where: { id: typeId, deletedAt: null, isActive: true },
      select: { id: true },
    });
    if (type === null) throw HttpError.badRequest('That carrier type is not available.');

    return db.carrier.update({
      where: { id },
      data: {
        name: input.name,
        typeId,
        officeAddress: input.officeAddress ?? null,
        updatedBy: auth.userId,
      },
      select: {
        id: true,
        code: true,
        name: true,
        typeId: true,
        officeAddress: true,
        isActive: true,
        type: { select: { name: true } },
      },
    });
  });

  const payload: ApiSuccess<CarrierDto> = {
    success: true,
    data: {
      id: updated.id.toString(),
      code: updated.code,
      name: updated.name,
      typeId: updated.typeId.toString(),
      typeName: updated.type.name,
      officeAddress: updated.officeAddress,
      isActive: updated.isActive,
      isSystem: false,
      picCount: 0,
      servicePortCount: 0,
    },
  };
  res.json(payload);
});

carrierRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'carrier');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.carrier.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, tenantId: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Carrier not found.');

      if (existing.tenantId !== null) {
        const updated = await db.carrier.update({
          where: { id },
          data: { isActive: !existing.isActive, updatedBy: auth.userId },
          select: { isActive: true },
        });
        return updated.isActive;
      }

      const override = await db.tenantMasterOverride.findFirst({
        where: { tableName: 'carrier', recordId: id },
        select: { id: true, isActive: true },
      });
      if (override === null) {
        await db.tenantMasterOverride.create({
          data: {
            tenantId: auth.tenantId,
            tableName: 'carrier',
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

// ===========================================================================
// Carrier → PIC   (§8 child screen, scoped to the parent by URL)
// ===========================================================================

const PIC_SELECT = {
  id: true,
  code: true,
  name: true,
  department: true,
  designation: true,
  telNo: true,
  mobileNo: true,
  email: true,
  country: true,
  isActive: true,
} as const;

function picToDto(row: {
  id: bigint;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  telNo: string | null;
  mobileNo: string | null;
  email: string | null;
  country: string | null;
  isActive: boolean;
}): CarrierPicDto {
  return { ...row, id: row.id.toString() };
}

/** The child screen header needs the parent's name (§8). */
carrierRouter.get('/:id/summary', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'carrier');
  const carrier = await withTenant(auth.tenantId, (db) => findVisibleCarrier(db, id));

  const payload: ApiSuccess<{ id: string; name: string; isSystem: boolean }> = {
    success: true,
    data: {
      id: carrier.id.toString(),
      name: carrier.name,
      isSystem: carrier.tenantId === null,
    },
  };
  res.json(payload);
});

carrierRouter.get('/:id/pics', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const carrierId = parseId(req.params.id, 'carrier');
  const query = listQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    await findVisibleCarrier(db, carrierId);
    const where = {
      carrierId,
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.carrierPic.findMany({
        where,
        select: PIC_SELECT,
        orderBy: [{ name: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.carrierPic.count({ where }),
    ]);
    return { rows: rows.map(picToDto), total };
  });

  const payload: ApiSuccess<CarrierPicDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

carrierRouter.post('/:id/pics', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const carrierId = parseId(req.params.id, 'carrier');
  const input = carrierPicInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    // Visible, not owned — a workspace keeps its own contacts at a shared carrier.
    await findVisibleCarrier(db, carrierId);
    return createWithCode(
      db,
      'carrierPic',
      CODE_PREFIX.carrierPic,
      auth.tenantId,
      (code) =>
        db.carrierPic.create({
          data: {
            tenantId: auth.tenantId,
            code,
            carrierId,
            name: input.name,
            department: input.department || null,
            designation: input.designation || null,
            telNo: input.telNo || null,
            mobileNo: input.mobileNo || null,
            email: input.email || null,
            country: input.country || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: PIC_SELECT,
        }),
      'contact',
    );
  });

  const payload: ApiSuccess<CarrierPicDto> = { success: true, data: picToDto(created) };
  res.status(201).json(payload);
});

carrierRouter.patch(
  '/:id/pics/:picId',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const picId = parseId(req.params.picId, 'contact');
    const input = carrierPicInputSchema.parse(req.body);

    const updated = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.carrierPic.findFirst({
        where: { id: picId, carrierId, deletedAt: null },
        select: { id: true },
      });
      if (existing === null) throw HttpError.notFound('Contact not found.');

      return db.carrierPic.update({
        where: { id: picId },
        data: {
          name: input.name,
          department: input.department || null,
          designation: input.designation || null,
          telNo: input.telNo || null,
          mobileNo: input.mobileNo || null,
          email: input.email || null,
          country: input.country || null,
          updatedBy: auth.userId,
        },
        select: PIC_SELECT,
      });
    });

    const payload: ApiSuccess<CarrierPicDto> = { success: true, data: picToDto(updated) };
    res.json(payload);
  },
);

carrierRouter.post(
  '/:id/pics/:picId/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const picId = parseId(req.params.picId, 'contact');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.carrierPic.findFirst({
        where: { id: picId, carrierId, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Contact not found.');
      const updated = await db.carrierPic.update({
        where: { id: picId },
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
// Carrier → Service Port
// ===========================================================================

const SP_SELECT = {
  id: true,
  code: true,
  portId: true,
  country: true,
  isActive: true,
  port: { select: { name: true, portCode: true } },
} as const;

function spToDto(row: {
  id: bigint;
  code: string;
  portId: bigint;
  country: string | null;
  isActive: boolean;
  port: { name: string; portCode: string };
}): CarrierServicePortDto {
  return {
    id: row.id.toString(),
    code: row.code,
    portId: row.portId.toString(),
    portName: row.port.name,
    portCode: row.port.portCode,
    country: row.country,
    isActive: row.isActive,
    // Filled in by the list, which resolves every row's lanes in one query. A
    // row just created or edited has none that the caller has not already seen.
    activePairs: [],
  };
}

/**
 * The port the workspace picked, with the country the row will store.
 *
 * country is derived here rather than accepted from the request (CR-001 §2), so
 * a client cannot file Changi under Bangladesh — which is exactly what the old
 * free-text field let three of the four existing rows do.
 */
async function findAvailablePort(db: TenantDb, portId: bigint) {
  const port = await db.port.findFirst({
    where: { id: portId, deletedAt: null, isActive: true },
    select: { id: true, country: true },
  });
  if (port === null) throw HttpError.badRequest('That port is not available.');
  return port;
}

carrierRouter.get(
  '/:id/service-ports',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const query = listQuerySchema.parse(req.query);

    const result = await withTenant(auth.tenantId, async (db) => {
      await findVisibleCarrier(db, carrierId);
      const where = {
        carrierId,
        deletedAt: null,
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.search !== undefined
          ? {
              OR: [
                { port: { name: { contains: query.search, mode: 'insensitive' as const } } },
                { country: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };
      const [rows, total] = await Promise.all([
        db.carrierServicePort.findMany({
          where,
          select: SP_SELECT,
          orderBy: [{ port: { name: query.sortOrder } }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        db.carrierServicePort.count({ where }),
      ]);

      // CR-001 §4 rule 5: deactivating a port that a live lane depends on has
      // to warn and name the lanes. One query for the carrier's pairs beats one
      // per row, and the page is 25 rows at most.
      const pairs = await db.carrierPortPair.findMany({
        where: { carrierId, deletedAt: null, isActive: true },
        select: {
          polId: true,
          podId: true,
          pol: { select: { portCode: true } },
          pod: { select: { portCode: true } },
        },
      });
      const lanesByPort = new Map<string, string[]>();
      for (const pair of pairs) {
        const label = `${pair.pol.portCode} → ${pair.pod.portCode}`;
        for (const portId of [pair.polId, pair.podId]) {
          const key = portId.toString();
          lanesByPort.set(key, [...(lanesByPort.get(key) ?? []), label]);
        }
      }

      return {
        rows: rows.map((row) => ({
          ...spToDto(row),
          activePairs: lanesByPort.get(row.portId.toString()) ?? [],
        })),
        total,
      };
    });

    const payload: ApiSuccess<CarrierServicePortDto[]> = {
      success: true,
      data: result.rows,
      meta: buildMeta(query.page, query.limit, result.total),
    };
    res.json(payload);
  },
);

carrierRouter.post(
  '/:id/service-ports',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const input = carrierServicePortInputSchema.parse(req.body);
    const portId = parseRefId(input.portId, 'port');

    const created = await withTenant(auth.tenantId, async (db) => {
      await findVisibleCarrier(db, carrierId);
      const port = await findAvailablePort(db, portId);

      const clash = await db.carrierServicePort.findFirst({
        where: { carrierId, portId, deletedAt: null },
        select: { id: true },
      });
      if (clash !== null) {
        throw HttpError.conflict('This carrier already has that port.');
      }

      return createWithCode(
        db,
        'carrierServicePort',
        CODE_PREFIX.carrierServicePort,
        auth.tenantId,
        (code) =>
          db.carrierServicePort.create({
            data: {
              tenantId: auth.tenantId,
              code,
              carrierId,
              portId,
              country: port.country,
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: SP_SELECT,
          }),
        'service port',
      );
    });

    const payload: ApiSuccess<CarrierServicePortDto> = { success: true, data: spToDto(created) };
    res.status(201).json(payload);
  },
);

carrierRouter.patch(
  '/:id/service-ports/:spId',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const spId = parseId(req.params.spId, 'service port');
    const input = carrierServicePortInputSchema.parse(req.body);
    const portId = parseRefId(input.portId, 'port');

    const updated = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.carrierServicePort.findFirst({
        where: { id: spId, carrierId, deletedAt: null },
        select: { id: true },
      });
      if (existing === null) throw HttpError.notFound('Service port not found.');

      const port = await findAvailablePort(db, portId);

      const clash = await db.carrierServicePort.findFirst({
        where: { carrierId, portId, deletedAt: null, NOT: { id: spId } },
        select: { id: true },
      });
      if (clash !== null) throw HttpError.conflict('This carrier already has that port.');

      return db.carrierServicePort.update({
        where: { id: spId },
        data: {
          portId,
          country: port.country,
          updatedBy: auth.userId,
        },
        select: SP_SELECT,
      });
    });

    const payload: ApiSuccess<CarrierServicePortDto> = { success: true, data: spToDto(updated) };
    res.json(payload);
  },
);

carrierRouter.post(
  '/:id/service-ports/:spId/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const spId = parseId(req.params.spId, 'service port');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.carrierServicePort.findFirst({
        where: { id: spId, carrierId, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Service port not found.');
      // §4 rule 5 is deliberate about this: lanes using this port are named to
      // the user before they confirm, and then the deactivation goes through.
      // Never cascade, never block.
      const updated = await db.carrierServicePort.update({
        where: { id: spId },
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
// Carrier → Port Pair   (CR-001 §3–§5)
//
// The lane, and this workspace's rank of the carrier on it. Its own feature,
// not SETTING.CARRIER's — the client wants lane rankings grantable separately
// from carrier contacts.
// ===========================================================================

const PAIR_FEATURE = 'SETTING.CARRIER_PORT_PAIR';

const PAIR_SELECT = {
  id: true,
  code: true,
  polId: true,
  podId: true,
  lowPricePosition: true,
  servicePosition: true,
  rankSource: true,
  remarks: true,
  isActive: true,
  pol: { select: { name: true, portCode: true } },
  pod: { select: { name: true, portCode: true } },
} as const;

interface PairRow {
  id: bigint;
  code: string;
  polId: bigint;
  podId: bigint;
  lowPricePosition: Prisma.Decimal | null;
  servicePosition: Prisma.Decimal | null;
  rankSource: 'MANUAL' | 'CALCULATED';
  remarks: string | null;
  isActive: boolean;
  pol: { name: string; portCode: string };
  pod: { name: string; portCode: string };
}

function pairToDto(row: PairRow): CarrierPortPairDto {
  return {
    id: row.id.toString(),
    code: row.code,
    polId: row.polId.toString(),
    polName: row.pol.name,
    polCode: row.pol.portCode,
    podId: row.podId.toString(),
    podName: row.pod.name,
    podCode: row.pod.portCode,
    // Decimal.toString() drops the stored trailing zeros, so a rank of 1.00
    // reads as "1" and 1.50 as "1.5" — which is how the pricing team writes it.
    lowPricePosition: row.lowPricePosition?.toString() ?? null,
    servicePosition: row.servicePosition?.toString() ?? null,
    rankSource: row.rankSource,
    remarks: row.remarks,
    isActive: row.isActive,
  };
}

function toRank(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/**
 * The port type a carrier of this type can call at (CR-001 §4 rule 6).
 *
 * carrier_type is a lookup table, so a workspace may add its own values. The
 * rule names four; anything else is unconstrained, because inventing a mapping
 * for a type the client never described would refuse valid data (§10 rule 2).
 */
function requiredPortType(carrierTypeName: string): 'SEAPORT' | 'AIRPORT' | null {
  const name = carrierTypeName.trim().toUpperCase();
  if (name === 'MLO' || name === 'NVOCC' || name === 'SOC') return 'SEAPORT';
  if (name === 'AIRLINE') return 'AIRPORT';
  return null;
}

/**
 * Resolves one end of a lane.
 *
 * §4 rule 1: a lane may only use a port this carrier is already recorded as
 * serving. That relation is what makes the Service Port screen worth keeping —
 * you say where a carrier calls, then you pair those calls into lanes.
 */
async function findLanePort(
  db: TenantDb,
  carrierId: bigint,
  portId: bigint,
  wanted: 'SEAPORT' | 'AIRPORT' | null,
  label: string,
) {
  const servicePort = await db.carrierServicePort.findFirst({
    where: { carrierId, portId, deletedAt: null, isActive: true },
    select: { port: { select: { id: true, name: true, type: true } } },
  });
  if (servicePort === null) {
    const port = await db.port.findFirst({ where: { id: portId }, select: { name: true } });
    throw HttpError.badRequest(
      port === null
        ? `Choose a ${label} from this carrier's service ports.`
        : `Add ${port.name} to this carrier's service ports before pairing it.`,
    );
  }
  if (wanted !== null && servicePort.port.type !== wanted) {
    throw HttpError.badRequest(
      wanted === 'SEAPORT'
        ? `${servicePort.port.name} is an airport, and this carrier ships by sea.`
        : `${servicePort.port.name} is a seaport, and this carrier flies.`,
    );
  }
  return servicePort.port;
}

/** The carrier plus the port type its lanes are limited to. */
async function findLaneCarrier(db: TenantDb, carrierId: bigint) {
  const carrier = await db.carrier.findFirst({
    where: { id: carrierId, deletedAt: null },
    select: { id: true, name: true, type: { select: { name: true } } },
  });
  if (carrier === null) throw HttpError.notFound('Carrier not found.');
  return { ...carrier, portType: requiredPortType(carrier.type.name) };
}

/** The ports a lane may use — §4 rule 1's dropdown, resolved server-side. */
carrierRouter.get(
  '/:id/lane-ports',
  requirePermission(`${PAIR_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');

    const result = await withTenant(auth.tenantId, async (db) => {
      const carrier = await findLaneCarrier(db, carrierId);
      const rows = await db.carrierServicePort.findMany({
        where: { carrierId, deletedAt: null, isActive: true },
        select: {
          port: { select: { id: true, name: true, portCode: true, country: true, type: true } },
        },
        orderBy: { port: { name: 'asc' } },
      });

      // Rule 6 is applied here rather than in the query so the screen can tell
      // "this carrier serves nothing yet" from "everything it serves is the
      // wrong kind of port". Those need different advice, and the second one
      // sent users to a screen where the port was already sitting.
      const usable = rows.filter(
        (row) => carrier.portType === null || row.port.type === carrier.portType,
      );

      return {
        ports: usable.map((row) => ({
          id: row.port.id.toString(),
          portCode: row.port.portCode,
          name: row.port.name,
          country: row.port.country,
        })),
        excludedByType: rows.length - usable.length,
        requiredPortType: carrier.portType,
      };
    });

    const payload: ApiSuccess<CarrierLanePorts> = { success: true, data: result };
    res.json(payload);
  },
);

carrierRouter.get(
  '/:id/port-pairs',
  requirePermission(`${PAIR_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const query = carrierPortPairListQuerySchema.parse(req.query);

    const result = await withTenant(auth.tenantId, async (db) => {
      await findVisibleCarrier(db, carrierId);
      const where = {
        carrierId,
        deletedAt: null,
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.search !== undefined
          ? {
              OR: [
                { pol: { name: { contains: query.search, mode: 'insensitive' as const } } },
                { pol: { portCode: { contains: query.search, mode: 'insensitive' as const } } },
                { pod: { name: { contains: query.search, mode: 'insensitive' as const } } },
                { pod: { portCode: { contains: query.search, mode: 'insensitive' as const } } },
                { remarks: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      };

      // §5: default sort is price rank ascending, nulls last. An unranked lane
      // belongs at the bottom of the list, not at the top pretending to be 0.
      const orderBy =
        query.sortBy === 'pol'
          ? [{ pol: { name: query.sortOrder } }, { id: 'asc' as const }]
          : [{ [query.sortBy]: { sort: query.sortOrder, nulls: 'last' } }, { id: 'asc' as const }];

      const [rows, total] = await Promise.all([
        db.carrierPortPair.findMany({
          where,
          select: PAIR_SELECT,
          orderBy: orderBy as Prisma.CarrierPortPairOrderByWithRelationInput[],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        db.carrierPortPair.count({ where }),
      ]);
      return { rows: rows.map(pairToDto), total };
    });

    const payload: ApiSuccess<CarrierPortPairDto[]> = {
      success: true,
      data: result.rows,
      meta: buildMeta(query.page, query.limit, result.total),
    };
    res.json(payload);
  },
);

/** One pair, so a create that collided can reopen the row it collided with. */
carrierRouter.get(
  '/:id/port-pairs/:pairId',
  requirePermission(`${PAIR_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const pairId = parseId(req.params.pairId, 'port pair');

    const pair = await withTenant(auth.tenantId, async (db) => {
      const row = await db.carrierPortPair.findFirst({
        where: { id: pairId, carrierId, deletedAt: null },
        select: PAIR_SELECT,
      });
      if (row === null) throw HttpError.notFound('Port pair not found.');
      return row;
    });

    const payload: ApiSuccess<CarrierPortPairDto> = { success: true, data: pairToDto(pair) };
    res.json(payload);
  },
);

carrierRouter.post(
  '/:id/port-pairs',
  requirePermission(`${PAIR_FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const input = carrierPortPairInputSchema.parse(req.body);
    const polId = parseRefId(input.polId, 'port of loading');
    const podId = parseRefId(input.podId, 'port of discharge');

    const created = await withTenant(auth.tenantId, async (db) => {
      const carrier = await findLaneCarrier(db, carrierId);
      const pol = await findLanePort(db, carrierId, polId, carrier.portType, 'port of loading');
      const pod = await findLanePort(db, carrierId, podId, carrier.portType, 'port of discharge');

      // §4 rule 3: a second row for the same lane is never what the user meant.
      // The id travels in `fields` so the screen can reopen that row for edit
      // rather than leaving them staring at an error they cannot act on.
      const clash = await db.carrierPortPair.findFirst({
        where: { carrierId, polId, podId, deletedAt: null },
        select: { id: true },
      });
      if (clash !== null) {
        throw new HttpError(
          409,
          'PAIR_EXISTS',
          `This carrier already has a ${pol.name} → ${pod.name} pair. Editing it instead.`,
          { existingId: [clash.id.toString()] },
        );
      }

      return createWithCode(
        db,
        'carrierPortPair',
        CODE_PREFIX.carrierPortPair,
        auth.tenantId,
        (code) =>
          db.carrierPortPair.create({
            data: {
              tenantId: auth.tenantId,
              code,
              carrierId,
              polId,
              podId,
              lowPricePosition: toRank(input.lowPricePosition),
              servicePosition: toRank(input.servicePosition),
              remarks: input.remarks || null,
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: PAIR_SELECT,
          }),
        'port pair',
      );
    });

    const payload: ApiSuccess<CarrierPortPairDto> = { success: true, data: pairToDto(created) };
    res.status(201).json(payload);
  },
);

carrierRouter.patch(
  '/:id/port-pairs/:pairId',
  requirePermission(`${PAIR_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const pairId = parseId(req.params.pairId, 'port pair');
    const input = carrierPortPairInputSchema.parse(req.body);
    const polId = parseRefId(input.polId, 'port of loading');
    const podId = parseRefId(input.podId, 'port of discharge');

    const updated = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.carrierPortPair.findFirst({
        where: { id: pairId, carrierId, deletedAt: null },
        select: { id: true },
      });
      if (existing === null) throw HttpError.notFound('Port pair not found.');

      const carrier = await findLaneCarrier(db, carrierId);
      const pol = await findLanePort(db, carrierId, polId, carrier.portType, 'port of loading');
      const pod = await findLanePort(db, carrierId, podId, carrier.portType, 'port of discharge');

      const clash = await db.carrierPortPair.findFirst({
        where: { carrierId, polId, podId, deletedAt: null, NOT: { id: pairId } },
        select: { id: true },
      });
      if (clash !== null) {
        throw HttpError.conflict(`This carrier already has a ${pol.name} → ${pod.name} pair.`);
      }

      return db.carrierPortPair.update({
        where: { id: pairId },
        data: {
          polId,
          podId,
          lowPricePosition: toRank(input.lowPricePosition),
          servicePosition: toRank(input.servicePosition),
          remarks: input.remarks || null,
          // A rank the pricing team typed is manual again, whatever set it last.
          rankSource: 'MANUAL',
          updatedBy: auth.userId,
        },
        select: PAIR_SELECT,
      });
    });

    const payload: ApiSuccess<CarrierPortPairDto> = { success: true, data: pairToDto(updated) };
    res.json(payload);
  },
);

carrierRouter.post(
  '/:id/port-pairs/:pairId/toggle-status',
  requirePermission(`${PAIR_FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const carrierId = parseId(req.params.id, 'carrier');
    const pairId = parseId(req.params.pairId, 'port pair');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.carrierPortPair.findFirst({
        where: { id: pairId, carrierId, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Port pair not found.');
      const updated = await db.carrierPortPair.update({
        where: { id: pairId },
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
 * shared system row — so it only ever removes a carrier entered by mistake.
 */
carrierRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'carrier');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.carrier.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, name: true },
    });
    await assertRowDeletable(
      db,
      'carrier',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.name },
      'Carrier not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'carrier', id, auth.userId);

    await db.carrier.update({
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
 * row — a second carrier with the same name, which is the very problem this
 * is meant to end.
 */
carrierRouter.post(
  '/:id/customise',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'carrier');

    const copyId = await withTenant(auth.tenantId, async (db) => {
      const shared = await db.carrier.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, tenantId: true, name: true, typeId: true, officeAddress: true },
      });
      await assertCustomisable(
        db,
        'carrier',
        id,
        shared === null ? null : { tenantId: shared.tenantId, name: shared.name },
        'Carrier not found.',
      );
      if (shared === null) throw HttpError.notFound('Carrier not found.');

      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
        const code = await nextCode(db, 'carrier', CODE_PREFIX.carrier, auth.tenantId);
        try {
          const copy = await db.carrier.create({
            data: {
              tenantId: auth.tenantId,
              code,
              name: shared.name, typeId: shared.typeId, officeAddress: shared.officeAddress,
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: { id: true },
          });

          await repointReferences(db, 'carrier', id, copy.id);
          await recordReplacement(db, auth.tenantId, 'carrier', id, copy.id, auth.userId);
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
