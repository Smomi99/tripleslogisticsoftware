import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client';
import {
  type CostParticipant,
  assertReconciles,
  readManualShares,
  splitCost,
} from './clp-cost';

/**
 * CR-002 §9 — splitting one container's cost across the bookings in it.
 *
 * The requirement these tests exist for is one sentence: money is never
 * silently left unallocated or counted twice. So almost every case below ends
 * by checking the parts sum to the whole, including the awkward ones where a
 * third of $2,000 does not divide.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const p = (id: number, code: string, cbm: string, kg: string): CostParticipant => ({
  shipmentId: BigInt(id),
  code,
  cbm: D(cbm),
  weightKg: D(kg),
});

const sum = (shares: { amount: Prisma.Decimal }[]) =>
  shares.reduce((a, s) => a.plus(s.amount), new Prisma.Decimal(0));

describe('splitting by CBM, the default basis', () => {
  it('gives one booking the whole cost', () => {
    const shares = splitCost(D(2000), 'CBM', [p(1, 'BKG-001', '18', '4000')]);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.amount.toString()).toBe('2000');
  });

  it('splits two bookings in proportion to their volume', () => {
    const shares = splitCost(D(2000), 'CBM', [
      p(1, 'BKG-001', '30', '1000'),
      p(2, 'BKG-002', '10', '1000'),
    ]);
    expect(shares[0]!.amount.toString()).toBe('1500');
    expect(shares[1]!.amount.toString()).toBe('500');
    expect(sum(shares).toString()).toBe('2000');
  });

  it('splits three bookings and still adds up exactly', () => {
    // $2,000 across equal thirds does not divide. The last share takes the
    // balance, which is what makes the parts sum to the whole.
    const shares = splitCost(D(2000), 'CBM', [
      p(1, 'BKG-001', '10', '1'),
      p(2, 'BKG-002', '10', '1'),
      p(3, 'BKG-003', '10', '1'),
    ]);
    expect(sum(shares).toString()).toBe('2000');
    expect(shares[0]!.amount.toString()).toBe('666.6667');
    expect(shares[2]!.amount.toString()).toBe('666.6666');
    assertReconciles(D(2000), shares);
  });

  it('handles fractional CBM without losing a penny', () => {
    const shares = splitCost(D('1875.50'), 'CBM', [
      p(1, 'BKG-001', '11.5200', '1'),
      p(2, 'BKG-002', '7.6800', '1'),
      p(3, 'BKG-003', '8.1000', '1'),
    ]);
    expect(sum(shares).toString()).toBe('1875.5');
    assertReconciles(D('1875.50'), shares);
  });

  it('gives a booking with no volume nothing, and the rest still balances', () => {
    const shares = splitCost(D(1000), 'CBM', [
      p(1, 'BKG-001', '20', '1'),
      p(2, 'BKG-002', '0', '1'),
    ]);
    expect(shares[1]!.amount.toString()).toBe('0');
    expect(sum(shares).toString()).toBe('1000');
  });
});

describe('splitting by weight', () => {
  it('apportions on the payload instead of the space', () => {
    // A heavy, low-volume consignment pays for what it actually uses up.
    const shares = splitCost(D(1200), 'WEIGHT', [
      p(1, 'BKG-001', '1', '9000'),
      p(2, 'BKG-002', '30', '3000'),
    ]);
    expect(shares[0]!.amount.toString()).toBe('900');
    expect(shares[1]!.amount.toString()).toBe('300');
  });
});

describe('what it refuses', () => {
  it('refuses to compute a manual split', () => {
    expect(() => splitCost(D(1000), 'MANUAL', [p(1, 'A', '1', '1')])).toThrow(
      /has to be entered, not calculated/,
    );
  });

  it('refuses a container with no bookings in it', () => {
    expect(() => splitCost(D(1000), 'CBM', [])).toThrow(/no bookings in this container/);
  });

  it('refuses a negative cost', () => {
    expect(() => splitCost(D(-5), 'CBM', [p(1, 'A', '1', '1')])).toThrow(/cannot be negative/);
  });

  it('refuses to split by a basis nobody recorded, rather than inventing one', () => {
    /*
      An equal split would be a second allocation rule that was never agreed.
      Better to say which basis failed and let the operator choose.
    */
    expect(() =>
      splitCost(D(1000), 'CBM', [p(1, 'A', '0', '100'), p(2, 'B', '0', '100')]),
    ).toThrow(/any volume recorded.*Split by weight, or enter the amounts/s);

    expect(() =>
      splitCost(D(1000), 'WEIGHT', [p(1, 'A', '10', '0'), p(2, 'B', '10', '0')]),
    ).toThrow(/any weight recorded.*Split by CBM/s);
  });

  it('allows a zero cost, which allocates zero to everyone', () => {
    const shares = splitCost(D(0), 'CBM', [p(1, 'A', '10', '1'), p(2, 'B', '10', '1')]);
    expect(sum(shares).toString()).toBe('0');
    assertReconciles(D(0), shares);
  });
});

describe('reconciliation is the guarantee', () => {
  it('accepts a split that adds up', () => {
    expect(() =>
      assertReconciles(D(2000), [
        { shipmentId: 1n, code: 'A', amount: D(1500) },
        { shipmentId: 2n, code: 'B', amount: D(500) },
      ]),
    ).not.toThrow();
  });

  it('refuses money left unallocated, and says how much', () => {
    expect(() =>
      assertReconciles(D(2000), [
        { shipmentId: 1n, code: 'A', amount: D(1500) },
        { shipmentId: 2n, code: 'B', amount: D(400) },
      ]),
    ).toThrow(/come to 1900.00, but the container cost is 2000.00 — under by 100.00/);
  });

  it('refuses money counted twice', () => {
    expect(() =>
      assertReconciles(D(2000), [
        { shipmentId: 1n, code: 'A', amount: D(1500) },
        { shipmentId: 2n, code: 'B', amount: D(900) },
      ]),
    ).toThrow(/over by 400.00/);
  });

  it('refuses a negative share', () => {
    expect(() =>
      assertReconciles(D(1000), [
        { shipmentId: 1n, code: 'BKG-001', amount: D(1200) },
        { shipmentId: 2n, code: 'BKG-002', amount: D(-200) },
      ]),
    ).toThrow(/BKG-002 cannot carry a negative share/);
  });

  it('has no tolerance, because the remainder rule leaves nothing to absorb', () => {
    // A few pennies a container is how a reconciliation nobody can close
    // begins.
    expect(() =>
      assertReconciles(D(2000), [
        { shipmentId: 1n, code: 'A', amount: D('1999.9999') },
      ]),
    ).toThrow(/under by 0.00/);
  });

  it('holds for every computed split', () => {
    for (const total of ['2000', '1875.50', '999.99', '0.01', '7']) {
      for (const basis of ['CBM', 'WEIGHT'] as const) {
        const shares = splitCost(D(total), basis, [
          p(1, 'A', '11.52', '2520'),
          p(2, 'B', '7.68', '1880'),
          p(3, 'C', '8.10', '1420'),
        ]);
        expect(() => assertReconciles(D(total), shares), `${total} by ${basis}`).not.toThrow();
      }
    }
  });
});

describe('a manual split', () => {
  const inBox = [p(1, 'BKG-001', '10', '1'), p(2, 'BKG-002', '10', '1')];

  it('takes the amounts as entered', () => {
    const shares = readManualShares(inBox, [
      { shipmentId: 1n, amount: '1200' },
      { shipmentId: 2n, amount: '800' },
    ]);
    expect(sum(shares).toString()).toBe('2000');
    assertReconciles(D(2000), shares);
  });

  it('refuses a booking that is not in this container', () => {
    // Allocating cost to cargo that is not in the box.
    expect(() =>
      readManualShares(inBox, [
        { shipmentId: 1n, amount: '1000' },
        { shipmentId: 99n, amount: '1000' },
      ]),
    ).toThrow(/not in this container/);
  });

  it('refuses a booking that was left out', () => {
    // Leaving money unallocated by omission rather than by arithmetic.
    expect(() => readManualShares(inBox, [{ shipmentId: 1n, amount: '2000' }])).toThrow(
      /BKG-002 has no amount/,
    );
  });

  it('refuses the same booking twice', () => {
    expect(() =>
      readManualShares(inBox, [
        { shipmentId: 1n, amount: '1000' },
        { shipmentId: 1n, amount: '1000' },
        { shipmentId: 2n, amount: '0' },
      ]),
    ).toThrow(/BKG-001 has been given two amounts/);
  });

  it('allows a zero share, which is a decision rather than an omission', () => {
    const shares = readManualShares(inBox, [
      { shipmentId: 1n, amount: '2000' },
      { shipmentId: 2n, amount: '0' },
    ]);
    assertReconciles(D(2000), shares);
  });

  it('still has to add up', () => {
    const shares = readManualShares(inBox, [
      { shipmentId: 1n, amount: '1000' },
      { shipmentId: 2n, amount: '500' },
    ]);
    expect(() => assertReconciles(D(2000), shares)).toThrow(/under by 500.00/);
  });
});
