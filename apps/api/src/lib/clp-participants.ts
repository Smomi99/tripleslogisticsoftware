import type { TenantDb } from './tenant-client';

/**
 * Which bookings are in a container — one definition, for every path that
 * asks.
 *
 * Two creation routes record it differently, and both are current:
 *
 *   POST /clps/consolidate      writes clp_booking rows (the canonical shape)
 *   POST /bookings/:id/clps     writes only clp.shipment_id ("Add another
 *                               container"), and no participation at all
 *
 * Every read that joined clp_booking alone therefore went blind on plans made
 * the second way — the booking list lost them, the printed document lost its
 * header, the cost split refused to run, and the billing panel came back
 * empty. Each was found separately, which is the argument for this file: the
 * answer to "whose cargo is in this box" belongs in one place, not restated
 * at five call sites that can drift apart.
 *
 * `clp.shipment_id` is not a second source of truth here. It is the ONLY
 * record those plans ever wrote, and this reads it. Nothing in this file
 * writes, backfills or repairs anything — a read path that quietly corrected
 * what it found would destroy the evidence of how the data got that way.
 */

/**
 * A `where` fragment matching the plans one booking takes part in.
 *
 * The branches are ordered narrow-first and the second is restricted to plans
 * with no participation at all, so this stays a statement about the legacy
 * shape rather than a general-purpose fallback.
 */
export function plansOfBooking(shipmentId: bigint) {
  return {
    OR: [
      { bookings: { some: { shipmentId, deletedAt: null } } },
      { bookings: { none: { deletedAt: null } }, shipmentId },
    ],
  };
}

/**
 * The bookings in one container, in a stable order.
 *
 * Participation order first (`clp_booking.id`), which is the order the
 * consolidation was built in; a legacy plan yields its single booking. Empty
 * only for a plan that has neither — which should not exist, and which every
 * caller here treats as "nothing to show" rather than inventing a booking.
 */
export async function participantShipmentIds(
  db: TenantDb,
  clpId: bigint,
): Promise<bigint[]> {
  const plan = await db.clp.findFirst({
    where: { id: clpId, deletedAt: null },
    select: {
      shipmentId: true,
      bookings: {
        where: { deletedAt: null },
        orderBy: { id: 'asc' },
        select: { shipmentId: true },
      },
    },
  });
  if (plan === null) return [];
  if (plan.bookings.length > 0) return plan.bookings.map((b) => b.shipmentId);
  return plan.shipmentId === null ? [] : [plan.shipmentId];
}

/**
 * True when this booking is one of the container's own.
 *
 * The question `allocate` has to ask before putting cargo in a box: §14 says
 * the API validates at save time whatever the screen believed, and without
 * this any cargo line in the workspace could be loaded into any draft plan.
 */
export async function isParticipant(
  db: TenantDb,
  clpId: bigint,
  shipmentId: bigint,
): Promise<boolean> {
  const ids = await participantShipmentIds(db, clpId);
  return ids.some((id) => id === shipmentId);
}
