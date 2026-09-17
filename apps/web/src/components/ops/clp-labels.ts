import type { ClpLoadingFamily } from '@ff/shared';

/**
 * The words the Container Load Plan screens share, in one place, so the list,
 * the planning view and a booking's plan never call the same thing by two
 * names.
 */

/** A workflow tab; the empty string is "All". */
export type FamilyTab = '' | ClpLoadingFamily;

export const FAMILY_TABS = [
  ['', 'All'],
  ['FCL', 'FCL'],
  ['LCL', 'LCL'],
  ['CONSOL_BOX', 'Consol box'],
] as const satisfies readonly (readonly [FamilyTab, string])[];

export const familyFromParam = (value: string | null): FamilyTab =>
  value === 'FCL' || value === 'LCL' || value === 'CONSOL_BOX' ? value : '';

/** What the operator calls a stored loading type. */
export const loadingLabel = (loadingType: string | null): string =>
  loadingType === null ? '—' : loadingType === 'CONSOL_BOX' ? 'Consol box' : loadingType;

/** The same name, for the middle of a sentence. */
export const familyInSentence = (family: FamilyTab): string =>
  family === '' ? '' : family === 'CONSOL_BOX' ? 'consol box' : family;

/**
 * What a booking needs, as a planner reads it.
 *
 * A consol box goes into the forwarder's own container, so it has no required
 * container of its own — the quotation's volume grid otherwise renders as a
 * weight ("60 Kg"), which reads like a container nobody can find.
 */
export const requiredLabel = (loadingType: string | null, required: string): string =>
  loadingType === 'CONSOL_BOX' ? 'None — our consol box' : required;

/** One line under the tabs, saying what the chosen workflow allows. */
export const FAMILY_HINT: Record<FamilyTab, string> = {
  '': 'FCL, LCL and consol box cargo never share a container. Pick one to narrow the list.',
  FCL: 'One booking to a container. Tick the POs that go in this box.',
  LCL: "Several exporters' bookings in one box, across customers.",
  CONSOL_BOX: 'Small shipments in our own container, across customers.',
};
