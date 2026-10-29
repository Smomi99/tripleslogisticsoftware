import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  businessMatrixQuerySchema,
  type BusinessMatrixRowDto,
  CODE_PREFIX,
  isoCurrency,
  TRADE_LANE_DIRECTION_LABEL,
  type TradeLaneDirection,
  type TradeLaneDto,
  type TradeLaneOptionsDto,
  type TradeLanePortDto,
  tradeLaneSaveSchema,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { CODE_RETRY_LIMIT, inSavepoint, isUniqueViolation, nextCode } from '../lib/codes';
import { baseCurrency } from '../lib/currency-rate';
import { HttpError } from '../lib/http-error';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { workspaceZone } from '../lib/milestone';
import { parseId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';

/**
 * Sales & Marketing → Business Matrix (docs/DESIGN-UPDATE-2026-10-28.md §1).
 *
 * A trade lane is one port on one side and many on the other: one POL to many
 * PODs outbound, many POLs to one POD inbound. Its table has a row per port
 * pair, and every figure on it is counted when the lane is read:
 *
 *   Inquiry Received    inquiries of the lane's direction on that POL → POD
 *   No of Quotation     quotations likewise, past DRAFT, one per number
 *                       however many revisions it went through
 *   Shipment Volume     FINAL load plans holding a booking on that
 *                       POL → POD, at the container size's TEU factor, a
 *                       container counted once
 *   Total Revenue       ISSUED debit invoices of those bookings, in base
 *
 * Each record is matched on its own ports and dated by its own date (§6 Q1).
 */

export const businessMatrixRouter: Router = Router();
businessMatrixRouter.use(authenticate);

const FEATURE = 'SALES.BUSINESS_MATRIX';

const PORT_SELECT = { id: true, name: true, portCode: true, country: true, type: true } as const;

const LANE_SELECT = {
  id: true,
  code: true,
  name: true,
  movementType: true,
  isActive: true,
  port: { select: PORT_SELECT },
  ports: {
    where: { deletedAt: null },
    // Written 0, 1, 2… on every save, so the order is unique within a lane.
    orderBy: { sortOrder: 'asc' },
    select: { port: { select: PORT_SELECT } },
  },
} as const;

type LaneRecord = Prisma.TradeLaneGetPayload<{ select: typeof LANE_SELECT }>;
type PortRecord = LaneRecord['port'];

function portDto(p: PortRecord): TradeLanePortDto {
  return { id: p.id.toString(), name: p.name, portCode: p.portCode, country: p.country };
}

/** The lane's port pairs, POL first, in the order its table reads. */
function pairsOf(lane: LaneRecord): { pol: PortRecord; pod: PortRecord }[] {
  return lane.ports.map(({ port }) =>
    lane.movementType === 'INBOUND' ? { pol: port, pod: lane.port } : { pol: lane.port, pod: port },
  );
}

interface Period {
  from?: string | undefined;
  to?: string | undefined;
}

function within(column: Prisma.Sql, period: Period): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (period.from !== undefined) parts.push(Prisma.sql`${column} >= ${period.from}::date`);
  if (period.to !== undefined) parts.push(Prisma.sql`${column} <= ${period.to}::date`);
  return parts.length === 0 ? Prisma.empty : Prisma.sql`AND ${Prisma.join(parts, ' AND ')}`;
}

interface PairFigures {
  inquiries: number;
  quotations: number;
  teus: Prisma.Decimal;
  revenue: Prisma.Decimal;
}

const pairKey = (pol: bigint, pod: bigint, direction: string) => `${direction}:${pol}:${pod}`;

/**
 * The four figures for every pair on the page, in one statement.
 *
 * tenant_id is named on every table even though RLS filters them too: the
 * application is the first line (CLAUDE.md §7A rule 2), and a raw query has
 * no Prisma extension to add it.
 */
async function figuresFor(
  db: TenantDb,
  tenantId: bigint,
  pairs: { pol: bigint; pod: bigint; direction: TradeLaneDirection }[],
  period: Period,
): Promise<Map<string, PairFigures>> {
  const out = new Map<string, PairFigures>();
  if (pairs.length === 0) return out;
  const zone = await workspaceZone(db, tenantId);
  const values = Prisma.join(
    pairs.map((p) => Prisma.sql`(${p.pol}::bigint, ${p.pod}::bigint, ${p.direction}::movement_type)`),
  );
  const loadedOn = Prisma.sql`(COALESCE(k.load_datetime, k.finalised_at) AT TIME ZONE ${zone})::date`;

  const rows = await db.$queryRaw<
    { pol_id: bigint; pod_id: bigint; direction: string; inquiries: bigint; quotations: bigint; teus: Prisma.Decimal; revenue: Prisma.Decimal }[]
  >`
    WITH pair(pol_id, pod_id, direction) AS (VALUES ${values})
    SELECT p.pol_id, p.pod_id, p.direction::text AS direction,
           (SELECT COUNT(*)
              FROM inquiry i
             WHERE i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
               AND i.movement_type = p.direction AND i.pol_id = p.pol_id AND i.pod_id = p.pod_id
               ${within(Prisma.sql`i.inquiry_date`, period)}
           ) AS inquiries,
           (SELECT COUNT(DISTINCT q.code)
              FROM quotation q
             WHERE q.tenant_id = ${tenantId} AND q.deleted_at IS NULL AND q.status <> 'DRAFT'
               AND q.movement_type = p.direction AND q.pol_id = p.pol_id AND q.pod_id = p.pod_id
               -- A cancelled number was withdrawn (2026-10-29): the inquiry's
               -- new quotation is the one that counts, not both.
               AND NOT EXISTS (SELECT 1 FROM quotation c
                                WHERE c.tenant_id = q.tenant_id AND c.code = q.code
                                  AND c.deleted_at IS NULL AND c.status = 'CANCELLED')
               ${within(Prisma.sql`q.quotation_date`, period)}
           ) AS quotations,
           (SELECT COALESCE(SUM(cs.teu_factor), 0)
              FROM clp k
              JOIN container_size cs ON cs.id = k.container_size_id
             WHERE k.tenant_id = ${tenantId} AND k.deleted_at IS NULL AND k.status = 'FINAL'
               ${within(loadedOn, period)}
               -- clp_booking is which bookings are in the box (CR-002 §2).
               AND EXISTS (
                 SELECT 1
                   FROM clp_booking cb
                   JOIN shipment s   ON s.tenant_id = cb.tenant_id AND s.id = cb.shipment_id
                   JOIN quotation sq ON sq.tenant_id = s.tenant_id AND sq.id = s.quotation_id
                  WHERE cb.tenant_id = k.tenant_id AND cb.clp_id = k.id AND cb.deleted_at IS NULL
                    AND s.deleted_at IS NULL
                    AND sq.movement_type = p.direction AND s.pol_id = p.pol_id AND s.pod_id = p.pod_id
               )
           ) AS teus,
           (SELECT COALESCE(SUM(d.total_amount_base), 0)
              FROM debit_invoice d
              JOIN shipment s   ON s.tenant_id = d.tenant_id AND s.id = d.shipment_id
              JOIN quotation sq ON sq.tenant_id = s.tenant_id AND sq.id = s.quotation_id
             WHERE d.tenant_id = ${tenantId} AND d.deleted_at IS NULL AND d.status = 'ISSUED'
               AND s.deleted_at IS NULL
               AND sq.movement_type = p.direction AND s.pol_id = p.pol_id AND s.pod_id = p.pod_id
               ${within(Prisma.sql`d.invoice_date`, period)}
           ) AS revenue
      FROM pair p
  `;
  for (const r of rows) {
    out.set(pairKey(r.pol_id, r.pod_id, r.direction), {
      inquiries: Number(r.inquiries),
      quotations: Number(r.quotations),
      teus: new Prisma.Decimal(r.teus),
      revenue: new Prisma.Decimal(r.revenue),
    });
  }
  return out;
}

async function lanesWithFigures(db: TenantDb, tenantId: bigint, lanes: LaneRecord[], period: Period): Promise<TradeLaneDto[]> {
  const base = await baseCurrency(db, tenantId);
  const revenueCurrency = base === null ? '' : isoCurrency(base.currency);
  const pairs = lanes.flatMap((lane) =>
    pairsOf(lane).map(({ pol, pod }) => ({ pol: pol.id, pod: pod.id, direction: lane.movementType as TradeLaneDirection })),
  );
  const figures = await figuresFor(db, tenantId, pairs, period);

  return lanes.map((lane) => {
    const direction = lane.movementType as TradeLaneDirection;
    const isAir = lane.port.type === 'AIRPORT';
    const rows: BusinessMatrixRowDto[] = pairsOf(lane).map(({ pol, pod }) => {
      const f = figures.get(pairKey(pol.id, pod.id, direction));
      return {
        pol: portDto(pol),
        pod: portDto(pod),
        inquiries: f?.inquiries ?? 0,
        quotations: f?.quotations ?? 0,
        teus: isAir ? null : (f?.teus ?? new Prisma.Decimal(0)).toFixed(2),
        revenue: (f?.revenue ?? new Prisma.Decimal(0)).toFixed(4),
      };
    });
    return {
      id: lane.id.toString(),
      code: lane.code,
      name: lane.name,
      movementType: direction,
      isActive: lane.isActive,
      port: portDto(lane.port),
      ports: lane.ports.map(({ port }) => portDto(port)),
      isAir,
      revenueCurrency,
      rows,
    };
  });
}

businessMatrixRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = businessMatrixQuerySchema.parse(req.query);

  const { lanes, total } = await withTenant(auth.tenantId, async (db) => {
    const where: Prisma.TradeLaneWhereInput = {
      deletedAt: null,
      movementType: query.movementType,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              { port: { name: { contains: query.search, mode: 'insensitive' } } },
              { port: { portCode: { contains: query.search, mode: 'insensitive' } } },
              { ports: { some: { deletedAt: null, port: { name: { contains: query.search, mode: 'insensitive' } } } } },
              { ports: { some: { deletedAt: null, port: { portCode: { contains: query.search, mode: 'insensitive' } } } } },
            ],
          }),
    };
    const order: Prisma.TradeLaneOrderByWithRelationInput =
      query.sortBy === 'code' ? { code: query.sortOrder } : { name: query.sortOrder };
    const [found, counted] = await Promise.all([
      db.tradeLane.findMany({
        where,
        orderBy: [order, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: LANE_SELECT,
      }),
      db.tradeLane.count({ where }),
    ]);
    return { lanes: await lanesWithFigures(db, auth.tenantId, found, query), total: counted };
  });

  const payload: ApiSuccess<TradeLaneDto[]> = { success: true, data: lanes, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

/** The port picker, narrowed to what this workspace may use (§7A rule 7). */
businessMatrixRouter.get('/options', requireAnyPermission(`${FEATURE}.CREATE`, `${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const data = await withTenant(auth.tenantId, async (db): Promise<TradeLaneOptionsDto> => {
    const inactive = await inactiveMasters(db);
    const ports = await db.port.findMany({
      where: { ...excludeInactive(inactive, 'port'), deletedAt: null, isActive: true },
      select: { id: true, name: true, portCode: true, type: true },
      orderBy: { name: 'asc' },
    });
    return {
      ports: ports.map((p) => ({ id: p.id.toString(), name: `${p.name} (${p.portCode})`, portCode: p.portCode, type: p.type })),
    };
  });
  const payload: ApiSuccess<TradeLaneOptionsDto> = { success: true, data };
  res.json(payload);
});

type SaveInput = ReturnType<typeof tradeLaneSaveSchema.parse>;

/**
 * A pair already on another live, active lane of the same direction, named —
 * it would be counted twice in any total across lanes (§6 Q2). Asked on save
 * and again on activation.
 */
async function assertNoOverlap(
  db: TenantDb,
  lane: { id?: bigint; movementType: TradeLaneDirection; portId: bigint; portIds: bigint[] },
): Promise<void> {
  const clash = await db.tradeLanePort.findFirst({
    where: {
      deletedAt: null,
      portId: { in: lane.portIds },
      tradeLane: {
        deletedAt: null,
        isActive: true,
        movementType: lane.movementType,
        portId: lane.portId,
        ...(lane.id === undefined ? {} : { id: { not: lane.id } }),
      },
    },
    select: { port: { select: { name: true } }, tradeLane: { select: { name: true, port: { select: { name: true } } } } },
  });
  if (clash === null) return;
  const [pol, pod] =
    lane.movementType === 'INBOUND'
      ? [clash.port.name, clash.tradeLane.port.name]
      : [clash.tradeLane.port.name, clash.port.name];
  throw new HttpError(
    409,
    'PAIR_ON_ANOTHER_LANE',
    `${pol} to ${pod} is already on the lane "${clash.tradeLane.name}". A port pair belongs to one lane, or it would be counted twice.`,
  );
}

/**
 * Every port must be one this workspace can see and has not switched off, and
 * a lane is all seaports or all airports (§6 Q3). Asked again on the way in,
 * because a request is not a form.
 */
async function checkPorts(db: TenantDb, input: SaveInput): Promise<void> {
  const inactive = await inactiveMasters(db);
  const ids = [input.portId, ...input.portIds].map((v) => BigInt(v));
  const ports = await db.port.findMany({
    where: { AND: [{ id: { in: ids } }, excludeInactive(inactive, 'port')], deletedAt: null, isActive: true },
    select: { id: true, type: true },
  });
  if (ports.length !== ids.length) throw HttpError.badRequest('One of those ports is not available.');
  if (new Set(ports.map((p) => p.type)).size > 1) {
    throw HttpError.badRequest('A trade lane is all seaports or all airports. Choose ports of one kind.');
  }
}

async function assertNameFree(db: TenantDb, input: SaveInput, exceptId?: bigint): Promise<void> {
  const taken = await db.tradeLane.findFirst({
    where: {
      deletedAt: null,
      movementType: input.movementType,
      name: { equals: input.name, mode: 'insensitive' },
      ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (taken !== null) {
    throw HttpError.conflict(
      `There is already an ${TRADE_LANE_DIRECTION_LABEL[input.movementType].toLowerCase()} lane called "${input.name}".`,
    );
  }
}

async function writePorts(db: TenantDb, tenantId: bigint, userId: bigint, tradeLaneId: bigint, input: SaveInput): Promise<void> {
  await db.tradeLanePort.createMany({
    data: input.portIds.map((portId, index) => ({
      tenantId,
      tradeLaneId,
      portId: BigInt(portId),
      sortOrder: index,
      createdBy: userId,
      updatedBy: userId,
    })),
  });
}

async function loadLane(db: TenantDb, tenantId: bigint, id: bigint): Promise<TradeLaneDto> {
  const lane = await db.tradeLane.findFirst({ where: { id, deletedAt: null }, select: LANE_SELECT });
  if (lane === null) throw HttpError.notFound('Trade lane not found.');
  const [dto] = await lanesWithFigures(db, tenantId, [lane], {});
  return dto!;
}

const asOverlapInput = (input: SaveInput, id?: bigint) => ({
  ...(id === undefined ? {} : { id }),
  movementType: input.movementType,
  portId: BigInt(input.portId),
  portIds: input.portIds.map((v) => BigInt(v)),
});

/** The sheet's `add` (E6). */
businessMatrixRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = tradeLaneSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    await checkPorts(db, input);
    await assertNameFree(db, input);
    await assertNoOverlap(db, asOverlapInput(input));
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'tradeLane', CODE_PREFIX.tradeLane, auth.tenantId);
      try {
        const created = await inSavepoint(db, () =>
          db.tradeLane.create({
            data: {
              tenantId: auth.tenantId,
              code,
              name: input.name,
              movementType: input.movementType,
              portId: BigInt(input.portId),
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: { id: true },
          }),
        );
        await writePorts(db, auth.tenantId, auth.userId, created.id, input);
        return loadLane(db, auth.tenantId, created.id);
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a trade lane code.');
  });

  const payload: ApiSuccess<TradeLaneDto> = { success: true, data };
  res.status(201).json(payload);
});

businessMatrixRouter.put('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'trade lane');
  const input = tradeLaneSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.tradeLane.findFirst({ where: { id, deletedAt: null }, select: { isActive: true } });
    if (existing === null) throw HttpError.notFound('Trade lane not found.');
    await checkPorts(db, input);
    await assertNameFree(db, input, id);
    // An inactive lane counts nowhere, so it may hold a pair until it is switched back on.
    if (existing.isActive) await assertNoOverlap(db, asOverlapInput(input, id));
    await db.tradeLane.update({
      where: { id },
      data: { name: input.name, movementType: input.movementType, portId: BigInt(input.portId), updatedBy: auth.userId },
    });
    // Retired rather than edited: the audit trail keeps the lane as it was.
    await db.tradeLanePort.updateMany({
      where: { tradeLaneId: id, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
    await writePorts(db, auth.tenantId, auth.userId, id, input);
    return loadLane(db, auth.tenantId, id);
  });

  const payload: ApiSuccess<TradeLaneDto> = { success: true, data };
  res.json(payload);
});

businessMatrixRouter.post('/:id/toggle-status', requirePermission(`${FEATURE}.TOGGLE_STATUS`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'trade lane');
  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.tradeLane.findFirst({
      where: { id, deletedAt: null },
      select: { isActive: true, movementType: true, portId: true, ports: { where: { deletedAt: null }, select: { portId: true } } },
    });
    if (existing === null) throw HttpError.notFound('Trade lane not found.');
    if (!existing.isActive) {
      await assertNoOverlap(db, {
        id,
        movementType: existing.movementType as TradeLaneDirection,
        portId: existing.portId,
        portIds: existing.ports.map((p) => p.portId),
      });
    }
    await db.tradeLane.update({ where: { id }, data: { isActive: !existing.isActive, updatedBy: auth.userId } });
    return loadLane(db, auth.tenantId, id);
  });
  const payload: ApiSuccess<TradeLaneDto> = { success: true, data };
  res.json(payload);
});
