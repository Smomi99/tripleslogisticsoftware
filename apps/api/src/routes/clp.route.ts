import {
  type ApiSuccess,
  buildMeta,
  clpAllocateSchema,
  type ClpBookingRow,
  clpBookingListQuerySchema,
  type ClpListRow,
  clpListQuerySchema,
  type ClpCard,
  clpCancelSchema,
  clpCreateSchema,
  clpDetailsSchema,
  clpFinaliseSchema,
  type ClpPlan,
  type ClpPoolRow,
} from '@ff/shared';
import { Router } from 'express';

import { allocate, availableCartons, cancelClp, deallocate } from '../lib/clp-allocate';
import { buildClpPdf, type ClpPrintDoc, clpPdfFilename } from '../lib/clp-print';
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


/**
 * GET /clps — §5.2's "List of CLP - SEA".
 *
 * One row per container plan, where /clp-bookings gives one row per booking.
 * The two answer different questions: that one is "what still needs
 * planning?", this one is "where are my plans, and which are still drafts?".
 *
 * Cancelled plans are included rather than hidden. §4.3 keeps a cancelled
 * record with its lines for audit, and somebody asking why a container was
 * re-planned needs to find it.
 */
clpRouter.get('/clps', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = clpListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const search = query.search === undefined || query.search === '' ? null : query.search;
    const where = {
      deletedAt: null,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(search === null
        ? {}
        : {
            OR: [
              { code: { contains: search, mode: 'insensitive' as const } },
              { containerNo: { contains: search, mode: 'insensitive' as const } },
              { shipment: { code: { contains: search, mode: 'insensitive' as const } } },
              {
                shipment: {
                  customer: { name: { contains: search, mode: 'insensitive' as const } },
                },
              },
            ],
          }),
    };

    const [rows, total] = await Promise.all([
      db.clp.findMany({
        where,
        orderBy: [{ shipmentId: 'desc' }, { clpSeq: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          code: true,
          clpSeq: true,
          status: true,
          containerNo: true,
          sealNo: true,
          loadDatetime: true,
          shipmentId: true,
          totalCtnQty: true,
          totalVolumeCbm: true,
          volumeUtilisation: true,
          containerSize: { select: { code: true } },
          carrier: { select: { name: true } },
        },
      }),
      db.clp.count({ where }),
    ]);

    /*
      The booking columns come from the same helper the selector uses, so the
      two lists cannot disagree about what a booking's POL or required
      container is. One fetch per distinct booking, not per row — a booking
      with four containers would otherwise be read four times.
    */
    const bookings = new Map<string, ClpBookingRow>();
    for (const row of rows) {
      const key = row.shipmentId.toString();
      if (!bookings.has(key)) {
        bookings.set(key, await bookingRow(db, await findBooking(db, row.shipmentId)));
      }
    }

    return {
      total,
      rows: rows.map((row): ClpListRow => {
        const booking = bookings.get(row.shipmentId.toString())!;
        return {
          id: row.id.toString(),
          code: row.code,
          clpSeq: row.clpSeq,
          status: row.status,
          containerSizeCode: row.containerSize.code,
          containerNo: row.containerNo,
          sealNo: row.sealNo,
          loadDatetime: row.loadDatetime?.toISOString() ?? null,

          shipmentId: row.shipmentId.toString(),
          bookingCode: booking.code,
          shippingOrderCode: booking.shippingOrderCode,
          customerName: booking.customerName,
          exporterName: booking.exporterName,
          commodity: booking.commodity,
          shipmentType: booking.shipmentType,
          polName: booking.polName,
          podName: booking.podName,
          requiredContainer: booking.requiredContainer,
          carrierName: row.carrier.name,

          totalCtnQty: row.totalCtnQty,
          totalVolumeCbm: dec(row.totalVolumeCbm),
          volumeUtilisation: dec(row.volumeUtilisation),
        };
      }),
    };
  });

  const payload: ApiSuccess<ClpListRow[]> = {
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
      capacityOverrideReason: true,
      capacityOverrideUser: {
        select: { username: true, employee: { select: { name: true } } },
      },
      containerNo: true,
      sealNo: true,
      loadDatetime: true,
      supervisorEmployeeId: true,
      supervisor: { select: { name: true } },
      tallyManName: true,
      finalisedAt: true,
      finalisedByUser: { select: { username: true, employee: { select: { name: true } } } },
      cancelledAt: true,
      cancelReason: true,
      cancelledByUser: { select: { username: true, employee: { select: { name: true } } } },
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
    /*
      §4.2 — the reason goes back to the screen, not only to audit_log. A
      container at 107% with no explanation on it is the thing a supervisor
      wrote the reason to prevent; whoever opens the plan next is exactly who
      needs to read it.
    */
    capacityOverrideReason: row.capacityOverrideReason,
    capacityOverrideBy:
      row.capacityOverrideUser === null
        ? null
        : (row.capacityOverrideUser.employee?.name ?? row.capacityOverrideUser.username),
    containerNo: row.containerNo,
    sealNo: row.sealNo,
    loadDatetime: row.loadDatetime?.toISOString() ?? null,
    supervisorEmployeeId: row.supervisorEmployeeId?.toString() ?? null,
    supervisorName: row.supervisor?.name ?? null,
    tallyManName: row.tallyManName,
    finalisedAt: row.finalisedAt?.toISOString() ?? null,
    finalisedBy:
      row.finalisedByUser === null
        ? null
        : (row.finalisedByUser.employee?.name ?? row.finalisedByUser.username),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    cancelledBy:
      row.cancelledByUser === null
        ? null
        : (row.cancelledByUser.employee?.name ?? row.cancelledByUser.username),
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

  /*
    §4.4 — "fully allocated" is a claim about this plan, so it is counted from
    the plan: a PO with cargo loaded and nothing left in the pool.

    It deliberately does NOT count every PO on the shipment. A PO whose goods
    have not been received yet never reaches the pool, so counting it would
    report it as finished while it is still at the supplier — the one reading
    of this sentence that would actually mislead a planner.
  */
  /*
    §5.2's Supervisor is a lookup to the Employee master (§8 Q2). Sent with
    the plan rather than fetched separately: the panel is on every card, and
    a list per card would be one request each.
  */
  const supervisors = await db.employee.findMany({
    where: { deletedAt: null, isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });

  const allocatedPos = new Set(
    clps
      .filter((c) => c.status !== 'CANCELLED')
      .flatMap((c) => c.lines.map((l) => l.poNo)),
  );
  const outstandingPos = new Set(poolRows.map((r) => r.poNo));

  const planned = describeContainers(
    clps.filter((c) => c.status !== 'CANCELLED').map((c) => c.containerSizeName),
  );

  return {
    booking: row,
    pool: poolRows,
    clps,
    supervisors: supervisors.map((e) => ({ id: e.id.toString(), name: e.name })),
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
      /*
        §4.4 — "Always show the unallocated balance." Named rather than
        summed: "PO-004 has 20 cartons unassigned" tells a planner where to
        look, where "20 cartons unassigned" tells them only that they are not
        finished.
      */
      fullyAllocatedPos: [...allocatedPos].filter((po) => !outstandingPos.has(po)).length,
      outstanding: [...outstandingPos].map((poNo) => ({
        poNo,
        ctnQty: poolRows
          .filter((r) => r.poNo === poNo)
          .reduce((sum, r) => sum + r.ctnQty, 0),
      })),
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

    /*
      §4.2 — whether this user may override is the route's decision, not the
      service's. An override offered by somebody without the right is refused
      outright rather than quietly ignored: a planner who typed a reason and
      saw it saved would believe they had done something they had not.
    */
    let override: { reason: string } | null = null;
    if (input.overrideReason !== undefined) {
      const mayOverride =
        auth.isSuperadmin || auth.permissions.has(`${FEATURE}.OVERRIDE_CAPACITY`);
      if (!mayOverride) {
        throw HttpError.forbidden(
          'Loading a container past its volume needs a supervisor. Ask one to do it, ' +
            'or take some cargo out.',
        );
      }
      override = { reason: input.overrideReason };
    }

    await allocate(
      db,
      { tenantId: auth.tenantId, userId: auth.userId },
      { cargoLineId, clpId, ctnQty: input.ctnQty, override },
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

/**
 * PATCH /clps/:id — record what is known so far (§5.2's SAVE CLP).
 *
 * Draft only. The details are how a container is identified, and §4.3 gives
 * FINAL no edit path, so once finalised these stop moving.
 */
clpRouter.patch('/clps/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');
  const input = clpDetailsSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const plan = await db.clp.findFirst({
      where: { id: clpId, deletedAt: null },
      select: { shipmentId: true, status: true, code: true },
    });
    if (plan === null) throw HttpError.notFound('That load plan no longer exists.');
    if (plan.status !== 'DRAFT') {
      throw HttpError.conflict(
        `${plan.code} is ${plan.status.toLowerCase()}. A finalised plan cannot be edited — ` +
          'cancel it and make a new one.',
      );
    }

    await db.clp.update({
      where: { id: clpId },
      data: {
        containerNo: input.containerNo ?? null,
        sealNo: input.sealNo ?? null,
        loadDatetime: input.loadDatetime == null ? null : new Date(input.loadDatetime),
        supervisorEmployeeId:
          input.supervisorEmployeeId == null || input.supervisorEmployeeId === ''
            ? null
            : parseId(input.supervisorEmployeeId, 'supervisor'),
        tallyManName: input.tallyManName ?? null,
        updatedBy: auth.userId,
      },
    });
    return buildPlan(db, plan.shipmentId);
  });

  const payload: ApiSuccess<ClpPlan> = { success: true, data };
  res.json(payload);
});

/**
 * POST /clps/:id/finalise — §4.3's one-way door.
 *
 * Everything the status needs is required here rather than left to the check
 * constraint, so the refusal names the missing field instead of surfacing a
 * constraint violation. The constraint stays as the backstop.
 */
clpRouter.post('/clps/:id/finalise', requirePermission(`${FEATURE}.FINALISE`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');
  const input = clpFinaliseSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const plan = await db.clp.findFirst({
      where: { id: clpId, deletedAt: null },
      select: {
        shipmentId: true,
        status: true,
        code: true,
        clpSeq: true,
        _count: { select: { lines: { where: { deletedAt: null } } } },
      },
    });
    if (plan === null) throw HttpError.notFound('That load plan no longer exists.');
    if (plan.status === 'FINAL') {
      throw HttpError.conflict(`${plan.code} is already final.`);
    }
    if (plan.status === 'CANCELLED') {
      throw HttpError.conflict(`${plan.code} was cancelled, so it cannot be finalised.`);
    }
    /*
      §4.3 lists "≥1 line". An empty container is not a load plan, and
      finalising one would put an unopenable record in front of the carrier.
    */
    if (plan._count.lines === 0) {
      throw HttpError.conflict(
        `CLP ${plan.clpSeq} has no cargo in it. Load something before finalising it.`,
      );
    }

    /*
      Two plans on the SAME booking claiming one container is a mistake — the
      cargo has been promised to that box twice, and the second lot is
      discovered at the gate.

      Deliberately scoped to this booking. The same physical container carries
      cargo to Hamburg, comes back, and carries more; a check across all
      bookings would refuse the second voyage of every box the company uses.
      Telling whether two shipments overlap in time needs sailing dates this
      table does not have, so the narrow rule is the one that has no false
      refusals.
    */
    const clash = await db.clp.findFirst({
      where: {
        shipmentId: plan.shipmentId,
        containerNo: input.containerNo,
        status: 'FINAL',
        deletedAt: null,
        id: { not: clpId },
      },
      select: { code: true, clpSeq: true },
    });
    if (clash !== null) {
      throw HttpError.conflict(
        `Container ${input.containerNo} is already on CLP ${clash.clpSeq} (${clash.code}) ` +
          'for this booking. Check the number, or cancel that plan first.',
      );
    }

    await db.clp.update({
      where: { id: clpId },
      data: {
        containerNo: input.containerNo,
        sealNo: input.sealNo,
        loadDatetime: new Date(input.loadDatetime),
        supervisorEmployeeId:
          input.supervisorEmployeeId == null || input.supervisorEmployeeId === ''
            ? null
            : parseId(input.supervisorEmployeeId, 'supervisor'),
        tallyManName: input.tallyManName ?? null,
        status: 'FINAL',
        finalisedAt: new Date(),
        finalisedBy: auth.userId,
        updatedBy: auth.userId,
      },
    });
    return buildPlan(db, plan.shipmentId);
  });

  const payload: ApiSuccess<ClpPlan> = { success: true, data };
  res.json(payload);
});

/**
 * POST /clps/:id/cancel — §4.3's only way out of a finalised plan.
 *
 * Two rights, one endpoint. Cancelling a DRAFT needs EDIT; cancelling a
 * FINAL is privileged and needs CANCEL, because it un-does a document the
 * warehouse may already be working from. The guard here is the broader EDIT
 * — the narrower check happens inside, where the plan's status is known.
 */
clpRouter.post('/clps/:id/cancel', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');
  const input = clpCancelSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const plan = await db.clp.findFirst({
      where: { id: clpId, deletedAt: null },
      select: { shipmentId: true },
    });
    if (plan === null) throw HttpError.notFound('That load plan no longer exists.');

    await cancelClp(
      db,
      { tenantId: auth.tenantId, userId: auth.userId },
      {
        clpId,
        reason: input.reason,
        mayCancelFinal: auth.isSuperadmin || auth.permissions.has(`${FEATURE}.CANCEL`),
      },
    );
    return buildPlan(db, plan.shipmentId);
  });

  const payload: ApiSuccess<ClpPlan> = { success: true, data };
  res.json(payload);
});

/**
 * GET /clps/:id/print — §5.3's document.
 *
 * Guarded by EXPORT, which is the decision taken when the permissions were
 * agreed: PRINT is not a separate right, because a printed CLP and an
 * exported one put the same figures in the same hands.
 *
 * §4.3 — "PRINT works in both states". A draft prints, and carries the
 * watermark that says so.
 */
clpRouter.get('/clps/:id/print', requirePermission(`${FEATURE}.EXPORT`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');

  const { pdf, name } = await withTenant(auth.tenantId, async (db) => {
    const row = await db.clp.findFirst({
      where: { id: clpId, deletedAt: null },
      select: {
        code: true,
        clpSeq: true,
        status: true,
        containerNo: true,
        sealNo: true,
        loadDatetime: true,
        loadedBy: true,
        tallyManName: true,
        containerSize: { select: { code: true } },
        carrier: { select: { name: true } },
        supervisor: { select: { name: true } },
        shipment: {
          select: {
            code: true,
            exporterName: true,
            customer: { select: { name: true } },
            pol: { select: { name: true } },
            pod: { select: { name: true } },
            shippingOrders: {
              where: { deletedAt: null },
              orderBy: { id: 'desc' },
              take: 1,
              select: { code: true },
            },
          },
        },
        lines: {
          where: { deletedAt: null },
          orderBy: { id: 'asc' },
          select: {
            poNo: true,
            itemCode: true,
            sku: true,
            ctnQty: true,
            pcsQty: true,
            netWeightKg: true,
            grossWeightKg: true,
            volumeCbm: true,
            cartonLengthCm: true,
            cartonWidthCm: true,
            cartonHeightCm: true,
          },
        },
      },
    });
    if (row === null) throw HttpError.notFound('That load plan no longer exists.');

    const workspace = await db.tenant.findFirstOrThrow({
      where: { id: auth.tenantId },
      select: { name: true },
    });
    const me = await db.user.findFirstOrThrow({
      where: { id: auth.userId },
      select: { username: true, employee: { select: { name: true } } },
    });

    const doc: ClpPrintDoc = {
      workspaceName: workspace.name,
      status: row.status,
      code: row.code,
      clpSeq: row.clpSeq,
      bookingCode: row.shipment.code,
      shippingOrderCode: row.shipment.shippingOrders[0]?.code ?? null,
      carrierName: row.carrier.name,
      containerSizeCode: row.containerSize.code,
      containerNo: row.containerNo,
      sealNo: row.sealNo,
      loadDatetime: row.loadDatetime?.toISOString() ?? null,
      loadedBy: row.loadedBy,
      supervisorName: row.supervisor?.name ?? null,
      tallyManName: row.tallyManName,
      polName: row.shipment.pol.name,
      podName: row.shipment.pod.name,
      customerName: row.shipment.customer.name,
      exporterName: row.shipment.exporterName,
      generatedBy: me.employee?.name ?? me.username,
      lines: row.lines.map((l) => ({
        poNo: l.poNo,
        itemCode: l.itemCode,
        sku: l.sku,
        ctnQty: l.ctnQty,
        pcsQty: l.pcsQty,
        netWeightKg: dec(l.netWeightKg),
        grossWeightKg: dec(l.grossWeightKg),
        /*
          The allocation's OWN snapshot, not a join back to the booked line.
          A printed load plan should say what the cartons measured when they
          went in the box; re-reading the master would let a later correction
          silently rewrite a document somebody already signed.
        */
        cartonLengthCm: dec(l.cartonLengthCm),
        cartonWidthCm: dec(l.cartonWidthCm),
        cartonHeightCm: dec(l.cartonHeightCm),
        volumeCbm: dec(l.volumeCbm),
      })),
    };

    return { pdf: await buildClpPdf(doc), name: clpPdfFilename(doc) };
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.send(pdf);
});
