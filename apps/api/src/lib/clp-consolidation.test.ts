import { describe, expect, it } from 'vitest';

import {
  type ConsolidationCandidate,
  checkCompatibility,
  cfsLocations,
  isCompatible,
  loadingFamily,
  loadingTypesOf,
  suggestGroups,
} from './clp-consolidation';

/**
 * CR-002 §3 — which bookings may share a container.
 *
 * These are the rules that decide what physically goes into a steel box, so
 * they are tested as a matrix rather than by example: same/different for each
 * dimension, and the message checked as well as the verdict, because a
 * planner who is refused needs to know which booking and why.
 */

const BASE: ConsolidationCandidate = {
  shipmentId: 1n,
  code: 'BKG-001',
  customerName: 'Shafidi',
  exporterName: 'Exporter A',
  loadingType: 'FCL',
  family: 'FCL',
  shipmentType: 'SEA',
  status: 'CARGO_RECEIVED',
  polId: 10n,
  polName: 'Chittagong',
  podId: 20n,
  podName: 'Hamburg',
  carrierId: 30n,
  carrierName: 'SITC',
  vesselId: 40n,
  vesselName: 'MSC XXX',
  voyageNo: '123E',
  cutOffDate: new Date('2026-10-01T00:00:00Z'),
  quotationId: 50n,
  quotationCode: 'QTN-031',
  inquiryCode: 'INQ-042',
  cfsLocations: ['CFS A'],
  receivedCtnQty: 340,
  receivedCbm: 18,
  receivedGrossKg: 4000,
};

const other = (over: Partial<ConsolidationCandidate> = {}): ConsolidationCandidate => ({
  ...BASE,
  shipmentId: 2n,
  code: 'BKG-002',
  exporterName: 'Exporter B',
  ...over,
});

const blocking = (cs: ConsolidationCandidate[]) =>
  checkCompatibility(cs).filter((p) => p.blocking);

// --------------------------------------------------------------- the sailing

describe('sailing identity — vessel + voyage, never schedule id', () => {
  it('lets the same vessel on the same voyage travel together', () => {
    expect(blocking([BASE, other()])).toEqual([]);
    expect(isCompatible(checkCompatibility([BASE, other()]))).toBe(true);
  });

  it('refuses the same vessel on a different voyage', () => {
    /*
      The rule CR-002 called "the one that catches real mistakes": same lane,
      same carrier, same ship — and a container that cannot exist, because the
      two lots sail a fortnight apart.
    */
    const problems = blocking([BASE, other({ voyageNo: '125E' })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toMatch(/sails on MSC XXX 125E, not MSC XXX 123E/);
  });

  it('refuses a different vessel on the same voyage number', () => {
    // Voyage numbers are only unique within a carrier's own vessel.
    const problems = blocking([
      BASE,
      other({ vesselId: 41n, vesselName: 'MSC YYY' }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toMatch(/MSC YYY 123E/);
  });

  it('refuses a booking with no approved sailing yet', () => {
    const problems = blocking([
      BASE,
      other({ vesselId: null, vesselName: null, voyageNo: null }),
    ]);
    expect(problems[0]!.reason).toMatch(/no approved vessel and voyage/);
  });

  it('does not trip over voyage spelling', () => {
    // " 123e " and "123E" are one voyage; a planner should not be refused for
    // a trailing space.
    expect(blocking([BASE, other({ voyageNo: ' 123e ' })])).toEqual([]);
  });
});

// ------------------------------------------------------------- FCL/LCL split

describe('FCL and LCL never share a box', () => {
  it('allows FCL with FCL', () => {
    expect(blocking([BASE, other()])).toEqual([]);
  });

  it('allows LCL with LCL', () => {
    const a = { ...BASE, loadingType: 'LCL', family: 'LCL' as const };
    const b = other({ loadingType: 'LCL', family: 'LCL' });
    expect(blocking([a, b])).toEqual([]);
  });

  it('refuses FCL with LCL, and says so plainly', () => {
    const problems = blocking([BASE, other({ loadingType: 'LCL', family: 'LCL' })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toMatch(/FCL and LCL cargo never share a container/);
  });

  it('treats CONSOL_BOX as FCL-like, so it may join FCL', () => {
    // Client decision 2026-09-15. It is a whole container the forwarder
    // fills, not many shippers sharing one.
    expect(loadingFamily('CONSOL_BOX')).toBe('FCL');
    expect(blocking([BASE, other({ loadingType: 'CONSOL_BOX', family: 'FCL' })])).toEqual([]);
  });

  it('refuses CONSOL_BOX with LCL', () => {
    const a = { ...BASE, loadingType: 'CONSOL_BOX', family: 'FCL' as const };
    const problems = blocking([a, other({ loadingType: 'LCL', family: 'LCL' })]);
    expect(problems[0]!.reason).toMatch(/never share a container/);
  });

  it('refuses a booking with no loading type rather than assuming one', () => {
    // A guess here decides what shares a steel box.
    expect(loadingFamily(null)).toBeNull();
    const problems = blocking([BASE, other({ loadingType: null, family: null })]);
    expect(problems.some((p) => /no loading type set/.test(p.reason))).toBe(true);
  });
});

/*
  §13 — the FCL/LCL view split filters on the same rule that decides what may
  share a box, through one helper rather than a second copy of the mapping.
  These tests exist so the two can never drift: if a view ever showed a set of
  loading types the compatibility rule disagreed with, a planner would be
  offered a booking the server would then refuse.
*/
describe('loadingTypesOf — the query side of the same rule', () => {
  it('puts CONSOL_BOX in the FCL workflow, never LCL', () => {
    expect(loadingTypesOf('FCL')).toEqual(['FCL', 'CONSOL_BOX']);
    expect(loadingTypesOf('LCL')).toEqual(['LCL']);
  });

  it('is the exact inverse of loadingFamily, in both directions', () => {
    // Every stored value lands in exactly one workflow's list, and that list
    // is the one loadingFamily names.
    for (const family of ['FCL', 'LCL'] as const) {
      for (const type of loadingTypesOf(family)) {
        expect(loadingFamily(type)).toBe(family);
      }
    }
    // And nothing is in both, so a view can never show a row twice.
    expect(loadingTypesOf('FCL').filter((t) => loadingTypesOf('LCL').includes(t))).toEqual([]);
  });

  it('covers every loading type the schema allows', () => {
    /*
      A new enum value added to `shipment.loading_type` without a decision
      about which workflow owns it would silently vanish from both views. This
      fails when that happens, which is the moment to ask rather than guess.
    */
    const stored = ['FCL', 'LCL', 'CONSOL_BOX'];
    const covered = [...loadingTypesOf('FCL'), ...loadingTypesOf('LCL')].sort();
    expect(covered).toEqual([...stored].sort());
  });

  it('never claims a booking with no loading type', () => {
    // The null case is not in any list: unstated is a refusal, not a default.
    expect(loadingTypesOf('FCL')).not.toContain(null);
    expect(loadingTypesOf('LCL')).not.toContain(null);
  });
});

// ------------------------------------------------------------- destination

describe('destination — pod_id, separate by default', () => {
  it('allows the same destination', () => {
    expect(blocking([BASE, other()])).toEqual([]);
  });

  it('refuses a different destination, naming both', () => {
    const problems = blocking([BASE, other({ podId: 21n, podName: 'Rotterdam' })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toBe('BKG-002 is going to Rotterdam, not Hamburg.');
  });

  it('refuses a different load port', () => {
    const problems = blocking([BASE, other({ polId: 11n, polName: 'Mongla' })]);
    expect(problems[0]!.reason).toMatch(/loads at Mongla, not Chittagong/);
  });

  it('refuses a different carrier', () => {
    const problems = blocking([BASE, other({ carrierId: 31n, carrierName: 'Maersk' })]);
    expect(problems[0]!.reason).toMatch(/booked with Maersk, not SITC/);
  });
});

// ------------------------------------------------------------ cargo readiness

describe('the cargo has to be in', () => {
  it('accepts part-received as well as fully received', () => {
    expect(blocking([BASE, other({ status: 'PART_RECEIVED' })])).toEqual([]);
  });

  it('refuses a booking whose cargo has not arrived', () => {
    const problems = blocking([BASE, other({ status: 'APPROVED_FOR_SHIPMENT' })]);
    expect(problems[0]!.reason).toMatch(/no cargo received yet/);
  });

  it('refuses a booking with nothing accepted', () => {
    const problems = blocking([BASE, other({ receivedCtnQty: 0 })]);
    expect(problems.some((p) => /no accepted cartons/.test(p.reason))).toBe(true);
  });

  it('refuses air, which uses ULD build-up', () => {
    const problems = blocking([BASE, other({ shipmentType: 'AIR' })]);
    expect(problems[0]!.reason).toMatch(/air booking/);
  });
});

// -------------------------------------------------------------- the cut-off

describe('cut-off', () => {
  it('reports a differing cut-off without blocking it', () => {
    /*
      Bookings that passed the sailing rule are on one sailing and therefore
      share its cut-off, so a difference is a data-entry discrepancy worth
      seeing rather than a physical impossibility. Flagged in the report as an
      open question.
    */
    const all = checkCompatibility([BASE, other({ cutOffDate: new Date('2026-10-03T00:00:00Z') })]);
    expect(all).toHaveLength(1);
    expect(all[0]!.blocking).toBe(false);
    expect(all[0]!.reason).toMatch(/cut-off 2026-10-03 against 2026-10-01/);
    expect(isCompatible(all)).toBe(true);
  });

  it('ignores a difference in time of day', () => {
    const all = checkCompatibility([BASE, other({ cutOffDate: new Date('2026-10-01T18:00:00Z') })]);
    expect(all).toEqual([]);
  });
});

// ---------------------------------------------------------------- reporting

describe('what the planner is told', () => {
  it('reports every failure, not just the first', () => {
    // Six boxes ticked: say which two are wrong, do not reveal them one at a
    // time.
    const problems = blocking([
      BASE,
      other({ shipmentId: 2n, code: 'BKG-002', podId: 21n, podName: 'Rotterdam' }),
      other({ shipmentId: 3n, code: 'BKG-003', voyageNo: '999W' }),
    ]);
    expect(problems).toHaveLength(2);
    expect(problems.map((p) => p.code).sort()).toEqual(['BKG-002', 'BKG-003']);
  });

  it('says nothing about a single booking that is fine', () => {
    expect(checkCompatibility([BASE])).toEqual([]);
    expect(checkCompatibility([])).toEqual([]);
  });

  it('still checks a single booking on its own merits', () => {
    /*
      This returned early for one candidate until the route tests caught it,
      which let a booking with nothing received — or an air booking, or one
      with no loading type — walk straight into a container plan. Only the
      pairwise rules need something to compare against.
    */
    expect(blocking([other({ receivedCtnQty: 0 })])).toHaveLength(1);
    expect(blocking([other({ shipmentType: 'AIR' })])[0]!.reason).toMatch(/air booking/);
    expect(blocking([other({ status: 'APPROVED_FOR_SHIPMENT' })])[0]!.reason).toMatch(
      /no cargo received/,
    );
    expect(blocking([other({ loadingType: null, family: null })])[0]!.reason).toMatch(
      /no loading type/,
    );
  });
});

// --------------------------------------------------------------------- CFS

describe('CFS locations (§8)', () => {
  it('reports one location when every receipt agrees', () => {
    expect(cfsLocations([BASE, other()])).toEqual(['CFS A']);
  });

  it('reports them all when they differ, rather than picking one', () => {
    // A booking with three deliveries can genuinely have three.
    const many = other({ cfsLocations: ['CFS B', 'CFS C'] });
    expect(cfsLocations([BASE, many])).toEqual(['CFS A', 'CFS B', 'CFS C']);
  });

  it('handles a booking whose receipts recorded no location', () => {
    expect(cfsLocations([{ ...BASE, cfsLocations: [] }])).toEqual([]);
  });
});

// ------------------------------------------------------- commercial default

describe('grouping is a suggestion, not a decision', () => {
  it('puts one quotation together', () => {
    const groups = suggestGroups([BASE, other(), other({ shipmentId: 3n, code: 'BKG-003' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.shipmentIds).toHaveLength(3);
  });

  it('never suggests a group the rules would then refuse', () => {
    /*
      Same quotation, different sailing. Suggesting these together would
      produce a proposal the engine rejects, which teaches a planner to
      ignore suggestions.
    */
    const groups = suggestGroups([BASE, other({ voyageNo: '125E' })]);
    expect(groups).toHaveLength(2);
  });

  it('splits two quotations apart, and each stays valid on its own', () => {
    const groups = suggestGroups([BASE, other({ quotationId: 51n, quotationCode: 'QTN-032' })]);
    expect(groups).toHaveLength(2);
    // ...but the split is commercial only: physically they could share a box,
    // which is exactly what §4 lets a user act on.
    expect(blocking([BASE, other({ quotationId: 51n })])).toEqual([]);
  });

  it('does not group LCL by quotation — that is what LCL is', () => {
    const a = { ...BASE, loadingType: 'LCL', family: 'LCL' as const };
    const b = other({
      loadingType: 'LCL',
      family: 'LCL',
      quotationId: 51n,
      customerName: 'Another customer',
    });
    const groups = suggestGroups([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.shipmentIds).toHaveLength(2);
  });
});
