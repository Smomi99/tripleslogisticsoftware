import {
  canTransition,
  SHIPMENT_REASON_REQUIRED,
  SHIPMENT_STATUS_LABEL,
  SHIPMENT_TRANSITIONS,
  type ShipmentStatus,
} from '@ff/shared';

import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * ShipmentStatusService — docs/MODULE_BOOKING_CARGO.md §5.1.
 *
 * The one place a shipment's status changes. §5.1 asks for exactly this: an
 * explicit enum with guarded transitions, "never as a set of booleans", and
 * "never let the frontend decide what the next state is". Every route that
 * moves a booking calls `transitionShipment`; none of them writes `status`
 * itself, and a review that finds `data: { status: ... }` anywhere else has
 * found a bug.
 *
 * The audit trail §5.1 requires is already there and is not re-implemented
 * here. `app_audit_row()` fires on every UPDATE to `shipment` and records the
 * actor from `app.user_id`, the timestamp, and both the old and new status in
 * its JSONB columns. Writing a second trail beside it would be a second thing
 * to keep in step.
 *
 * What this file adds on top of the table in @ff/shared is the part that needs
 * a database: reading the current status inside the caller's transaction, so a
 * check and the write it guards cannot be separated by another request.
 */

export interface TransitionInput {
  shipmentId: bigint;
  to: ShipmentStatus;
  userId: bigint;
  /** Mandatory for the transitions in SHIPMENT_REASON_REQUIRED (§5.1, §5.5). */
  reason?: string | null;
  /**
   * Extra columns to write in the same statement.
   *
   * The status and the fact behind it belong in one UPDATE: a booking that is
   * SO_ISSUED for the instant before its shipping order id lands is a booking
   * another request can read in a state that never really existed.
   */
  data?: Record<string, unknown>;
}

export interface TransitionResult {
  from: ShipmentStatus;
  to: ShipmentStatus;
}

/**
 * Moves a booking, or refuses and says why.
 *
 * Runs inside the caller's `withTenant` transaction — passing `db` rather than
 * opening one is deliberate, so the read of the current status and the write
 * that depends on it are the same transaction.
 */
export async function transitionShipment(
  db: TenantDb,
  input: TransitionInput,
): Promise<TransitionResult> {
  const { shipmentId, to, userId } = input;

  const shipment = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: { id: true, code: true, status: true },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');

  const from = shipment.status;
  assertTransitionAllowed(from, to, shipment.code);

  const reason = (input.reason ?? '').trim();
  if (SHIPMENT_REASON_REQUIRED.includes(to) && reason === '') {
    throw new HttpError(
      422,
      'REASON_REQUIRED',
      `Say why ${shipment.code} is being ${SHIPMENT_STATUS_LABEL[to].toLowerCase()}. ` +
        'This is what accounts and the customer will read later.',
      { reason: ['A reason is required.'] },
    );
  }

  await db.shipment.update({
    where: { id: shipmentId },
    data: {
      status: to,
      ...(to === 'CANCELLED'
        ? { cancelledAt: new Date(), cancelledBy: userId, cancelReason: reason }
        : {}),
      ...(input.data ?? {}),
      updatedBy: userId,
    },
  });

  return { from, to };
}

/**
 * The refusal §5.1 asks for: "Reject anything not on this list with a clear
 * error."
 *
 * Clear means naming both states and what the booking can actually do instead.
 * A 409 saying "invalid transition" sends an operator to a developer; one that
 * says a rejected booking can only go back to a new proposal sends them to the
 * right button.
 */
export function assertTransitionAllowed(
  from: ShipmentStatus,
  to: ShipmentStatus,
  code: string,
): void {
  if (canTransition(from, to)) return;

  const allowed = SHIPMENT_TRANSITIONS[from];
  const options =
    allowed.length === 0
      ? 'Nothing follows it.'
      : `From here it can only become ${allowed.map((s) => SHIPMENT_STATUS_LABEL[s]).join(' or ')}.`;

  throw new HttpError(
    409,
    'ILLEGAL_TRANSITION',
    `${code} is ${SHIPMENT_STATUS_LABEL[from]} and cannot become ` +
      `${SHIPMENT_STATUS_LABEL[to]}. ${options}`,
    { status: allowed.map((s) => SHIPMENT_STATUS_LABEL[s]) },
  );
}
