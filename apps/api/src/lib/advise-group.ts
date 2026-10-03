import {
  type AdviseGroupDto,
  type AdviseGroupMatch,
  type AdviseStatus,
  canTransition,
  type EfrGroupTag,
  SHIPMENT_STATUS_LABEL,
  type ShipmentStatus,
} from '@ff/shared';

import { type AdviseLineDraft, adviseBlockedReason, buildAdviseLines } from './advise-build';
import { efrKey, efrsOfBookings } from './clp-efr';
import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * CR-005 — bookings that share an EFR share one advise and one BL.
 *
 * The client, 2026-10-02: when the same EFR No is found on several bookings of
 * one quotation, those bookings get a single shipment advise and a single BL.
 * This file decides which bookings those are; the routes only act on it.
 *
 * Relative to the booking an advise is made from (the lead), every other
 * booking of the quotation received under the same EFR is one of:
 *
 *   FULL     same sailing, shipper and consignee — on the advise whenever it
 *            is ready, because the rule is one advise per EFR;
 *   WARN     the shipper or the consignee differs — often one company typed
 *            twice — so the user decides;
 *   REFUSED  a different sailing, which no single bill of lading can cover,
 *            or a booking received under more than one EFR, which keeps its
 *            own advise (CR-005 §10 Q1's working default).
 *
 * The database holds the parts that would leak or corrupt if a route forgot
 * them — same quotation, same customer, drafts only, one live advise per
 * booking (20261002170000). The EFR is checked here instead, because it lives
 * on the cargo receipts and can be corrected after the advise is made.
 */

export { efrKey, efrsOfBookings };

/** Party text compares ignoring case and how the spaces were typed. */
const textKey = (v: string | null): string => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** A row of shipment_advise_booking that still holds its booking. */
export const LIVE_MEMBERSHIP = { releasedAt: null, deletedAt: null };

/** An advise that is not cancelled. */
export const LIVE_ADVISE = { deletedAt: null, status: { not: 'CANCELLED' as const } };

export interface LiveAdvise {
  id: bigint;
  code: string;
  status: AdviseStatus;
  /** The booking it was made from. */
  shipmentId: bigint;
  houseBlNo: string;
  mblNo: string | null;
  sentAt: Date | null;
}

const liveAdviseSelect = {
  id: true,
  code: true,
  status: true,
  shipmentId: true,
  houseBlNo: true,
  mblNo: true,
  sentAt: true,
} as const;

/**
 * For a worklist: which bookings share an EFR with others of their quotation,
 * said before anyone opens one — "Shares EFR-501 with BKG-2 — one advise for
 * all". Only the shared EFR is checked here; the advise screen says which of
 * them can actually go on one advise, and why the others cannot.
 */
export async function sharedEfrNotes(
  db: TenantDb,
  shipmentIds: bigint[],
): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  if (shipmentIds.length === 0) return notes;

  const own = await db.shipment.findMany({
    where: { id: { in: shipmentIds } },
    select: { id: true, quotationId: true },
  });
  const siblings = await db.shipment.findMany({
    where: {
      quotationId: { in: [...new Set(own.map((s) => s.quotationId))] },
      deletedAt: null,
      status: { not: 'CANCELLED' },
    },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, quotationId: true },
  });
  const efrs = await efrsOfBookings(db, siblings.map((s) => s.id));

  for (const s of own) {
    const mine = efrs.get(s.id.toString()) ?? [];
    if (mine.length !== 1) continue;
    const key = efrKey(mine[0]!);
    const others = siblings
      .filter(
        (o) =>
          o.quotationId === s.quotationId &&
          o.id !== s.id &&
          (efrs.get(o.id.toString()) ?? []).some((e) => efrKey(e) === key),
      )
      .map((o) => o.code);
    if (others.length > 0) {
      notes.set(s.id.toString(), `Shares ${mine[0]} with ${others.join(', ')} — one advise for all.`);
    }
  }
  return notes;
}

/** The live advise each booking is on, by booking id. */
export async function liveAdvisesOf(
  db: TenantDb,
  shipmentIds: bigint[],
): Promise<Map<string, LiveAdvise>> {
  const found = new Map<string, LiveAdvise>();
  if (shipmentIds.length === 0) return found;
  const rows = await db.shipmentAdviseBooking.findMany({
    where: { shipmentId: { in: shipmentIds }, ...LIVE_MEMBERSHIP, advise: LIVE_ADVISE },
    select: { shipmentId: true, advise: { select: liveAdviseSelect } },
  });
  for (const row of rows) found.set(row.shipmentId.toString(), row.advise);
  return found;
}

/** The live advise a booking is on — as the lead or as one of the others. */
export async function liveAdviseOf(
  db: TenantDb,
  shipmentId: bigint,
  status?: 'DRAFT' | 'SENT',
): Promise<LiveAdvise | null> {
  const advise = (await liveAdvisesOf(db, [shipmentId])).get(shipmentId.toString()) ?? null;
  if (advise === null || (status !== undefined && advise.status !== status)) return null;
  return advise;
}

export interface AdviseMember {
  id: bigint;
  code: string;
  status: ShipmentStatus;
  shipmentType: 'SEA' | 'AIR';
}

/**
 * The bookings an advise holds, the one it was made from first.
 *
 * Live rows only, so a cancelled advise has none — a caller that needs a
 * cancelled advise's bookings reads them before cancelling it.
 */
export async function adviseMembers(db: TenantDb, adviseId: bigint): Promise<AdviseMember[]> {
  const advise = await db.shipmentAdvise.findFirst({
    where: { id: adviseId },
    select: {
      shipmentId: true,
      bookings: {
        where: LIVE_MEMBERSHIP,
        select: {
          shipment: { select: { id: true, code: true, status: true, shipmentType: true } },
        },
      },
    },
  });
  if (advise === null) throw HttpError.notFound('Shipment advise not found.');
  return leadFirst(
    advise.shipmentId,
    advise.bookings.map((b) => b.shipment),
  );
}

/** The lead booking first, then the rest by booking number. */
export function leadFirst<T extends { id: bigint; code: string }>(leadId: bigint, rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.id === leadId) return -1;
    if (b.id === leadId) return 1;
    return a.code.localeCompare(b.code);
  });
}

// ------------------------------------------------------------------ the group

export interface GroupCandidate {
  shipmentId: bigint;
  code: string;
  shipmentType: 'SEA' | 'AIR';
  match: AdviseGroupMatch;
  reason: string | null;
  efrNos: string[];
  /** Null when it can be advised now. */
  blockedReason: string | null;
  liveAdvise: LiveAdvise | null;
}

export interface AdviseGroup {
  leadId: bigint;
  leadCode: string;
  /** The shared EFR as the lead's receipt has it; null when there is no group. */
  efrNo: string | null;
  note: string | null;
  /** The lead first. */
  candidates: GroupCandidate[];
}

const shipmentFields = {
  id: true,
  code: true,
  status: true,
  quotationId: true,
  customerId: true,
  shipmentType: true,
  exporterName: true,
  exporterAddress: true,
  importerName: true,
  importerAddress: true,
  polId: true,
  podId: true,
} as const;

interface Sailing {
  key: string;
  label: string;
}

/**
 * What a bill of lading prints once: the first vessel and voyage (air: the
 * flight), where it loads and where it discharges — from the approved
 * schedule, which is what the advise header is filled from (§2.1, M14).
 */
async function sailingsOf(
  db: TenantDb,
  shipments: { id: bigint; polId: bigint; podId: bigint }[],
): Promise<Map<string, Sailing>> {
  const ids = shipments.map((s) => s.id);
  const schedules = await db.shipmentSchedule.findMany({
    where: { shipmentId: { in: ids }, deletedAt: null, status: 'APPROVED' },
    orderBy: { id: 'desc' },
    select: {
      shipmentId: true,
      legs: {
        where: { deletedAt: null },
        orderBy: { legNo: 'asc' },
        select: {
          vesselId: true,
          voyageNo: true,
          flightNo: true,
          originPortId: true,
          destinationPortId: true,
          vessel: { select: { name: true } },
        },
      },
    },
  });

  const portIds = new Set<bigint>();
  const parts = new Map<
    string,
    { vesselId: bigint | null; vessel: string | null; voyage: string | null; flight: string | null; pol: bigint; pod: bigint }
  >();
  for (const shipment of shipments) {
    const schedule = schedules.find((s) => s.shipmentId === shipment.id);
    const first = schedule?.legs[0];
    const last = schedule?.legs[schedule.legs.length - 1];
    const pol = first?.originPortId ?? shipment.polId;
    const pod = last?.destinationPortId ?? shipment.podId;
    portIds.add(pol);
    portIds.add(pod);
    parts.set(shipment.id.toString(), {
      vesselId: first?.vesselId ?? null,
      vessel: first?.vessel?.name ?? null,
      voyage: first?.voyageNo ?? null,
      flight: first?.flightNo ?? null,
      pol,
      pod,
    });
  }

  const ports = await db.port.findMany({
    where: { id: { in: [...portIds] } },
    select: { id: true, name: true },
  });
  const portName = (id: bigint): string => ports.find((p) => p.id === id)?.name ?? '—';

  const out = new Map<string, Sailing>();
  for (const [key, p] of parts) {
    const carrier = p.flight ?? p.vessel ?? 'no vessel yet';
    out.set(key, {
      key: [p.vesselId ?? '', textKey(p.voyage), textKey(p.flight), p.pol, p.pod].join('|'),
      label: `${carrier}${p.voyage === null ? '' : ` voyage ${p.voyage}`}, ${portName(p.pol)} to ${portName(p.pod)}`,
    });
  }
  return out;
}

/**
 * Whether a booking can go on an advise now — null if it can.
 *
 * The lead keeps the rule it always had: something to put in the grid. Any
 * other booking must also be CARGO_RECEIVED, because sending the advise moves
 * every booking on it to ADVISED and nothing else may make that move.
 */
async function readiness(
  db: TenantDb,
  shipment: { id: bigint; code: string; status: ShipmentStatus; shipmentType: 'SEA' | 'AIR' },
  isLead: boolean,
): Promise<string | null> {
  if (!isLead && !canTransition(shipment.status, 'ADVISED')) {
    return `${shipment.code} is ${SHIPMENT_STATUS_LABEL[shipment.status].toLowerCase()}, not cargo received.`;
  }
  const blocked = await adviseBlockedReason(db, shipment.id, shipment.shipmentType);
  return blocked === null ? null : blocked.replace(/^This booking/, shipment.code);
}

/** The bookings that share the lead's EFR, and how each one stands. */
export async function adviseGroupFor(db: TenantDb, leadId: bigint): Promise<AdviseGroup> {
  const lead = await db.shipment.findFirst({
    where: { id: leadId, deletedAt: null },
    select: shipmentFields,
  });
  if (lead === null) throw HttpError.notFound('Booking not found.');

  const siblings = await db.shipment.findMany({
    where: {
      quotationId: lead.quotationId,
      id: { not: leadId },
      deletedAt: null,
      status: { not: 'CANCELLED' },
    },
    orderBy: { code: 'asc' },
    select: shipmentFields,
  });

  const efrs = await efrsOfBookings(db, [leadId, ...siblings.map((s) => s.id)]);
  const leadEfrs = efrs.get(leadId.toString()) ?? [];

  const leadCandidate = async (live: Map<string, LiveAdvise>): Promise<GroupCandidate> => ({
    shipmentId: lead.id,
    code: lead.code,
    shipmentType: lead.shipmentType,
    match: 'LEAD',
    reason: null,
    efrNos: leadEfrs,
    blockedReason: await readiness(db, lead, true),
    liveAdvise: live.get(lead.id.toString()) ?? null,
  });

  if (leadEfrs.length !== 1) {
    return {
      leadId,
      leadCode: lead.code,
      efrNo: null,
      note:
        leadEfrs.length === 0
          ? `${lead.code} has no EFR No on its confirmed cargo receipts, so it is advised on its own.`
          : `${lead.code} was received under ${leadEfrs.join(', ')}. A booking with more than one EFR is advised on its own.`,
      candidates: [await leadCandidate(await liveAdvisesOf(db, [leadId]))],
    };
  }

  const efr = leadEfrs[0]!;
  const key = efrKey(efr);
  const related = siblings.filter((s) =>
    (efrs.get(s.id.toString()) ?? []).some((e) => efrKey(e) === key),
  );

  const ids = [leadId, ...related.map((s) => s.id)];
  const [live, sailings] = await Promise.all([
    liveAdvisesOf(db, ids),
    sailingsOf(db, [lead, ...related]),
  ]);
  const leadSailing = sailings.get(leadId.toString())!;

  const candidates: GroupCandidate[] = [await leadCandidate(live)];
  for (const s of related) {
    const theirs = efrs.get(s.id.toString()) ?? [];
    const sailing = sailings.get(s.id.toString())!;
    let match: AdviseGroupMatch = 'FULL';
    let reason: string | null = null;

    if (theirs.length > 1) {
      match = 'REFUSED';
      reason = `Received under ${theirs.join(', ')}. A booking with more than one EFR is advised on its own.`;
    } else if (s.customerId !== lead.customerId) {
      match = 'REFUSED';
      reason = 'Another customer’s booking.';
    } else if (s.shipmentType !== lead.shipmentType) {
      match = 'REFUSED';
      reason = `${s.shipmentType === 'AIR' ? 'An air' : 'A sea'} booking; ${lead.code} is not.`;
    } else if (sailing.key !== leadSailing.key) {
      match = 'REFUSED';
      reason = `Sails on ${sailing.label}, not ${leadSailing.label}. One BL cannot cover two sailings.`;
    } else {
      const differs: string[] = [];
      if (textKey(s.exporterName) !== textKey(lead.exporterName) || textKey(s.exporterAddress) !== textKey(lead.exporterAddress)) {
        differs.push(`shipper ${s.exporterName ?? '(none)'}`);
      }
      if (textKey(s.importerName) !== textKey(lead.importerName) || textKey(s.importerAddress) !== textKey(lead.importerAddress)) {
        differs.push(`consignee ${s.importerName ?? '(none)'}`);
      }
      if (differs.length > 0) {
        match = 'WARN';
        reason = `Different ${differs.join(' and ')}. The BL prints one shipper and one consignee.`;
      }
    }

    candidates.push({
      shipmentId: s.id,
      code: s.code,
      shipmentType: s.shipmentType,
      match,
      reason,
      efrNos: theirs,
      blockedReason: match === 'REFUSED' ? null : await readiness(db, s, false),
      liveAdvise: live.get(s.id.toString()) ?? null,
    });
  }

  return { leadId, leadCode: lead.code, efrNo: efr, note: null, candidates };
}

/** Whether a candidate is free to join an advise right now. */
function isFree(c: GroupCandidate): boolean {
  return c.blockedReason === null && c.liveAdvise === null;
}

/**
 * Which bookings go on a new advise: the lead, every ready FULL match, and the
 * WARN matches the user ticked. A ticked booking that cannot join is refused
 * with its reason rather than quietly left off.
 */
export function bookingsToInclude(group: AdviseGroup, requested: string[]): GroupCandidate[] {
  const wanted = new Set(requested);
  const [lead, ...others] = group.candidates;
  const included: GroupCandidate[] = [lead!];

  for (const c of others) {
    const id = c.shipmentId.toString();
    if (c.match === 'FULL' && isFree(c)) {
      included.push(c);
    } else if (wanted.has(id)) {
      assertCanJoin(c);
      included.push(c);
    }
    wanted.delete(id);
  }
  wanted.delete(group.leadId.toString());
  if (wanted.size > 0) {
    throw new HttpError(
      409,
      'NOT_IN_GROUP',
      group.efrNo === null
        ? `${group.leadCode} is advised on its own, so no other booking can join it.`
        : `Only bookings of the same quotation received under ${group.efrNo} can share this advise.`,
    );
  }
  return included;
}

/** The checks for one booking joining an advise, with the reason when it cannot. */
export function assertCanJoin(c: GroupCandidate): void {
  if (c.match === 'REFUSED') {
    throw new HttpError(409, 'CANNOT_SHARE', `${c.code} cannot share this advise. ${c.reason ?? ''}`.trim());
  }
  if (c.liveAdvise !== null) {
    throw new HttpError(409, 'ALREADY_ADVISED', `${c.code} is already on ${c.liveAdvise.code}.`);
  }
  if (c.blockedReason !== null) {
    throw new HttpError(409, 'NOT_READY', `${c.code} is not ready to advise. ${c.blockedReason}`);
  }
}

/**
 * The live advise that already carries the lead's EFR — the one this booking
 * should join instead of starting a second advise for the same EFR.
 *
 * Only a FULL match decides it: a WARN match on another advise is the case the
 * user decides, and they may advise this booking on its own.
 */
export function adviseToJoin(group: AdviseGroup): LiveAdvise | null {
  for (const c of group.candidates.slice(1)) {
    if (c.match === 'FULL' && c.liveAdvise !== null) return c.liveAdvise;
  }
  return null;
}

/** The refusal for starting a second advise on an EFR that already has one. */
export function joinInsteadMessage(group: AdviseGroup, advise: LiveAdvise): string {
  return advise.status === 'DRAFT'
    ? `${group.efrNo} is already on ${advise.code}, a draft. Add ${group.leadCode} to it instead of making another advise.`
    : `${group.efrNo} is already on ${advise.code}, which has been sent. To put ${group.leadCode} on it, cancel ${advise.code} and make the advise again — it will get a new House BL number.`;
}

/** The group as the screen shows it, with `included` marked from the set given. */
export function groupDto(group: AdviseGroup, included: Set<string>): AdviseGroupDto {
  return {
    efrNo: group.efrNo,
    note: group.note,
    bookings: group.candidates.map((c) => ({
      shipmentId: c.shipmentId.toString(),
      bookingNo: c.code,
      match: c.match,
      reason: c.reason,
      efrNos: c.efrNos,
      blockedReason: c.blockedReason,
      adviseId: c.liveAdvise?.id.toString() ?? null,
      adviseCode: c.liveAdvise?.code ?? null,
      included: included.has(c.shipmentId.toString()),
    })),
  };
}

/** The PO grid of every booking on the advise, the lead's first. */
export async function buildGroupLines(
  db: TenantDb,
  members: { id: bigint; code: string; shipmentType: 'SEA' | 'AIR' }[],
): Promise<AdviseLineDraft[]> {
  const lines: AdviseLineDraft[] = [];
  for (const member of members) {
    lines.push(...(await buildAdviseLines(db, member.id, member.shipmentType, member.code)));
  }
  return lines;
}

/** Puts a booking on an advise. The database refuses a second live advise. */
export async function addMembership(
  db: TenantDb,
  args: { tenantId: bigint; adviseId: bigint; shipmentId: bigint; code: string; userId: bigint },
): Promise<void> {
  try {
    await db.shipmentAdviseBooking.create({
      data: {
        tenantId: args.tenantId,
        adviseId: args.adviseId,
        shipmentId: args.shipmentId,
        createdBy: args.userId,
        updatedBy: args.userId,
      },
    });
  } catch (error) {
    // Two people advising the same EFR at once: the live index lets one in.
    const code = (error as { code?: unknown }).code;
    if (code === 'P2002') {
      throw new HttpError(
        409,
        'ALREADY_ADVISED',
        `${args.code} was just put on another advise. Refresh to see it.`,
      );
    }
    throw error;
  }
}

// ------------------------------------------------- the tag on a list row

/** A party block as the BL prints it, for "do these share a shipper?". */
const partyKeyOf = (s: {
  exporterName: string | null;
  exporterAddress: string | null;
  importerName: string | null;
  importerAddress: string | null;
}): { shipper: string; consignee: string } => ({
  shipper: `${textKey(s.exporterName)}|${textKey(s.exporterAddress)}`,
  consignee: `${textKey(s.importerName)}|${textKey(s.importerAddress)}`,
});

/**
 * CR-005, said on a list row: which bookings this one will share a Shipment
 * Advise with — so the booking, approval, order and receipt tables show the
 * grouping before anyone opens the advise screen.
 *
 * The advise screen's own rules, read for a whole page at once and without a
 * lead booking: the bookings of one quotation with the same single EFR, on the
 * same sailing, form a group; within it, the bookings with the most common
 * shipper and consignee share one advise (SHARED), and the rest are offered
 * (CHECK). A different voyage, or two EFRs, is an advise of its own (OWN). A
 * booking already on an advise says which (ON_ADVISE), and a ready booking of
 * an advised group says whether it can still join (JOINS) or came too late
 * (LATE). A booking with no other booking of its EFR gets no tag.
 */
export async function efrGroupTags(
  db: TenantDb,
  shipmentIds: bigint[],
): Promise<Map<string, EfrGroupTag>> {
  const tags = new Map<string, EfrGroupTag>();
  if (shipmentIds.length === 0) return tags;

  const own = await db.shipment.findMany({
    where: { id: { in: shipmentIds } },
    select: { quotationId: true },
  });
  const siblings = await db.shipment.findMany({
    where: {
      quotationId: { in: [...new Set(own.map((s) => s.quotationId))] },
      deletedAt: null,
      status: { not: 'CANCELLED' },
    },
    orderBy: { code: 'asc' },
    select: shipmentFields,
  });
  const efrs = await efrsOfBookings(db, siblings.map((s) => s.id));
  const keysOf = (id: bigint): string[] => (efrs.get(id.toString()) ?? []).map(efrKey);

  // Only bookings whose EFR another booking of the quotation also has.
  const related = siblings.filter((s) => {
    const mine = keysOf(s.id);
    return (
      mine.length > 0 &&
      siblings.some(
        (o) => o.id !== s.id && o.quotationId === s.quotationId && keysOf(o.id).some((k) => mine.includes(k)),
      )
    );
  });
  if (related.length === 0) return tags;

  const [sailings, live] = await Promise.all([
    sailingsOf(db, related),
    liveAdvisesOf(db, related.map((s) => s.id)),
  ]);
  const adviseIds = [...new Set([...live.values()].map((a) => a.id))];
  const memberRows =
    adviseIds.length === 0
      ? []
      : await db.shipmentAdviseBooking.findMany({
          where: { adviseId: { in: adviseIds }, ...LIVE_MEMBERSHIP },
          select: { adviseId: true, shipment: { select: { id: true, code: true } } },
        });
  const membersOf = (adviseId: bigint) =>
    memberRows.filter((m) => m.adviseId === adviseId).map((m) => m.shipment);
  const sailingKey = (id: bigint): string => sailings.get(id.toString())?.key ?? '';

  for (const id of shipmentIds) {
    const s = related.find((r) => r.id === id);
    if (s === undefined) continue;
    const key = id.toString();

    const advise = live.get(key);
    if (advise !== undefined) {
      tags.set(key, {
        kind: 'ON_ADVISE',
        adviseCode: advise.code,
        withBookings: membersOf(advise.id).filter((m) => m.id !== s.id).map((m) => m.code).sort(),
        reason: null,
        groupKey: `A${advise.id}`,
      });
      continue;
    }

    const mine = keysOf(s.id);
    if (mine.length > 1) {
      tags.set(key, { kind: 'OWN', adviseCode: null, withBookings: [], reason: 'two EFRs', groupKey: null });
      continue;
    }

    // The bookings it could share one bill of lading with.
    const core = related.filter(
      (o) =>
        o.quotationId === s.quotationId &&
        o.customerId === s.customerId &&
        o.shipmentType === s.shipmentType &&
        keysOf(o.id).length === 1 &&
        keysOf(o.id)[0] === mine[0],
    );
    const sameSailing = core.filter((o) => sailingKey(o.id) === sailingKey(s.id));
    if (sameSailing.length === 1) {
      // Nobody else of the EFR sails with it. A booking whose only company is
      // two-EFR bookings needs no tag — they carry the explanation.
      if (core.length > 1) {
        tags.set(key, { kind: 'OWN', adviseCode: null, withBookings: [], reason: 'other voyage', groupKey: null });
      }
      continue;
    }

    // The group's advise, if one of the others is already on it.
    const groupAdvise = sameSailing
      .map((o) => live.get(o.id.toString()))
      .find((a): a is LiveAdvise => a !== undefined);
    const anchorParties = (() => {
      if (groupAdvise !== undefined) {
        const lead = related.find((o) => o.id === groupAdvise.shipmentId);
        if (lead !== undefined) return partyKeyOf(lead);
      }
      // The most common shipper and consignee; on a tie, the earliest booking's.
      const counts = new Map<string, { n: number; first: (typeof sameSailing)[number] }>();
      for (const o of sameSailing) {
        const p = partyKeyOf(o);
        const k = `${p.shipper}#${p.consignee}`;
        const seen = counts.get(k);
        counts.set(k, { n: (seen?.n ?? 0) + 1, first: seen?.first ?? o });
      }
      const best = [...counts.values()].sort((a, b) => b.n - a.n || a.first.code.localeCompare(b.first.code))[0]!;
      return partyKeyOf(best.first);
    })();
    const groupKey =
      groupAdvise !== undefined
        ? `A${groupAdvise.id}`
        : `G${s.quotationId}|${mine[0]}|${sailingKey(s.id)}|${anchorParties.shipper}#${anchorParties.consignee}`;

    const parties = partyKeyOf(s);
    const shipperDiffers = parties.shipper !== anchorParties.shipper;
    const consigneeDiffers = parties.consignee !== anchorParties.consignee;
    if (shipperDiffers || consigneeDiffers) {
      tags.set(key, {
        kind: 'CHECK',
        adviseCode: groupAdvise?.code ?? null,
        withBookings: [],
        reason: shipperDiffers && consigneeDiffers ? 'shipper and consignee' : shipperDiffers ? 'shipper' : 'consignee',
        groupKey,
      });
      continue;
    }

    if (groupAdvise !== undefined) {
      tags.set(key, {
        kind: groupAdvise.status === 'SENT' ? 'LATE' : 'JOINS',
        adviseCode: groupAdvise.code,
        withBookings: membersOf(groupAdvise.id).map((m) => m.code).sort(),
        reason: null,
        groupKey,
      });
      continue;
    }

    const partners = sameSailing
      .filter((o) => o.id !== s.id)
      .filter((o) => {
        const p = partyKeyOf(o);
        return p.shipper === anchorParties.shipper && p.consignee === anchorParties.consignee;
      })
      .map((o) => o.code);
    if (partners.length > 0) {
      tags.set(key, { kind: 'SHARED', adviseCode: null, withBookings: partners, reason: null, groupKey });
      continue;
    }
    // The only one with these parties, while others share the EFR and the
    // sailing: the advise screen offers them to it, and it to them.
    const other = partyKeyOf(sameSailing.find((o) => o.id !== s.id)!);
    const shipper = other.shipper !== parties.shipper;
    const consignee = other.consignee !== parties.consignee;
    tags.set(key, {
      kind: 'CHECK',
      adviseCode: null,
      withBookings: [],
      reason: shipper && consignee ? 'shipper and consignee' : consignee ? 'consignee' : 'shipper',
      groupKey,
    });
  }
  return tags;
}
