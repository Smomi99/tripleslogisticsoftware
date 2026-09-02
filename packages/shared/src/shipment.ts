import { z } from 'zod';

import { listQuerySchema } from './api';

import { LOADING_TYPES, SHIPMENT_TYPES } from './inquiry';
import { TRANSIT_TYPES } from './quotation';

/**
 * The shipment file (docs/MODULE_BOOKING_CARGO.md §4.1, §5.2, §6.1).
 *
 * §2.1: this is where a quotation becomes an operation, and eleven later
 * modules hang off it. Everything measured travels as a string, for §4 rule 6's
 * reason — a JSON number is a float, and these figures decide what the airline
 * bills.
 */

export const SHIPMENT_STATUSES = [
  'BOOKING_RECEIVED',
  'VESSEL_PROPOSED',
  'APPROVED_FOR_SHIPMENT',
  'REJECTED',
  'SO_ISSUED',
  'SO_SKIPPED',
  'PART_RECEIVED',
  'CARGO_RECEIVED',
  'SHORT_CLOSED',
  'CANCELLED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  BOOKING_RECEIVED: 'Booking received',
  VESSEL_PROPOSED: 'Vessel proposed',
  APPROVED_FOR_SHIPMENT: 'Approved for shipment',
  REJECTED: 'Rejected',
  SO_ISSUED: 'S/O issued',
  SO_SKIPPED: 'S/O skipped',
  PART_RECEIVED: 'Part received',
  CARGO_RECEIVED: 'Cargo received',
  SHORT_CLOSED: 'Short closed',
  CANCELLED: 'Cancelled',
};

export const PO_APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type PoApprovalStatus = (typeof PO_APPROVAL_STATUSES)[number];

export const PO_APPROVAL_STATUS_LABEL: Record<PoApprovalStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/**
 * A booking is editable until a schedule has been put in front of the customer.
 *
 * §5.1 moves it to VESSEL_PROPOSED the moment C/S saves a schedule, and every
 * state after that has somebody downstream relying on the figures. §9 Q7 —
 * whether the customer may edit their own booking after submitting and before
 * a vessel is proposed — is still open; this is the permissive reading, and
 * the route is where it would be tightened.
 */
export const SHIPMENT_EDITABLE: readonly ShipmentStatus[] = ['BOOKING_RECEIVED'];

// --------------------------------------------------------- the status machine

/**
 * §5.1's transition table, verbatim, and the only definition of it.
 *
 * The spec is emphatic about two things and this constant is how both hold:
 * the state is an explicit enum with guarded transitions rather than a set of
 * booleans, and "never let the frontend decide what the next state is". So the
 * API refuses anything not listed here, and the screens read the same table to
 * work out which button to draw — the button is derived from the status, never
 * stored.
 *
 * `CANCELLED` is reachable from everywhere, which is §5.1's "any -> CANCELLED".
 * Read literally, including from the states where the cargo has already
 * arrived: a shipment can be received and the booking behind it still voided,
 * and the spec does not carve that out. The one exclusion is CANCELLED itself,
 * because cancelling twice is a mistake rather than a transition.
 */
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  // C/S saves a schedule.
  BOOKING_RECEIVED: ['VESSEL_PROPOSED', 'CANCELLED'],
  // The customer approves or rejects what was proposed.
  VESSEL_PROPOSED: ['APPROVED_FOR_SHIPMENT', 'REJECTED', 'CANCELLED'],
  // C/S proposes a new version; §4.2 keeps the rejected one.
  REJECTED: ['VESSEL_PROPOSED', 'CANCELLED'],
  // §5.4 rule 3: inbound skips the shipping order entirely.
  APPROVED_FOR_SHIPMENT: ['SO_ISSUED', 'SO_SKIPPED', 'CANCELLED'],
  SO_ISSUED: ['PART_RECEIVED', 'CARGO_RECEIVED', 'CANCELLED'],
  SO_SKIPPED: ['PART_RECEIVED', 'CARGO_RECEIVED', 'CANCELLED'],
  // §5.5 rule 4: a booking may have several receipts, so this one loops.
  PART_RECEIVED: ['PART_RECEIVED', 'CARGO_RECEIVED', 'SHORT_CLOSED', 'CANCELLED'],
  CARGO_RECEIVED: ['CANCELLED'],
  SHORT_CLOSED: ['CANCELLED'],
  CANCELLED: [],
};

export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}

/**
 * Transitions that cannot be made without saying why.
 *
 * §5.1 marks CANCELLED "reason mandatory" and §5.5 rule 5 does the same for a
 * short close — both write off work somebody paid for, and the trail is what
 * accounts and the customer will argue over later.
 */
export const SHIPMENT_REASON_REQUIRED: readonly ShipmentStatus[] = ['CANCELLED', 'SHORT_CLOSED'];

/**
 * The Action button §6.2 draws for a booking, derived from its status.
 *
 * §5.1: "The Action button on the Booking List is derived from status, never
 * stored." Sea and air differ only in the word, the way §3 asks.
 */
export interface ShipmentAction {
  label: string;
  /** The permission the button needs, or null when it is only a statement. */
  permission: string | null;
}

export function shipmentAction(
  status: ShipmentStatus,
  shipmentType: (typeof SHIPMENT_TYPES)[number],
): ShipmentAction {
  switch (status) {
    case 'BOOKING_RECEIVED':
      return {
        label: shipmentType === 'AIR' ? 'Flight Booking' : 'Vsl Booking',
        permission: 'CUSTOMER_SERVICE.SCHEDULE.CREATE',
      };
    case 'VESSEL_PROPOSED':
      // A statement, not an action: the customer is the one who acts next.
      return { label: 'Awaiting Shipment Approval', permission: null };
    case 'REJECTED':
      return {
        label: shipmentType === 'AIR' ? 'Re-propose Flight' : 'Re-propose Vessel',
        permission: 'CUSTOMER_SERVICE.SCHEDULE.CREATE',
      };
    case 'APPROVED_FOR_SHIPMENT':
      return { label: 'Issue S/O', permission: 'CUSTOMER_SERVICE.SHIPPING_ORDER.VIEW' };
    case 'SO_ISSUED':
    case 'SO_SKIPPED':
    case 'PART_RECEIVED':
      return { label: 'Cargo Receipt', permission: 'OPERATION.CARGO_RECEIPT.VIEW' };
    case 'CARGO_RECEIVED':
    case 'SHORT_CLOSED':
    case 'CANCELLED':
      return { label: 'View', permission: 'CUSTOMER_SERVICE.CARGO_BOOKING.VIEW' };
  }
}

// ------------------------------------------------------------- measurements

/**
 * §2.3's arithmetic, in the one place both sides read it from.
 *
 * §6.1 needs CBM and chargeable weight to update live as L/W/H and quantity are
 * typed, and §2.3 forbids that maths existing in three places. So it exists
 * once, here: the screen previews with it, and Postgres stores the same
 * formula as a generated column. The two must agree digit for digit, which is
 * why this rounds exactly where the database rounds.
 *
 * Dimensions are CENTIMETRES (§9 Q2, answered 2026-09-02).
 */
export const CBM_DECIMALS = 4;
export const WEIGHT_DECIMALS = 3;
/** IATA: one cubic metre of air freight bills as 167 kg (6000 cm³/kg). */
export const VOLUMETRIC_KG_PER_CBM = 167;

/**
 * Rounds the way Postgres `round(numeric, n)` does — half away from zero.
 *
 * `toFixed` is used rather than `Math.round(x * 10**n) / 10**n` because the
 * multiply-round-divide form drifts on values like 1.005. This is a preview;
 * the stored figure is always the database's.
 */
function roundTo(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

export interface CargoMeasureInput {
  ctnQty: number | null;
  grossWeightKg: number | null;
  cartonLengthCm: number | null;
  cartonWidthCm: number | null;
  cartonHeightCm: number | null;
}

export interface CargoMeasures {
  /** null when the cartons have not been measured yet. */
  volumeCbm: number | null;
  volumetricKg: number | null;
  /** GREATEST of actual and volumetric — what an airline bills (§2.3). */
  chargeableWtKg: number | null;
}

export function computeCargoMeasures(line: CargoMeasureInput): CargoMeasures {
  const { ctnQty, grossWeightKg, cartonLengthCm, cartonWidthCm, cartonHeightCm } = line;

  const measured =
    ctnQty !== null &&
    ctnQty > 0 &&
    cartonLengthCm !== null &&
    cartonLengthCm > 0 &&
    cartonWidthCm !== null &&
    cartonWidthCm > 0 &&
    cartonHeightCm !== null &&
    cartonHeightCm > 0;

  const volumeCbm = measured
    ? roundTo((cartonLengthCm * cartonWidthCm * cartonHeightCm * ctnQty) / 1_000_000, CBM_DECIMALS)
    : null;

  // The database multiplies the ROUNDED cbm by 167, so that cbm * 167 always
  // reproduces this number. At full precision the two disagreed in the last
  // decimals, and a chargeable weight an operator cannot check by hand is the
  // §2.3 disagreement in miniature.
  const volumetricKg =
    volumeCbm === null ? null : roundTo(volumeCbm * VOLUMETRIC_KG_PER_CBM, WEIGHT_DECIMALS);

  // GREATEST ignores nulls in Postgres: cargo weighed but not measured keeps
  // its weight, and cargo measured but not weighed keeps its volumetric figure.
  const candidates = [grossWeightKg, volumetricKg].filter((v): v is number => v !== null);
  const chargeableWtKg = candidates.length === 0 ? null : roundTo(Math.max(...candidates), WEIGHT_DECIMALS);

  return { volumeCbm, volumetricKg, chargeableWtKg };
}

/** The Grand Total strip (§6.1), and the per-PO subtotals above it. */
export interface CargoTotals {
  ctnQty: number;
  pcsQty: number;
  netWeightKg: number;
  grossWeightKg: number;
  volumeCbm: number;
  chargeableWtKg: number;
}

export function sumCargoTotals(
  lines: readonly (CargoMeasureInput & { pcsQty: number | null; netWeightKg: number | null })[],
): CargoTotals {
  const total: CargoTotals = {
    ctnQty: 0,
    pcsQty: 0,
    netWeightKg: 0,
    grossWeightKg: 0,
    volumeCbm: 0,
    chargeableWtKg: 0,
  };

  for (const line of lines) {
    const measures = computeCargoMeasures(line);
    total.ctnQty += line.ctnQty ?? 0;
    total.pcsQty += line.pcsQty ?? 0;
    total.netWeightKg += line.netWeightKg ?? 0;
    total.grossWeightKg += line.grossWeightKg ?? 0;
    total.volumeCbm += measures.volumeCbm ?? 0;
    total.chargeableWtKg += measures.chargeableWtKg ?? 0;
  }

  // Summed at full precision then rounded once, so a column of subtotals adds
  // up to the grand total rather than drifting a gram per row.
  total.netWeightKg = roundTo(total.netWeightKg, WEIGHT_DECIMALS);
  total.grossWeightKg = roundTo(total.grossWeightKg, WEIGHT_DECIMALS);
  total.volumeCbm = roundTo(total.volumeCbm, CBM_DECIMALS);
  total.chargeableWtKg = roundTo(total.chargeableWtKg, WEIGHT_DECIMALS);
  return total;
}

// ----------------------------------------------------------------------- dto

export interface ShipmentCargoLineDto {
  id: string;
  shipmentPoId: string;
  poNo: string;
  itemCode: string;
  sku: string | null;
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: string | null;
  grossWeightKg: string | null;
  cartonLengthCm: string | null;
  cartonWidthCm: string | null;
  cartonHeightCm: string | null;
  /** Computed by Postgres (§2.3). Read-only on every screen. */
  volumeCbm: string | null;
  chargeableWtKg: string | null;
  dc: string | null;
  soCtnQty: number | null;
}

export interface ShipmentPoDto {
  id: string;
  poNo: string;
  approvalStatus: PoApprovalStatus;
  approvedAt: string | null;
  rejectionComments: string | null;
  /** Who decided, and whether they were speaking for the customer (§9 Q6). */
  approvedByName: string | null;
  approvedOnBehalf: boolean;
}

export interface ShipmentCommodityDto {
  id: string;
  commodityItemId: string;
  commodityName: string;
  hsCode: string | null;
}

export interface ShipmentDto {
  id: string;
  code: string;
  seriesYear: number;
  status: ShipmentStatus;
  submittedAt: string | null;
  /** §5.1: set together with CANCELLED, and never without a reason. */
  cancelledAt: string | null;
  cancelReason: string | null;

  quotationId: string;
  quotationCode: string;
  shipmentType: (typeof SHIPMENT_TYPES)[number];
  /** Read through the quotation — §5.4's inbound SKIP S/O is decided on it. */
  movementType: string;

  customerId: string;
  customerName: string;
  exporterName: string | null;
  exporterAddress: string | null;
  importerName: string | null;
  importerAddress: string | null;

  goodsTypeId: string | null;
  goodsTypeName: string | null;
  placeOfReceipt: string | null;
  loadingType: (typeof LOADING_TYPES)[number] | null;
  tosId: string | null;
  tosName: string | null;
  modeId: string | null;
  modeName: string | null;

  carrierId: string;
  carrierName: string;
  polId: string;
  polName: string;
  polCode: string;
  podId: string;
  podName: string;
  podCode: string;

  etd: string | null;
  eta: string | null;
  goodsHandoverDate: string | null;
  transitType: (typeof TRANSIT_TYPES)[number] | null;
  warehouseCfs: string | null;

  commodities: ShipmentCommodityDto[];
  pos: ShipmentPoDto[];
  cargoLines: ShipmentCargoLineDto[];
}

/**
 * One row of the Booking List (§6.2), in the client's own columns and order.
 *
 * The Action column is not here: §5.1 says it is derived from the status, and
 * `shipmentAction` is where that happens. A column the server sent would be a
 * decision the server made about what the operator may do next.
 */
export interface ShipmentListRow {
  id: string;
  quotationCode: string;
  code: string;
  customerName: string;
  /** The commodities, joined — the column is one cell wide. */
  commodity: string;
  shipmentType: (typeof SHIPMENT_TYPES)[number];
  polName: string;
  polCode: string;
  podName: string;
  podCode: string;
  /** "20STD(1) + 40HC(1)", or "200 Kg" for air, from the inquiry's volumes. */
  requiredContainer: string;
  transitType: (typeof TRANSIT_TYPES)[number] | null;
  goodsHandoverDate: string | null;
  etd: string | null;
  eta: string | null;
  status: ShipmentStatus;
  /** Drawn on the list so an operator can see why one stopped (§5.1). */
  cancelReason: string | null;
}

export const shipmentListQuerySchema = listQuerySchema.extend({
  /**
   * §3 splits the menu into Shipment Booking - Sea and - Air. One screen, one
   * set of routes; the mode is a filter rather than a fork.
   */
  shipmentType: z.enum(SHIPMENT_TYPES).optional(),
  status: z.enum(SHIPMENT_STATUSES).optional(),
  /** §7's VIEW_ALL: your own bookings by default, the team's with it. */
  scope: z.enum(['OWN', 'ALL']).default('ALL'),
});

export type ShipmentListQuery = z.infer<typeof shipmentListQuerySchema>;

/** What the form loads before anything has been typed (§5.2 rule 2). */
export interface ShipmentPrefillDto {
  quotationId: string;
  quotationCode: string;
  shipmentType: (typeof SHIPMENT_TYPES)[number];
  movementType: string;
  customerId: string;
  customerName: string;
  goodsTypeId: string | null;
  goodsTypeName: string | null;
  placeOfReceipt: string | null;
  loadingType: (typeof LOADING_TYPES)[number] | null;
  tosId: string | null;
  tosName: string | null;
  modeId: string | null;
  modeName: string | null;
  carrierId: string;
  carrierName: string;
  polId: string;
  polName: string;
  polCode: string;
  podId: string;
  podName: string;
  podCode: string;
  etd: string | null;
  eta: string | null;
  transitType: (typeof TRANSIT_TYPES)[number] | null;
  commodities: ShipmentCommodityDto[];
}

// -------------------------------------------------------------------- inputs

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');

/** Kilograms and centimetres. Three decimals, as the columns store. */
const measure = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,3})?$/, 'Use digits, up to three decimal places.');

const optionalMeasure = measure.nullish().transform((v) => (v === '' ? undefined : (v ?? undefined)));

const count = z
  .number()
  .int('Whole numbers only.')
  .min(1, 'Must be at least one.')
  .max(100_000_000, 'That is more than a ship can carry.');

export const shipmentCargoLineInputSchema = z.object({
  /** Present when editing a line that already exists. */
  id: z.string().optional(),
  /**
   * §2.2: the PO is an entity. The form still renders one flat grid, so the
   * line carries the PO NUMBER and the route resolves or creates the row.
   */
  poNo: z.string().trim().min(1, 'Enter the PO number.').max(100, 'That PO number is too long.'),
  itemCode: z.string().trim().min(1, 'Enter the item.').max(100, 'That item code is too long.'),
  sku: z.string().trim().max(100, 'That SKU is too long.').nullish(),
  ctnQty: count,
  pcsQty: count.nullish(),
  netWeightKg: optionalMeasure,
  grossWeightKg: optionalMeasure,
  cartonLengthCm: optionalMeasure,
  cartonWidthCm: optionalMeasure,
  cartonHeightCm: optionalMeasure,
  /** §9 Q1: meaning unconfirmed, so free text until the client says. */
  dc: z.string().trim().max(500, 'That is too long.').nullish(),
});

export type ShipmentCargoLineInput = z.infer<typeof shipmentCargoLineInputSchema>;

/** The header fields §6.1 draws, all editable on the booking (§5.2 rule 2). */
const shipmentHeader = {
  exporterName: z.string().trim().max(500, 'That name is too long.').nullish(),
  exporterAddress: z.string().trim().max(2000, 'That address is too long.').nullish(),
  importerName: z.string().trim().max(500, 'That name is too long.').nullish(),
  importerAddress: z.string().trim().max(2000, 'That address is too long.').nullish(),
  goodsTypeId: z.string().nullish(),
  placeOfReceipt: z.string().trim().max(1000, 'That is too long.').nullish(),
  loadingType: z.enum(LOADING_TYPES).nullish(),
  tosId: z.string().nullish(),
  modeId: z.string().nullish(),
  carrierId: z.string().min(1, 'Choose the carrier.'),
  polId: z.string().min(1, 'Choose the port of loading.'),
  podId: z.string().min(1, 'Choose the port of discharge.'),
  etd: isoDate.nullish(),
  eta: isoDate.nullish(),
  goodsHandoverDate: isoDate.nullish(),
  transitType: z.enum(TRANSIT_TYPES).nullish(),
  warehouseCfs: z.string().trim().max(1000, 'That is too long.').nullish(),
};

/** A shipment that arrives before it leaves is a typo, not a schedule. */
const datesInOrder = <T extends { etd?: string | null; eta?: string | null }>(v: T): boolean =>
  v.etd === undefined || v.etd === null || v.eta === undefined || v.eta === null || v.eta >= v.etd;

export const shipmentCreateSchema = z
  .object({
    /** §4.1: NOT NULL. A booking exists because a quotation was accepted. */
    quotationId: z.string().min(1, 'Choose the quotation this booking is against.'),
    ...shipmentHeader,
    /** §5.2 rule 4: a booking cannot be submitted with zero cargo lines. */
    cargoLines: z.array(shipmentCargoLineInputSchema),
  })
  .refine(datesInOrder, { message: 'The ETA is before the ETD.', path: ['eta'] });

export type ShipmentCreateInput = z.infer<typeof shipmentCreateSchema>;

export const shipmentUpdateSchema = z
  .object({
    ...shipmentHeader,
    carrierId: z.string().min(1, 'Choose the carrier.').optional(),
    polId: z.string().min(1, 'Choose the port of loading.').optional(),
    podId: z.string().min(1, 'Choose the port of discharge.').optional(),
    /**
     * The whole grid, every time. §2.2's hierarchy means a line moving between
     * POs is two writes and a possible orphan; sending the grid entire lets the
     * route reconcile it in one transaction instead.
     */
    cargoLines: z.array(shipmentCargoLineInputSchema).optional(),
  })
  .refine(datesInOrder, { message: 'The ETA is before the ETD.', path: ['eta'] });

export type ShipmentUpdateInput = z.infer<typeof shipmentUpdateSchema>;

/**
 * §5.1's cancellation. The reason is not optional and not a formality — it is
 * the only record of why work somebody paid for was stopped.
 */
export const shipmentCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Say why this booking is being cancelled.')
    .max(2000, 'That reason is too long.'),
});

export type ShipmentCancelInput = z.infer<typeof shipmentCancelSchema>;

// --------------------------------------------------------------- schedule

export const SCHEDULE_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_STATUS_LABEL: Record<ScheduleStatus, string> = {
  PROPOSED: 'Proposed',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  SUPERSEDED: 'Superseded',
};

/**
 * How many legs each transit type allows (§6.4).
 *
 * "Direct allows one leg. Indirect allows two or three." The database's CHECK
 * is wider (1..5, as §4.2 writes it) on purpose: the table holds what the spec
 * wrote, and this is the rule the screen and the route enforce.
 */
export const LEGS_ALLOWED: Record<(typeof TRANSIT_TYPES)[number], readonly number[]> = {
  DIRECT: [1],
  INDIRECT: [2, 3],
};

export interface ShipmentScheduleLegDto {
  id: string;
  legNo: number;
  vesselId: string | null;
  vesselName: string | null;
  voyageNo: string | null;
  flightNo: string | null;
  flightTime: string | null;
  originPortId: string;
  originPortName: string;
  destinationPortId: string;
  destinationPortName: string;
  /** ISO datetime — a leg departs and arrives at a time, not on a day. */
  etd: string | null;
  eta: string | null;
}

export interface ShipmentScheduleDto {
  id: string;
  code: string;
  shipmentId: string;
  versionNo: number;
  status: ScheduleStatus;
  carrierId: string;
  carrierName: string;
  cutOffDate: string | null;
  vgmDate: string | null;
  siDate: string | null;
  transitType: (typeof TRANSIT_TYPES)[number];
  proposedAt: string;
  decidedAt: string | null;
  rejectionComments: string | null;
  legs: ShipmentScheduleLegDto[];
}

// -------------------------------------------------------------------- input

const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use the date and time picker.');

export const scheduleLegInputSchema = z.object({
  legNo: z.number().int().min(1, 'Legs start at 1.').max(5, 'Five legs is the most (§4.2).'),
  vesselId: z.string().nullish(),
  voyageNo: z.string().trim().max(100, 'That voyage number is too long.').nullish(),
  flightNo: z.string().trim().max(100, 'That flight number is too long.').nullish(),
  flightTime: z.string().trim().max(100, 'That is too long.').nullish(),
  originPortId: z.string().min(1, 'Choose where this leg starts.'),
  destinationPortId: z.string().min(1, 'Choose where this leg ends.'),
  etd: isoDateTime.nullish(),
  eta: isoDateTime.nullish(),
});

export type ScheduleLegInput = z.infer<typeof scheduleLegInputSchema>;

/**
 * The continuity §6.4 asks for, as one function both sides call.
 *
 * "Validate leg continuity: leg 2's origin must equal leg 1's destination, and
 * each ETD must follow the previous ETA. A schedule that cannot physically
 * happen should not reach the customer."
 *
 * Returns the problems rather than throwing, so the screen can mark the leg
 * that is wrong and the route can answer with all of them at once.
 */
export interface LegProblem {
  legNo: number;
  message: string;
}

export function checkLegContinuity(
  transitType: (typeof TRANSIT_TYPES)[number],
  legs: readonly ScheduleLegInput[],
): LegProblem[] {
  const problems: LegProblem[] = [];
  const allowed = LEGS_ALLOWED[transitType];

  if (!allowed.includes(legs.length)) {
    problems.push({
      legNo: 0,
      message:
        transitType === 'DIRECT'
          ? 'A direct sailing has one leg. Switch to Indirect to add another.'
          : 'An indirect sailing has two or three legs.',
    });
  }

  const ordered = [...legs].sort((a, b) => a.legNo - b.legNo);
  for (const [index, leg] of ordered.entries()) {
    if (leg.originPortId === leg.destinationPortId) {
      problems.push({ legNo: leg.legNo, message: 'A leg cannot start and end at the same port.' });
    }
    if (leg.etd != null && leg.eta != null && Date.parse(leg.eta) < Date.parse(leg.etd)) {
      problems.push({ legNo: leg.legNo, message: 'This leg arrives before it departs.' });
    }

    const previous = index === 0 ? null : ordered[index - 1]!;
    if (previous === null) continue;

    if (previous.destinationPortId !== leg.originPortId) {
      problems.push({
        legNo: leg.legNo,
        message: `Leg ${leg.legNo} starts somewhere leg ${previous.legNo} did not end. Cargo cannot teleport between them.`,
      });
    }
    if (previous.eta != null && leg.etd != null && Date.parse(leg.etd) < Date.parse(previous.eta)) {
      problems.push({
        legNo: leg.legNo,
        message: `Leg ${leg.legNo} departs before leg ${previous.legNo} has arrived.`,
      });
    }
  }

  return problems;
}

export const shipmentScheduleInputSchema = z
  .object({
    carrierId: z.string().min(1, 'Choose the carrier.'),
    cutOffDate: isoDateTime.nullish(),
    vgmDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.').nullish(),
    siDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.').nullish(),
    transitType: z.enum(TRANSIT_TYPES),
    legs: z.array(scheduleLegInputSchema).min(1, 'A schedule needs at least one leg.'),
  })
  .superRefine((value, ctx) => {
    // §6.4's rule, checked here so the client and the server refuse the same
    // schedules — a schedule that cannot physically happen should not reach
    // the customer, and should not depend on which side is asked.
    for (const problem of checkLegContinuity(value.transitType, value.legs)) {
      ctx.addIssue({
        code: 'custom',
        path: problem.legNo === 0 ? ['legs'] : ['legs', problem.legNo - 1],
        message: problem.message,
      });
    }
  });

export type ShipmentScheduleInput = z.infer<typeof shipmentScheduleInputSchema>;

// --------------------------------------------------------------- activities

/**
 * One line of §6.3's Activities tab — the audit trail, read as sentences.
 *
 * §5.1 requires every transition to be recorded and the trigger already does
 * it, but `UPDATE` with two JSONB blobs is a developer's view of the file. The
 * operations team needs "Status: Booking received → Vessel proposed", so the
 * API describes the row and the screen only lays it out.
 */
export interface ShipmentActivityDto {
  id: string;
  at: string;
  /** Null when the change had no signed-in actor — a job, a migration. */
  actorName: string | null;
  /** What happened, in one line. */
  summary: string;
  /** The before and after, when there is one worth showing. */
  detail: string | null;
}

/** The tabs of §6.3's shipment file, in the client's own order. */
export const SHIPMENT_TABS = [
  { id: 'overview', label: 'Overview', live: true },
  { id: 'booking', label: 'Booking', live: true },
  { id: 'schedule', label: 'Vessel Schedule', live: true },
  { id: 'approval', label: 'Approval', live: true },
  { id: 'shipping-order', label: 'Shipping Order', live: true },
  { id: 'cargo-receipt', label: 'Cargo Receipt', live: true },
  { id: 'stuffing', label: 'Stuffing', live: false },
  { id: 'shipment-advise', label: 'Shipment Advise', live: false },
  { id: 'bl', label: 'BL', live: false },
  { id: 'documents', label: 'Documents', live: false },
  { id: 'tracking', label: 'Tracking', live: false },
  { id: 'finance', label: 'Finance', live: false },
  { id: 'activities', label: 'Activities', live: true },
] as const;

export type ShipmentTabId = (typeof SHIPMENT_TABS)[number]['id'];

export function isShipmentTab(value: string): value is ShipmentTabId {
  return SHIPMENT_TABS.some((tab) => tab.id === value);
}

// ----------------------------------------------------------------- approval

/**
 * §5.3: approval is per PO, not per booking.
 *
 * "Single PO can be approved / Multiple can be approved." So a decision is a
 * list, and one submission can approve two POs and reject a third — which is
 * why rejection comments hang off the PO rather than the schedule.
 */
export const poDecisionSchema = z
  .object({
    poId: z.string().min(1),
    decision: z.enum(['APPROVED', 'REJECTED']),
    comments: z.string().trim().max(2000, 'That comment is too long.').nullish(),
  })
  .refine(
    (v) => v.decision !== 'REJECTED' || (v.comments ?? '').trim() !== '',
    // §5.3: "Rejection requires a comment, shown back to the C/S team." A
    // rejection with no reason is a decision nobody can act on.
    { message: 'Say why this PO is being rejected.', path: ['comments'] },
  );

export type PoDecisionInput = z.infer<typeof poDecisionSchema>;

export const shipmentApprovalSchema = z.object({
  decisions: z.array(poDecisionSchema).min(1, 'Decide on at least one PO.'),
  /**
   * §9 Q6, answered 2026-09-02: C/S may record a decision the customer made by
   * phone or email. The record says which, because "approved by Rahim" reads as
   * the customer having agreed when Rahim is our own desk.
   */
  onBehalfOfCustomer: z.boolean().default(false),
});

export type ShipmentApprovalInput = z.infer<typeof shipmentApprovalSchema>;

/** §5.3's summary line: "3 of 5 POs approved. 2 will not ship on this vessel." */
export function describeApproval(approved: number, total: number): string {
  if (total === 0) return 'No POs on this booking.';
  if (approved === 0) return `None of the ${total} PO(s) approved. Nothing ships on this vessel.`;
  if (approved === total) return `All ${total} PO(s) approved.`;
  const held = total - approved;
  return `${approved} of ${total} POs approved. ${held} will not ship on this vessel.`;
}
