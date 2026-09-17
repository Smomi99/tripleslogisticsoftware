import {
  type ApiSuccess,
  buildMeta,
  CLP_LOADING_FAMILIES,
  clpAllocateSchema,
  type ClpBookingRow,
  clpBookingListQuerySchema,
  type ClpListRow,
  clpListQuerySchema,
  type ClpCard,
  type ClpCandidateList,
  clpCandidateQuerySchema,
  clpCancelSchema,
  type ClpBillingCbm,
  clpCheckSchema,
  type ClpCompatibilityResult,
  clpCostOverrideSchema,
  type ClpCostPreview,
  clpCostSchema,
  clpConsolidateSchema,
  clpCreateSchema,
  clpDetailsSchema,
  clpFinaliseSchema,
  type ClpPlan,
  type ClpPoolRow,
} from '@ff/shared';
import { Router } from 'express';

import {
  allocate,
  availableCartons,
  cancelClp,
  deallocate,
  LIVE_ALLOCATION,
} from '../lib/clp-allocate';
import { billingCbmForBooking } from '../lib/clp-billing';
import { baseCurrency } from '../lib/currency-rate';
import {
  type CostParticipant,
  assertReconciles,
  readManualShares,
  splitCost,
} from '../lib/clp-cost';
import {
  assertConsolidatable,
  bookingsInTickOrder,
  cfsLocations,
  checkCompatibility,
  inOrder,
  isCompatible,
  loadCandidatePos,
  loadCandidates,
  loadingFamily,
  loadingTypesOf,
  loadSelectedPos,
  suggestGroups,
  unloadablePos,
} from '../lib/clp-consolidation';
import { efrNosOfCargoLines } from '../lib/clp-efr';
import {
  participantShipmentIds,
  plansOfBooking,
} from '../lib/clp-participants';
import { buildClpPdf, type ClpPrintDoc, clpPdfFilename } from '../lib/clp-print';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { formatDocumentNo, seriesYearOf } from '../lib/inquiry-no';
import { Prisma } from '../generated/prisma/client';
import { renderRequiredContainer } from '../lib/render-volumes';
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
      // What the booking is loaded as — the authoritative source for the
      // FCL/LCL split, already stored, never re-derived.
      loadingType: true,
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
          /* The agreed containers — see renderRequiredContainer. */
          lines: {
            where: { deletedAt: null, isActive: true },
            orderBy: { sortOrder: 'asc' },
            select: { containerSizeName: true, quantity: true },
          },
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

  const schedule = await db.shipmentSchedule.findFirst({
    where: { shipmentId: row.id, deletedAt: null, status: 'APPROVED' },
    orderBy: { versionNo: 'desc' },
    select: {
      legs: {
        where: { deletedAt: null },
        orderBy: { legNo: 'asc' },
        take: 1,
        select: { voyageNo: true, vessel: { select: { name: true } } },
      },
    },
  });
  const sailing = schedule?.legs[0] ?? null;

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

  /*
    Every live plan the booking is in, shared containers included. Counting
    clp.shipment_id alone left a booking in a consolidated container reading
    "0 planned" beside "All assigned".
  */
  const plannedCount = await db.clp.count({
    where: { deletedAt: null, status: { not: 'CANCELLED' }, ...plansOfBooking(row.id) },
  });

  return {
    shipmentId: row.id.toString(),
    code: row.code,
    shippingOrderCode: so?.code ?? null,
    customerName: row.customer.name,
    exporterName: row.exporterName,
    commodity: row.commodities.map((c) => c.commodityItem.name).join(', ') || '—',
    shipmentType: row.shipmentType,
    loadingType: row.loadingType,
    family: loadingFamily(row.loadingType),
    polName: row.pol?.name ?? '—',
    polCode: row.pol?.portCode ?? '',
    podName: row.pod?.name ?? '—',
    podCode: row.pod?.portCode ?? '',
    requiredContainer: renderRequiredContainer(row.quotation.lines, row.quotation.inquiry?.volumes ?? []),
    carrierName: row.carrier?.name ?? null,
    // The sailing identity CR-002 §2 settled on: first leg of the APPROVED
    // schedule, never shipment_schedule.id.
    vesselName: sailing?.vessel?.name ?? null,
    voyageNo: sailing?.voyageNo ?? null,
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
 * Which booking's plan view to rebuild after changing a CLP.
 *
 * A consolidated container belongs to several bookings, so "the" shipment is
 * no longer a column. The first participant is used — stable, because
 * clp_booking is read in id order — and for every plan built before CR-002
 * that is the one booking it always had.
 */
async function planShipmentId(db: TenantDb, clpId: bigint): Promise<bigint> {
  const [found] = await participantShipmentIds(db, clpId);
  if (found === undefined) throw HttpError.notFound('That load plan no longer exists.');
  return found;
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
      /*
        The FCL/LCL split, §13. One workflow at a time, off the booking's own
        loading type — the same values `loadCandidates` filters on, through the
        same helper, so the queue and the creation screen agree on what an FCL
        booking is. A booking with no loading type appears in neither, which is
        the refusal to guess, not an omission.
      */
      ...(query.family === undefined
        ? {}
        : { loadingType: { in: loadingTypesOf(query.family) } }),
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
              /*
                A shared container records its bookings in clp_booking and has
                no clp.shipment_id, so the two branches above never found it by
                booking or customer — a planner searching the booking they had
                just planned was told there was no plan.
              */
              {
                bookings: {
                  some: {
                    deletedAt: null,
                    shipment: {
                      OR: [
                        { code: { contains: search, mode: 'insensitive' as const } },
                        { customer: { name: { contains: search, mode: 'insensitive' as const } } },
                      ],
                    },
                  },
                },
              },
            ],
          }),
      /*
        The FCL/LCL split, §13. A container's workflow is its bookings' loading
        type, which is already stored — no column was added to `clp`.

        Two shapes, because two creation paths exist. A consolidated plan holds
        `clp_booking` rows; a plan made by "Add another container" holds only
        `clp.shipment_id`. The list already reads the booking that way
        (`bookings[0] ?? shipmentId`), so the filter reads it the same way, and
        a plan cannot be visible in one view while classified by the other.

        `some` rather than `every` needs no tolerance for a mixed container:
        `checkCompatibility` refuses to build one, so every participant of a
        plan shares a family.
      */
      ...(query.family === undefined
        ? {}
        : {
            AND: [
              {
                OR: [
                  {
                    bookings: {
                      some: {
                        deletedAt: null,
                        shipment: { loadingType: { in: loadingTypesOf(query.family) } },
                      },
                    },
                  },
                  {
                    bookings: { none: { deletedAt: null } },
                    shipment: { loadingType: { in: loadingTypesOf(query.family) } },
                  },
                ],
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
          // CR-002: who is in the box. Ordered so the "primary" booking is
          // stable between requests.
          bookings: {
            where: { deletedAt: null },
            orderBy: { id: 'asc' },
            select: { shipmentId: true },
          },
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
      const primary = row.bookings[0]?.shipmentId ?? row.shipmentId;
      if (primary === null) continue;
      const key = primary.toString();
      if (!bookings.has(key)) {
        bookings.set(key, await bookingRow(db, await findBooking(db, primary)));
      }
    }

    return {
      total,
      rows: rows.map((row): ClpListRow => {
        const primary = (row.bookings[0]?.shipmentId ?? row.shipmentId)!;
        const booking = bookings.get(primary.toString())!;
        return {
          id: row.id.toString(),
          code: row.code,
          clpSeq: row.clpSeq,
          status: row.status,
          containerSizeCode: row.containerSize.code,
          containerNo: row.containerNo,
          sealNo: row.sealNo,
          loadDatetime: row.loadDatetime?.toISOString() ?? null,

          shipmentId: primary.toString(),
          bookingCode: booking.code,
          bookingCount: Math.max(1, row.bookings.length),
          shippingOrderCode: booking.shippingOrderCode,
          customerName: booking.customerName,
          exporterName: booking.exporterName,
          commodity: booking.commodity,
          shipmentType: booking.shipmentType,
          loadingType: booking.loadingType,
          family: booking.family,
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
    /*
      CR-002 — the plans this booking takes part in, which on a consolidated
      container includes plans other bookings also appear on.
    */
    where: {
      deletedAt: null,
      // The one definition of "a plan this booking is in" — see
      // clp-participants.ts for why both shapes exist.
      ...plansOfBooking(shipmentId),
    },
    orderBy: [{ clpSeq: 'asc' }, { id: 'asc' }],
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
      consolidationType: true,
      actualContainerCost: true,
      costAllocationBasis: true,
      finalCfsLocation: true,
      costCurrency: { select: { code: true } },
      // The legacy shape's booking, for its loading type — see clp-participants.ts.
      shipment: { select: { loadingType: true } },
      bookings: {
        where: { deletedAt: null },
        orderBy: { id: 'asc' },
        select: {
          shipmentId: true,
          defaultCostAmount: true,
          allocatedCostAmount: true,
          costOverriddenBy: true,
          costOverrideReason: true,
          shipment: {
            select: {
              code: true,
              exporterName: true,
              loadingType: true,
              customer: { select: { name: true } },
            },
          },
          overriddenByUser: {
            select: { username: true, employee: { select: { name: true } } },
          },
        },
      },
      lines: {
        where: { deletedAt: null },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          shipmentCargoLineId: true,
          shipmentCargoLine: { select: { shipmentId: true } },
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

  const efrs = await efrNosOfCargoLines(
    db,
    rows.flatMap((row) => row.lines.map((l) => l.shipmentCargoLineId)),
  );

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
    consolidationType: row.consolidationType,
    loadingType: row.bookings[0]?.shipment.loadingType ?? row.shipment?.loadingType ?? null,
    actualContainerCost: dec(row.actualContainerCost),
    costCurrencyCode: row.costCurrency?.code ?? null,
    costAllocationBasis: row.costAllocationBasis,
    finalCfsLocation: row.finalCfsLocation,
    bookings: row.bookings.map((b) => ({
      shipmentId: b.shipmentId.toString(),
      bookingCode: b.shipment.code,
      customerName: b.shipment.customer.name,
      exporterName: b.shipment.exporterName,
      defaultCostAmount: dec(b.defaultCostAmount),
      allocatedCostAmount: dec(b.allocatedCostAmount),
      costOverriddenBy:
        b.overriddenByUser === null
          ? null
          : (b.overriddenByUser.employee?.name ?? b.overriddenByUser.username),
      costOverrideReason: b.costOverrideReason,
    })),
    lines: row.lines.map((l) => ({
      id: l.id.toString(),
      cargoLineId: l.shipmentCargoLineId.toString(),
      shipmentId: l.shipmentCargoLine.shipmentId.toString(),
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
      efrNos: efrs.get(l.shipmentCargoLineId.toString()) ?? [],
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

  const efrs = await efrNosOfCargoLines(
    db,
    lines.map((line) => line.id),
  );

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
      efrNos: efrs.get(line.id.toString()) ?? [],
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
  const [currencies, base] = await Promise.all([
    db.currency.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, currency: true },
    }),
    db.shipment
      .findFirstOrThrow({ where: { id: shipmentId }, select: { tenantId: true } })
      .then((s) => baseCurrency(db, s.tenantId)),
  ]);

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
    currencies: currencies.map((c) => ({
      id: c.id.toString(),
      code: c.code,
      name: c.currency,
      isBase: base !== null && c.id === base.id,
    })),
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
    return buildPlan(db, await planShipmentId(db, clpId));
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
      select: { clpId: true },
    });
    if (row === null) throw HttpError.notFound('That allocation no longer exists.');

    await deallocate(db, { tenantId: auth.tenantId, userId: auth.userId }, clpLineId);
    return buildPlan(db, await planShipmentId(db, row.clpId));
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
    return buildPlan(db, await planShipmentId(db, clpId));
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
    return buildPlan(db, await planShipmentId(db, clpId));
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

      Deliberately scoped to the bookings in THIS box. The same physical
      container carries cargo to Hamburg, comes back, and carries more; a
      check across all bookings would refuse the second voyage of every box
      the company uses. Telling whether two shipments overlap in time needs
      sailing dates this table does not have, so the narrow rule is the one
      that has no false refusals.

      Scoped through the participants rather than `clp.shipment_id`, which is
      what it used to compare. On a consolidated plan that column is NULL, and
      Prisma renders `shipmentId: null` as `shipment_id IS NULL` — so the
      check quietly became "any FINAL consolidated plan in this workspace
      using this container number", across every booking and every voyage. It
      refused legitimate finalisations while naming a CLP the operator had
      nothing to do with, and the message still said "for this booking".
    */
    const participants = await participantShipmentIds(db, clpId);
    const clash =
      participants.length === 0
        ? null
        : await db.clp.findFirst({
            where: {
              containerNo: input.containerNo,
              status: 'FINAL',
              deletedAt: null,
              id: { not: clpId },
              // Any plan that any of this box's bookings is also in, read
              // through the one definition so both shapes are found.
              OR: participants.map((shipmentId) => plansOfBooking(shipmentId)),
            },
            select: { code: true, clpSeq: true },
          });
    if (clash !== null) {
      throw HttpError.conflict(
        `Container ${input.containerNo} is already on CLP ${clash.clpSeq ?? clash.code} ` +
          `(${clash.code}) for a booking in this container. Check the number, or cancel ` +
          'that plan first.',
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
    return buildPlan(db, await planShipmentId(db, clpId));
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
    return buildPlan(db, await planShipmentId(db, clpId));
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
        finalCfsLocation: true,
        consolidationType: true,
        lines: {
          where: { deletedAt: null },
          orderBy: { id: 'asc' },
          select: {
            shipmentCargoLineId: true,
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

    /*
      B2 — the bookings in the box, both shapes.

      This read joined clp_booking alone, so a plan made by "Add another
      container" printed with no booking number, no POL, no POD and no
      customer: the document that goes to the carrier, blank where it matters
      most. CR-002 §16 wants every booking named; that is what the header and
      the list below are for, and a plan that recorded its booking the legacy
      way has one to name like any other.
    */
    const participants = await participantShipmentIds(db, clpId);
    const inTheBox = await db.shipment.findMany({
      where: { id: { in: participants } },
      select: {
        id: true,
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
    });
    // Back into participation order, which findMany does not promise.
    const byId = new Map(inTheBox.map((b) => [b.id.toString(), b]));
    const bookings = participants.map((id) => byId.get(id.toString())).filter((b) => b !== undefined);
    const first = bookings[0] ?? null;
    const efrs = await efrNosOfCargoLines(
      db,
      row.lines.map((l) => l.shipmentCargoLineId),
    );

    const doc: ClpPrintDoc = {
      workspaceName: workspace.name,
      status: row.status,
      code: row.code,
      clpSeq: row.clpSeq,
      /*
        The first participant carries the header fields; every booking is
        listed separately below it. On a single-booking plan — which is every
        plan built before CR-002 — this is identical to what it printed
        before.
      */
      bookingCode: first?.code ?? '—',
      bookingCodes: bookings.map((b) => b.code),
      consolidated: row.consolidationType !== 'SINGLE',
      finalCfsLocation: row.finalCfsLocation,
      shippingOrderCode: first?.shippingOrders[0]?.code ?? null,
      carrierName: row.carrier.name,
      containerSizeCode: row.containerSize.code,
      containerNo: row.containerNo,
      sealNo: row.sealNo,
      loadDatetime: row.loadDatetime?.toISOString() ?? null,
      loadedBy: row.loadedBy,
      supervisorName: row.supervisor?.name ?? null,
      tallyManName: row.tallyManName,
      polName: first?.pol.name ?? '—',
      podName: first?.pod.name ?? '—',
      customerName: first?.customer.name ?? '—',
      exporterName: first?.exporterName ?? null,
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
        efrNo: (efrs.get(l.shipmentCargoLineId.toString()) ?? []).join(', ') || null,
      })),
    };

    return { pdf: await buildClpPdf(doc), name: clpPdfFilename(doc) };
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.send(pdf);
});

// ==========================================================================
// CR-002 — consolidation and cost.
//
// These handlers are deliberately thin. Every rule they enforce lives in
// clp-consolidation.ts, clp-cost.ts or clp-billing.ts, which are tested on
// their own; a handler that re-implemented one would be a second copy to
// drift. What belongs here is the permission decision, the transaction, and
// turning a service's answer into the API envelope.
// ==========================================================================

/**
 * GET /clp-candidates — the bookings one workflow may plan, with their POs.
 *
 * `family` is required rather than optional: FCL, LCL and Consol box are
 * separate workflows, and a list that mixed them would invite the one
 * selection the engine always refuses.
 */
clpRouter.get('/clp-candidates', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = clpCandidateQuerySchema.parse(req.query);

  const data = await withTenant(auth.tenantId, async (db): Promise<ClpCandidateList> => {
    const search = query.search === undefined || query.search === '' ? null : query.search;

    /*
      Only bookings with cargo actually in. §1 puts the CLP after cargo
      receipt, so a booking with nothing received is a row nobody can act on.
      The loading-type filter is a WHERE rather than something the engine
      rejects later, because this is the FCL screen or the LCL screen and the
      other kind does not belong on it.
    */
    const rows = await db.shipment.findMany({
      where: {
        deletedAt: null,
        shipmentType: 'SEA',
        status: { in: ['PART_RECEIVED', 'CARGO_RECEIVED'] },
        // No family means every workflow, which the screen's "All" tab shows;
        // a booking with no loading type is still in none of them.
        loadingType: {
          in: query.family === undefined ? [...CLP_LOADING_FAMILIES] : loadingTypesOf(query.family),
        },
        ...(search === null
          ? {}
          : {
              OR: [
                { code: { contains: search, mode: 'insensitive' as const } },
                { customer: { name: { contains: search, mode: 'insensitive' as const } } },
                { exporterName: { contains: search, mode: 'insensitive' as const } },
                // POs are what a planner ticks, so a PO number finds its booking.
                {
                  pos: {
                    some: { deletedAt: null, poNo: { contains: search, mode: 'insensitive' as const } },
                  },
                },
              ],
            }),
      },
      orderBy: { id: 'desc' },
      take: 200,
      select: {
        id: true,
        // The quotation's containers, read exactly as bookingRow reads them.
        quotation: {
          select: {
            lines: {
              where: { deletedAt: null, isActive: true },
              orderBy: { sortOrder: 'asc' },
              select: { containerSizeName: true, quantity: true },
            },
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
      },
    });
    const requiredOf = new Map(
      rows.map((r) => [
        r.id.toString(),
        renderRequiredContainer(r.quotation.lines, r.quotation.inquiry?.volumes ?? []),
      ]),
    );

    // Newest first, as queried — loadCandidates' findMany promises no order,
    // and the screen groups by quotation in the order bookings arrive.
    const candidates = inOrder(
      await loadCandidates(
        db,
        rows.map((r) => r.id),
      ),
      rows.map((r) => r.id),
    );

    // How much of each booking is already in a container, so the screen can
    // show what is left rather than implying it is all still to plan.
    const planned = new Map<string, number>();
    for (const line of await db.clpLine.findMany({
      where: {
        ...LIVE_ALLOCATION,
        shipmentCargoLine: { shipmentId: { in: rows.map((r) => r.id) } },
      },
      select: { ctnQty: true, shipmentCargoLine: { select: { shipmentId: true } } },
    })) {
      const key = line.shipmentCargoLine.shipmentId.toString();
      planned.set(key, (planned.get(key) ?? 0) + line.ctnQty);
    }

    /*
      The POs a planner ticks (client sheet, 2026-09-16). Only ones with cargo
      received: a PO still at the supplier has nothing to load and no reason
      to be on a loading screen. A fully planned PO stays, showing zero, so the
      booking does not appear to have lost an order.
    */
    const posOf = new Map<string, ClpCandidateList['candidates'][number]['pos']>();
    /** What each booking still has to load — what ticking all of it would put in a box. */
    const leftOf = new Map<string, { ctn: number; cbm: Prisma.Decimal; kg: Prisma.Decimal }>();
    for (const po of await loadCandidatePos(db, { shipmentIds: rows.map((r) => r.id) })) {
      if (po.receivedCtnQty <= 0) continue;
      const key = po.shipmentId.toString();
      const left = leftOf.get(key) ?? { ctn: 0, cbm: new Prisma.Decimal(0), kg: new Prisma.Decimal(0) };
      leftOf.set(key, {
        ctn: left.ctn + po.ctnQty,
        cbm: left.cbm.plus(po.cbm),
        kg: left.kg.plus(po.grossKg),
      });
      const list = posOf.get(key) ?? [];
      list.push({
        poId: po.poId.toString(),
        poNo: po.poNo,
        ctnQty: po.ctnQty,
        receivedCtnQty: po.receivedCtnQty,
        cbm: po.cbm.toFixed(4),
        grossKg: po.grossKg.toFixed(3),
        efrNos: po.efrNos,
        plans: po.plans.map((plan) => ({ ...plan, clpId: plan.clpId.toString() })),
      });
      posOf.set(key, list);
    }

    const toRow = (c: (typeof candidates)[number]) => ({
      shipmentId: c.shipmentId.toString(),
      code: c.code,
      customerName: c.customerName,
      exporterName: c.exporterName,
      importerName: c.importerName,
      loadingType: c.loadingType,
      family: c.family,
      polName: c.polName,
      podName: c.podName,
      carrierName: c.carrierName,
      vesselName: c.vesselName,
      voyageNo: c.voyageNo,
      cutOffDate: c.cutOffDate?.toISOString() ?? null,
      quotationCode: c.quotationCode,
      inquiryCode: c.inquiryCode,
      cfsLocations: c.cfsLocations,
      receivedCtnQty: c.receivedCtnQty,
      receivedCbm: c.receivedCbm.toFixed(4),
      receivedGrossKg: c.receivedGrossKg.toFixed(3),
      plannedCtnQty: planned.get(c.shipmentId.toString()) ?? 0,
      requiredContainer: requiredOf.get(c.shipmentId.toString()) ?? '—',
      pos: posOf.get(c.shipmentId.toString()) ?? [],
    });

    const byId = new Map(candidates.map((c) => [c.shipmentId.toString(), c]));

    const sizes = await db.containerSize.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { id: true, code: true, maxVolumeCbm: true, maxWeightKg: true },
    });

    return {
      containerSizes: sizes.map((s) => ({
        id: s.id.toString(),
        code: s.code,
        maxVolumeCbm: dec(s.maxVolumeCbm),
        maxWeightKg: dec(s.maxWeightKg),
      })),
      candidates: candidates.map(toRow),
      /*
        Suggestions only. §4: the user may split any of these.

        Drawn from bookings that still have cargo to load, and totalled on what
        is left. A booking already planned in full cannot be ticked, so counting
        it made the chip promise 38 cartons and tick 8.
      */
      suggestions: suggestGroups(candidates.filter((c) => (leftOf.get(c.shipmentId.toString())?.ctn ?? 0) > 0))
        .filter((g) => g.shipmentIds.length > 1)
        .map((g) => {
          const members = g.shipmentIds.map((id) => byId.get(id.toString())!);
          const left = g.shipmentIds.map((id) => leftOf.get(id.toString())!);
          return {
            key: g.key,
            quotationCode: members[0]?.quotationCode ?? null,
            inquiryCode: members[0]?.inquiryCode ?? null,
            shipmentIds: g.shipmentIds.map((id) => id.toString()),
            totalCtnQty: left.reduce((s, l) => s + l.ctn, 0),
            totalCbm: left.reduce((s, l) => s.plus(l.cbm), new Prisma.Decimal(0)).toFixed(4),
            totalGrossKg: left.reduce((s, l) => s.plus(l.kg), new Prisma.Decimal(0)).toFixed(3),
          };
        }),
    };
  });

  const payload: ApiSuccess<ClpCandidateList> = { success: true, data };
  res.json(payload);
});

/**
 * POST /clp-candidates/check — would these bookings go together?
 *
 * Read-only. The screen calls it as boxes are ticked so a planner sees the
 * refusal before committing to it; the same rules run again on the write,
 * because a request need not have come from our screen (§14).
 */
clpRouter.post('/clp-candidates/check', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const input = clpCheckSchema.parse(req.body);
  const bookingIds = input.shipmentIds.map((id) => parseId(id, 'booking'));
  const poIds = input.shipmentPoIds.map((id) => parseId(id, 'PO'));

  const data = await withTenant(auth.tenantId, async (db): Promise<ClpCompatibilityResult> => {
    const pos = await loadSelectedPos(db, poIds);
    // The rules judge bookings, so ticked POs are judged through theirs.
    const ids = [
      ...new Set([...bookingIds, ...bookingsInTickOrder(pos)].map((id) => id.toString())),
    ].map((id) => BigInt(id));
    const candidates = inOrder(await loadCandidates(db, ids), ids);
    const issues = [
      ...checkCompatibility(candidates),
      ...unloadablePos(pos, new Map(candidates.map((c) => [c.shipmentId.toString(), c.code]))),
    ];

    const families = new Set(candidates.map((c) => c.family).filter((f) => f !== null));
    const byPo = poIds.length > 0;

    return {
      ok: isCompatible(issues),
      // One family or none — a mixed selection is refused anyway, and naming
      // one for a mixed selection would send an entry point to the wrong list.
      family: families.size === 1 ? ([...families][0] ?? null) : null,
      issues,
      cfsLocations: cfsLocations(candidates),
      // Ticked POs are measured by what ticking them loads; a booking alone,
      // by what it received — the answer an entry point asks for.
      totalCtnQty: byPo
        ? pos.reduce((s, p) => s + p.ctnQty, 0)
        : candidates.reduce((s, c) => s + c.receivedCtnQty, 0),
      totalCbm: byPo
        ? pos.reduce((s, p) => s.plus(p.cbm), new Prisma.Decimal(0)).toFixed(4)
        : candidates.reduce((s, c) => s + c.receivedCbm, 0).toFixed(4),
      totalGrossKg: byPo
        ? pos.reduce((s, p) => s.plus(p.grossKg), new Prisma.Decimal(0)).toFixed(3)
        : candidates.reduce((s, c) => s + c.receivedGrossKg, 0).toFixed(3),
    };
  });

  const payload: ApiSuccess<ClpCompatibilityResult> = { success: true, data };
  res.json(payload);
});

/**
 * POST /clps/consolidate — one container, from ticked POs or chosen bookings.
 *
 * The single-booking route above still exists and still works; this is the
 * path that writes clp_booking rows for a selection. A selection of one comes
 * through here perfectly well and produces a SINGLE plan.
 *
 * Ticked POs (the client's sheet, 2026-09-16) make the plan AND load it: every
 * carton of each PO still free goes in, through the same `allocate` a planner's
 * `add` uses, in the same transaction — so a refusal part-way leaves no plan
 * behind. Their bookings are the container's participants; nobody sends those.
 */
clpRouter.post('/clps/consolidate', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = clpConsolidateSchema.parse(req.body);
  const poIds = input.shipmentPoIds.map((id) => parseId(id, 'PO'));
  const containerSizeId = parseId(input.containerSizeId, 'container size');

  const data = await withTenant(auth.tenantId, async (db) => {
    const pos = await loadSelectedPos(db, poIds);
    const shipmentIds =
      poIds.length > 0
        ? bookingsInTickOrder(pos)
        : input.shipmentIds.map((id) => parseId(id, 'booking'));

    // The gate. Hard rules, server-side, whatever the screen believed.
    const candidates = await assertConsolidatable(db, shipmentIds);

    const empty = unloadablePos(pos, new Map(candidates.map((c) => [c.shipmentId.toString(), c.code])));
    if (empty.length > 0) throw HttpError.conflict(empty.map((p) => p.reason).join(' '));

    const size = await db.containerSize.findFirst({
      where: { id: containerSizeId, deletedAt: null },
      select: { id: true, code: true, maxVolumeCbm: true, maxWeightKg: true },
    });
    if (size === null) throw HttpError.notFound('That container size no longer exists.');

    /*
      §4.2, before anything is written. The plan does not exist yet, so the
      refusal speaks about the ticked POs rather than a container number the
      planner has never seen, and it offers no override: that is a supervisor's
      call made on a real plan, from inside it. `allocate` checks the written
      figures again below, which is the check that holds.
    */
    if (pos.length > 0) {
      const cbm = pos.reduce((s, p) => s.plus(p.cbm), new Prisma.Decimal(0));
      const kg = pos.reduce((s, p) => s.plus(p.grossKg), new Prisma.Decimal(0));
      const fmt = (v: Prisma.Decimal, dp: number) =>
        Number(v.toFixed(dp)).toLocaleString('en-US', {
          minimumFractionDigits: dp,
          maximumFractionDigits: dp,
        });
      if (size.maxWeightKg !== null && kg.greaterThan(size.maxWeightKg)) {
        throw HttpError.conflict(
          `The ticked POs weigh ${fmt(kg, 0)} kg, and a ${size.code} takes ` +
            `${fmt(size.maxWeightKg, 0)} kg. Untick some POs or choose a bigger container.`,
        );
      }
      if (size.maxVolumeCbm !== null && cbm.greaterThan(size.maxVolumeCbm)) {
        throw HttpError.conflict(
          `The ticked POs come to ${fmt(cbm, 2)} CBM, and a ${size.code} holds ` +
            `${fmt(size.maxVolumeCbm, 0)} CBM. Untick some POs or choose a bigger container.`,
        );
      }
    }

    const anchor = candidates[0]!;
    const consolidated = candidates.length > 1;
    /*
      A consolidated container has no position "within a booking", so clp_seq
      is null and `code` is its whole identity (§4.5 as CR-002 amends it). A
      selection of one keeps the old numbering, so nothing about existing
      single-booking plans changes.
    */
    const year = seriesYearOf(new Date());

    let clpId: bigint | null = null;
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT && clpId === null; attempt += 1) {
      const seqRows = await db.$queryRaw<{ max_seq: number | null }[]>`
        SELECT MAX((regexp_replace(code, '^.*-', ''))::int) AS max_seq
          FROM clp
         WHERE tenant_id = ${auth.tenantId} AND series_year = ${year}
      `;
      const code = formatDocumentNo('CLP', year, (seqRows[0]?.max_seq ?? 0) + 1);

      let clpSeq: number | null = null;
      if (!consolidated) {
        const last = await db.clp.findFirst({
          where: { shipmentId: anchor.shipmentId },
          orderBy: { clpSeq: 'desc' },
          select: { clpSeq: true },
        });
        clpSeq = (last?.clpSeq ?? 0) + 1;
      }

      try {
        const created = await db.clp.create({
          data: {
            tenantId: auth.tenantId,
            code,
            seriesYear: year,
            clpSeq,
            // Kept in step with clp_booking for a single-booking plan, so the
            // column CR-002 will drop later never disagrees with the table
            // that replaces it.
            shipmentId: consolidated ? null : anchor.shipmentId,
            containerSizeId,
            carrierId: anchor.carrierId,
            /*
              Only LCL and Consol box bookings can share a box now (rule 9), and
              both are consolidations across customers, so both are recorded
              as one. Which of the two it is stays on the bookings' own
              loading type, where the register already reads it.
              FCL_QUOTATION remains in the enum for the plans that have it,
              and no longer describes anything that can be created. Nor does
              a quotation grouping, so quotation_id is left empty.
            */
            consolidationType: consolidated ? 'LCL_CONSOLIDATION' : 'SINGLE',
            quotationId: null,
            finalCfsLocation: input.finalCfsLocation ?? null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: { id: true },
        });

        /*
          Written separately rather than as a nested create: clp_booking's
          relation to clp is composite (tenant_id, clp_id), so Prisma will not
          take tenantId inside a nested create — and tenant_id is not something
          to leave to a relation here.
        */
        await db.clpBooking.createMany({
          data: candidates.map((c) => ({
            tenantId: auth.tenantId,
            clpId: created.id,
            shipmentId: c.shipmentId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })),
        });

        clpId = created.id;
      } catch (error) {
        if (isUniqueViolation(error) && attempt < CODE_RETRY_LIMIT - 1) continue;
        throw error;
      }
    }
    if (clpId === null) throw HttpError.conflict('Could not allocate a load plan number. Try again.');

    /*
      Load what was ticked, PO by PO in the order ticked, each line's whole
      free balance — `add` exactly, so conservation, the remainder rule and
      capacity are the allocation service's and nobody else's.
    */
    for (const po of pos) {
      for (const cargoLineId of po.openCargoLineIds) {
        const free = await availableCartons(db, cargoLineId);
        if (free <= 0) continue;
        await allocate(
          db,
          { tenantId: auth.tenantId, userId: auth.userId },
          { cargoLineId, clpId, ctnQty: free, override: null },
        );
      }
    }

    return { id: clpId.toString(), shipmentId: anchor.shipmentId.toString() };
  });

  const payload: ApiSuccess<{ id: string; shipmentId: string }> = { success: true, data };
  res.status(201).json(payload);
});

/**
 * What each booking has loaded in THIS container.
 *
 * The split is apportioned on what is in the box, not on what the booking
 * holds altogether — a booking spread across two containers pays each one for
 * the share it actually occupies.
 */
async function costParticipants(db: TenantDb, clpId: bigint): Promise<CostParticipant[]> {
  /*
    B3 — whose cargo is in the box, both shapes. A plan made by "Add another
    container" has no clp_booking row, so this used to come back empty and
    splitCost refused with "there are no bookings in this container", in front
    of an operator looking at a container that plainly holds their cargo.
  */
  const participants = await participantShipmentIds(db, clpId);

  const plan = await db.clp.findFirst({
    where: { id: clpId, deletedAt: null },
    select: {
      lines: {
        where: { deletedAt: null },
        select: {
          volumeCbm: true,
          grossWeightKg: true,
          shipmentCargoLine: { select: { shipmentId: true } },
        },
      },
    },
  });
  if (plan === null) throw HttpError.notFound('That load plan no longer exists.');

  const loaded = new Map<string, { cbm: Prisma.Decimal; kg: Prisma.Decimal }>();
  for (const line of plan.lines) {
    const key = line.shipmentCargoLine.shipmentId.toString();
    const acc = loaded.get(key) ?? { cbm: new Prisma.Decimal(0), kg: new Prisma.Decimal(0) };
    acc.cbm = acc.cbm.plus(line.volumeCbm ?? 0);
    acc.kg = acc.kg.plus(line.grossWeightKg ?? 0);
    loaded.set(key, acc);
  }

  /*
    Every participating booking, in participation order — including one with
    nothing loaded yet, which gets a zero share rather than disappearing. A
    booking that vanished from the split would be money quietly landing on the
    others.

    The codes are read in one query and mapped back, so the order above is the
    order here whichever shape the plan used.
  */
  const codes = new Map(
    (
      await db.shipment.findMany({
        where: { id: { in: participants } },
        select: { id: true, code: true },
      })
    ).map((row) => [row.id.toString(), row.code]),
  );

  return participants.map((shipmentId) => {
    const got = loaded.get(shipmentId.toString());
    return {
      shipmentId,
      code: codes.get(shipmentId.toString()) ?? '—',
      cbm: got?.cbm ?? new Prisma.Decimal(0),
      weightKg: got?.kg ?? new Prisma.Decimal(0),
    };
  });
}

/** §4.3 — a finalised plan has no edit path, and that includes its money. */
async function assertPlanEditable(db: TenantDb, clpId: bigint): Promise<void> {
  const plan = await db.clp.findFirst({
    where: { id: clpId, deletedAt: null },
    select: { status: true, code: true },
  });
  if (plan === null) throw HttpError.notFound('That load plan no longer exists.');
  if (plan.status !== 'DRAFT') {
    throw HttpError.conflict(
      `${plan.code} is ${plan.status.toLowerCase()}. Its cost split cannot be changed — ` +
        'cancel it and build a new plan.',
    );
  }
}

/**
 * GET /clps/:id/billing — booked against actual, per booking.
 *
 * §7: both measurements stay visible. LCL is billed per CBM, so this is the
 * figure a customer disputes, and being able to show what was measured beside
 * what was booked is the reason the measurement is captured at all.
 */
clpRouter.get('/clps/:id/billing', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');

  const data = await withTenant(auth.tenantId, async (db): Promise<ClpBillingCbm[]> => {
    const plan = await db.clp.findFirst({
      where: { id: clpId, deletedAt: null },
      select: { id: true },
    });
    if (plan === null) throw HttpError.notFound('That load plan no longer exists.');

    /*
      B4 — both shapes, so a plan made by "Add another container" reports its
      booking instead of an empty table.

      Read-only, and deliberately so. The figures below come from the cargo
      receipts, not from the plan: §7's billing CBM is what a BOOKING is
      charged on, which spans every delivery against it, and it is not a
      per-container snapshot. So on a finalised container this can legitimately
      move after the fact when a later delivery is re-measured, while the
      plan's own stored figures stay frozen. Nothing here writes either way.
    */
    const participants = await participantShipmentIds(db, clpId);
    const codes = new Map(
      (
        await db.shipment.findMany({
          where: { id: { in: participants } },
          select: { id: true, code: true },
        })
      ).map((row) => [row.id.toString(), row.code]),
    );

    const out: ClpBillingCbm[] = [];
    for (const shipmentId of participants) {
      const lines = await db.cargoReceiptLine.findMany({
        where: {
          deletedAt: null,
          lineStatus: 'ACCEPTED',
          receipt: { status: 'CONFIRMED', deletedAt: null },
          cargoLine: { shipmentId, deletedAt: null },
        },
        select: {
          receivedCtnQty: true,
          receivedVolumeCbm: true,
          cargoLine: { select: { cbmPerCarton: true } },
        },
      });

      const r = billingCbmForBooking(
        lines.map((l) => ({
          receivedCtnQty: l.receivedCtnQty,
          receivedVolumeCbm: l.receivedVolumeCbm,
          bookedCbmPerCarton: l.cargoLine.cbmPerCarton,
        })),
      );

      out.push({
        shipmentId: shipmentId.toString(),
        bookingCode: codes.get(shipmentId.toString()) ?? '—',
        basis: r.basis,
        billingCbm: r.cbm.toFixed(4),
        bookedCbm: r.bookedCbm.toFixed(4),
        actualCbm: r.actualCbm.toFixed(4),
        measuredLines: r.measuredLines,
        totalLines: r.totalLines,
      });
    }
    return out;
  });

  const payload: ApiSuccess<ClpBillingCbm[]> = { success: true, data };
  res.json(payload);
});

/**
 * POST /clps/:id/cost/preview — what the split would be, without saving it.
 *
 * §9's "preview before saving". Read-only, so it needs only VIEW: seeing the
 * arithmetic is not the same act as committing to it.
 */
clpRouter.post('/clps/:id/cost/preview', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');
  const input = clpCostSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db): Promise<ClpCostPreview> => {
    const participants = await costParticipants(db, clpId);
    const total = new Prisma.Decimal(input.actualContainerCost);
    const shares = splitCost(total, input.basis, participants);
    assertReconciles(total, shares);

    const currency = await db.currency.findFirst({
      where: { id: parseId(input.costCurrencyId, 'currency'), deletedAt: null },
      select: { code: true },
    });

    return {
      basis: input.basis,
      actualContainerCost: total.toFixed(4),
      currencyCode: currency?.code ?? null,
      shares: shares.map((s) => ({
        shipmentId: s.shipmentId.toString(),
        bookingCode: s.code,
        amount: s.amount.toFixed(4),
      })),
      reconciles: true,
    };
  });

  const payload: ApiSuccess<ClpCostPreview> = { success: true, data };
  res.json(payload);
});

/**
 * PATCH /clps/:id/cost — record what the box cost, and split it.
 *
 * Writing the cost recomputes the default allocation, which is the behaviour
 * a planner expects: change the figure, the shares follow. A manual split is
 * a separate, permissioned act below.
 */
clpRouter.patch('/clps/:id/cost', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.id, 'load plan');
  const input = clpCostSchema.parse(req.body);
  const currencyId = parseId(input.costCurrencyId, 'currency');

  const data = await withTenant(auth.tenantId, async (db) => {
    await assertPlanEditable(db, clpId);

    const currency = await db.currency.findFirst({
      where: { id: currencyId, deletedAt: null },
      select: { id: true },
    });
    if (currency === null) throw HttpError.notFound('That currency no longer exists.');

    const participants = await costParticipants(db, clpId);
    const total = new Prisma.Decimal(input.actualContainerCost);
    const shares = splitCost(total, input.basis, participants);
    assertReconciles(total, shares);

    await db.clp.update({
      where: { id: clpId },
      data: {
        actualContainerCost: total,
        costCurrencyId: currencyId,
        costAllocationBasis: input.basis,
        updatedBy: auth.userId,
      },
    });

    for (const share of shares) {
      await db.clpBooking.updateMany({
        where: { clpId, shipmentId: share.shipmentId, deletedAt: null },
        data: {
          defaultCostAmount: share.amount,
          allocatedCostAmount: share.amount,
          // A recomputed default replaces any earlier hand-split: the figures
          // it was based on have changed, so keeping the old override would
          // leave a split that no longer reconciles.
          costOverriddenBy: null,
          costOverriddenAt: null,
          costOverrideReason: null,
          updatedBy: auth.userId,
        },
      });
    }

    return buildPlan(db, await planShipmentId(db, clpId));
  });

  const payload: ApiSuccess<ClpPlan> = { success: true, data };
  res.json(payload);
});

/**
 * PUT /clps/:id/cost/allocations — a split entered by hand.
 *
 * Guarded by OVERRIDE_COST rather than EDIT: this moves money between
 * different customers' invoices, which is not something everyone who can edit
 * a load plan should do.
 */
clpRouter.put(
  '/clps/:id/cost/allocations',
  requirePermission(`${FEATURE}.OVERRIDE_COST`),
  async (req, res) => {
    const auth = req.auth!;
    const clpId = parseId(req.params.id, 'load plan');
    const input = clpCostOverrideSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      await assertPlanEditable(db, clpId);

      const plan = await db.clp.findFirstOrThrow({
        where: { id: clpId },
        select: { actualContainerCost: true, code: true },
      });
      if (plan.actualContainerCost === null) {
        throw HttpError.conflict(
          `${plan.code} has no container cost recorded yet, so there is nothing to split.`,
        );
      }

      const participants = await costParticipants(db, clpId);
      const shares = readManualShares(
        participants,
        input.allocations.map((a) => ({
          shipmentId: parseId(a.shipmentId, 'booking'),
          amount: a.amount,
        })),
      );
      // The guarantee, on the path where money actually goes missing.
      assertReconciles(new Prisma.Decimal(plan.actualContainerCost), shares);

      await db.clp.update({
        where: { id: clpId },
        data: { costAllocationBasis: 'MANUAL', updatedBy: auth.userId },
      });

      const now = new Date();
      for (const share of shares) {
        await db.clpBooking.updateMany({
          where: { clpId, shipmentId: share.shipmentId, deletedAt: null },
          data: {
            // default_cost_amount is deliberately untouched: §9 wants "what
            // would it have been" to survive the override.
            allocatedCostAmount: share.amount,
            costOverriddenBy: auth.userId,
            costOverriddenAt: now,
            costOverrideReason: input.reason,
            updatedBy: auth.userId,
          },
        });
      }

      return buildPlan(db, await planShipmentId(db, clpId));
    });

    const payload: ApiSuccess<ClpPlan> = { success: true, data };
    res.json(payload);
  },
);
