import { z } from 'zod';

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
