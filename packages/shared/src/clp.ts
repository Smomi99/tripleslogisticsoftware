import { z } from 'zod';

import { listQuerySchema } from './api';
import { normaliseContainerNo, validateContainerNo } from './iso6346';

/**
 * Container Load Plan — MODULE_CLP.md §5.1.
 *
 * Two screens: one that lists the bookings whose goods are in at CFS, and one
 * that builds the plan for a chosen booking. The types here are what passes
 * between them and the server.
 *
 * §5.1's "Exporter" column is the booking's own exporter_name — one quotation
 * can yield several bookings, each shipping for a different exporter, so it is
 * recorded per booking rather than inherited from the customer.
 */

// ------------------------------------------------------------ the selector

export interface ClpBookingRow {
  shipmentId: string;
  code: string;
  /** Null until a shipping order has been issued for the booking. */
  shippingOrderCode: string | null;
  customerName: string;
  /** The booking's own exporter, which is not always the customer. */
  exporterName: string | null;
  commodity: string;
  shipmentType: string;
  polName: string;
  polCode: string;
  podName: string;
  podCode: string;
  /** "20STD(1) + 40HC(1)" — what the booking says it needs. */
  requiredContainer: string;
  carrierName: string | null;
  cutOff: string | null;
  etd: string | null;
  eta: string | null;
  status: string;

  /** How far the plan has got, so the list says what to do next. */
  plannedCount: number;
  /** Cartons received and accepted that no plan has claimed yet. */
  unallocatedCtnQty: number;
  receivedCtnQty: number;
}

export const clpBookingListQuerySchema = listQuerySchema.extend({
  shipmentType: z.enum(['SEA', 'AIR']).optional(),
});

/**
 * §5.2's "List of CLP - SEA" — one row per container plan.
 *
 * A different question from the booking selector above it. That one asks
 * "what still needs planning?"; this one asks "where are my container plans,
 * and which are still drafts?" — which is what someone chasing a sailing
 * needs, and the booking list cannot answer because it has no CLP rows.
 */
export interface ClpListRow {
  id: string;
  code: string;
  clpSeq: number | null;
  status: ClpStatus;
  containerSizeCode: string;
  containerNo: string | null;
  sealNo: string | null;
  loadDatetime: string | null;

  shipmentId: string;
  bookingCode: string;
  /** More than one when the container is shared (CR-002). */
  bookingCount: number;
  shippingOrderCode: string | null;
  customerName: string;
  exporterName: string | null;
  commodity: string;
  shipmentType: string;
  polName: string;
  podName: string;
  requiredContainer: string;
  carrierName: string | null;

  totalCtnQty: number;
  totalVolumeCbm: string | null;
  volumeUtilisation: string | null;
}

export const clpListQuerySchema = listQuerySchema.extend({
  status: z.enum(['DRAFT', 'FINAL', 'CANCELLED']).optional(),
});

// --------------------------------------------------------------- the plan

/** One line of the cargo pool — what is still free to load (§5.1). */
export interface ClpPoolRow {
  cargoLineId: string;
  poId: string;
  poNo: string;
  itemCode: string;
  sku: string | null;
  /** Remaining to allocate, drawn from accepted receipts — never the booked qty. */
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: string | null;
  grossWeightKg: string | null;
  cartonLengthCm: string | null;
  cartonWidthCm: string | null;
  cartonHeightCm: string | null;
  volumeCbm: string | null;
  dc: string | null;
  /** What arrived in total, so the split dialog can show "available". */
  receivedCtnQty: number;
}

export interface ClpLineRow {
  id: string;
  cargoLineId: string;
  poNo: string;
  itemCode: string;
  sku: string | null;
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: string | null;
  grossWeightKg: string | null;
  volumeCbm: string | null;
  isSplit: boolean;
  isFinalAllocation: boolean;
}

export type ClpStatus = 'DRAFT' | 'FINAL' | 'CANCELLED';

/** One booking sharing a container (CR-002). */
export interface ClpParticipant {
  shipmentId: string;
  bookingCode: string;
  customerName: string;
  exporterName: string | null;
  /** §9 — what this booking's share of the container cost came to. */
  defaultCostAmount: string | null;
  allocatedCostAmount: string | null;
  costOverriddenBy: string | null;
  costOverrideReason: string | null;
}

export type ClpConsolidationType = 'SINGLE' | 'FCL_QUOTATION' | 'LCL_CONSOLIDATION';

export interface ClpCard {
  id: string;
  code: string;
  /** Null on a consolidated plan: it has no position "within a booking". */
  clpSeq: number | null;
  status: ClpStatus;
  containerSizeId: string;
  containerSizeCode: string;
  /** The size's full name, which is the vocabulary §4.4 compares in. */
  containerSizeName: string;
  /** Null where the size has no limit recorded — not "no limit" (§4.2). */
  maxVolumeCbm: string | null;
  maxWeightKg: string | null;

  totalCtnQty: number;
  totalPcsQty: number | null;
  totalNetWeightKg: string | null;
  totalGrossWeightKg: string | null;
  totalVolumeCbm: string | null;
  /** 1.0000 is exactly full. Null when the limit is unknown. */
  volumeUtilisation: string | null;
  weightUtilisation: string | null;

  /*
    §4.2 — set only where a supervisor knowingly loaded past the volume limit.
    Weight is never overridable, so these never explain an overweight box.
  */
  capacityOverrideReason: string | null;
  /**
   * Who allowed it, by name. There is no "when" column — audit_log holds the
   * timestamp, and duplicating it on the row would be a second thing to keep
   * true.
   */
  capacityOverrideBy: string | null;

  /* §5.2's panel — what has been recorded so far, saved or not yet final. */
  containerNo: string | null;
  sealNo: string | null;
  loadDatetime: string | null;
  supervisorEmployeeId: string | null;
  supervisorName: string | null;
  tallyManName: string | null;
  /** Set once §4.3's one-way door has been walked through. */
  finalisedAt: string | null;
  finalisedBy: string | null;
  /** §4.3 — a cancelled plan is kept, so it has to be able to say why. */
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;

  /* CR-002 — who is in this box, and what it cost them. */
  consolidationType: ClpConsolidationType;
  bookings: ClpParticipant[];
  actualContainerCost: string | null;
  costCurrencyCode: string | null;
  costAllocationBasis: 'CBM' | 'WEIGHT' | 'MANUAL' | null;
  finalCfsLocation: string | null;

  lines: ClpLineRow[];
}

export interface ClpPlan {
  booking: ClpBookingRow;
  pool: ClpPoolRow[];
  clps: ClpCard[];
  containerSizes: {
    id: string;
    code: string;
    name: string;
    maxVolumeCbm: string | null;
    maxWeightKg: string | null;
  }[];
  /** §5.2's Supervisor lookup — the tenant's active employees. */
  supervisors: { id: string; name: string }[];
  /*
    CR-002 §9's cost is entered here, so the picker travels with the plan
    rather than through the Settings currency lookup — a load planner should
    not need SETTING.CURRENCY.VIEW to say what a container cost.
  */
  currencies: { id: string; code: string; name: string; isBase: boolean }[];
  /** §4.4: what the booking declared against what this plan actually uses. */
  reconciliation: {
    required: string;
    planned: string;
    matches: boolean;
    /** "3 POs fully allocated" — the sentence §4.4 asks to always show. */
    fullyAllocatedPos: number;
    /** The ones that are not, named, because "20 cartons left" is not actionable. */
    outstanding: { poNo: string; ctnQty: number }[];
  };
}

/**
 * §4.2 — the refusal a supervisor can answer.
 *
 * Named rather than recognised from its wording: the screen decides whether
 * to offer the override dialog on this code, and matching the prose instead
 * would quietly remove that path the first time somebody improved the
 * sentence.
 */
export const CLP_OVER_VOLUME = 'CLP_OVER_VOLUME';

// -------------------------------------------------------------- the inputs

export const clpCreateSchema = z.object({
  containerSizeId: z.string().min(1, 'Choose a container size.'),
});
export type ClpCreateInput = z.input<typeof clpCreateSchema>;

/**
 * §2.2 — `add` and `Split` are the same request.
 *
 * `add` sends the whole remaining balance; `Split` sends part of it. The
 * server does not need to be told which one the user clicked, and giving it
 * two shapes would be two places for conservation to break.
 */
export const clpAllocateSchema = z.object({
  cargoLineId: z.string().min(1, 'Choose a cargo line.'),
  ctnQty: z
    .number()
    .int('Cartons come in whole numbers.')
    .positive('Enter at least one carton.'),
  /*
    §4.2 — sent only when a supervisor is knowingly loading past the volume
    limit. Weight is never overridable, so this never excuses it.
  */
  overrideReason: z
    .string()
    .trim()
    .min(5, 'Say why this container may go over its volume.')
    .max(500, 'That reason is too long.')
    .optional(),
});
export type ClpAllocateInput = z.input<typeof clpAllocateSchema>;


// -------------------------------------------------- the finalisation panel

/**
 * §5.2's panel, and §4.3's preconditions for FINAL.
 *
 * Saving and finalising are deliberately two steps. A planner learns the
 * container number when the box arrives at the gate and the seal number only
 * once it is closed, which can be hours apart — forcing both into one
 * irreversible action would mean either keeping the details on paper until
 * the end, or finalising a plan before the container is sealed.
 *
 * So: SAVE CLP records what is known on a DRAFT, and FINAL is a separate,
 * confirmed step that refuses unless everything §4.3 lists is present.
 */
const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Use the date and time picker.');

/**
 * The container number is checked here as well as on the screen, because
 * §5.2 puts the rule in one utility and this is the boundary that has to
 * hold — a request need not have come from our form.
 */
const containerNo = z
  .string()
  .trim()
  .transform(normaliseContainerNo)
  .superRefine((value, ctx) => {
    const result = validateContainerNo(value);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.message ?? 'Check the container number.' });
    }
  });

export const clpDetailsSchema = z.object({
  containerNo: containerNo.nullish(),
  sealNo: z.string().trim().max(50, 'That seal number is too long.').nullish(),
  loadDatetime: isoDateTime.nullish(),
  supervisorEmployeeId: z.string().nullish(),
  tallyManName: z.string().trim().max(200, 'That name is too long.').nullish(),
});
export type ClpDetailsInput = z.input<typeof clpDetailsSchema>;

/**
 * §4.3 — FINAL has no edit path, so the confirm step carries the figures the
 * planner is signing off on rather than just asking "are you sure?".
 */
/**
 * §4.3 — every cancellation carries a reason (client-confirmed).
 *
 * A cancelled CLP is kept with its lines for audit, and a record nobody can
 * explain is worth much less than one that says why it stopped being true.
 */
export const clpCancelSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Say why this load plan is being cancelled.')
    .max(500, 'That reason is too long.'),
});
export type ClpCancelInput = z.input<typeof clpCancelSchema>;

export const clpFinaliseSchema = z.object({
  containerNo,
  sealNo: z.string().trim().min(1, 'Enter the seal number.').max(50, 'That seal number is too long.'),
  loadDatetime: isoDateTime,
  supervisorEmployeeId: z.string().nullish(),
  tallyManName: z.string().trim().max(200, 'That name is too long.').nullish(),
});
export type ClpFinaliseInput = z.input<typeof clpFinaliseSchema>;

/**
 * What a split of `n` cartons comes to, for the dialog's live preview.
 *
 * §5.1 draws one editable cell and everything else read-only. This is the
 * arithmetic behind the other rows — deliberately the same shape the server
 * uses, so the figure a planner reads before saving is the figure that is
 * saved. It rounds like the server does; the exact remainder only lands when
 * the allocation completes the line, which the dialog says rather than guesses.
 */
export function splitPreview(
  row: Pick<ClpPoolRow, 'ctnQty' | 'pcsQty' | 'netWeightKg' | 'grossWeightKg' | 'volumeCbm'>,
  use: number,
): {
  cartons: { available: number; use: number; remaining: number };
  pieces: { available: number; use: number; remaining: number } | null;
  netWeight: { available: number; use: number; remaining: number } | null;
  grossWeight: { available: number; use: number; remaining: number } | null;
  volume: { available: number; use: number; remaining: number } | null;
} {
  const available = row.ctnQty;
  const clamped = Number.isFinite(use) ? Math.max(0, Math.min(use, available)) : 0;
  const share = available === 0 ? 0 : clamped / available;

  const part = (total: string | number | null, decimals: number) => {
    if (total === null) return null;
    const value = Number(total);
    if (!Number.isFinite(value)) return null;
    const used = Number((value * share).toFixed(decimals));
    return { available: value, use: used, remaining: Number((value - used).toFixed(decimals)) };
  };

  return {
    cartons: { available, use: clamped, remaining: available - clamped },
    pieces:
      row.pcsQty === null
        ? null
        : {
            available: row.pcsQty,
            use: Math.round(row.pcsQty * share),
            remaining: row.pcsQty - Math.round(row.pcsQty * share),
          },
    netWeight: part(row.netWeightKg, 3),
    grossWeight: part(row.grossWeightKg, 3),
    volume: part(row.volumeCbm, 4),
  };
}

// ------------------------------------------------- CR-002: consolidation

/** One booking offered for consolidation, with what the rules judge it on. */
export interface ClpCandidateRow {
  shipmentId: string;
  code: string;
  customerName: string;
  exporterName: string | null;
  loadingType: string | null;
  family: 'FCL' | 'LCL' | null;
  polName: string;
  podName: string;
  carrierName: string;
  vesselName: string | null;
  voyageNo: string | null;
  cutOffDate: string | null;
  quotationCode: string | null;
  inquiryCode: string | null;
  /** Never collapsed to one value — a booking can have several (§8). */
  cfsLocations: string[];
  receivedCtnQty: number;
  receivedCbm: string;
  receivedGrossKg: string;
  /** Already planned into a container? Shown, not hidden. */
  plannedCtnQty: number;
}

/**
 * A commercial suggestion, never a constraint.
 *
 * The screen renders these as proposals a planner may split. §4: physical
 * compatibility is the hard rule; the quotation is a default.
 */
export interface ClpSuggestedGroup {
  key: string;
  quotationCode: string | null;
  inquiryCode: string | null;
  shipmentIds: string[];
  /** The running strip §4.2 asks for. */
  totalCtnQty: number;
  totalCbm: string;
  totalGrossKg: string;
}

export interface ClpCandidateList {
  candidates: ClpCandidateRow[];
  suggestions: ClpSuggestedGroup[];
  /*
    Sent with the list rather than fetched from the Settings lookup, which is
    guarded by SETTING.CONTAINER_SIZE.VIEW — a load planner need not hold a
    settings right to pick the box they are filling.
  */
  containerSizes: { id: string; code: string; maxVolumeCbm: string | null; maxWeightKg: string | null }[];
}

/** Why a selection cannot share a container — or merely should be looked at. */
export interface ClpCompatibilityIssue {
  shipmentId: string;
  code: string;
  reason: string;
  /** False for a data-quality warning, such as a cut-off mismatch. */
  blocking: boolean;
}

export interface ClpCompatibilityResult {
  ok: boolean;
  issues: ClpCompatibilityIssue[];
  /** Distinct CFS locations across the selection (§8). */
  cfsLocations: string[];
  totalCtnQty: number;
  totalCbm: string;
  totalGrossKg: string;
}

export const clpCandidateQuerySchema = z.object({
  family: z.enum(['FCL', 'LCL']),
  search: z.string().trim().optional(),
});

export const clpCheckSchema = z.object({
  shipmentIds: z.array(z.string().min(1)).min(1, 'Choose at least one booking.'),
});
export type ClpCheckInput = z.input<typeof clpCheckSchema>;

export const clpConsolidateSchema = z.object({
  shipmentIds: z.array(z.string().min(1)).min(1, 'Choose at least one booking.'),
  containerSizeId: z.string().min(1, 'Choose a container size.'),
  /** §8 — an explicit choice, never derived from one receipt. */
  finalCfsLocation: z.string().trim().max(200).optional(),
});
export type ClpConsolidateInput = z.input<typeof clpConsolidateSchema>;

// ------------------------------------------------------ CR-002: the money

/** What a booking is billed on, with both sources kept visible (§7). */
export interface ClpBillingCbm {
  shipmentId: string;
  bookingCode: string;
  /** BOOKED, ACTUAL, or MIXED where some deliveries were measured and some not. */
  basis: 'BOOKED' | 'ACTUAL' | 'MIXED' | null;
  billingCbm: string;
  bookedCbm: string;
  actualCbm: string;
  measuredLines: number;
  totalLines: number;
}

export interface ClpCostPreview {
  basis: 'CBM' | 'WEIGHT' | 'MANUAL';
  actualContainerCost: string;
  currencyCode: string | null;
  shares: { shipmentId: string; bookingCode: string; amount: string }[];
  /** Always true on a preview the server produced; the UI shows it anyway. */
  reconciles: boolean;
}

export const clpCostSchema = z.object({
  actualContainerCost: z
    .string()
    .trim()
    .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Enter the cost as a number, to at most four decimals.'),
  costCurrencyId: z.string().min(1, 'Choose the currency this cost is in.'),
  basis: z.enum(['CBM', 'WEIGHT']),
});
export type ClpCostInput = z.input<typeof clpCostSchema>;

/**
 * §9 — a manual split. Every booking in the box carries an amount, even zero,
 * and the reason is kept against the name of whoever changed it.
 */
export const clpCostOverrideSchema = z.object({
  allocations: z
    .array(
      z.object({
        shipmentId: z.string().min(1),
        amount: z
          .string()
          .trim()
          .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Enter each amount as a number.'),
      }),
    )
    .min(1, 'Give an amount for each booking.'),
  reason: z
    .string()
    .trim()
    .min(5, 'Say why the split is being changed by hand.')
    .max(500, 'That reason is too long.'),
});
export type ClpCostOverrideInput = z.input<typeof clpCostOverrideSchema>;
