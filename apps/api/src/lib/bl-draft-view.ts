import type { BlDraftContainerDto, BlDraftDto, BlDraftPrefillDto } from '@ff/shared';

import { Prisma } from '../generated/prisma/client';

import { adviseMembers, leadFirst, LIVE_MEMBERSHIP, liveAdviseOf } from './advise-group';
import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * Reading a BL draft — docs/MODULE_DOCUMENTATION.md §2.3, §2.4.
 *
 * Shared by the staff router and the customer portal on purpose. §3.6 makes
 * both sheets one document in different states, and two readers of one table
 * would be two chances to disagree about what it says. What differs between
 * them is who may call which route and which rows RLS admits — never the shape
 * of the answer.
 */

const dec = (d: Prisma.Decimal | null): string | null => (d === null ? null : d.toString());
const stamp = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

export const blDraftArgs = {
  include: {
    shipment: {
      select: {
        id: true,
        code: true,
        shipmentType: true,
        exporterName: true,
        exporterAddress: true,
        importerName: true,
        importerAddress: true,
        placeOfReceipt: true,
        customer: { select: { id: true, name: true } },
        // The Incoterms decide Prepaid or Collect on the printed bill.
        tos: { select: { code: true } },
      },
    },
    advise: {
      select: {
        id: true,
        houseBlNo: true,
        mblNo: true,
        status: true,
        // The first leg's vessel and voyage — the printed bill's pre-carriage
        // when the route transships; a direct sailing has none.
        transitType: true,
        firstVessel: { select: { name: true } },
        voyageNo: true,
        // CR-005: one bill for every booking on its advise.
        bookings: {
          where: { deletedAt: null },
          orderBy: { id: 'asc' },
          select: { releasedAt: true, shipment: { select: { id: true, code: true } } },
        },
      },
    },
    preCarriage: { select: { name: true } },
    // The name, and where to find them: the bill's "Please Apply to" block.
    deliveryAgent: { select: { name: true, address: true, country: true } },
    pol: { select: { name: true } },
    pod: { select: { name: true } },
    // §13: who issued the bill, for BL Print's confirmation and its list.
    issuedByUser: { select: { username: true } },
    containers: {
      where: { deletedAt: null },
      orderBy: { id: 'asc' },
    },
  },
} satisfies { include: Prisma.BlDraftInclude };

export type BlDraftRow = Prisma.BlDraftGetPayload<typeof blDraftArgs>;

/**
 * The bookings a bill covers, the one its advise was made from first — the
 * advise's live bookings, or, once it is cancelled, the ones it held.
 */
export function billBookings(row: BlDraftRow): { id: bigint; code: string }[] {
  const all = row.advise.bookings;
  const live = all.filter((b) => b.releasedAt === null);
  const rows = (live.length > 0 ? live : all).map((b) => b.shipment);
  return rows.length === 0
    ? [{ id: row.shipmentId, code: row.shipment.code }]
    : leadFirst(row.shipmentId, rows);
}

function containerDto(row: BlDraftRow['containers'][number]): BlDraftContainerDto {
  return {
    id: row.id.toString(),
    containerNo: row.containerNo,
    containerSize: row.containerSize,
    sealNo: row.sealNo,
    ctnQty: row.ctnQty,
    grossWeightKg: dec(row.grossWeightKg),
    measurementCbm: dec(row.measurementCbm),
  };
}

export function blDraftDto(
  row: BlDraftRow,
  recipients: { name: string | null; email: string }[],
): BlDraftDto {
  return {
    id: row.id.toString(),
    code: row.code,
    status: row.status,
    origin: row.origin,
    shipmentId: row.shipmentId.toString(),
    bookingNo: row.shipment.code,
    bookingNos: billBookings(row).map((b) => b.code),
    customerName: row.shipment.customer.name,
    blNo: row.blNo,
    mblNo: row.advise.mblNo,
    manifestNo: row.manifestNo,
    shipperText: row.shipperText,
    consigneeText: row.consigneeText,
    notifyText: row.notifyText,
    alsoNotifyText: row.alsoNotifyText,
    exportReferences: row.exportReferences,
    forwardingAgentReferences: row.forwardingAgentReferences,
    pointCountryOfOrigin: row.pointCountryOfOrigin,
    preCarriageByModeId: row.preCarriageByModeId.toString(),
    preCarriageByModeName: row.preCarriage.name,
    placeOfReceipt: row.placeOfReceipt,
    deliveryAgentId: row.deliveryAgentId?.toString() ?? null,
    deliveryAgentName: row.deliveryAgent?.name ?? null,
    deliveryAgentText: row.deliveryAgentText,
    oceanVesselVoyage: row.oceanVesselVoyage,
    polId: row.polId.toString(),
    polName: row.pol.name,
    podId: row.podId.toString(),
    podName: row.pod.name,
    placeOfDelivery: row.placeOfDelivery,
    packagesDescription: row.packagesDescription,
    marksAndNumbers: row.marksAndNumbers,
    grossWeightKg: dec(row.grossWeightKg),
    measurementCbm: dec(row.measurementCbm),
    freightPayableAt: row.freightPayableAt,
    originalBlCount: row.originalBlCount,
    ladenOnBoardDate: day(row.ladenOnBoardDate),
    submittedAt: stamp(row.submittedAt),
    approvedAt: stamp(row.approvedAt),
    sentAt: stamp(row.sentAt),
    issuedAt: stamp(row.issuedAt),
    cancelReason: row.cancelReason,
    containers: row.containers.map(containerDto),
    recipients,
  };
}

export async function recipientsOfCustomer(
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

/**
 * The live bill covering a booking. CR-005: the bill hangs off the booking its
 * advise was made from, so any other booking on that advise finds it through
 * the advise — one bill, reached from every booking it covers.
 */
export async function liveBlDraftRow(db: TenantDb, shipmentId: bigint): Promise<BlDraftRow | null> {
  return db.blDraft.findFirst({
    where: {
      deletedAt: null,
      status: { not: 'CANCELLED' },
      advise: { bookings: { some: { shipmentId, ...LIVE_MEMBERSHIP } } },
    },
    orderBy: { id: 'desc' },
    ...blDraftArgs,
  });
}

export async function loadLiveBlDraft(
  db: TenantDb,
  shipmentId: bigint,
): Promise<BlDraftDto | null> {
  const row = await liveBlDraftRow(db, shipmentId);
  if (row === null) return null;
  return blDraftDto(row, await recipientsOfCustomer(db, row.shipment.customer.id));
}

export async function loadBlDraftById(db: TenantDb, id: bigint): Promise<BlDraftRow> {
  const row = await db.blDraft.findFirst({ where: { id, deletedAt: null }, ...blDraftArgs });
  if (row === null) throw HttpError.notFound('BL draft not found.');
  return row;
}

/**
 * The container block (B40), pulled from the finalised plans of the bookings
 * on the bill — CR-005: every booking on its advise.
 *
 * Filtered through the load plan's own lines for those bookings, so a
 * consolidated box lists the container once and not once per participant, and
 * counts only the cartons this bill covers.
 */
export async function containersForShipments(db: TenantDb, shipmentIds: bigint[]) {
  const ours = { deletedAt: null, shipmentPo: { shipmentId: { in: shipmentIds }, deletedAt: null } };
  const clps = await db.clp.findMany({
    where: {
      deletedAt: null,
      status: 'FINAL',
      lines: { some: ours },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      containerNo: true,
      sealNo: true,
      containerSize: { select: { name: true } },
      lines: {
        where: ours,
        select: { ctnQty: true, grossWeightKg: true, volumeCbm: true },
      },
    },
  });

  return clps.map((clp) => {
    const ctnQty = clp.lines.reduce((acc, l) => acc + l.ctnQty, 0);
    const gross = clp.lines.reduce(
      (acc, l) => (l.grossWeightKg === null ? acc : acc.add(l.grossWeightKg)),
      new Prisma.Decimal(0),
    );
    const cbm = clp.lines.reduce(
      (acc, l) => (l.volumeCbm === null ? acc : acc.add(l.volumeCbm)),
      new Prisma.Decimal(0),
    );
    return {
      clpId: clp.id,
      containerNo: clp.containerNo,
      containerSize: clp.containerSize.name,
      sealNo: clp.sealNo,
      ctnQty,
      grossWeightKg: gross,
      measurementCbm: cbm,
    };
  });
}

/**
 * What the form opens on before anything is typed (§2.4's `Pull`).
 *
 * The party blocks come from the booking — exporter as shipper, importer as
 * consignee and notify — and belong to the document from that moment on (§3.4).
 */
export async function blDraftPrefill(
  db: TenantDb,
  shipmentId: bigint,
): Promise<BlDraftPrefillDto> {
  const requested = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: { id: true, code: true },
  });
  if (requested === null) throw HttpError.notFound('Booking not found.');

  // CR-005: the bill is drawn from the booking its advise was made from, and
  // covers every booking on that advise — whichever of them it is opened from.
  const live = await liveAdviseOf(db, shipmentId, 'SENT');
  const shipment = await db.shipment.findFirst({
    where: { id: live?.shipmentId ?? shipmentId, deletedAt: null },
    select: {
      id: true,
      code: true,
      shipmentType: true,
      exporterName: true,
      exporterAddress: true,
      importerName: true,
      importerAddress: true,
      placeOfReceipt: true,
      modeId: true,
      polId: true,
      podId: true,
      customer: { select: { id: true, name: true } },
      mode: { select: { name: true } },
      pol: { select: { name: true } },
      pod: { select: { name: true } },
    },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');

  const advise = live === null ? null : await db.shipmentAdvise.findFirst({
    where: { id: live.id },
    select: {
      id: true,
      houseBlNo: true,
      mblNo: true,
      transitType: true,
      firstVessel: { select: { name: true } },
      voyageNo: true,
      // The last leg — the mother vessel, when the route transships.
      schedule: {
        select: {
          legs: {
            where: { deletedAt: null },
            orderBy: { legNo: 'desc' },
            take: 1,
            select: { legNo: true, voyageNo: true, vessel: { select: { name: true } } },
          },
        },
      },
      polId: true,
      podId: true,
      pol: { select: { name: true } },
      pod: { select: { name: true } },
    },
  });

  /*
   * The ocean vessel is the one that crosses (client, 2026-10-06): on a route
   * that transships, the last leg's — the first leg prints as pre-carriage —
   * and on a direct sailing, the first and only one.
   */
  const lastLeg = advise?.transitType === 'INDIRECT' ? advise.schedule?.legs[0] : undefined;
  const oceanVessel =
    advise === null
      ? []
      : lastLeg !== undefined && lastLeg.legNo > 1
        ? [lastLeg.vessel?.name, lastLeg.voyageNo]
        : [advise.firstVessel?.name, advise.voyageNo];

  const members = advise === null ? [] : await adviseMembers(db, advise.id);
  const containers =
    advise === null ? [] : await containersForShipments(db, members.map((m) => m.id));
  // DESIGN-UPDATE-2026-10-04 §2: a confirmed departure "will finally pull to
  // BL as on board date". The bill's own booking first, then any on its advise.
  const departed = await db.shipmentMilestone.findFirst({
    where: {
      kind: 'DEPARTED',
      deletedAt: null,
      shipmentId: { in: [shipment.id, ...members.map((m) => m.id)] },
    },
    orderBy: { confirmedOn: 'asc' },
    select: { confirmedOn: true },
  });
  const gross = containers.reduce((acc, c) => acc.add(c.grossWeightKg), new Prisma.Decimal(0));
  const cbm = containers.reduce((acc, c) => acc.add(c.measurementCbm), new Prisma.Decimal(0));

  const blocked =
    advise === null
      ? `${requested.code} has no sent shipment advise yet. The BL number is allocated there.`
      : shipment.shipmentType === 'AIR'
        ? 'Both BL Draft sheets say "Only for Outbound shipment-Sea". An air equivalent is open question 8.'
        : null;

  const party = (name: string | null, address: string | null): string =>
    [name, address].filter((v) => (v ?? '').trim() !== '').join('\n');

  return {
    shipmentId: shipment.id.toString(),
    bookingNo: shipment.code,
    bookingNos: members.length === 0 ? [requested.code] : members.map((m) => m.code),
    customerName: shipment.customer.name,
    blNo: advise?.houseBlNo ?? '',
    mblNo: advise?.mblNo ?? null,
    manifestNo: null,
    shipperText: party(shipment.exporterName, shipment.exporterAddress),
    consigneeText: party(shipment.importerName, shipment.importerAddress),
    notifyText: party(shipment.importerName, shipment.importerAddress),
    alsoNotifyText: null,
    exportReferences: null,
    forwardingAgentReferences: null,
    pointCountryOfOrigin: null,
    preCarriageByModeId: shipment.modeId?.toString() ?? '',
    preCarriageByModeName: shipment.mode?.name ?? '',
    placeOfReceipt: shipment.placeOfReceipt ?? '',
    deliveryAgentId: null,
    deliveryAgentName: null,
    deliveryAgentText: null,
    oceanVesselVoyage: oceanVessel.filter((v) => (v ?? '') !== '').join(' / ') || null,
    polId: (advise?.polId ?? shipment.polId).toString(),
    polName: advise?.pol.name ?? shipment.pol.name,
    podId: (advise?.podId ?? shipment.podId).toString(),
    podName: advise?.pod.name ?? shipment.pod.name,
    placeOfDelivery: null,
    packagesDescription: null,
    marksAndNumbers: null,
    grossWeightKg: containers.length === 0 ? null : gross.toString(),
    measurementCbm: containers.length === 0 ? null : cbm.toString(),
    freightPayableAt: null,
    originalBlCount: null,
    ladenOnBoardDate: day(departed?.confirmedOn ?? null),
    containers: containers.map((c, index) => ({
      id: `draft-${index}`,
      containerNo: c.containerNo,
      containerSize: c.containerSize,
      sealNo: c.sealNo,
      ctnQty: c.ctnQty,
      grossWeightKg: c.grossWeightKg.toString(),
      measurementCbm: c.measurementCbm.toString(),
    })),
    recipients: await recipientsOfCustomer(db, shipment.customer.id),
    blockedReason: blocked,
  };
}
