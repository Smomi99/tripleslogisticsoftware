import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client';
import {
  type MeasuredLine,
  billingBasisOf,
  billingCbmForBooking,
  billingCbmForLine,
} from './clp-billing';

/**
 * CR-002 §7 — which CBM an LCL charge is raised on.
 *
 *     actual available  ->  billing CBM = actual
 *     otherwise         ->  billing CBM = booked
 *
 * The point of the tests is that BOTH sources survive every path. LCL is
 * billed per CBM, so this is the number a customer disputes, and being able to
 * show what was measured alongside what was booked is the whole reason the
 * measurement is captured.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** 20 cartons booked at 0.125 CBM each = 2.5 CBM. */
const line = (over: Partial<MeasuredLine> = {}): MeasuredLine => ({
  receivedCtnQty: 20,
  receivedVolumeCbm: null,
  bookedCbmPerCarton: D('0.125'),
  ...over,
});

describe('one receipt line', () => {
  it('uses booked when the CFS did not re-measure', () => {
    const r = billingCbmForLine(line());
    expect(r.basis).toBe('BOOKED');
    expect(r.cbm.toString()).toBe('2.5');
    expect(r.actualCbm).toBeNull();
    expect(r.bookedCbm.toString()).toBe('2.5');
  });

  it('uses the measurement when there is one', () => {
    const r = billingCbmForLine(line({ receivedVolumeCbm: D('2.9') }));
    expect(r.basis).toBe('ACTUAL');
    expect(r.cbm.toString()).toBe('2.9');
    // ...and still reports what was booked, which is the number being disputed.
    expect(r.bookedCbm.toString()).toBe('2.5');
  });

  it('keeps both sources whichever one governs', () => {
    const measured = billingCbmForLine(line({ receivedVolumeCbm: D('2.9') }));
    expect(measured.actualCbm!.toString()).toBe('2.9');
    expect(measured.bookedCbm.toString()).toBe('2.5');

    const unmeasured = billingCbmForLine(line());
    expect(unmeasured.actualCbm).toBeNull();
    expect(unmeasured.bookedCbm.toString()).toBe('2.5');
  });

  it('treats a measured zero as a measurement, not as missing', () => {
    /*
      Odd, and worth a planner's attention — but it is what the CFS recorded,
      and calling it "missing" would be a second billing rule nobody agreed.
    */
    const r = billingCbmForLine(line({ receivedVolumeCbm: D(0) }));
    expect(r.basis).toBe('ACTUAL');
    expect(r.cbm.toString()).toBe('0');
    expect(r.bookedCbm.toString()).toBe('2.5');
  });

  it('bills the cartons that arrived, not the cartons that were ordered', () => {
    // The short-shipment rule, applied to an invoice: 12 of 20 turned up.
    const r = billingCbmForLine(line({ receivedCtnQty: 12 }));
    expect(r.cbm.toString()).toBe('1.5');
  });

  it('copes with a booking that has no booked per-carton rate', () => {
    const r = billingCbmForLine(line({ bookedCbmPerCarton: null }));
    expect(r.basis).toBe('BOOKED');
    expect(r.cbm.toString()).toBe('0');
  });

  it('does not round a fractional measurement away', () => {
    const r = billingCbmForLine(line({ receivedVolumeCbm: D('2.9376') }));
    expect(r.cbm.toString()).toBe('2.9376');
  });
});

describe('across several receipts', () => {
  it('sums a booking delivered in one go', () => {
    const r = billingCbmForBooking([line({ receivedVolumeCbm: D('2.9') })]);
    expect(r.basis).toBe('ACTUAL');
    expect(r.cbm.toString()).toBe('2.9');
  });

  it('sums several deliveries that were all measured', () => {
    const r = billingCbmForBooking([
      line({ receivedCtnQty: 10, receivedVolumeCbm: D('1.4') }),
      line({ receivedCtnQty: 10, receivedVolumeCbm: D('1.5') }),
    ]);
    expect(r.basis).toBe('ACTUAL');
    expect(r.cbm.toString()).toBe('2.9');
    expect(r.measuredLines).toBe(2);
  });

  it('sums several deliveries that were none of them measured', () => {
    const r = billingCbmForBooking([
      line({ receivedCtnQty: 10 }),
      line({ receivedCtnQty: 10 }),
    ]);
    expect(r.basis).toBe('BOOKED');
    expect(r.cbm.toString()).toBe('2.5');
  });

  it('says MIXED when one delivery was measured and another was not', () => {
    /*
      A real case: the first truck was re-measured at the CFS and the second
      was waved through. Part of the charge rests on a measurement and part
      does not, and an invoice should not pretend otherwise.
    */
    const r = billingCbmForBooking([
      line({ receivedCtnQty: 10, receivedVolumeCbm: D('1.4') }),
      line({ receivedCtnQty: 10 }),
    ]);
    expect(r.basis).toBe('MIXED');
    expect(r.measuredLines).toBe(1);
    expect(r.totalLines).toBe(2);
    // 1.4 measured + 10 x 0.125 booked
    expect(r.cbm.toString()).toBe('2.65');
    // Both totals stay available for the dispute.
    expect(r.actualCbm.toString()).toBe('1.4');
    expect(r.bookedCbm.toString()).toBe('2.5');
  });

  it('says nothing about a booking with no accepted lines', () => {
    const r = billingCbmForBooking([]);
    expect(r.basis).toBeNull();
    expect(r.cbm.toString()).toBe('0');
  });
});

describe('the stored basis', () => {
  it('matches the rule that was applied', () => {
    // The writer calls this rather than deciding for itself, so the column and
    // the computation cannot disagree.
    expect(billingBasisOf({ receivedVolumeCbm: D('2.9') })).toBe('ACTUAL');
    expect(billingBasisOf({ receivedVolumeCbm: D(0) })).toBe('ACTUAL');
    expect(billingBasisOf({ receivedVolumeCbm: null })).toBe('BOOKED');
  });

  it('agrees with billingCbmForLine on every shape', () => {
    for (const measurement of [null, D(0), D('2.9'), D('0.0001')]) {
      const l = line({ receivedVolumeCbm: measurement });
      expect(billingBasisOf(l)).toBe(billingCbmForLine(l).basis);
    }
  });
});
