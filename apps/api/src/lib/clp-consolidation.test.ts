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

/*
  LCL, because it is a workflow in which two bookings may share a box at all —
  the physical rules below are the same in every workflow, and an FCL pair is
  refused by rule 9 before any of them matters.
*/
const BASE: ConsolidationCandidate = {
  shipmentId: 1n,
  code: 'BKG-001',
  customerName: 'Shafidi',
  exporterName: 'Exporter A',
  importerName: 'Importer Z',
  loadingType: 'LCL',
  family: 'LCL',
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

// --------------------------------------------------------- the three workflows

const as = (type: 'FCL' | 'LCL' | 'CONSOL_BOX') => ({ loadingType: type, family: type });

/*
  The client's loading-type sheet, 2026-09-16: FCL is one booking with one
  EFR; LCL is several exporters' bookings in one box, across customers
  (confirmed the same day); Consol box is small shipments in the forwarder's
  own box, across customers, and its own workflow.
*/
describe('loading types never share a box, and FCL never shares at all', () => {
  it('lets one FCL booking have its container', () => {
    expect(blocking([{ ...BASE, ...as('FCL') }])).toEqual([]);
  });

  it('refuses two FCL bookings, even on one quotation and one sailing', () => {
    const problems = blocking([{ ...BASE, ...as('FCL') }, other(as('FCL'))]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.code).toBe('BKG-002');
    expect(problems[0]!.reason).toMatch(
      /BKG-002 and BKG-001 are separate FCL bookings, and an FCL container holds one booking/,
    );
    // It says what to do instead, not only that it is wrong.
    expect(problems[0]!.reason).toMatch(/book them as LCL/);
  });

  it('names every extra FCL booking, not just the first', () => {
    const problems = blocking([
      { ...BASE, ...as('FCL') },
      other(as('FCL')),
      other({ ...as('FCL'), shipmentId: 3n, code: 'BKG-003' }),
    ]);
    expect(problems.map((p) => p.code)).toEqual(['BKG-002', 'BKG-003']);
  });

  it('lets LCL bookings of different exporters and different customers share', () => {
    const b = other({ exporterName: 'KLM', customerName: 'Another customer', quotationId: 51n });
    expect(blocking([BASE, b])).toEqual([]);
  });

  it('lets Consol box bookings of different customers share', () => {
    const a = { ...BASE, ...as('CONSOL_BOX') };
    const b = other({ ...as('CONSOL_BOX'), customerName: 'Another customer', quotationId: 51n });
    expect(blocking([a, b])).toEqual([]);
  });

  it.each([
    ['FCL', 'LCL', 'BKG-002 is LCL and BKG-001 is FCL.'],
    ['LCL', 'CONSOL_BOX', 'BKG-002 is Consol box and BKG-001 is LCL.'],
    ['CONSOL_BOX', 'FCL', 'BKG-002 is FCL and BKG-001 is Consol box.'],
  ] as const)('refuses %s with %s, and says so plainly', (first, second, said) => {
    const problems = blocking([{ ...BASE, ...as(first) }, other(as(second))]);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.reason).toBe(`${said} Different loading types never share a container.`);
  });

  it('maps each stored loading type to its own workflow', () => {
    expect(loadingFamily('FCL')).toBe('FCL');
    expect(loadingFamily('LCL')).toBe('LCL');
    // Superseding the 2026-09-15 decision that made it FCL-like.
    expect(loadingFamily('CONSOL_BOX')).toBe('CONSOL_BOX');
  });

  it('refuses a booking with no loading type rather than assuming one', () => {
    // A guess here decides what shares a steel box.
    expect(loadingFamily(null)).toBeNull();
    expect(loadingFamily('')).toBeNull();
    const problems = blocking([BASE, other({ loadingType: null, family: null })]);
    expect(problems.some((p) => /no loading type set/.test(p.reason))).toBe(true);
  });
});

/*
  §13 — the workflow views filter on the same rule that decides what may
  share a box, through one helper rather than a second copy of the mapping.
  These tests exist so the two can never drift: if a view ever showed a set of
  loading types the compatibility rule disagreed with, a planner would be
  offered a booking the server would then refuse.
*/
describe('loadingTypesOf — the query side of the same rule', () => {
  const FAMILIES = ['FCL', 'LCL', 'CONSOL_BOX'] as const;

  it('gives each workflow exactly its own loading type', () => {
    expect(loadingTypesOf('FCL')).toEqual(['FCL']);
    expect(loadingTypesOf('LCL')).toEqual(['LCL']);
    expect(loadingTypesOf('CONSOL_BOX')).toEqual(['CONSOL_BOX']);
  });

  it('is the exact inverse of loadingFamily, in both directions', () => {
    // Every stored value lands in exactly one workflow's list, and that list
    // is the one loadingFamily names.
    for (const family of FAMILIES) {
      for (const type of loadingTypesOf(family)) {
        expect(loadingFamily(type)).toBe(family);
      }
    }
    // And nothing is in two, so a view can never show a row twice.
    const all = FAMILIES.flatMap((f) => loadingTypesOf(f));
    expect(new Set(all).size).toBe(all.length);
  });

  it('covers every loading type the schema allows', () => {
    /*
      A new enum value added to `shipment.loading_type` without a decision
      about which workflow owns it would silently vanish from every view. This
      fails when that happens, which is the moment to ask rather than guess.
    */
    const stored = ['FCL', 'LCL', 'CONSOL_BOX'];
    const covered = FAMILIES.flatMap((f) => loadingTypesOf(f)).sort();
    expect(covered).toEqual([...stored].sort());
  });

  it('never claims a booking with no loading type', () => {
    // The null case is not in any list: unstated is a refusal, not a default.
    for (const family of FAMILIES) expect(loadingTypesOf(family)).not.toContain(null);
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
  it('puts one sailing together', () => {
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

  it('does not group LCL by quotation or customer — that is what LCL is', () => {
    const b = other({ quotationId: 51n, customerName: 'Another customer' });
    const groups = suggestGroups([BASE, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.shipmentIds).toHaveLength(2);
  });

  it('groups Consol box the same way, but never with LCL', () => {
    const boxA = { ...BASE, ...as('CONSOL_BOX') };
    const boxB = other({ ...as('CONSOL_BOX'), customerName: 'Another customer' });
    const lcl = other({ shipmentId: 3n, code: 'BKG-003' });
    const groups = suggestGroups([boxA, boxB, lcl]);
    expect(groups.map((g) => g.shipmentIds.length).sort()).toEqual([1, 2]);
  });

  it('suggests every FCL booking alone, since rule 9 gives each its own box', () => {
    const groups = suggestGroups([{ ...BASE, ...as('FCL') }, other(as('FCL'))]);
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.shipmentIds).toHaveLength(1);
  });
});
