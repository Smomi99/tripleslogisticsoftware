import {
  type ApiSuccess,
  buildMeta,
  clpAllocateSchema,
  type ClpBookingRow,
  clpBookingListQuerySchema,
  type ClpCard,
  clpCreateSchema,
  type ClpPlan,
  type ClpPoolRow,
} from '@ff/shared';
import { Router } from 'express';

import { allocate, availableCartons, deallocate } from '../lib/clp-allocate';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { formatDocumentNo, seriesYearOf } from '../lib/inquiry-no';
import { Prisma } from '../generated/prisma/client';
import { renderVolumes } from '../lib/render-volumes';
import { parseId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Container Load Plan — MODULE_CLP.md §5.1.
 *
 * The plan is made after the goods are in at CFS and before the container is
 * physically stuffed, so everything here reads from the receipt rather than
 * from what was booked (§2.4). The arithmetic lives in lib/clp-allocate; these
 * handlers are the way in and the way back out.
 */

export const clpRouter: Router = Router();
clpRouter.use(authenticate);

const FEATURE = 'OPERATION.CONTAINER_LOAD_PLAN';

const dec = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

/** The booking, or a 404 that does not say whether it exists elsewhere. */
async function findBooking(db: TenantDb, shipmentId: bigint) {
  const row = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: {
      id: true,
      code: true,
      status: true,
      shipmentType: true,
      customer: { select: { name: true } },
      exporterName: true,
      carrier: { select: { name: true } },
      pol: { select: { name: true, portCode: true } },
      pod: { select: { name: true, portCode: true } },
      commodities: {
        where: { isActive: true },
        select: { commodityItem: { select: { name: true } } },
      },
      quotation: {
        select: {
          inquiry: {
            select: {
              volumes: {
                where: { deletedAt: null, isActive: true },
                select: {
                  quantity: true,
                  cbm: true,
                  weightKg: true,
                  containerSizeNote: true,
                  containerSize: { select: { name: true } },
                },
              },
            },
          },
        },
      },
      shippingOrders: {
        where: { deletedAt: null, status: { not: 'CANCELLED' } },
        orderBy: { id: 'desc' },
        take: 1,
        select: { code: true, cutOff: true, etd: true, eta: true },
      },
    },
  });
  if (row === null) throw HttpError.notFound('Booking not found.');
  return row;
}

type BookingRow = Awaited<ReturnType<typeof findBooking>>;

/**
 * How the plan's containers read back, for §4.4's comparison.
 *
 * Deliberately the same shape and vocabulary renderVolumes uses for the
 * booking's Required Container — "20' Standard(2)", the size's NAME and not
 * its code. The first version of this said "2x20STD", which no amount of
 * correct planning could ever equal, so the banner fired on every plan and
 * meant nothing.
 */
function describeContainers(names: string[]): string {
  if (names.length === 0) return '—';
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => `${name}(${n})`).join(' + ');
}

async function bookingRow(db: TenantDb, row: BookingRow): Promise<ClpBookingRow> {
  const so = row.shippingOrders[0] ?? null;

  const cargoLines = await db.shipmentCargoLine.findMany({
    where: { shipmentId: row.id, deletedAt: null },
    select: { id: true },
  });

  let received = 0;
  let unallocated = 0;
  for (const line of cargoLines) {
    const free = await availableCartons(db, line.id);
    unallocated += free;
  }
  const receivedRows = await db.cargoReceiptLine.findMany({
    where: {
      cargoLine: { shipmentId: row.id },
      deletedAt: null,
      lineStatus: 'ACCEPTED',
      receipt: { status: 'CONFIRMED', deletedAt: null },
    },
    select: { receivedCtnQty: true },
  });
  received = receivedRows.reduce((sum, r) => sum + r.receivedCtnQty, 0);

  const plannedCount = await db.clp.count({
    where: { shipmentId: row.id, deletedAt: null, status: { not: 'CANCELLED' } },
  });

  return {
    shipmentId: row.id.toString(),
    code: row.code,
    shippingOrderCode: so?.code ?? null,
    customerName: row.customer.name,
    exporterName: row.exporterName,
    commodity: row.commodities.map((c) => c.commodityItem.name).join(', ') || '—',
    shipmentType: row.shipmentType,
    polName: row.pol?.name ?? '—',
    polCode: row.pol?.portCode ?? '',
    podName: row.pod?.name ?? '—',
    podCode: row.pod?.portCode ?? '',
    requiredContainer: renderVolumes(row.quotation.inquiry?.volumes ?? []),
    carrierName: row.carrier?.name ?? null,
    cutOff: so?.cutOff?.toISOString() ?? null,
    etd: so?.etd?.toISOString() ?? null,
    eta: so?.eta?.toISOString() ?? null,
    status: row.status,
    plannedCount,
    unallocatedCtnQty: unallocated,
    receivedCtnQty: received,
  };
}

/**
 * GET /clp-bookings — the §5.1 selector.
 *
 * Only bookings whose goods are actually in: the CLP is made after cargo
 * receipt, so a booking with nothing received has nothing to plan and would
 * only be a row that cannot be acted on.
 */
clpRouter.get('/clp-bookings', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = clpBookingListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      status: { notIn: ['CANCELLED' as const] },
      ...(query.shipmentType === undefined ? {} : { shipmentType: query.shipmentType }),
      ...(query.search === undefined || query.search === ''
        ? {}
        : {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' as const } },
              { customer: { name: { contains: query.search, mode: 'insensitive' as const } } },
            ],
          }),
      // Goods in at CFS — §1 puts the CLP after cargo receipt.
      cargoLines: {
        some: {
          deletedAt: null,
          cargoReceiptLines: {
            some: {
              deletedAt: null,
              lineStatus: 'ACCEPTED' as const,
              receipt: { status: 'CONFIRMED' as const, deletedAt: null },
            },
          },
        },
      },
    };

    const [ids, total] = await Promise.all([
      db.shipment.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: { id: true },
      }),
      db.shipment.count({ where }),
    ]);

    const rows: ClpBookingRow[] = [];
    for (const { id } of ids) rows.push(await bookingRow(db, await findBooking(db, id)));
    return { rows, total };
  });

  const payload: ApiSuccess<ClpBookingRow[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** Every plan on the booking, with its lines. */
async function cards(db: TenantDb, shipmentId: bigint): Promise<ClpCard[]> {
  const rows = await db.clp.findMany({
    where: { shipmentId, deletedAt: null },
    orderBy: { clpSeq: 'asc' },
    select: {
      id: true,
      code: true,
      clpSeq: true,
      status: true,
      containerSizeId: true,
      containerSize: { select: { code: true, name: true, maxVolumeCbm: true, maxWeightKg: true } },
      totalCtnQty: true,
      totalPcsQty: true,
      totalNetWeightKg: true,
      totalGrossWeightKg: true,
      totalVolumeCbm: true,
      volumeUtilisation: true,
      weightUtilisation: true,
      lines: {
        where: { deletedAt: null },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          shipmentCargoLineId: true,
          poNo: true,
          itemCode: true,
          sku: true,
          ctnQty: true,
          pcsQty: true,
          netWeightKg: true,
          grossWeightKg: true,
          volumeCbm: true,
          isSplit: true,
          isFinalAllocation: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id.toString(),
    code: row.code,
    clpSeq: row.clpSeq,
    status: row.status,
    containerSizeId: row.containerSizeId.toString(),
    containerSizeCode: row.containerSize.code,
    containerSizeName: row.containerSize.name,
    maxVolumeCbm: dec(row.containerSize.maxVolumeCbm),
    maxWeightKg: dec(row.containerSize.maxWeightKg),
    totalCtnQty: row.totalCtnQty,
    totalPcsQty: row.totalPcsQty,
    totalNetWeightKg: dec(row.totalNetWeightKg),
    totalGrossWeightKg: dec(row.totalGrossWeightKg),
    totalVolumeCbm: dec(row.totalVolumeCbm),
    volumeUtilisation: dec(row.volumeUtilisation),
    weightUtilisation: dec(row.weightUtilisation),
    lines: row.lines.map((l) => ({
      id: l.id.toString(),
      cargoLineId: l.shipmentCargoLineId.toString(),
      poNo: l.poNo,
      itemCode: l.itemCode,
      sku: l.sku,
      ctnQty: l.ctnQty,
      pcsQty: l.pcsQty,
      netWeightKg: dec(l.netWeightKg),
      grossWeightKg: dec(l.grossWeightKg),
      volumeCbm: dec(l.volumeCbm),
      isSplit: l.isSplit,
      isFinalAllocation: l.isFinalAllocation,
    })),
  }));
}

/** The cargo still free to load, per §5.1's grid. */
async function pool(db: TenantDb, shipmentId: bigint): Promise<ClpPoolRow[]> {
  const lines = await db.shipmentCargoLine.findMany({
    where: { shipmentId, deletedAt: null },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      shipmentPoId: true,
      itemCode: true,
      sku: true,
      dc: true,
      cartonLengthCm: true,
      cartonWidthCm: true,
      cartonHeightCm: true,
      pcsPerCarton: true,
      netWeightPerCarton: true,
      grossWeightPerCarton: true,
      cbmPerCarton: true,
      shipmentPo: { select: { poNo: true } },
      cargoReceiptLines: {
        where: {
          deletedAt: null,
          lineStatus: 'ACCEPTED',
          receipt: { status: 'CONFIRMED', deletedAt: null },
        },
        select: { receivedCtnQty: true },
      },
    },
  });

  const rows: ClpPoolRow[] = [];
  for (const line of lines) {
    const free = await availableCartons(db, line.id);
    // §5.1: a fully allocated row leaves the pool. The grid shrinks as the
    // planner works, which is how they know when they are finished.
    if (free <= 0) continue;

    const received = line.cargoReceiptLines.reduce((s, r) => s + r.receivedCtnQty, 0);
    const n = new Prisma.Decimal(free);
    const per = (v: Prisma.Decimal | null, dp: number): string | null =>
      v === null ? null : v.times(n).toDecimalPlaces(dp).toString();

    rows.push({
      cargoLineId: line.id.toString(),
      poId: line.shipmentPoId.toString(),
      poNo: line.shipmentPo.poNo,
      itemCode: line.itemCode,
      sku: line.sku,
      // Everything here is the REMAINING quantity, not the booked one — the
      // planner is choosing from what is left, so that is what the grid shows.
      ctnQty: free,
      pcsQty:
        line.pcsPerCarton === null
          ? null
          : line.pcsPerCarton.times(n).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber(),
      netWeightKg: per(line.netWeightPerCarton, 3),
      grossWeightKg: per(line.grossWeightPerCarton, 3),
      cartonLengthCm: dec(line.cartonLengthCm),
      cartonWidthCm: dec(line.cartonWidthCm),
      cartonHeightCm: dec(line.cartonHeightCm),
      volumeCbm: per(line.cbmPerCarton, 4),
      dc: line.dc,
      receivedCtnQty: received,
    });
  }
  return rows;
}

async function buildPlan(db: TenantDb, shipmentId: bigint): Promise<ClpPlan> {
  const booking = await findBooking(db, shipmentId);
  const [row, poolRows, clps, sizes] = await Promise.all([
    bookingRow(db, booking),
    pool(db, shipmentId),
    cards(db, shipmentId),
    db.containerSize.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, maxVolumeCbm: true, maxWeightKg: true },
    }),
  ]);

  const planned = describeContainers(
    clps.filter((c) => c.status !== 'CANCELLED').map((c) => c.containerSizeName),
  );

  return {
    booking: row,
    pool: poolRows,
    clps,
    containerSizes: sizes.map((s) => ({
      id: s.id.toString(),
      code: s.code,
      name: s.name,
      maxVolumeCbm: dec(s.maxVolumeCbm),
      maxWeightKg: dec(s.maxWeightKg),
    })),
    /*
      §4.4 — never blocks. The real cargo decides what it takes, and the gap
      between that and what was quoted is exactly what customer service needs
      to see and re-quote.
    */
    reconciliation: {
      required: row.requiredContainer,
      planned,
      matches: row.requiredContainer === planned,
    },
  };
}

clpRouter.get('/bookings/:id/clp', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.id, 'booking');
  const data = await withTenant(auth.tenantId, (db) => buildPlan(db, shipmentId));
  const payload: ApiSuccess<ClpPlan> = { success: true, data };
  res.json(payload);
});

/** POST /bookings/:id/clps — §5.1's `Select Container`. */
clpRouter.post('/bookings/:id/clps', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.id, 'booking');
  const input = clpCreateSchema.parse(req.body);
  const containerSizeId = parseId(input.containerSizeId, 'container size');

  const data = await withTenant(auth.tenantId, async (db) => {
    const booking = await findBooking(db, shipmentId);

    const size = await db.containerSize.findFirst({
      where: { id: containerSizeId, deletedAt: null },
      select: { id: true },
    });
    if (size === null) throw HttpError.notFound('That container size no longer exists.');

    const carrierId = (
      await db.shipment.findFirstOrThrow({
        where: { id: shipmentId },
        select: { carrierId: true },
      })
    ).carrierId;

    const year = seriesYearOf(new Date());

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      /*
        Two counts, §4.5: clp_seq is this container's place in its booking —
        the "CLP No : 1" on the client's cards — while code is the document
        number for the whole workspace. Using one for the other would make the
        second container on the tenth booking read as CLP-…-000002.
      */
      const last = await db.clp.findFirst({
        where: { shipmentId },
        orderBy: { clpSeq: 'desc' },
        select: { clpSeq: true },
      });
      const rows = await db.$queryRaw<{ max_seq: number | null }[]>`
        SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
          FROM clp
         WHERE tenant_id = ${auth.tenantId} AND series_year = ${year}
      `;
      const code = formatDocumentNo('CLP', year, (rows[0]?.max_seq ?? 0) + 1);

      try {
        return await db.clp.create({
          data: {
            tenantId: auth.tenantId,
            code,
            seriesYear: year,
            clpSeq: (last?.clpSeq ?? 0) + 1,
            shipmentId: booking.id,
            shippingOrderId: null,
            containerSizeId,
            carrierId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not number that plan. Try again.');
  });

  const payload: ApiSuccess<{ id: string }> = {
    success: true,
    data: { id: data.id.toString() },
  };
  res.status(201).json(payload);
});

/**
 * POST /clps/:id/lines — §2.2's one operation.
 *
 * `add` sends the whole remaining balance and `Split` sends part of it. The
 * request does not say which, because nothing downstream should care.
 */
clpRouter.post('/clps/:id/lines', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');
  const input = clpAllocateSchema.parse(req.body);
  const cargoLineId = parseId(input.cargoLineId, 'cargo line');

  const data = await withTenant(auth.tenantId, async (db) => {
    const plan = await db.clp.findFirst({
      where: { id: clpId, deletedAt: null },
      select: { shipmentId: true },
    });
    if (plan === null) throw HttpError.notFound('That load plan no longer exists.');

    await allocate(
      db,
      { tenantId: auth.tenantId, userId: auth.userId },
      { cargoLineId, clpId, ctnQty: input.ctnQty },
    );
    return buildPlan(db, plan.shipmentId);
  });

  const payload: ApiSuccess<ClpPlan> = { success: true, data };
  res.status(201).json(payload);
});

/** DELETE /clp-lines/:id — take an allocation back out. */
clpRouter.delete('/clp-lines/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const clpLineId = parseId(req.params.id, 'allocation');

  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await db.clpLine.findFirst({
      where: { id: clpLineId, deletedAt: null },
      select: { clp: { select: { shipmentId: true } } },
    });
    if (row === null) throw HttpError.notFound('That allocation no longer exists.');

    await deallocate(db, { tenantId: auth.tenantId, userId: auth.userId }, clpLineId);
    return buildPlan(db, row.clp.shipmentId);
  });

  const payload: ApiSuccess<ClpPlan> = { success: true, data };
  res.json(payload);
});

/**
 * DELETE /clps/:id — undo a container picked by mistake.
 *
 * Only an empty draft. A plan with cargo in it is retired by CANCELLED, which
 * keeps the record and releases the cartons (§4.3, built in Phase H) — this is
 * for the click before any of that, where the planner chose 40HC and meant
 * 40STD.
 */
clpRouter.delete('/clps/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');

  const data = await withTenant(auth.tenantId, async (db) => {
    const plan = await db.clp.findFirst({
      where: { id: clpId, deletedAt: null },
      select: {
        shipmentId: true,
        status: true,
        code: true,
        _count: { select: { lines: { where: { deletedAt: null } } } },
      },
    });
    if (plan === null) throw HttpError.notFound('That load plan no longer exists.');
    if (plan.status !== 'DRAFT') {
      throw HttpError.conflict(`${plan.code} is not a draft, so it is cancelled rather than removed.`);
    }
    if (plan._count.lines > 0) {
      throw HttpError.conflict(
        `${plan.code} still has cargo in it. Take the cargo out first, or cancel the plan.`,
      );
    }

    await db.clp.update({
      where: { id: clpId },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
    return buildPlan(db, plan.shipmentId);
  });

  const payload: ApiSuccess<ClpPlan> = { success: true, data };
  res.json(payload);
});
