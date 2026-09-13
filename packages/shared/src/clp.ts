import { z } from 'zod';

import { listQuerySchema } from './api';

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

export interface ClpCard {
  id: string;
  code: string;
  clpSeq: number;
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
