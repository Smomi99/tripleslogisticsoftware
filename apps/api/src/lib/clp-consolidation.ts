import { Prisma } from '../generated/prisma/client';
import { LIVE_ALLOCATION } from './clp-allocate';
import { efrNosOfCargoLines } from './clp-efr';
import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * Which bookings may share a container — CR-002 §3, as corrected by the
 * decisions of 2026-09-15.
 *
 * Two ideas are kept apart on purpose, because conflating them is how a
 * planner ends up unable to do something legitimate:
 *
 *   PHYSICAL COMPATIBILITY is a hard rule. Cargo that cannot travel together
 *   must not be planned together, and no permission overrides it. That is
 *   what `checkCompatibility` enforces, server-side, at save time.
 *
 *   COMMERCIAL GROUPING is a default. Bookings under one quotation are
 *   *suggested* together, and a user may split that suggestion whenever the
 *   physical rules still hold. `suggestGroups` proposes; it never decides.
 *
 * The sailing rule is the one worth reading twice. CR-002 originally keyed it
 * on `shipment_schedule.id`, which cannot work: that table is per shipment, so
 * two bookings on one sailing hold two different rows and no two bookings
 * could ever match. The physical sailing is
 * `shipment_schedule_leg.(vessel_id, voyage_no)` on the APPROVED schedule —
 * the same read `shipping-order.route.ts` already does.
 */

/**
 * Three workflows, one per loading type, and they never share a box — the
 * client's loading-type sheet of 2026-09-16:
 *
 *   FCL         one booking fills its own container. One exporter, one EFR;
 *               the booking may need several containers, but no other
 *               booking joins it (rule 9).
 *   LCL         several bookings share a box — different exporters, and
 *               different customers too (confirmed 2026-09-16).
 *   CONSOL_BOX  small shipments that cannot fill a container, loaded into the
 *               forwarder's own box with other customers' cargo. Its own
 *               workflow: the 2026-09-15 decision that made it FCL-like is
 *               superseded, and it does not mix with LCL either.
 */
export type LoadingFamily = 'FCL' | 'LCL' | 'CONSOL_BOX';

/**
 * Null where the booking never recorded one. Not defaulted to FCL: a guess
 * here decides which cargo may share a steel box, and "not stated" is a
 * refusal, not a default.
 */
export function loadingFamily(loadingType: string | null): LoadingFamily | null {
  return loadingType === 'FCL' || loadingType === 'LCL' || loadingType === 'CONSOL_BOX'
    ? loadingType
    : null;
}

/**
 * The inverse, for querying: which stored `loading_type` values belong to a
 * workflow.
 *
 * Kept beside `loadingFamily` and used by every list that filters, so a view
 * can never disagree with the rule that decides what may share a box. A
 * booking with no loading type is in no list — the same refusal to guess.
 */
export function loadingTypesOf(family: LoadingFamily): LoadingFamily[] {
  return [family];
}

/** How a workflow is named in a sentence a planner reads. */
export const familyLabel = (family: LoadingFamily): string =>
  family === 'CONSOL_BOX' ? 'Consol box' : family;

/** Everything the rules need to judge one booking. */
export interface ConsolidationCandidate {
  shipmentId: bigint;
  code: string;
  customerName: string;
  exporterName: string | null;
  importerName: string | null;
  loadingType: string | null;
  family: LoadingFamily | null;
  shipmentType: string;
  status: string;

  polId: bigint;
  polName: string;
  /*
    §5 / Decision 2 — pod_id IS the final destination for consolidation.
    Deliberately not the last leg's destination_port_id: pod_id is always
    present, and the booking, the quotation and the shipping order already
    agree on it.
  */
  podId: bigint;
  podName: string;

  carrierId: bigint;
  carrierName: string;

  /** The sailing, from legs[0] of the APPROVED schedule. Null if unscheduled. */
  vesselId: bigint | null;
  vesselName: string | null;
  voyageNo: string | null;
  cutOffDate: Date | null;

  /** The commercial default grouping, never a constraint. */
  quotationId: bigint | null;
  quotationCode: string | null;
  inquiryCode: string | null;

  /*
    §8 — every distinct unload location across this booking's confirmed
    receipts. A booking with three deliveries can genuinely have three, so
    this is a list and never collapsed into one value.
  */
  cfsLocations: string[];

  receivedCtnQty: number;
  receivedCbm: number;
  receivedGrossKg: number;
}

export interface Incompatibility {
  shipmentId: string;
  code: string;
  /** Names the rule and the two values, so the screen can say why. */
  reason: string;
  /** False where the difference is worth showing but does not block. */
  blocking: boolean;
}

/** A sailing, as the rules compare it. */
const sailingOf = (c: ConsolidationCandidate): string | null =>
  c.vesselId === null || c.voyageNo === null || c.voyageNo.trim() === ''
    ? null
    : `${c.vesselId.toString()}/${c.voyageNo.trim().toUpperCase()}`;

const sailingText = (c: ConsolidationCandidate): string =>
  c.vesselName === null ? 'no approved sailing' : `${c.vesselName} ${c.voyageNo ?? ''}`.trim();

const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

/**
 * Can these bookings share one container?
 *
 * The first candidate is the anchor and every other is compared to it, so the
 * message always reads "this booking cannot join that group" rather than
 * naming an arbitrary pair.
 *
 * Returns every failure rather than the first, because a planner ticking six
 * boxes wants to know which two are wrong, not to discover them one at a time.
 */
export function checkCompatibility(candidates: ConsolidationCandidate[]): Incompatibility[] {
  if (candidates.length === 0) return [];
  /*
    The per-candidate rules below run whatever the count. Returning early for a
    single booking — as this did until the route tests caught it — meant one
    with no cargo received, or no loading type, or an air booking, walked
    straight through into a container plan. Only the PAIRWISE comparisons need
    something to compare against.
  */
  const [anchor, ...rest] = candidates as [ConsolidationCandidate, ...ConsolidationCandidate[]];
  const problems: Incompatibility[] = [];

  const fail = (c: ConsolidationCandidate, reason: string, blocking = true) =>
    problems.push({ shipmentId: c.shipmentId.toString(), code: c.code, reason, blocking });

  for (const c of candidates) {
    // Rule 6 — sea only. Air uses ULD build-up, a different screen entirely.
    if (c.shipmentType !== 'SEA') {
      fail(c, `${c.code} is an air booking. Container load plans are for sea freight.`);
    }
    /*
      Rule 7 — the cargo has to be in. §1 puts the CLP after cargo receipt, so
      a booking with nothing received has nothing to load.
    */
    if (c.status !== 'PART_RECEIVED' && c.status !== 'CARGO_RECEIVED') {
      fail(c, `${c.code} has no cargo received yet (${c.status.toLowerCase().replace(/_/g, ' ')}).`);
    }
    if (c.receivedCtnQty <= 0) {
      fail(c, `${c.code} has no accepted cartons to load.`);
    }
    // Rule 8's precondition: without a loading type there is no workflow to
    // put it in.
    if (c.family === null) {
      fail(c, `${c.code} has no loading type set, so it cannot be planned into a container.`);
    }
  }

  for (const c of rest) {
    // Rule 8 — never mix the workflows.
    if (c.family !== null && anchor.family !== null && c.family !== anchor.family) {
      fail(
        c,
        `${c.code} is ${familyLabel(c.family)} and ${anchor.code} is ${familyLabel(anchor.family)}. ` +
          'Different loading types never share a container.',
      );
    }

    /*
      Rule 9 — an FCL container is one booking's (client sheet, 2026-09-16).
      The sheet defines FCL as one booking with one EFR; several exporters
      sharing a box is what it calls LCL. So two FCL bookings are refused even
      on the same quotation and sailing, and the message says what to do
      instead rather than only that it is wrong.
    */
    if (c.family === 'FCL' && anchor.family === 'FCL') {
      fail(
        c,
        `${c.code} and ${anchor.code} are separate FCL bookings, and an FCL container holds one ` +
          'booking. If their cargo has to share a box, book them as LCL.',
      );
    }

    // Rule 1 — same lane.
    if (c.polId !== anchor.polId) {
      fail(c, `${c.code} loads at ${c.polName}, not ${anchor.polName}.`);
    }
    // Rule 1 / §5 — same destination. Separate by default.
    if (c.podId !== anchor.podId) {
      fail(c, `${c.code} is going to ${c.podName}, not ${anchor.podName}.`);
    }

    // Rule 2 — same carrier.
    if (c.carrierId !== anchor.carrierId) {
      fail(c, `${c.code} is booked with ${c.carrierName}, not ${anchor.carrierName}.`);
    }

    /*
      Rule 3 — same sailing, and the rule that catches real mistakes. Two
      bookings on the same lane with the same carrier but different voyages
      look identical in a list, and merging them produces a container that
      cannot exist.
    */
    const a = sailingOf(anchor);
    const b = sailingOf(c);
    if (a === null || b === null) {
      const which = a === null ? anchor : c;
      fail(
        c,
        `${which.code} has no approved vessel and voyage yet, so there is no sailing to share.`,
      );
    } else if (a !== b) {
      fail(c, `${c.code} sails on ${sailingText(c)}, not ${sailingText(anchor)}.`);
    }

    /*
      Rule 4 — cut-off. Reported, not blocked: bookings that passed rule 3 are
      on one sailing and therefore share its cut-off, so a difference here is
      a data-entry discrepancy worth seeing rather than a physical
      impossibility. See the note in the implementation report.
    */
    if (day(c.cutOffDate) !== day(anchor.cutOffDate)) {
      fail(
        c,
        `${c.code} has cut-off ${day(c.cutOffDate) ?? 'not set'} against ` +
          `${day(anchor.cutOffDate) ?? 'not set'} on ${anchor.code}. Check which is right.`,
        false,
      );
    }
  }

  return problems;
}

/** True when nothing blocking was found. */
export const isCompatible = (problems: Incompatibility[]): boolean =>
  !problems.some((p) => p.blocking);

/**
 * §8 — the CFS locations across a set of bookings.
 *
 * Never collapsed to one value. The caller shows the single location when
 * there is one and "Multiple CFS locations" when there is not, and the
 * operator chooses the final one explicitly.
 */
export function cfsLocations(candidates: ConsolidationCandidate[]): string[] {
  return [...new Set(candidates.flatMap((c) => c.cfsLocations))].sort();
}

/**
 * Which bookings could go in one box, as a starting point.
 *
 * LCL and Consol box bookings on one physical sailing are suggested together,
 * whoever the customer. FCL is never grouped: rule 9 gives every FCL booking
 * its own container, so each is a group of one — which the screen does not
 * draw. A proposal the user may split; nothing here is enforced, and a group
 * it returns still has to pass `checkCompatibility` before anything is created.
 */
export function suggestGroups(
  candidates: ConsolidationCandidate[],
): { key: string; quotationId: bigint | null; shipmentIds: bigint[] }[] {
  const groups = new Map<string, { quotationId: bigint | null; shipmentIds: bigint[] }>();

  for (const c of candidates) {
    /*
      Physical first, commercial second. Two bookings on one quotation but
      different sailings must not be suggested together — the suggestion would
      be one the rules then refuse, which teaches a planner to ignore
      suggestions.
    */
    const key = [
      c.family ?? 'unset',
      c.polId.toString(),
      c.podId.toString(),
      c.carrierId.toString(),
      sailingOf(c) ?? 'unscheduled',
      c.family === 'FCL' ? `booking-${c.shipmentId}` : 'shared',
    ].join('|');

    const found = groups.get(key);
    if (found === undefined) {
      groups.set(key, { quotationId: c.quotationId, shipmentIds: [c.shipmentId] });
    } else {
      found.shipmentIds.push(c.shipmentId);
    }
  }

  return [...groups].map(([key, g]) => ({ key, ...g }));
}

/**
 * Reads the candidates for a set of bookings.
 *
 * Runs inside the tenant client, so RLS has already excluded every other
 * workspace — a booking from another tenant cannot become eligible, and the
 * join is not widened to make that easier.
 */
export async function loadCandidates(
  db: TenantDb,
  shipmentIds: bigint[],
): Promise<ConsolidationCandidate[]> {
  if (shipmentIds.length === 0) return [];

  const rows = await db.shipment.findMany({
    where: { id: { in: shipmentIds }, deletedAt: null },
    select: {
      id: true,
      code: true,
      loadingType: true,
      shipmentType: true,
      status: true,
      exporterName: true,
      importerName: true,
      polId: true,
      podId: true,
      carrierId: true,
      customer: { select: { name: true } },
      pol: { select: { name: true } },
      pod: { select: { name: true } },
      carrier: { select: { name: true } },
      quotation: {
        select: { id: true, code: true, inquiry: { select: { code: true } } },
      },
      // The approved sailing, read exactly as shipping-order.route.ts does.
      schedules: {
        where: { deletedAt: null, status: 'APPROVED' },
        orderBy: { versionNo: 'desc' },
        take: 1,
        select: {
          cutOffDate: true,
          legs: {
            where: { deletedAt: null },
            orderBy: { legNo: 'asc' },
            take: 1,
            select: { vesselId: true, voyageNo: true, vessel: { select: { name: true } } },
          },
        },
      },
      cargoReceipts: {
        where: { deletedAt: null, status: 'CONFIRMED' },
        select: { unloadLocation: true },
      },
    },
  });

  /*
    What is actually in the warehouse, per booking.

    Where the CFS re-measured, its figure is used — that is what was on the
    tape. Where it did not, the booked per-carton rate across the cartons that
    arrived is the fallback, exactly as the allocation service does it.

    The fallback is not a nicety. received_volume_cbm is generated from the
    RECEIPT's own carton dimensions, so a receipt that recorded a quantity but
    no measurement leaves it NULL — and without this, a booking of 20 cartons
    would report 0 CBM and the "what else fits in this box" figure on the LCL
    screen would be nonsense.
  */
  const receiptLines = await db.cargoReceiptLine.findMany({
    where: {
      deletedAt: null,
      lineStatus: 'ACCEPTED',
      receipt: { status: 'CONFIRMED', deletedAt: null },
      cargoLine: { shipmentId: { in: shipmentIds }, deletedAt: null },
    },
    select: {
      receivedCtnQty: true,
      receivedGrossWeightKg: true,
      receivedVolumeCbm: true,
      cargoLine: {
        select: {
          shipmentId: true,
          cbmPerCarton: true,
          grossWeightPerCarton: true,
        },
      },
    },
  });

  const received = new Map<string, { ctn: number; cbm: number; kg: number }>();
  for (const line of receiptLines) {
    const key = line.cargoLine.shipmentId.toString();
    const acc = received.get(key) ?? { ctn: 0, cbm: 0, kg: 0 };
    const ctn = line.receivedCtnQty;

    acc.ctn += ctn;
    acc.cbm +=
      line.receivedVolumeCbm !== null
        ? Number(line.receivedVolumeCbm)
        : Number(line.cargoLine.cbmPerCarton ?? 0) * ctn;
    acc.kg +=
      line.receivedGrossWeightKg !== null
        ? Number(line.receivedGrossWeightKg)
        : Number(line.cargoLine.grossWeightPerCarton ?? 0) * ctn;
    received.set(key, acc);
  }

  return rows.map((row): ConsolidationCandidate => {
    const schedule = row.schedules[0] ?? null;
    const leg = schedule?.legs[0] ?? null;
    const got = received.get(row.id.toString()) ?? { ctn: 0, cbm: 0, kg: 0 };

    return {
      shipmentId: row.id,
      code: row.code,
      customerName: row.customer.name,
      exporterName: row.exporterName,
      importerName: row.importerName,
      loadingType: row.loadingType,
      family: loadingFamily(row.loadingType),
      shipmentType: row.shipmentType,
      status: row.status,

      polId: row.polId,
      polName: row.pol.name,
      podId: row.podId,
      podName: row.pod.name,

      carrierId: row.carrierId,
      carrierName: row.carrier.name,

      vesselId: leg?.vesselId ?? null,
      vesselName: leg?.vessel?.name ?? null,
      voyageNo: leg?.voyageNo ?? null,
      cutOffDate: schedule?.cutOffDate ?? null,

      quotationId: row.quotation?.id ?? null,
      quotationCode: row.quotation?.code ?? null,
      inquiryCode: row.quotation?.inquiry?.code ?? null,

      cfsLocations: [
        ...new Set(
          row.cargoReceipts
            .map((r) => r.unloadLocation)
            .filter((l): l is string => l !== null && l.trim() !== ''),
        ),
      ].sort(),

      receivedCtnQty: got.ctn,
      receivedCbm: got.cbm,
      receivedGrossKg: got.kg,
    };
  });
}

/** Candidates rearranged into the order their ids were given; findMany promises none. */
export function inOrder(
  candidates: ConsolidationCandidate[],
  shipmentIds: bigint[],
): ConsolidationCandidate[] {
  const byId = new Map(candidates.map((c) => [c.shipmentId.toString(), c]));
  return shipmentIds
    .map((id) => byId.get(id.toString()))
    .filter((c): c is ConsolidationCandidate => c !== undefined);
}

/**
 * One PO as the creation screen offers it and the consolidation loads it.
 *
 * The client's sheet has planners tick POs rather than bookings ("multiple
 * exporter's PO will select by check box and make CLP"), so the PO is the unit
 * the selection is made in, while the booking stays the unit the rules judge.
 */
export interface CandidatePo {
  poId: bigint;
  shipmentId: bigint;
  poNo: string;
  /** Cartons that arrived and were accepted. */
  receivedCtnQty: number;
  /** Of those, the ones in no live plan — exactly what ticking the PO loads. */
  ctnQty: number;
  /** The received CBM and weight those cartons carry. */
  cbm: Prisma.Decimal;
  grossKg: Prisma.Decimal;
  /** Lines with cartons still to load, in the order they are loaded. */
  openCargoLineIds: bigint[];
  efrNos: string[];
  /** Live plans holding cartons of this PO, in the order they were made. */
  plans: { clpId: bigint; code: string; status: 'DRAFT' | 'FINAL' | 'CANCELLED'; ctnQty: number }[];
}

const ZERO = new Prisma.Decimal(0);

/**
 * Reads POs with what is left of them to load.
 *
 * Quantity comes from the allocation ledger exactly as `availableCartons`
 * computes it: accepted receipts minus live allocations. CBM and weight are
 * the received figures — the CFS's measurement where there is one, the booked
 * per-carton rate otherwise, as `loadCandidates` reads them — apportioned to
 * the cartons still free. They are what the running strip shows and what the
 * capacity pre-check compares; `allocate` still writes and checks the real
 * figures afterwards.
 *
 * Every PO matching the filter is returned, including one with nothing
 * received, so a caller can say why it cannot be loaded rather than only that
 * it is missing.
 */
export async function loadCandidatePos(
  db: TenantDb,
  filter: { shipmentIds: bigint[] } | { poIds: bigint[] },
): Promise<CandidatePo[]> {
  const byPo = 'poIds' in filter;
  const wanted = byPo ? filter.poIds : filter.shipmentIds;
  if (wanted.length === 0) return [];

  const pos = await db.shipmentPo.findMany({
    where: {
      ...(byPo ? { id: { in: wanted } } : { shipmentId: { in: wanted } }),
      deletedAt: null,
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      shipmentId: true,
      poNo: true,
      cargoLines: {
        where: { deletedAt: null },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          cbmPerCarton: true,
          grossWeightPerCarton: true,
          cargoReceiptLines: {
            where: {
              deletedAt: null,
              lineStatus: 'ACCEPTED',
              receipt: { status: 'CONFIRMED', deletedAt: null },
            },
            select: { receivedCtnQty: true, receivedVolumeCbm: true, receivedGrossWeightKg: true },
          },
        },
      },
    },
  });

  const lineIds = pos.flatMap((po) => po.cargoLines.map((line) => line.id));
  const [allocations, efrs] = await Promise.all([
    lineIds.length === 0
      ? []
      : db.clpLine.findMany({
          where: { ...LIVE_ALLOCATION, shipmentCargoLineId: { in: lineIds } },
          orderBy: { clpId: 'asc' },
          select: {
            shipmentCargoLineId: true,
            ctnQty: true,
            clpId: true,
            clp: { select: { code: true, status: true } },
          },
        }),
    efrNosOfCargoLines(db, lineIds),
  ]);

  const planned = new Map<string, number>();
  const plansOfLine = new Map<string, typeof allocations>();
  for (const a of allocations) {
    const key = a.shipmentCargoLineId.toString();
    planned.set(key, (planned.get(key) ?? 0) + a.ctnQty);
    plansOfLine.set(key, [...(plansOfLine.get(key) ?? []), a]);
  }

  return pos.map((po): CandidatePo => {
    let received = 0;
    let free = 0;
    let cbm = ZERO;
    let kg = ZERO;
    const open: bigint[] = [];
    const lineEfrs: string[] = [];
    const plans = new Map<string, CandidatePo['plans'][number]>();

    for (const line of po.cargoLines) {
      for (const efr of efrs.get(line.id.toString()) ?? []) {
        if (!lineEfrs.includes(efr)) lineEfrs.push(efr);
      }
      for (const a of plansOfLine.get(line.id.toString()) ?? []) {
        const key = a.clpId.toString();
        const found = plans.get(key) ?? { clpId: a.clpId, code: a.clp.code, status: a.clp.status, ctnQty: 0 };
        plans.set(key, { ...found, ctnQty: found.ctnQty + a.ctnQty });
      }

      let got = 0;
      let lineCbm = ZERO;
      let lineKg = ZERO;
      for (const r of line.cargoReceiptLines) {
        got += r.receivedCtnQty;
        lineCbm = lineCbm.plus(
          r.receivedVolumeCbm ?? new Prisma.Decimal(line.cbmPerCarton ?? 0).times(r.receivedCtnQty),
        );
        lineKg = lineKg.plus(
          r.receivedGrossWeightKg ??
            new Prisma.Decimal(line.grossWeightPerCarton ?? 0).times(r.receivedCtnQty),
        );
      }
      received += got;

      const left = got - (planned.get(line.id.toString()) ?? 0);
      if (left <= 0) continue;
      free += left;
      open.push(line.id);
      cbm = cbm.plus(lineCbm.times(left).dividedBy(got));
      kg = kg.plus(lineKg.times(left).dividedBy(got));
    }

    return {
      poId: po.id,
      shipmentId: po.shipmentId,
      poNo: po.poNo,
      receivedCtnQty: received,
      ctnQty: free,
      cbm,
      grossKg: kg,
      openCargoLineIds: open,
      efrNos: lineEfrs,
      plans: [...plans.values()],
    };
  });
}

/**
 * The ticked POs, in the order they were ticked.
 *
 * RLS has already removed another workspace's POs, so one that does not come
 * back is deleted or not ours — either way not loadable, and the 404 does not
 * say which.
 */
export async function loadSelectedPos(db: TenantDb, poIds: bigint[]): Promise<CandidatePo[]> {
  const unique = [...new Set(poIds.map((id) => id.toString()))].map((id) => BigInt(id));
  const found = await loadCandidatePos(db, { poIds: unique });
  if (found.length !== unique.length) {
    throw HttpError.notFound('One of those POs is no longer available.');
  }
  const byId = new Map(found.map((po) => [po.poId.toString(), po]));
  return unique.map((id) => byId.get(id.toString())!);
}

/** A ticked PO with nothing to load, named with the reason. */
export function unloadablePos(
  pos: CandidatePo[],
  bookingCodes: Map<string, string>,
): Incompatibility[] {
  return pos
    .filter((po) => po.ctnQty <= 0)
    .map((po) => {
      const code = bookingCodes.get(po.shipmentId.toString()) ?? '';
      return {
        shipmentId: po.shipmentId.toString(),
        code,
        reason:
          po.receivedCtnQty === 0
            ? `${po.poNo} on ${code} has no cartons received yet.`
            : `${po.poNo} on ${code} has nothing left to load — all ${po.receivedCtnQty} ` +
              'received cartons are already in a plan.',
        blocking: true,
      };
    });
}

/** Bookings in the order their first PO was ticked — the order the box is described in. */
export function bookingsInTickOrder(pos: CandidatePo[]): bigint[] {
  return [...new Set(pos.map((po) => po.shipmentId.toString()))].map((id) => BigInt(id));
}

/**
 * The gate every write goes through.
 *
 * §14: the API validates at save time even though the screen validates too,
 * because a request need not have come from our screen.
 */
export async function assertConsolidatable(
  db: TenantDb,
  shipmentIds: bigint[],
): Promise<ConsolidationCandidate[]> {
  const unique = [...new Set(shipmentIds.map((id) => id.toString()))].map((s) => BigInt(s));
  if (unique.length === 0) {
    throw HttpError.badRequest('Choose at least one booking.');
  }

  const found = await loadCandidates(db, unique);
  if (found.length !== unique.length) {
    // RLS has already filtered another tenant's rows out, so a missing one is
    // either deleted or not ours. Either way it is not consolidatable.
    throw HttpError.notFound('One of those bookings is no longer available.');
  }
  // In the order asked for, so the first booking chosen is the anchor the
  // messages are written against and the first one the container names.
  const candidates = inOrder(found, unique);

  const problems = checkCompatibility(candidates);
  if (!isCompatible(problems)) {
    const blocking = problems.filter((p) => p.blocking);
    throw HttpError.conflict(
      blocking.length === 1
        ? blocking[0]!.reason
        : `These bookings cannot share a container. ${blocking.map((p) => p.reason).join(' ')}`,
    );
  }

  return candidates;
}
