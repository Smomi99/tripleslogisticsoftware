import { z } from 'zod';

import { listQuerySchema } from './api';
import { RATE_MODES } from './rate-lookups';

/**
 * Freight rates — docs/MODULE_PURCHASE_SALES.md §3.2, §4.
 *
 * A rate is a parent row plus one price line per tier, so the same schema
 * serves Sea FCL, Sea LCL and Air. Which tiers a screen offers comes from
 * rate_tier filtered by mode, never from a hardcoded list of four columns.
 */

// ------------------------------------------------------------------ vocabulary

export const PURCHASE_SOURCE_TYPES = ['CARRIER', 'VENDOR', 'AGENT'] as const;
export type PurchaseSourceType = (typeof PURCHASE_SOURCE_TYPES)[number];

export const PURCHASE_SOURCE_LABEL: Record<PurchaseSourceType, string> = {
  CARRIER: 'Carrier',
  VENDOR: 'Vendor',
  AGENT: 'Agent',
};

export const RATE_STATUSES = ['DRAFT', 'PUBLISHED', 'EXPIRED'] as const;
export type RateStatus = (typeof RATE_STATUSES)[number];

export const RATE_STATUS_LABEL: Record<RateStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  EXPIRED: 'Expired',
};

export const PROFIT_TYPES = ['FLAT', 'PERCENT'] as const;
export type ProfitType = (typeof PROFIT_TYPES)[number];

export const PROFIT_TYPE_LABEL: Record<ProfitType, string> = {
  FLAT: 'Flat',
  PERCENT: 'Percent',
};

export const CHARGE_SIDES = ['POL', 'POD'] as const;
export type ChargeSide = (typeof CHARGE_SIDES)[number];

// ----------------------------------------------------------------- primitives

const idField = z.string().regex(/^\d+$/, 'Choose an option.');
const optionalIdField = z.union([idField, z.literal('')]).optional();

/** Money travels as a string — §4 rule 6 forbids float anywhere near a rate. */
const moneyField = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v), message);

const optionalMoneyField = (message: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d{1,14}(\.\d{1,4})?$/.test(v), message)
    .optional();

/** `YYYY-MM-DD`. Dates are stored UTC and displayed Asia/Dhaka (CLAUDE.md §9). */
const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.');

// ----------------------------------------------------------------- rate lines

export const rateLineInputSchema = z.object({
  tierId: idField,
  buyPrice: moneyField('Enter a buy price, e.g. 1450 or 1450.50.'),
  profitType: z.enum(PROFIT_TYPES).default('FLAT'),
  profitValue: optionalMoneyField('Enter a profit amount.'),
  /** §9 Q6: the floor this line bills at. Blank means no floor. */
  minCharge: optionalMoneyField('Enter a minimum charge.'),
});

export type RateLineInput = z.input<typeof rateLineInputSchema>;

export const localChargeInputSchema = z.object({
  costHeadId: idField,
  side: z.enum(CHARGE_SIDES).default('POL'),
  amount: moneyField('Enter an amount.'),
  currencyId: idField,
  remarks: z.string().trim().max(2000, 'Remarks are too long.').optional(),
});

export type LocalChargeInput = z.input<typeof localChargeInputSchema>;

// ---------------------------------------------------------------------- rate

export const freightRateInputSchema = z
  .object({
    mode: z.enum(RATE_MODES, { message: 'Choose a freight mode.' }),
    polId: idField,
    podId: idField,
    carrierId: idField,
    goodsTypeId: idField,
    purchaseSourceType: z.enum(PURCHASE_SOURCE_TYPES, { message: 'Choose where this was bought.' }),
    /** Exactly one of these is set, matching purchaseSourceType. */
    purchaseCarrierId: optionalIdField,
    purchaseVendorId: optionalIdField,
    purchaseAgentId: optionalIdField,
    currencyId: idField,
    validFrom: dateField,
    validTo: dateField,
    transitDays: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{1,4}$/.test(v), 'Enter a whole number of days.')
      .optional(),
    remarks: z.string().trim().max(2000, 'Remarks are too long.').optional(),
    status: z.enum(RATE_STATUSES).default('DRAFT'),
    lines: z.array(rateLineInputSchema).min(1, 'Enter a price for at least one tier.'),
    localCharges: z.array(localChargeInputSchema).default([]),
  })
  .refine((v) => v.polId !== v.podId, {
    message: 'The destination must differ from the origin.',
    path: ['podId'],
  })
  .refine((v) => v.validTo >= v.validFrom, {
    message: 'The end date cannot fall before the start date.',
    path: ['validTo'],
  })
  .refine(
    (v) => {
      // The database CHECK is authoritative; this is so the user hears about it
      // in the form rather than as a 500 from a constraint they cannot see.
      const named = {
        CARRIER: v.purchaseCarrierId,
        VENDOR: v.purchaseVendorId,
        AGENT: v.purchaseAgentId,
      }[v.purchaseSourceType];
      return named !== undefined && named !== '';
    },
    { message: 'Choose who this rate was bought from.', path: ['purchaseSourceId'] },
  )
  .refine(
    (v) => new Set(v.lines.map((l) => l.tierId)).size === v.lines.length,
    { message: 'Each tier can only be priced once.', path: ['lines'] },
  )
  .refine(
    (v) =>
      new Set(v.localCharges.map((c) => `${c.costHeadId}:${c.side}`)).size ===
      v.localCharges.length,
    { message: 'Each cost head can only appear once per side.', path: ['localCharges'] },
  );

export type FreightRateInput = z.input<typeof freightRateInputSchema>;

// --------------------------------------------------------------------- output

/**
 * §4 rule 5: buyPrice, profitType, profitValue and margin are OPTIONAL on the
 * wire because the API omits them entirely when the caller lacks
 * PURCHASE.RATE.VIEW_BUY_PRICE. They are not blanked, not zeroed — absent.
 */
export interface RateLineDto {
  id: string;
  tierId: string;
  tierCode: string;
  tierLabel: string;
  sellPrice: string;
  minCharge: string | null;
  buyPrice?: string;
  profitType?: ProfitType;
  profitValue?: string;
}

export interface LocalChargeDto {
  id: string;
  costHeadId: string;
  costHeadName: string;
  side: ChargeSide;
  amount: string;
  currencyId: string;
  currencyCode: string;
  costUnitName: string | null;
  remarks: string | null;
}

export interface FreightRateDto {
  id: string;
  code: string;
  mode: (typeof RATE_MODES)[number];
  polId: string;
  polName: string;
  polCode: string;
  podId: string;
  podName: string;
  podCode: string;
  carrierId: string;
  carrierName: string;
  goodsTypeId: string;
  goodsTypeName: string;
  purchaseSourceType: PurchaseSourceType;
  purchaseSourceId: string;
  purchaseSourceName: string;
  currencyId: string;
  currencyCode: string;
  validFrom: string;
  validTo: string;
  transitDays: number | null;
  remarks: string | null;
  status: RateStatus;
  isActive: boolean;
  /** §4 rule 3: within 7 days of expiry, so the list can flag it. */
  expiringSoon: boolean;
  lines: RateLineDto[];
  localCharges: LocalChargeDto[];
  localChargeTotal: string;
  localChargeCount: number;
}

// ---------------------------------------------------------------- list query

export const freightRateListQuerySchema = listQuerySchema.extend({
  mode: z.enum(RATE_MODES),
  polId: optionalIdField,
  /** §4 rule 7: the Add-on and Price List screens filter many PODs at once. */
  podIds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const raw = Array.isArray(v) ? v : v.split(',');
      const ids = raw.map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
      return ids.length > 0 ? ids : undefined;
    }),
  carrierId: optionalIdField,
  goodsTypeId: optionalIdField,
  status: z.enum(RATE_STATUSES).optional(),
  /**
   * §4 rule 2: valid rates only, unless the user explicitly asks otherwise.
   * The default lives here so every rate list screen inherits it.
   */
  includeExpired: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});

export type FreightRateListQuery = z.infer<typeof freightRateListQuerySchema>;

export const RATE_SORT_FIELDS = ['code', 'validFrom', 'validTo', 'status'] as const;
export type RateSortField = (typeof RATE_SORT_FIELDS)[number];

/** How near expiry a rate has to be before the list flags it (§4 rule 3). */
export const EXPIRING_SOON_DAYS = 7;
