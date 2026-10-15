import {
  type AirRouteLegDto,
  AWB_ORIGINALS,
  type BlDraftContainerDto,
  type BlDraftDto,
  type BlDraftPrefillDto,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';

import { adviseMembers, leadFirst, LIVE_MEMBERSHIP, liveAdviseOf } from './advise-group';
import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';
import { tenantDayOf } from './tenant-day';

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

/**
 * What an air waybill's routing is read from (§14): the first flight and
 * departure as the advise recorded them, and the legs of the schedule the
 * advise was built from.
 *
 * The airline by id, not through the relation: a customer session cannot read
 * carrier rows (CR-004), and a required relation it cannot see fails the whole
 * read — the portal's sea drafts with it. The name is only a fallback for a
 * flight number with no designator, so the printer looks it up on its own.
 */
const AIR_ROUTE_SELECT = {
  carrierId: true,
  firstFlightNo: true,
  etd: true,
  pol: { select: { name: true, portCode: true } },
  pod: { select: { name: true, portCode: true } },
  schedule: {
    select: {
      legs: {
        where: { deletedAt: null },
        orderBy: { legNo: 'asc' as const },
        select: {
          legNo: true,
          flightNo: true,
          etd: true,
          originPort: { select: { name: true, portCode: true } },
          destinationPort: { select: { name: true, portCode: true } },
        },
      },
    },
  },
} satisfies Prisma.ShipmentAdviseSelect;

type AirRouteSource = Prisma.ShipmentAdviseGetPayload<{
  select: typeof AIR_ROUTE_SELECT & { transitType: true };
}>;

/**
 * The airline in a flight number — IATA's two-character designator, which is
 * what an air waybill's "by" boxes carry: `G9 507` is Air Arabia's flight 507,
 * so `G9`. A number in any other shape gives null, and the caller prints the
 * airline's name instead.
 */
export function airlineDesignator(flightNo: string | null): string | null {
  const m = /^\s*([A-Z][A-Z0-9]|[0-9][A-Z])\s*-?\s*\d{1,4}[A-Z]?\s*$/i.exec(flightNo ?? '');
  return m === null ? null : m[1]!.toUpperCase();
}

/**
 * The flights on an air waybill (§14), in order.
 *
 * A direct flight is the advise's own: its first flight, its departure, from
 * its AOL to its AOD. A route that transships takes its legs from the
 * schedule, with the ends and the first flight as the advise overrode them —
 * the advise is what went to the customer, so where it differs it wins.
 *
 * `airlineName` stands in for a flight number with no designator.
 */
export function airRouteOf(advise: AirRouteSource, airlineName: string | null = null): AirRouteLegDto[] {
  const legs = advise.schedule?.legs ?? [];
  const designated = (flightNo: string | null): string | null =>
    airlineDesignator(flightNo) ?? airlineName;

  if (advise.transitType !== 'INDIRECT' || legs.length < 2) {
    const departure = advise.etd ?? legs[0]?.etd ?? null;
    return [
      {
        legNo: 1,
        flightNo: advise.firstFlightNo,
        carrier: designated(advise.firstFlightNo),
        fromCode: advise.pol.portCode,
        fromName: advise.pol.name,
        toCode: advise.pod.portCode,
        toName: advise.pod.name,
        departure: departure?.toISOString() ?? null,
      },
    ];
  }

  const last = legs.length - 1;
  return legs.map((leg, i) => {
    const flightNo = i === 0 ? (advise.firstFlightNo ?? leg.flightNo) : leg.flightNo;
    const from = i === 0 ? advise.pol : leg.originPort;
    const to = i === last ? advise.pod : leg.destinationPort;
    const departure = i === 0 ? (advise.etd ?? leg.etd) : leg.etd;
    return {
      legNo: leg.legNo,
      flightNo,
      carrier: designated(flightNo),
      fromCode: from.portCode,
      fromName: from.name,
      toCode: to.portCode,
      toName: to.name,
      departure: departure?.toISOString() ?? null,
    };
  });
}

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
        // §14: an air waybill's routing and flights, read from the advise.
        ...AIR_ROUTE_SELECT,
        // CR-005: one bill for every booking on its advise.
        bookings: {
          where: { deletedAt: null },
          orderBy: { id: 'asc' },
          select: { releasedAt: true, shipment: { select: { id: true, code: true } } },
        },
      },
    },
    preCarriage: { select: { name: true } },
    // The name and the agent's own Delivery agent details: the bill's "Please Apply to" block.
    deliveryAgent: { select: { name: true, deliveryAgentDetails: true } },
    // The airport codes and the country: an air waybill prints both (§14).
    pol: { select: { name: true, portCode: true, country: true } },
    pod: { select: { name: true, portCode: true, country: true } },
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
    shipmentType: row.shipment.shipmentType,
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
    preCarriageByModeId: row.preCarriageByModeId?.toString() ?? null,
    preCarriageByModeName: row.preCarriage?.name ?? null,
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
    packageCount: row.packageCount,
    chargeableWeightKg: dec(row.chargeableWeightKg),
    freightPayableAt: row.freightPayableAt,
    originalBlCount: row.originalBlCount,
    ladenOnBoardDate: day(row.ladenOnBoardDate),
    airRoute: row.shipment.shipmentType === 'AIR' ? airRouteOf(row.advise) : [],
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
      tenantId: true,
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
      etd: true,
      // §14: an air waybill's figures are the advise's totals — no containers.
      totalCtnQty: true,
      totalGrossWeightKg: true,
      totalVolumeCbm: true,
      totalChargeableWtKg: true,
    },
  });
  const isAir = shipment.shipmentType === 'AIR';
  // §14: the flights, in their own read — the schedule above is the sea's last leg only.
  const airAdvise =
    !isAir || live === null
      ? null
      : await db.shipmentAdvise.findFirst({
          where: { id: live.id },
          select: { ...AIR_ROUTE_SELECT, transitType: true },
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
  // Air has no load plan, so nothing to pull a container from (§14).
  const containers =
    advise === null || isAir ? [] : await containersForShipments(db, members.map((m) => m.id));
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

  /*
   * §14: an air waybill is executed before the flight rather than dated by
   * it, so the departure stands in until a milestone confirms one. Read in
   * the workspace's calendar — a 02:00 Dhaka departure is the day before in UTC.
   */
  const dayOf = await tenantDayOf(db, shipment.tenantId);
  const departure = isAir ? (advise?.etd ?? null) : null;
  const onBoard =
    departed !== null ? day(departed.confirmedOn) : departure === null ? null : dayOf(departure);

  const blocked =
    advise === null
      ? `${requested.code} has no sent shipment advise yet. The ${isAir ? 'HAWB' : 'BL'} number is allocated there.`
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
    shipmentType: shipment.shipmentType,
    // A sea bill's starred boxes (B34, F34); an air waybill has neither.
    preCarriageByModeId: isAir ? null : (shipment.modeId?.toString() ?? ''),
    preCarriageByModeName: isAir ? null : (shipment.mode?.name ?? ''),
    placeOfReceipt: isAir ? null : (shipment.placeOfReceipt ?? ''),
    deliveryAgentId: null,
    deliveryAgentName: null,
    deliveryAgentText: null,
    oceanVesselVoyage: isAir
      ? null
      : oceanVessel.filter((v) => (v ?? '') !== '').join(' / ') || null,
    polId: (advise?.polId ?? shipment.polId).toString(),
    polName: advise?.pol.name ?? shipment.pol.name,
    podId: (advise?.podId ?? shipment.podId).toString(),
    podName: advise?.pod.name ?? shipment.pod.name,
    placeOfDelivery: null,
    packagesDescription: null,
    marksAndNumbers: null,
    grossWeightKg: isAir
      ? dec(advise?.totalGrossWeightKg ?? null)
      : containers.length === 0
        ? null
        : gross.toString(),
    measurementCbm: isAir
      ? dec(advise?.totalVolumeCbm ?? null)
      : containers.length === 0
        ? null
        : cbm.toString(),
    packageCount: isAir ? (advise?.totalCtnQty ?? null) : null,
    chargeableWeightKg: isAir ? dec(advise?.totalChargeableWtKg ?? null) : null,
    freightPayableAt: null,
    // A waybill is always issued in three originals (§14); a sea bill says.
    originalBlCount: isAir ? AWB_ORIGINALS.length : null,
    ladenOnBoardDate: onBoard,
    airRoute: airAdvise === null ? [] : airRouteOf(airAdvise),
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
