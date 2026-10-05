import { Router } from 'express';

import {
  type AdviseGroupDto,
  type ApiSuccess,
  type ShipmentAdviseDto,
  type ShipmentAdviseLineDto,
  type ShipmentAdvisePrefillDto,
  type ShipmentAdviseTotalsDto,
  shipmentAdviseAddBookingSchema,
  shipmentAdviseCancelSchema,
  shipmentAdviseCreateSchema,
  shipmentAdviseHeaderSchema,
  shipmentAdviseSendSchema,
} from '@ff/shared';

import { type AdviseLineDraft, adviseBlockedReason, totalsOf } from '../lib/advise-build';
import {
  addMembership,
  adviseGroupFor,
  adviseMembers,
  adviseToJoin,
  assertCanJoin,
  bookingsToInclude,
  buildGroupLines,
  type GroupCandidate,
  groupDto,
  joinInsteadMessage,
  leadFirst,
  LIVE_ADVISE,
  LIVE_MEMBERSHIP,
  liveAdviseOf,
} from '../lib/advise-group';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { queueMail } from '../lib/email-queue';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { nextHouseBlNo, nextShipmentAdviseNo, seriesYearOf } from '../lib/inquiry-no';
import { letterheadOf } from '../lib/letterhead';
import { logger } from '../lib/logger';
import { putFile } from '../lib/storage';
import { renderShipmentAdvisePdf } from '../lib/shipment-advise-pdf';
import { parseId } from '../lib/request';
import { transitionShipment } from '../lib/shipment-status';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Shipment Advise — docs/MODULE_DOCUMENTATION.md §2.1, §2.2, §5.
 *
 * One advise per booking (§3.1), and the place the House BL number is born
 * (§3.3) — which is why the BL Draft screen can show it as a column.
 *
 * The PO grid is never posted by the client. It is pulled from the finalised
 * CLP (sea) or the confirmed receipts (air) by the build step and snapshotted,
 * so the document says what the operation actually did rather than what a
 * browser sent.
 */
export const shipmentAdviseRouter: Router = Router();

const FEATURE = 'DOCUMENTATION.SHIPMENT_ADVISE';

shipmentAdviseRouter.use(authenticate);

const stamp = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));
const dec = (d: Prisma.Decimal | null): string | null => (d === null ? null : d.toString());

const adviseArgs = {
  include: {
    shipment: {
      select: {
        id: true,
        code: true,
        shipmentType: true,
        exporterName: true,
        customer: { select: { id: true, name: true } },
      },
    },
    carrier: { select: { name: true } },
    firstVessel: { select: { name: true } },
    pol: { select: { name: true } },
    pod: { select: { name: true } },
    sentByUser: { select: { username: true } },
    lines: {
      where: { deletedAt: null },
      orderBy: [{ poNo: 'asc' }, { id: 'asc' }],
      include: {
        clp: { select: { code: true, containerNo: true, sealNo: true, containerSize: { select: { code: true } } } },
        booking: { select: { shipment: { select: { code: true } } } },
      },
    },
    // CR-005: the bookings it covers. Released rows included, so a cancelled
    // advise can still say what it was for.
    bookings: {
      where: { deletedAt: null },
      orderBy: { id: 'asc' },
      select: { releasedAt: true, shipment: { select: { id: true, code: true } } },
    },
  },
} satisfies { include: Prisma.ShipmentAdviseInclude };

type AdviseRow = Prisma.ShipmentAdviseGetPayload<typeof adviseArgs>;

/**
 * The bookings an advise covers, the one it was made from first. A live advise
 * answers with the bookings it holds; a cancelled one has released them all,
 * and answers with the bookings it held.
 */
function coveredBookings(row: AdviseRow): { id: bigint; code: string }[] {
  const live = row.bookings.filter((b) => b.releasedAt === null);
  return leadFirst(row.shipmentId, (live.length > 0 ? live : row.bookings).map((b) => b.shipment));
}

/** The grid in booking order — the lead's POs first — then PO order within each. */
function orderedLines(row: AdviseRow): AdviseRow['lines'] {
  const rank = new Map(coveredBookings(row).map((b, i) => [b.code, i]));
  return [...row.lines].sort(
    (a, b) =>
      (rank.get(a.booking.shipment.code) ?? 0) - (rank.get(b.booking.shipment.code) ?? 0) ||
      a.poNo.localeCompare(b.poNo) ||
      (a.id < b.id ? -1 : 1),
  );
}

function lineDto(row: AdviseRow['lines'][number]): ShipmentAdviseLineDto {
  return {
    id: row.id.toString(),
    bookingNo: row.booking.shipment.code,
    poNo: row.poNo,
    itemCode: row.itemCode,
    sku: row.sku,
    ctnQty: row.ctnQty,
    pcsQty: row.pcsQty,
    netWeightKg: dec(row.netWeightKg),
    grossWeightKg: dec(row.grossWeightKg),
    cartonLengthCm: dec(row.cartonLengthCm),
    cartonWidthCm: dec(row.cartonWidthCm),
    cartonHeightCm: dec(row.cartonHeightCm),
    volumeCbm: dec(row.volumeCbm),
    chargeableWtKg: dec(row.chargeableWtKg),
    cargoReceiptDate: day(row.cargoReceiptDate),
    stuffingDate: day(row.stuffingDate),
    efrNo: row.efrNo,
    clpCode: row.clp?.code ?? null,
    containerNo: row.clp?.containerNo ?? null,
    sealNo: row.clp?.sealNo ?? null,
    containerSize: row.clp?.containerSize.code ?? null,
  };
}

/** The customer's contacts, for the send form (sheet B24). */
async function recipientsOf(
  db: TenantDb,
  customerId: bigint,
): Promise<{ name: string | null; email: string }[]> {
  const pics = await db.customerPic.findMany({
    where: { customerId, deletedAt: null, isActive: true, email: { not: null } },
    orderBy: { id: 'asc' },
    select: { name: true, email: true },
  });
  return pics
    .filter((p): p is { name: string; email: string } => (p.email ?? '').trim() !== '')
    .map((p) => ({ name: p.name, email: p.email }));
}

function totalsDto(row: AdviseRow): ShipmentAdviseTotalsDto {
  return {
    poCount: row.totalPoCount,
    ctnQty: row.totalCtnQty,
    pcsQty: row.totalPcsQty,
    netWeightKg: dec(row.totalNetWeightKg),
    grossWeightKg: dec(row.totalGrossWeightKg),
    volumeCbm: dec(row.totalVolumeCbm),
    chargeableWtKg: dec(row.totalChargeableWtKg),
  };
}

function toDto(
  row: AdviseRow,
  recipients: { name: string | null; email: string }[],
  group: AdviseGroupDto,
): ShipmentAdviseDto {
  return {
    id: row.id.toString(),
    code: row.code,
    status: row.status,
    shipmentId: row.shipmentId.toString(),
    bookingNo: row.shipment.code,
    shipmentType: row.shipment.shipmentType,
    customerName: row.shipment.customer.name,
    exporterName: row.shipment.exporterName,
    carrierId: row.carrierId.toString(),
    carrierName: row.carrier.name,
    transitType: row.transitType,
    firstVesselId: row.firstVesselId?.toString() ?? null,
    firstVesselName: row.firstVessel?.name ?? null,
    voyageNo: row.voyageNo,
    firstFlightNo: row.firstFlightNo,
    polId: row.polId.toString(),
    polName: row.pol.name,
    podId: row.podId.toString(),
    podName: row.pod.name,
    etd: stamp(row.etd),
    eta: stamp(row.eta),
    stuffingDate: day(row.stuffingDate),
    houseBlNo: row.houseBlNo,
    mblNo: row.mblNo,
    sentAt: stamp(row.sentAt),
    sentByName: row.sentByUser?.username ?? null,
    cancelReason: row.cancelReason,
    lines: orderedLines(row).map(lineDto),
    totals: totalsDto(row),
    recipients,
    bookingNos: coveredBookings(row).map((b) => b.code),
    group,
  };
}

/**
 * The live advise a booking is on — CR-005: as the booking it was made from,
 * or as one of the others sharing its EFR.
 */
async function loadLive(db: TenantDb, shipmentId: bigint): Promise<ShipmentAdviseDto | null> {
  const row = await db.shipmentAdvise.findFirst({
    where: { ...LIVE_ADVISE, bookings: { some: { shipmentId, ...LIVE_MEMBERSHIP } } },
    orderBy: { id: 'desc' },
    ...adviseArgs,
  });
  if (row === null) return null;
  const group = await adviseGroupFor(db, row.shipmentId);
  const included = new Set(
    row.bookings.filter((b) => b.releasedAt === null).map((b) => b.shipment.id.toString()),
  );
  return toDto(row, await recipientsOf(db, row.shipment.customer.id), groupDto(group, included));
}

/**
 * Puts every ready booking that fully matches the EFR on a draft advise
 * (CR-005 rule 8) — the client's rule is one advise per EFR, so these are not
 * left for someone to remember.
 */
async function growGroup(
  db: TenantDb,
  args: { tenantId: bigint; userId: bigint; adviseId: bigint; leadId: bigint },
): Promise<void> {
  const group = await adviseGroupFor(db, args.leadId);
  for (const c of group.candidates.slice(1)) {
    if (c.match === 'FULL' && c.blockedReason === null && c.liveAdvise === null) {
      await addMembership(db, {
        tenantId: args.tenantId,
        adviseId: args.adviseId,
        shipmentId: c.shipmentId,
        code: c.code,
        userId: args.userId,
      });
    }
  }
}

const member = (c: GroupCandidate) => ({ id: c.shipmentId, code: c.code, shipmentType: c.shipmentType });

/** Re-pulls the PO grid of every booking on the advise. */
async function rebuild(
  db: TenantDb,
  args: { tenantId: bigint; userId: bigint; adviseId: bigint },
): Promise<void> {
  const members = await adviseMembers(db, args.adviseId);
  const lines = await buildGroupLines(db, members);
  await writeLines(db, args.tenantId, args.adviseId, args.userId, lines);
}

async function loadById(db: TenantDb, id: bigint): Promise<AdviseRow> {
  const row = await db.shipmentAdvise.findFirst({ where: { id, deletedAt: null }, ...adviseArgs });
  if (row === null) throw HttpError.notFound('Shipment advise not found.');
  return row;
}

/** The booking, with everything the header needs. */
async function gather(db: TenantDb, shipmentId: bigint) {
  const shipment = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: {
      id: true,
      code: true,
      status: true,
      shipmentType: true,
      exporterName: true,
      transitType: true,
      carrierId: true,
      polId: true,
      podId: true,
      etd: true,
      eta: true,
      customer: { select: { id: true, name: true } },
      carrier: { select: { name: true } },
      pol: { select: { name: true } },
      pod: { select: { name: true } },
    },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');
  return shipment;
}

/** The approved schedule the header is prefilled from (§2.1, M14). */
async function approvedSchedule(db: TenantDb, shipmentId: bigint) {
  return db.shipmentSchedule.findFirst({
    where: { shipmentId, deletedAt: null, status: 'APPROVED' },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      transitType: true,
      legs: {
        where: { deletedAt: null },
        orderBy: { legNo: 'asc' },
        select: {
          vesselId: true,
          voyageNo: true,
          flightNo: true,
          etd: true,
          eta: true,
          originPortId: true,
          destinationPortId: true,
          vessel: { select: { name: true } },
        },
      },
    },
  });
}

/** A sent advise is the document, not a draft. §5 rule 3. */
function assertDraft(row: AdviseRow): void {
  if (row.status === 'SENT') {
    throw new HttpError(
      409,
      'ADVISE_SENT',
      `${row.code} has already gone to the customer. Cancel it and issue another rather than editing it.`,
    );
  }
  if (row.status === 'CANCELLED') {
    throw new HttpError(409, 'ADVISE_CANCELLED', `${row.code} was cancelled.`);
  }
}

/** Writes the grid and the totals row together — they are one statement. */
async function writeLines(
  db: TenantDb,
  tenantId: bigint,
  adviseId: bigint,
  userId: bigint,
  lines: AdviseLineDraft[],
): Promise<void> {
  await db.shipmentAdviseLine.updateMany({
    where: { adviseId, deletedAt: null },
    data: { deletedAt: new Date(), updatedBy: userId },
  });

  await db.shipmentAdviseLine.createMany({
    data: lines.map((line) => ({
      tenantId,
      adviseId,
      shipmentId: line.shipmentId,
      shipmentPoId: line.shipmentPoId,
      shipmentCargoLineId: line.shipmentCargoLineId,
      clpId: line.clpId,
      poNo: line.poNo,
      itemCode: line.itemCode,
      sku: line.sku,
      ctnQty: line.ctnQty,
      pcsQty: line.pcsQty,
      netWeightKg: line.netWeightKg,
      grossWeightKg: line.grossWeightKg,
      cartonLengthCm: line.cartonLengthCm,
      cartonWidthCm: line.cartonWidthCm,
      cartonHeightCm: line.cartonHeightCm,
      volumeCbm: line.volumeCbm,
      chargeableWtKg: line.chargeableWtKg,
      cargoReceiptDate: line.cargoReceiptDate,
      stuffingDate: line.stuffingDate,
      efrNo: line.efrNo,
      createdBy: userId,
      updatedBy: userId,
    })),
  });

  const totals = totalsOf(lines);
  await db.shipmentAdvise.update({
    where: { id: adviseId },
    data: {
      totalPoCount: totals.poCount,
      totalCtnQty: totals.ctnQty,
      totalPcsQty: totals.pcsQty,
      totalNetWeightKg: totals.netWeightKg,
      totalGrossWeightKg: totals.grossWeightKg,
      totalVolumeCbm: totals.volumeCbm,
      totalChargeableWtKg: totals.chargeableWtKg,
      updatedBy: userId,
    },
  });
}

/**
 * GET /bookings/:id/advise — the live advise, or null.
 *
 * Null is an answer: a booking that has not been advised yet is the ordinary
 * case, and the screen says so rather than erroring.
 */
shipmentAdviseRouter.get(
  '/bookings/:id/advise',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');

    const data = await withTenant(auth.tenantId, async (db) => {
      await gather(db, shipmentId);
      return loadLive(db, shipmentId);
    });

    const payload: ApiSuccess<ShipmentAdviseDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * GET /bookings/:id/advise/prefill — the document before it is saved.
 *
 * The header comes from the approved schedule ("Approved vessel schedule will
 * show"), the grid from the CLP or the receipts. `blockedReason` is how the
 * screen explains an Add button it cannot offer yet.
 */
shipmentAdviseRouter.get(
  '/bookings/:id/advise/prefill',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');

    // CR-005: the warned bookings the user has ticked so far, so the grid
    // below shows what the advise will actually hold.
    const requested = String(req.query['include'] ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => /^\d+$/.test(v));

    const data = await withTenant<ShipmentAdvisePrefillDto>(auth.tenantId, async (db) => {
      const shipment = await gather(db, shipmentId);
      const schedule = await approvedSchedule(db, shipmentId);
      const first = schedule?.legs[0];
      const last = schedule?.legs[schedule.legs.length - 1];
      const ownBlock = await adviseBlockedReason(db, shipmentId, shipment.shipmentType);

      const group = await adviseGroupFor(db, shipmentId);
      const join = adviseToJoin(group);
      const blocked = ownBlock ?? (join === null ? null : joinInsteadMessage(group, join));
      const eligible = requested.filter((id) => {
        const c = group.candidates.find((x) => x.shipmentId.toString() === id);
        return (
          c !== undefined &&
          (c.match === 'FULL' || c.match === 'WARN') &&
          c.blockedReason === null &&
          c.liveAdvise === null
        );
      });
      const included: GroupCandidate[] =
        blocked === null ? bookingsToInclude(group, eligible) : group.candidates.slice(0, 1);
      const codeOf = new Map(included.map((c) => [c.shipmentId.toString(), c.code]));

      const lines = blocked === null ? await buildGroupLines(db, included.map(member)) : [];
      const totals = totalsOf(lines);

      const polId = first?.originPortId ?? shipment.polId;
      const podId = last?.destinationPortId ?? shipment.podId;
      const ports = await db.port.findMany({
        where: { id: { in: [...new Set([polId, podId])] } },
        select: { id: true, name: true },
      });
      const portName = (id: bigint): string =>
        ports.find((p) => p.id === id)?.name ?? '—';

      const clpCodes = new Map<
        string,
        { code: string; containerNo: string | null; sealNo: string | null; containerSize: string }
      >();
      const clpIds = [...new Set(lines.map((l) => l.clpId).filter((v): v is bigint => v !== null))];
      if (clpIds.length > 0) {
        const clps = await db.clp.findMany({
          where: { id: { in: clpIds } },
          select: { id: true, code: true, containerNo: true, sealNo: true, containerSize: { select: { code: true } } },
        });
        for (const clp of clps) {
          clpCodes.set(clp.id.toString(), {
            code: clp.code,
            containerNo: clp.containerNo,
            sealNo: clp.sealNo,
            containerSize: clp.containerSize.code,
          });
        }
      }
      const clpOf = (id: bigint | null) => (id === null ? undefined : clpCodes.get(id.toString()));

      return {
        shipmentId: shipment.id.toString(),
        bookingNo: shipment.code,
        shipmentType: shipment.shipmentType,
        customerName: shipment.customer.name,
        exporterName: shipment.exporterName,
        carrierId: shipment.carrierId.toString(),
        carrierName: shipment.carrier.name,
        transitType: schedule?.transitType ?? shipment.transitType ?? 'DIRECT',
        firstVesselId: first?.vesselId?.toString() ?? null,
        firstVesselName: first?.vessel?.name ?? null,
        voyageNo: first?.voyageNo ?? null,
        firstFlightNo: first?.flightNo ?? null,
        polId: polId.toString(),
        polName: portName(polId),
        podId: podId.toString(),
        podName: portName(podId),
        etd: stamp(first?.etd ?? shipment.etd ?? null),
        eta: stamp(last?.eta ?? shipment.eta ?? null),
        stuffingDate: null,
        mblNo: null,
        lines: lines.map((line, index) => ({
          id: `draft-${index}`,
          bookingNo: codeOf.get(line.shipmentId.toString()) ?? shipment.code,
          poNo: line.poNo,
          itemCode: line.itemCode,
          sku: line.sku,
          ctnQty: line.ctnQty,
          pcsQty: line.pcsQty,
          netWeightKg: dec(line.netWeightKg),
          grossWeightKg: dec(line.grossWeightKg),
          cartonLengthCm: dec(line.cartonLengthCm),
          cartonWidthCm: dec(line.cartonWidthCm),
          cartonHeightCm: dec(line.cartonHeightCm),
          volumeCbm: dec(line.volumeCbm),
          chargeableWtKg: dec(line.chargeableWtKg),
          cargoReceiptDate: day(line.cargoReceiptDate),
          stuffingDate: day(line.stuffingDate),
          efrNo: line.efrNo,
          clpCode: clpOf(line.clpId)?.code ?? null,
          containerNo: clpOf(line.clpId)?.containerNo ?? null,
          sealNo: clpOf(line.clpId)?.sealNo ?? null,
          containerSize: clpOf(line.clpId)?.containerSize ?? null,
        })),
        totals: {
          poCount: totals.poCount,
          ctnQty: totals.ctnQty,
          pcsQty: totals.pcsQty,
          netWeightKg: dec(totals.netWeightKg),
          grossWeightKg: dec(totals.grossWeightKg),
          volumeCbm: dec(totals.volumeCbm),
          chargeableWtKg: dec(totals.chargeableWtKg),
        },
        recipients: await recipientsOf(db, shipment.customer.id),
        blockedReason: blocked,
        existingAdvise:
          join === null ? null : { id: join.id.toString(), code: join.code, status: join.status },
        bookingNos: included.map((c) => c.code),
        group: groupDto(group, new Set(included.map((c) => c.shipmentId.toString()))),
      };
    });

    const payload: ApiSuccess<ShipmentAdvisePrefillDto> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /bookings/:id/advise — the client's `Make Shipment Advise`.
 *
 * Allocates the House BL number here rather than on send, because the BL Draft
 * list shows it as a column and a draft advise is still a real record (§3.3).
 */
shipmentAdviseRouter.post(
  '/bookings/:id/advise',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = shipmentAdviseCreateSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const shipment = await gather(db, shipmentId);

      // CR-005: on any live advise, not only one made from this booking.
      const existing = await liveAdviseOf(db, shipmentId);
      if (existing !== null) {
        throw new HttpError(
          409,
          'ALREADY_ADVISED',
          `${shipment.code} already has ${existing.code}. Cancel it before making another.`,
        );
      }

      // One advise per EFR: if another booking of it is already advised, this
      // one joins that advise rather than starting a second.
      const group = await adviseGroupFor(db, shipmentId);
      const join = adviseToJoin(group);
      if (join !== null) {
        throw new HttpError(409, 'EFR_ALREADY_ADVISED', joinInsteadMessage(group, join));
      }
      const members = bookingsToInclude(group, input.shipmentIds ?? []);

      const lines = await buildGroupLines(db, members.map(member));
      const schedule = await approvedSchedule(db, shipmentId);
      const seriesYear = seriesYearOf(new Date());
      const tenant = await db.tenant.findFirst({
        where: { id: auth.tenantId },
        select: { slug: true },
      });

      let created: { id: bigint } | null = null;
      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
        const code = await nextShipmentAdviseNo(db, auth.tenantId, seriesYear);
        const houseBlNo = await nextHouseBlNo(db, auth.tenantId, tenant?.slug ?? 'hbl', new Date());
        try {
          created = await db.shipmentAdvise.create({
            data: {
              tenantId: auth.tenantId,
              code,
              seriesYear,
              shipmentId,
              scheduleId: schedule?.id ?? null,
              carrierId: BigInt(input.carrierId),
              transitType: input.transitType,
              firstVesselId: input.firstVesselId == null ? null : BigInt(input.firstVesselId),
              voyageNo: input.voyageNo ?? null,
              firstFlightNo: input.firstFlightNo ?? null,
              polId: BigInt(input.polId),
              podId: BigInt(input.podId),
              etd: input.etd == null ? null : new Date(input.etd),
              eta: input.eta == null ? null : new Date(input.eta),
              stuffingDate: input.stuffingDate == null ? null : new Date(input.stuffingDate),
              houseBlNo,
              mblNo: input.mblNo ?? null,
              status: 'DRAFT',
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: { id: true },
          });
          break;
        } catch (error) {
          const raced =
            isUniqueViolation(error, 'code') || isUniqueViolation(error, 'house_bl_no');
          if (attempt === CODE_RETRY_LIMIT - 1 || !raced) throw error;
        }
      }
      if (created === null) {
        throw new HttpError(500, 'CODE_EXHAUSTED', 'Could not allocate an advise number.');
      }

      // CR-005: the booking an advise is made from is always one of the
      // bookings it covers, and every line must be one of those bookings'.
      for (const m of members) {
        await addMembership(db, {
          tenantId: auth.tenantId,
          adviseId: created.id,
          shipmentId: m.shipmentId,
          code: m.code,
          userId: auth.userId,
        });
      }
      await writeLines(db, auth.tenantId, created.id, auth.userId, lines);
      return loadLive(db, shipmentId);
    });

    const payload: ApiSuccess<ShipmentAdviseDto | null> = { success: true, data };
    res.status(201).json(payload);
  },
);

/** PATCH /shipment-advise/:id — the header (B12–B14), while it is a draft. */
shipmentAdviseRouter.patch(
  '/shipment-advise/:id',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'advise');
    const input = shipmentAdviseHeaderSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadById(db, id);
      assertDraft(row);

      await db.shipmentAdvise.update({
        where: { id },
        data: {
          carrierId: BigInt(input.carrierId),
          transitType: input.transitType,
          firstVesselId: input.firstVesselId == null ? null : BigInt(input.firstVesselId),
          voyageNo: input.voyageNo ?? null,
          firstFlightNo: input.firstFlightNo ?? null,
          polId: BigInt(input.polId),
          podId: BigInt(input.podId),
          etd: input.etd == null ? null : new Date(input.etd),
          eta: input.eta == null ? null : new Date(input.eta),
          stuffingDate: input.stuffingDate == null ? null : new Date(input.stuffingDate),
          mblNo: input.mblNo ?? null,
          updatedBy: auth.userId,
        },
      });
      return loadLive(db, row.shipmentId);
    });

    const payload: ApiSuccess<ShipmentAdviseDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /shipment-advise/:id/build — re-pull the grid from the CLP.
 *
 * Its own permission, not EDIT: this throws away whatever was corrected by
 * hand and replaces the whole grid.
 */
shipmentAdviseRouter.post(
  '/shipment-advise/:id/build',
  requirePermission(`${FEATURE}.BUILD`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'advise');

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadById(db, id);
      assertDraft(row);
      // CR-005 rule 8: a booking of the EFR that has become ready since joins
      // now, and every booking's grid is pulled again.
      const scope = { tenantId: auth.tenantId, userId: auth.userId, adviseId: id };
      await growGroup(db, { ...scope, leadId: row.shipmentId });
      await rebuild(db, scope);
      return loadLive(db, row.shipmentId);
    });

    const payload: ApiSuccess<ShipmentAdviseDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /shipment-advise/:id/bookings — CR-005's `Add to SA-…`.
 *
 * One more booking of the EFR onto a draft advise: a warned booking the user
 * has decided belongs, or one that was not ready when the advise was made.
 * BUILD, not EDIT, because it re-pulls the whole grid as Build does.
 */
shipmentAdviseRouter.post(
  '/shipment-advise/:id/bookings',
  requirePermission(`${FEATURE}.BUILD`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'advise');
    const input = shipmentAdviseAddBookingSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadById(db, id);
      if (row.status === 'SENT') {
        throw new HttpError(
          409,
          'ADVISE_SENT',
          `${row.code} has already gone to the customer, so no booking can be added to it. ` +
            `Cancel it and make the advise again — it will get a new House BL number.`,
        );
      }
      assertDraft(row);

      const group = await adviseGroupFor(db, row.shipmentId);
      const candidate = group.candidates
        .slice(1)
        .find((c) => c.shipmentId.toString() === input.shipmentId);
      if (candidate === undefined) {
        throw new HttpError(
          409,
          'NOT_IN_GROUP',
          group.efrNo === null
            ? `${row.code} covers ${group.leadCode} on its own; no other booking can join it.`
            : `Only bookings of the same quotation received under ${group.efrNo} can join ${row.code}.`,
        );
      }
      assertCanJoin(candidate);

      const scope = { tenantId: auth.tenantId, userId: auth.userId, adviseId: id };
      await addMembership(db, { ...scope, shipmentId: candidate.shipmentId, code: candidate.code });
      await growGroup(db, { ...scope, leadId: row.shipmentId });
      await rebuild(db, scope);
      return loadLive(db, row.shipmentId);
    });

    const payload: ApiSuccess<ShipmentAdviseDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /shipment-advise/:id/send — the sheet's `Save & Send`.
 *
 * Moves the booking to ADVISED (§3.8) and queues the letter. The subject is the
 * client's own wording from B29.
 */
shipmentAdviseRouter.post(
  '/shipment-advise/:id/send',
  requirePermission(`${FEATURE}.SEND`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'advise');
    const input = shipmentAdviseSendSchema.parse(req.body);

    const sent = await withTenant(auth.tenantId, async (db) => {
      const row = await loadById(db, id);
      assertDraft(row);
      if (row.lines.length === 0) {
        throw new HttpError(
          409,
          'NOTHING_TO_ADVISE',
          `${row.code} has no cargo on it. Build the PO grid before sending.`,
        );
      }

      await db.shipmentAdvise.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date(), sentBy: auth.userId, updatedBy: auth.userId },
      });
      // CR-005 §3: every booking on the advise moves, in this transaction —
      // one that cannot refuses the whole send, and the error names it.
      for (const m of await adviseMembers(db, id)) {
        await transitionShipment(db, { shipmentId: m.id, to: 'ADVISED', userId: auth.userId });
      }
      return loadById(db, id);
    });
    const bookingNos = coveredBookings(sent).map((b) => b.code).join(', ');

    /*
     * The document, rendered once and stored, so the copy the customer receives
     * is the copy `Download & Print` produces (§9). Stored rather than held in
     * the outbox because a PDF is not something an event log should carry.
     *
     * A failure here does not lose the send: the advise has gone out either
     * way, and a letter with a missing attachment beats a 500 on a booking
     * that has already moved.
     */
    const attachments = await withTenant(auth.tenantId, async (db) => {
      try {
        const doc = await adviseDocument(db, auth.tenantId, sent);
        const stored = await putFile(auth.tenantId, 'shipment-advise', {
          buffer: doc.pdf,
          originalname: doc.filename,
          mimetype: 'application/pdf',
          size: doc.pdf.length,
        });
        await db.shipmentAdvise.update({
          where: { id },
          data: { pdfFile: stored.key, updatedBy: auth.userId },
        });
        return [
          { filename: doc.filename, contentType: 'application/pdf', storageKey: stored.key },
        ];
      } catch (error) {
        logger.error({ err: error, adviseId: id.toString() }, 'advise PDF not attached');
        return [];
      }
    });

    /*
     * Queued after the transaction commits, like every other notification here.
     * A customer told about an advise that rolled back would be reading a
     * letter about nothing.
     */
    await queueMail({
      attachments,
      tenantId: auth.tenantId,
      templateKey: 'SHIPMENT_ADVISE_SENT',
      to: input.to.map((r) => r.email),
      cc: (input.cc ?? []).map((r) => r.email),
      variables: {
        bookingNo: bookingNos,
        adviseNo: sent.code,
        customerName: sent.shipment.customer.name,
        houseBlNo: sent.houseBlNo,
        mblNo: sent.mblNo ?? '—',
        carrierName: sent.carrier.name,
        vesselOrFlight: sent.firstVessel?.name ?? sent.firstFlightNo ?? '—',
        polName: sent.pol.name,
        podName: sent.pod.name,
        etd: day(sent.etd) ?? '—',
        eta: day(sent.eta) ?? '—',
        totalCtnQty: sent.totalCtnQty,
        note: input.note ?? '',
      },
      relatedType: 'shipment_advise',
      relatedId: id,
      actorId: auth.userId,
      fallback: {
        // B29, verbatim — with every booking the advise covers (CR-005).
        subject: `Shipment Advise of Booking no : ${bookingNos}`,
        bodyText:
          `Your shipment under booking ${bookingNos} is on ` +
          `${sent.firstVessel?.name ?? sent.firstFlightNo ?? 'the carrier'} from ${sent.pol.name} ` +
          `to ${sent.pod.name}. House BL ${sent.houseBlNo}.`,
      },
    });

    const data = await withTenant(auth.tenantId, (db) => loadLive(db, sent.shipmentId));
    const payload: ApiSuccess<ShipmentAdviseDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /shipment-advise/:id/cancel — the only way back from SENT (§5 rule 3).
 *
 * The House BL number is kept on the cancelled row forever. Handing a number a
 * customer has already seen to a different shipment is the one thing this must
 * not do.
 */
shipmentAdviseRouter.post(
  '/shipment-advise/:id/cancel',
  requirePermission(`${FEATURE}.CANCEL`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'advise');
    const input = shipmentAdviseCancelSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadById(db, id);
      if (row.status === 'CANCELLED') {
        throw new HttpError(409, 'ADVISE_CANCELLED', `${row.code} was already cancelled.`);
      }

      const drafts = await db.blDraft.count({
        where: { adviseId: id, deletedAt: null, status: { not: 'CANCELLED' } },
      });
      if (drafts > 0) {
        throw new HttpError(
          409,
          'BL_DRAFT_EXISTS',
          `${row.code} carries the BL number a draft is using. Cancel the BL draft first.`,
        );
      }

      // Read before cancelling: the cancel releases them (a trigger does it).
      const members = await adviseMembers(db, id);

      await db.shipmentAdvise.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: auth.userId,
          cancelReason: input.reason,
          updatedBy: auth.userId,
        },
      });

      // Back to where it was: a booking with no live advise is one waiting for
      // one. Only from ADVISED — a draft never moved the booking. CR-005: every
      // booking the advise covered.
      if (row.status === 'SENT') {
        for (const m of members) {
          await transitionShipment(db, { shipmentId: m.id, to: 'CARGO_RECEIVED', userId: auth.userId });
        }
      }
      return loadLive(db, row.shipmentId);
    });

    const payload: ApiSuccess<ShipmentAdviseDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * The bytes of the advise document, built from the saved snapshot.
 *
 * Shared by the download endpoint and by `Save & Send`, so the customer's
 * attachment is the same page the operator printed — not a second rendering
 * that could drift from it.
 */
export async function adviseDocument(
  db: TenantDb,
  tenantId: bigint,
  row: AdviseRow,
): Promise<{ filename: string; pdf: Buffer }> {
  const head = await letterheadOf(db, tenantId);
  const covered = coveredBookings(row);
  // Each booking's latest issued shipping order, in booking order.
  const orders = await db.shippingOrder.findMany({
    where: { shipmentId: { in: covered.map((b) => b.id) }, deletedAt: null, status: 'ISSUED' },
    orderBy: { id: 'desc' },
    select: { shipmentId: true, code: true },
  });
  const soNos = covered
    .map((b) => orders.find((o) => o.shipmentId === b.id)?.code)
    .filter((code): code is string => code !== undefined);
  const isAir = row.shipment.shipmentType === 'AIR';

  const pdf = await renderShipmentAdvisePdf({
    // The name only: the letterhead's second line is the email signature block,
    // which the client does not want on the advise.
    companyName: head.companyName,
    adviseNo: row.code,
    bookingNo: covered.map((b) => b.code).join(', '),
    soNo: soNos.length === 0 ? null : soNos.join(', '),
    showBooking: covered.length > 1,
    issueDate: day(row.sentAt ?? row.createdAt) ?? '',
    customerName: row.shipment.customer.name,
    exporterName: row.shipment.exporterName,
    isAir,
    carrierName: row.carrier.name,
    transitType: row.transitType,
    firstVesselOrFlight: isAir ? row.firstFlightNo : (row.firstVessel?.name ?? null),
    voyageNo: row.voyageNo,
    polName: row.pol.name,
    podName: row.pod.name,
    etd: isAir ? stamp(row.etd) : day(row.etd),
    eta: isAir ? stamp(row.eta) : day(row.eta),
    houseBlNo: row.houseBlNo,
    mblNo: row.mblNo,
    lines: orderedLines(row).map((line) => ({
      bookingNo: line.booking.shipment.code,
      poNo: line.poNo,
      itemCode: line.itemCode,
      sku: line.sku,
      ctnQty: line.ctnQty,
      pcsQty: line.pcsQty,
      netWeightKg: dec(line.netWeightKg),
      grossWeightKg: dec(line.grossWeightKg),
      volumeCbm: dec(line.volumeCbm),
      chargeableWtKg: dec(line.chargeableWtKg),
      cargoReceiptDate: day(line.cargoReceiptDate),
      stuffingDate: day(line.stuffingDate),
      efrNo: line.efrNo,
      containerNo: line.clp?.containerNo ?? line.clp?.code ?? null,
      sealNo: line.clp?.sealNo ?? null,
      containerSize: line.clp?.containerSize.code ?? null,
    })),
    totals: {
      poCount: row.totalPoCount,
      ctnQty: row.totalCtnQty,
      pcsQty: row.totalPcsQty === null ? '—' : String(row.totalPcsQty),
      netWeightKg: dec(row.totalNetWeightKg) ?? '—',
      grossWeightKg: dec(row.totalGrossWeightKg) ?? '—',
      volumeCbm: dec(row.totalVolumeCbm) ?? '—',
      chargeableWtKg: dec(row.totalChargeableWtKg) ?? '—',
    },
  });

  return { filename: `${row.code}.pdf`, pdf };
}

/** GET /shipment-advise/:id/pdf — the sheet's `Download & Print`. */
shipmentAdviseRouter.get(
  '/shipment-advise/:id/pdf',
  requirePermission(`${FEATURE}.EXPORT_PDF`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'advise');

    const doc = await withTenant(auth.tenantId, async (db) => {
      const row = await loadById(db, id);
      return adviseDocument(db, auth.tenantId, row);
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.send(doc.pdf);
  },
);
