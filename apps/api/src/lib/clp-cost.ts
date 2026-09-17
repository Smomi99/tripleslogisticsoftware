import { Prisma } from '../generated/prisma/client';
import { HttpError } from './http-error';

/**
 * Splitting one container's cost across the bookings that shared it —
 * CR-002 §9, client decisions 2026-09-15.
 *
 * The source is an OPERATOR-ENTERED actual container cost, held on the CLP.
 * Deliberately not `freight_rate_line.buy_price` and not the sum of the quoted
 * selling prices: those are commercial reference figures agreed before the box
 * was booked, and what the carrier actually charged for this container is a
 * third number. They may all differ, and only one of them is the cost being
 * apportioned.
 *
 * There is no Accounts module yet — no invoice, ledger or cost table exists —
 * so this captures the allocation where it originates rather than leaving
 * Accounts to reconstruct it later from a container plan that never recorded
 * it. The basis is stored explicitly for the same reason: six months on,
 * "why does this booking carry $900" has to be answerable.
 *
 * Rounding follows the rule this codebase already uses for splitting a whole
 * across parts (`recomputeCargoLine`, MODULE_CLP.md §2.3): intermediate shares
 * round to the column's scale and the LAST share takes whatever is left, so
 * the parts sum to the total exactly. Money is NUMERIC(18,4), so that is the
 * scale here.
 */

export type CostBasis = 'CBM' | 'WEIGHT' | 'MANUAL';

/** Money's scale, from the column. */
const MONEY_DP = 4;
const ZERO = new Prisma.Decimal(0);
const D = (v: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal =>
  v === null || v === undefined ? ZERO : new Prisma.Decimal(v);

/** One booking in the box, with the measures a split can be made on. */
export interface CostParticipant {
  shipmentId: bigint;
  code: string;
  /** What this booking actually has loaded in THIS container. */
  cbm: Prisma.Decimal;
  weightKg: Prisma.Decimal;
}

export interface CostShare {
  shipmentId: bigint;
  code: string;
  amount: Prisma.Decimal;
}

/**
 * Apportion `total` across the participants on the given basis.
 *
 * CBM is the default (client decision). WEIGHT is offered because a heavy,
 * low-volume consignment pays for the container's payload rather than its
 * space, and a forwarder will sometimes bill it that way.
 *
 * MANUAL is not computed here — by definition somebody types those figures —
 * so it is refused rather than silently guessed at.
 */
export function splitCost(
  total: Prisma.Decimal,
  basis: CostBasis,
  participants: CostParticipant[],
): CostShare[] {
  if (basis === 'MANUAL') {
    throw HttpError.badRequest(
      'A manual split has to be entered, not calculated. Give an amount for each booking.',
    );
  }
  if (participants.length === 0) {
    throw HttpError.badRequest('There are no bookings in this container to split the cost across.');
  }
  if (total.lessThan(0)) {
    throw HttpError.badRequest('A container cost cannot be negative.');
  }

  const measure = (p: CostParticipant) => (basis === 'CBM' ? p.cbm : p.weightKg);
  const totalMeasure = participants.reduce((sum, p) => sum.plus(measure(p)), ZERO);

  /*
    No measure to divide by. Rather than invent an equal split — which would be
    a second allocation rule nobody agreed — this refuses and says which basis
    failed, so the operator picks the other one or enters the figures.
  */
  if (totalMeasure.lessThanOrEqualTo(0)) {
    throw HttpError.badRequest(
      basis === 'CBM'
        ? 'No booking in this container has any volume recorded, so the cost cannot be split by CBM. Split by weight, or enter the amounts.'
        : 'No booking in this container has any weight recorded, so the cost cannot be split by weight. Split by CBM, or enter the amounts.',
    );
  }

  const shares: CostShare[] = [];
  let used = ZERO;

  participants.forEach((p, index) => {
    const isLast = index === participants.length - 1;
    /*
      §2.3's rule. Every share but the last multiplies out and rounds; the last
      takes the balance, which is what makes the parts sum to the whole rather
      than to the whole minus a rounding step.
    */
    const amount = isLast
      ? total.minus(used)
      : total.times(measure(p)).dividedBy(totalMeasure).toDecimalPlaces(MONEY_DP);

    shares.push({ shipmentId: p.shipmentId, code: p.code, amount });
    used = used.plus(amount);
  });

  return shares;
}

/**
 * The guarantee: what the bookings carry adds up to what the box cost.
 *
 * Checked on every write, computed or manual, because §9's requirement is that
 * money is never silently left unallocated or counted twice — and a manual
 * override is exactly where that happens.
 *
 * Exact at the money scale. There is no tolerance: with the remainder rule
 * above there is nothing for a tolerance to absorb, and a tolerance is how a
 * few pennies a container becomes a reconciliation nobody can close.
 */
export function assertReconciles(total: Prisma.Decimal, shares: CostShare[]): void {
  const sum = shares.reduce((acc, s) => acc.plus(s.amount), ZERO);
  const want = total.toDecimalPlaces(MONEY_DP);
  const got = sum.toDecimalPlaces(MONEY_DP);

  if (!got.equals(want)) {
    const diff = got.minus(want);
    throw HttpError.badRequest(
      `The booking amounts come to ${got.toFixed(2)}, but the container cost is ` +
        `${want.toFixed(2)} — ${diff.greaterThan(0) ? 'over' : 'under'} by ` +
        `${diff.abs().toFixed(2)}. Every part of the cost has to land on a booking.`,
    );
  }

  for (const share of shares) {
    if (share.amount.lessThan(0)) {
      throw HttpError.badRequest(
        `${share.code} cannot carry a negative share of the container cost.`,
      );
    }
  }
}

/**
 * A manual split, checked against the bookings that are actually in the box.
 *
 * Refuses a booking that is not in this container and a booking that was left
 * out, because both leave money in the wrong place: the first allocates cost
 * to cargo that is not there, the second leaves it unallocated.
 */
export function readManualShares(
  participants: CostParticipant[],
  entered: { shipmentId: bigint; amount: Prisma.Decimal | string | number }[],
): CostShare[] {
  const byId = new Map(participants.map((p) => [p.shipmentId.toString(), p]));
  const seen = new Set<string>();
  const shares: CostShare[] = [];

  for (const row of entered) {
    const key = row.shipmentId.toString();
    const participant = byId.get(key);
    if (participant === undefined) {
      throw HttpError.badRequest('One of those bookings is not in this container.');
    }
    if (seen.has(key)) {
      throw HttpError.badRequest(`${participant.code} has been given two amounts.`);
    }
    seen.add(key);
    shares.push({ shipmentId: participant.shipmentId, code: participant.code, amount: D(row.amount) });
  }

  const missing = participants.filter((p) => !seen.has(p.shipmentId.toString()));
  if (missing.length > 0) {
    throw HttpError.badRequest(
      `${missing.map((m) => m.code).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no amount. ` +
        'Every booking in the container has to carry a share, even if it is zero.',
    );
  }

  return shares;
}
