import { Prisma } from '../generated/prisma/client';

/**
 * Which CBM an LCL charge is raised on — CR-002 §7, client decision
 * 2026-09-15.
 *
 *     actual/measured CBM available  ->  billing CBM = actual
 *     otherwise                      ->  billing CBM = booked
 *
 * Both sources survive. Neither is overwritten, and no third column holds a
 * copy of the answer: booked lives on `shipment_cargo_line.volume_cbm` and
 * actual on `cargo_receipt_line.received_volume_cbm`, and both are GENERATED,
 * so a copy could only ever drift from them.
 *
 * What IS stored is the DECISION — `cargo_receipt_line.billing_basis`. That is
 * not duplication: it records which rule was in force when the charge was
 * raised, so changing the rule later cannot silently rewrite what a customer
 * was billed. A dispute six months from now asks "what did you charge and
 * why", and the basis is the "why".
 *
 * The booked fallback is the booked PER-CARTON rate across the cartons that
 * actually arrived, not the booked line total. Billing 200 cartons' volume
 * when 180 turned up is the same error the short-shipment fix removed from the
 * load plan on 2026-09-14, and it would be no more correct on an invoice.
 */

export type BillingBasis = 'BOOKED' | 'ACTUAL';

const ZERO = new Prisma.Decimal(0);
const D = (v: Prisma.Decimal | string | number | null): Prisma.Decimal =>
  v === null ? ZERO : new Prisma.Decimal(v);

/** One accepted receipt line, with both measurements as the database holds them. */
export interface MeasuredLine {
  receivedCtnQty: number;
  /**
   * GENERATED from the RECEIPT's own carton dimensions. Null where the CFS
   * recorded a quantity but did not re-measure — which is the ordinary case,
   * not an error.
   */
  receivedVolumeCbm: Prisma.Decimal | null;
  /** From the booked cargo line. Also generated, from the booked carton. */
  bookedCbmPerCarton: Prisma.Decimal | null;
}

export interface BillingCbm {
  basis: BillingBasis;
  /** What the charge is raised on. */
  cbm: Prisma.Decimal;
  /** Both sources, carried through so a dispute can see them side by side. */
  actualCbm: Prisma.Decimal | null;
  bookedCbm: Prisma.Decimal;
}

/**
 * The rule, for one receipt line.
 *
 * "Available" means NOT NULL, including zero. A measured zero is a measurement
 * — odd, and worth a planner's attention, but it is what the CFS recorded and
 * this helper does not get to overrule it. Treating 0 as "missing" would be a
 * second billing rule nobody agreed to.
 */
export function billingCbmForLine(line: MeasuredLine): BillingCbm {
  const bookedCbm = D(line.bookedCbmPerCarton).times(line.receivedCtnQty);

  if (line.receivedVolumeCbm !== null) {
    const actual = D(line.receivedVolumeCbm);
    return { basis: 'ACTUAL', cbm: actual, actualCbm: actual, bookedCbm };
  }

  return { basis: 'BOOKED', cbm: bookedCbm, actualCbm: null, bookedCbm };
}

/**
 * The rule across every accepted line of a booking.
 *
 * A booking can have several receipts as trucks arrive over days, and they
 * need not agree: one delivery may have been re-measured and the next not. So
 * each line is resolved on its own and the results summed, rather than the
 * booking being forced to a single basis it does not have.
 *
 * `basis` is MIXED in exactly that case, which the screen shows rather than
 * hides — it means part of this charge rests on a measurement and part does
 * not, and that is worth knowing before an invoice goes out.
 */
export function billingCbmForBooking(lines: MeasuredLine[]): {
  basis: BillingBasis | 'MIXED' | null;
  cbm: Prisma.Decimal;
  actualCbm: Prisma.Decimal;
  bookedCbm: Prisma.Decimal;
  measuredLines: number;
  totalLines: number;
} {
  if (lines.length === 0) {
    return { basis: null, cbm: ZERO, actualCbm: ZERO, bookedCbm: ZERO, measuredLines: 0, totalLines: 0 };
  }

  let cbm = ZERO;
  let actualCbm = ZERO;
  let bookedCbm = ZERO;
  let measured = 0;

  for (const line of lines) {
    const r = billingCbmForLine(line);
    cbm = cbm.plus(r.cbm);
    bookedCbm = bookedCbm.plus(r.bookedCbm);
    if (r.actualCbm !== null) {
      actualCbm = actualCbm.plus(r.actualCbm);
      measured += 1;
    }
  }

  const basis: BillingBasis | 'MIXED' =
    measured === 0 ? 'BOOKED' : measured === lines.length ? 'ACTUAL' : 'MIXED';

  return { basis, cbm, actualCbm, bookedCbm, measuredLines: measured, totalLines: lines.length };
}

/**
 * What `cargo_receipt_line.billing_basis` should say for a line.
 *
 * Kept beside the rule it implements so the stored value and the computed one
 * can never disagree — the writer calls this rather than deciding for itself.
 */
export const billingBasisOf = (line: Pick<MeasuredLine, 'receivedVolumeCbm'>): BillingBasis =>
  line.receivedVolumeCbm !== null ? 'ACTUAL' : 'BOOKED';
