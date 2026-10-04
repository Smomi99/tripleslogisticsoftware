import type {
  MilestoneKind,
  MilestoneRow,
  MilestoneSortField,
  MilestoneView,
  ShipmentType,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { containersForShipments, recipientsOfCustomer } from './bl-draft-view';
import type { TenantDb } from './tenant-client';

/**
 * Depart-Arrive Confirmation — docs/DESIGN-UPDATE-2026-10-04.md §2.
 *
 * Every row is a BOOKING. Which bookings a screen lists, and the date it
 * pulls, are decided here once, in SQL, so the list, its tile count and the
 * confirm route cannot disagree:
 *
 *   source of the legs   the live advise's schedule, or before there is an
 *                        advise, the booking's APPROVED schedule — inbound
 *                        bookings reach these screens too (Steps table), and
 *                        not every one has an advise
 *   On board             every booking with either; ETD from the advise
 *                        ("This date pull from shipment advise"), else leg 1
 *   Transshipment        indirect routes with a second leg ("There is no
 *                        transhipment confirmation for direct vsl"), once
 *                        the departure is confirmed; ETD of leg 2
 *   Arrival              once the departure is confirmed; ETA from the
 *                        advise, else the last leg
 *
 * Cancelled and rejected bookings never sail, so they are never listed.
 */

export interface MilestoneFilter {
  kind: MilestoneKind;
  shipmentType?: ShipmentType | undefined;
  view: MilestoneView;
  search?: string | undefined;
  /** One booking — the confirm route asks whether it is on the list. */
  shipmentId?: bigint | undefined;
  /**
   * Whether the booking must have sailed. Defaults to every kind but
   * DEPARTED; the inbound lists (§4) ask for the arrival columns without it.
   */
  requireDeparture?: boolean | undefined;
  /** Bookings whose quotation is INBOUND — IGM Update and DO Issue (§4). */
  inboundOnly?: boolean | undefined;
  /** Further conditions on `s` (the shipment), from a caller with its own views. */
  extra?: Prisma.Sql[] | undefined;
}

export interface MilestonePick {
  shipmentId: bigint;
  adviseId: bigint | null;
  scheduleId: bigint | null;
  plannedOn: Date | null;
  confirmedOn: Date | null;
}

function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The pulled date, in the workspace's own calendar (CLAUDE.md §9). */
function plannedExpr(kind: MilestoneKind, zone: string): Prisma.Sql {
  const asDay = (column: Prisma.Sql) => Prisma.sql`(${column} AT TIME ZONE ${zone})::date`;
  switch (kind) {
    case 'DEPARTED':
      return Prisma.sql`COALESCE(${asDay(Prisma.sql`adv.etd`)}, ${asDay(Prisma.sql`first_leg.etd`)})`;
    case 'TRANSSHIPPED':
      return asDay(Prisma.sql`second_leg.etd`);
    case 'ARRIVED':
      return Prisma.sql`COALESCE(${asDay(Prisma.sql`adv.eta`)}, ${asDay(Prisma.sql`last_leg.eta`)})`;
  }
}

function candidates(tenantId: bigint, zone: string, filter: MilestoneFilter): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filter.shipmentType !== undefined) {
    conditions.push(Prisma.sql`s.shipment_type = ${filter.shipmentType}::shipment_type`);
  }
  if (filter.shipmentId !== undefined) conditions.push(Prisma.sql`s.id = ${filter.shipmentId}`);
  if (filter.requireDeparture ?? filter.kind !== 'DEPARTED') conditions.push(Prisma.sql`dep.id IS NOT NULL`);
  if (filter.inboundOnly === true) conditions.push(Prisma.sql`q.movement_type = 'INBOUND'`);
  conditions.push(...(filter.extra ?? []));
  if (filter.kind === 'TRANSSHIPPED') {
    conditions.push(Prisma.sql`COALESCE(adv.transit_type, sch.transit_type) = 'INDIRECT'`);
    conditions.push(Prisma.sql`second_leg.leg_no IS NOT NULL`);
  }
  if (filter.view === 'AWAITING') conditions.push(Prisma.sql`m.id IS NULL`);
  if (filter.view === 'CONFIRMED') conditions.push(Prisma.sql`m.id IS NOT NULL`);
  if (filter.search !== undefined) {
    const like = containsPattern(filter.search);
    conditions.push(Prisma.sql`(
         s.code ILIKE ${like} ESCAPE '\\'
      OR q.code ILIKE ${like} ESCAPE '\\'
      OR c.name ILIKE ${like} ESCAPE '\\'
      OR s.exporter_name ILIKE ${like} ESCAPE '\\'
    )`);
  }
  const where = conditions.length === 0 ? Prisma.empty : Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}`;

  // tenant_id is named on every table even though RLS filters them too: the
  // application is the first line (CLAUDE.md §7A rule 2), and a raw query has
  // no Prisma extension to add it.
  return Prisma.sql`
    WITH cand AS (
      SELECT s.id,
             s.code,
             c.name AS customer_name,
             adv.id AS advise_id,
             sch.id AS schedule_id,
             ${plannedExpr(filter.kind, zone)} AS planned_on,
             m.confirmed_on
        FROM shipment s
        JOIN customer c  ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
        JOIN quotation q ON q.tenant_id = s.tenant_id AND q.id = s.quotation_id
        LEFT JOIN LATERAL (
          SELECT a.id, a.etd, a.eta, a.schedule_id, a.transit_type
            FROM shipment_advise_booking ab
            JOIN shipment_advise a ON a.tenant_id = ab.tenant_id AND a.id = ab.advise_id
           WHERE ab.tenant_id = s.tenant_id
             AND ab.shipment_id = s.id
             AND ab.released_at IS NULL
             AND ab.deleted_at IS NULL
             AND a.deleted_at IS NULL
             AND a.status <> 'CANCELLED'
           ORDER BY a.id DESC
           LIMIT 1
        ) adv ON true
        LEFT JOIN LATERAL (
          SELECT sc.id, sc.transit_type
            FROM shipment_schedule sc
           WHERE sc.tenant_id = s.tenant_id
             AND sc.shipment_id = s.id
             AND sc.deleted_at IS NULL
             AND (sc.status = 'APPROVED' OR sc.id = adv.schedule_id)
           ORDER BY COALESCE(sc.id = adv.schedule_id, false) DESC, sc.version_no DESC, sc.id DESC
           LIMIT 1
        ) sch ON true
        LEFT JOIN LATERAL (
          SELECT l.leg_no, l.etd, l.eta FROM shipment_schedule_leg l
           WHERE l.tenant_id = s.tenant_id AND l.schedule_id = sch.id AND l.deleted_at IS NULL
           ORDER BY l.leg_no ASC LIMIT 1
        ) first_leg ON true
        LEFT JOIN LATERAL (
          SELECT l.leg_no, l.etd, l.eta FROM shipment_schedule_leg l
           WHERE l.tenant_id = s.tenant_id AND l.schedule_id = sch.id AND l.deleted_at IS NULL
             AND l.leg_no = 2
           LIMIT 1
        ) second_leg ON true
        LEFT JOIN LATERAL (
          SELECT l.leg_no, l.etd, l.eta FROM shipment_schedule_leg l
           WHERE l.tenant_id = s.tenant_id AND l.schedule_id = sch.id AND l.deleted_at IS NULL
           ORDER BY l.leg_no DESC LIMIT 1
        ) last_leg ON true
        LEFT JOIN shipment_milestone m
               ON m.tenant_id = s.tenant_id AND m.shipment_id = s.id
              AND m.kind = ${filter.kind}::milestone_kind AND m.deleted_at IS NULL
        LEFT JOIN shipment_milestone dep
               ON dep.tenant_id = s.tenant_id AND dep.shipment_id = s.id
              AND dep.kind = 'DEPARTED' AND dep.deleted_at IS NULL
       WHERE s.tenant_id = ${tenantId}
         AND s.deleted_at IS NULL
         AND s.status NOT IN ('CANCELLED', 'REJECTED')
         AND (adv.id IS NOT NULL OR sch.id IS NOT NULL)
         ${where}
    )`;
}

const ORDER_BY: Record<MilestoneSortField, Prisma.Sql> = {
  // The confirmed date once there is one, the pulled date until then: the
  // worklist reads soonest first, the record reads by what happened.
  date: Prisma.sql`COALESCE(cand.confirmed_on, cand.planned_on)`,
  code: Prisma.sql`cand.code`,
  customer: Prisma.sql`cand.customer_name`,
};

export async function workspaceZone(db: TenantDb, tenantId: bigint): Promise<string> {
  const tenant = await db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } });
  return tenant?.timezone ?? 'Asia/Dhaka';
}

export async function milestonePicks(
  db: TenantDb,
  tenantId: bigint,
  filter: MilestoneFilter,
  sort: { by: MilestoneSortField; order: 'asc' | 'desc' },
  page: { page: number; limit: number },
): Promise<{ picks: MilestonePick[]; total: number }> {
  const zone = await workspaceZone(db, tenantId);
  const set = candidates(tenantId, zone, filter);
  const direction = Prisma.raw(sort.order === 'desc' ? 'DESC' : 'ASC');

  const [rows, counted] = await Promise.all([
    db.$queryRaw<
      {
        id: bigint;
        advise_id: bigint | null;
        schedule_id: bigint | null;
        planned_on: Date | null;
        confirmed_on: Date | null;
      }[]
    >`
      ${set}
      SELECT cand.id, cand.advise_id, cand.schedule_id, cand.planned_on, cand.confirmed_on
        FROM cand
       ORDER BY ${ORDER_BY[sort.by]} ${direction} NULLS LAST, cand.id ${direction}
       LIMIT ${page.limit} OFFSET ${(page.page - 1) * page.limit}
    `,
    db.$queryRaw<{ total: bigint }[]>`${set} SELECT COUNT(*) AS total FROM cand`,
  ]);

  return {
    picks: rows.map((r) => ({
      shipmentId: r.id,
      adviseId: r.advise_id,
      scheduleId: r.schedule_id,
      plannedOn: r.planned_on,
      confirmedOn: r.confirmed_on,
    })),
    total: Number(counted[0]?.total ?? 0),
  };
}

/** How many bookings wait on each kind, for one mode — the landing page's tiles. */
export async function awaitingCount(
  db: TenantDb,
  tenantId: bigint,
  kind: MilestoneKind,
  shipmentType: ShipmentType,
): Promise<number> {
  const zone = await workspaceZone(db, tenantId);
  const set = candidates(tenantId, zone, { kind, shipmentType, view: 'AWAITING' });
  const rows = await db.$queryRaw<{ total: bigint }[]>`${set} SELECT COUNT(*) AS total FROM cand`;
  return Number(rows[0]?.total ?? 0);
}

export const day = (d: Date | null | undefined): string | null =>
  d === null || d === undefined ? null : d.toISOString().slice(0, 10);

function legName(leg: {
  vessel: { name: string } | null;
  voyageNo: string | null;
  flightNo: string | null;
} | null | undefined, isAir: boolean): string | null {
  if (leg === null || leg === undefined) return null;
  if (isAir) return leg.flightNo ?? null;
  return [leg.vessel?.name, leg.voyageNo].filter((v) => (v ?? '') !== '').join(' / ') || null;
}

/**
 * Turns picked bookings into rows: one read per table for the page, then the
 * containers per booking, which is how the BL draft reads them.
 */
export async function milestoneRows(
  db: TenantDb,
  kind: MilestoneKind,
  picks: MilestonePick[],
): Promise<MilestoneRow[]> {
  if (picks.length === 0) return [];
  const ids = picks.map((p) => p.shipmentId);
  const adviseIds = picks.flatMap((p) => (p.adviseId === null ? [] : [p.adviseId]));
  const scheduleIds = picks.flatMap((p) => (p.scheduleId === null ? [] : [p.scheduleId]));

  const legSelect = {
    legNo: true,
    voyageNo: true,
    flightNo: true,
    vessel: { select: { name: true } },
  } as const;

  const [shipments, advises, schedules, milestones] = await Promise.all([
    db.shipment.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        code: true,
        status: true,
        shipmentType: true,
        exporterName: true,
        customer: { select: { id: true, name: true } },
        quotation: { select: { code: true } },
        pol: { select: { name: true, portCode: true } },
        pod: { select: { name: true, portCode: true } },
        carrier: { select: { name: true } },
        shippingOrders: {
          where: { deletedAt: null, status: 'ISSUED' },
          orderBy: { id: 'desc' },
          take: 1,
          select: { code: true },
        },
      },
    }),
    db.shipmentAdvise.findMany({
      where: { id: { in: adviseIds } },
      select: {
        id: true,
        voyageNo: true,
        firstFlightNo: true,
        firstVessel: { select: { name: true } },
        carrier: { select: { name: true } },
        pol: { select: { name: true, portCode: true } },
        pod: { select: { name: true, portCode: true } },
      },
    }),
    db.shipmentSchedule.findMany({
      where: { id: { in: scheduleIds } },
      select: {
        id: true,
        carrier: { select: { name: true } },
        legs: { where: { deletedAt: null }, orderBy: { legNo: 'asc' }, select: legSelect },
      },
    }),
    db.shipmentMilestone.findMany({
      where: { shipmentId: { in: ids }, kind, deletedAt: null },
      select: {
        shipmentId: true,
        confirmedOn: true,
        pulledOn: true,
        changeReason: true,
        confirmedAt: true,
        emailLogId: true,
        confirmedByUser: { select: { username: true } },
      },
    }),
  ]);

  const shipmentOf = new Map(shipments.map((s) => [s.id.toString(), s]));
  const adviseOf = new Map(advises.map((a) => [a.id.toString(), a]));
  const scheduleOf = new Map(schedules.map((s) => [s.id.toString(), s]));
  const milestoneOf = new Map(milestones.map((m) => [m.shipmentId.toString(), m]));

  const rows = await Promise.all(
    picks.map(async (pick): Promise<MilestoneRow | null> => {
      const s = shipmentOf.get(pick.shipmentId.toString());
      if (s === undefined) return null;
      const advise = pick.adviseId === null ? undefined : adviseOf.get(pick.adviseId.toString());
      const schedule = pick.scheduleId === null ? undefined : scheduleOf.get(pick.scheduleId.toString());
      const legs = schedule?.legs ?? [];
      const isAir = s.shipmentType === 'AIR';

      let legLabel: string | null;
      if (kind === 'DEPARTED') {
        legLabel =
          advise === undefined
            ? legName(legs[0], isAir)
            : isAir
              ? advise.firstFlightNo
              : [advise.firstVessel?.name, advise.voyageNo].filter((v) => (v ?? '') !== '').join(' / ') || null;
        legLabel ??= legName(legs[0], isAir);
      } else if (kind === 'TRANSSHIPPED') {
        legLabel = legName(legs.find((l) => l.legNo === 2), isAir);
      } else {
        legLabel = legName(legs[legs.length - 1], isAir);
      }

      const m = milestoneOf.get(s.id.toString());
      const [containers, recipients] = await Promise.all([
        isAir ? Promise.resolve([]) : containersForShipments(db, [s.id]),
        recipientsOfCustomer(db, s.customer.id),
      ]);
      const pol = advise?.pol ?? s.pol;
      const pod = advise?.pod ?? s.pod;

      return {
        shipmentId: s.id.toString(),
        bookingCode: s.code,
        bookingStatus: s.status,
        quotationCode: s.quotation.code,
        soCode: s.shippingOrders[0]?.code ?? null,
        customerName: s.customer.name,
        exporterName: s.exporterName,
        shipmentType: s.shipmentType,
        polName: pol.name,
        polCode: pol.portCode,
        podName: pod.name,
        podCode: pod.portCode,
        carrierName: advise?.carrier.name ?? schedule?.carrier.name ?? s.carrier.name,
        containers: containers.map((c) => ({ containerNo: c.containerNo, sealNo: c.sealNo, size: c.containerSize })),
        legLabel,
        plannedOn: day(pick.plannedOn),
        confirmation:
          m === undefined
            ? null
            : {
                confirmedOn: day(m.confirmedOn) ?? '',
                pulledOn: day(m.pulledOn),
                changeReason: m.changeReason,
                confirmedAt: m.confirmedAt.toISOString(),
                confirmedByName: m.confirmedByUser?.username ?? null,
                notified: m.emailLogId !== null,
              },
        recipients: recipients.map((r) => r.email),
      };
    }),
  );
  return rows.filter((r): r is MilestoneRow => r !== null);
}
