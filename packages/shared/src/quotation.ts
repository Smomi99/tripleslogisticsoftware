import { z } from 'zod';

/**
 * The quotation (§4.4, §5.3, §6.5) — the price the customer actually reads.
 *
 * Every figure here travels as a string. §4 rule 6 stores money as
 * NUMERIC(18,4) and a JSON number is a float: 1450.50 would not survive the
 * round trip intact, and this is the one document a customer can hold us to.
 */

export const QUOTATION_STATUSES = [
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'SUPERSEDED',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded',
};

export const TRANSIT_TYPES = ['DIRECT', 'INDIRECT'] as const;
export type TransitType = (typeof TRANSIT_TYPES)[number];

export const QUOTATION_LINE_GROUPS = ['STANDARD', 'ADDITIONAL'] as const;
export type QuotationLineGroup = (typeof QUOTATION_LINE_GROUPS)[number];

export const QUOTATION_LINE_SOURCES = ['AUTO', 'MANUAL'] as const;
export type QuotationLineSource = (typeof QUOTATION_LINE_SOURCES)[number];

/** A quotation stops being editable once it has been answered or replaced. */
export const QUOTATION_EDITABLE: readonly QuotationStatus[] = ['DRAFT', 'SENT'];

export function quotationIsEditable(status: string): boolean {
  return (QUOTATION_EDITABLE as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------- DTOs

export interface QuotationLineDto {
  id: string;
  lineGroup: QuotationLineGroup;
  sortOrder: number;
  costHeadId: string;
  costHeadName: string;
  containerSizeId: string | null;
  /** Null renders as the wireframe's "No size". */
  containerSizeName: string | null;
  costUnitId: string | null;
  unitName: string | null;
  quantity: string;
  sellingPrice: string;
  currencyId: string;
  currencyCode: string;
  /** Generated: quantity x sellingPrice. */
  totalAmount: string;
  conversionRate: string;
  /** Generated: quantity x sellingPrice x conversionRate. */
  billAmountLocal: string;
  source: QuotationLineSource;
  remarks: string | null;
}

export interface QuotationCommodityDto {
  id: string;
  commodityItemId: string;
  commodityName: string;
  hsCode: string | null;
}

export interface QuotationRecipientDto {
  id: string;
  email: string;
  kind: 'TO' | 'CC';
  source: 'CUSTOMER' | 'MANUAL';
}

export interface QuotationDto {
  id: string;
  code: string;
  revisionNo: number;
  inquiryId: string;
  inquiryCode: string;
  quotationDate: string;
  validityDate: string | null;

  customerId: string;
  customerName: string;
  shipmentType: string;
  movementType: string;
  polId: string;
  polName: string | null;
  polCode: string | null;
  podId: string;
  podName: string | null;
  podCode: string | null;
  goodsTypeId: string | null;
  goodsTypeName: string | null;
  placeOfReceipt: string | null;
  loadingType: string | null;
  tosId: string | null;
  tosName: string | null;
  modeId: string | null;
  modeName: string | null;

  carrierId: string;
  carrierName: string | null;
  firstVesselId: string | null;
  firstVesselName: string | null;
  transitType: TransitType | null;
  etd: string | null;
  eta: string | null;

  localCurrencyId: string;
  localCurrencyCode: string | null;
  conversionRate: string;

  sourceAgentQuoteId: string | null;

  totalAmountUsd: string | null;
  totalAmountLocal: string | null;
  amountInWords: string | null;

  status: QuotationStatus;
  sentAt: string | null;

  commodities: QuotationCommodityDto[];
  lines: QuotationLineDto[];
  recipients: QuotationRecipientDto[];
}

/** §6.7's row. Required Container is read from the inquiry, which owns it. */
export interface QuotationListItemDto {
  id: string;
  code: string;
  revisionNo: number;
  inquiryId: string;
  inquiryCode: string;
  quotationDate: string;
  customerName: string;
  commodities: string[];
  shipmentType: string;
  polCode: string | null;
  polName: string | null;
  podCode: string | null;
  podName: string | null;
  /** "20STD(1) + 40HC(1)", or "200 Kg" for air — rendered from inquiry_volume. */
  requiredContainer: string;
  validityDate: string | null;
  status: QuotationStatus;
  totalAmountUsd: string | null;
}

// -------------------------------------------------------------------- inputs

const money = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'Use digits, up to four decimal places.');

const quantity = z
  .string()
  .trim()
  .regex(/^\d{1,15}(\.\d{1,3})?$/, 'Use digits, up to three decimal places.');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');

export const quotationLineInputSchema = z.object({
  id: z.string().optional(),
  lineGroup: z.enum(QUOTATION_LINE_GROUPS).default('STANDARD'),
  costHeadId: z.string().min(1, 'Choose a cost head.'),
  containerSizeId: z.string().nullish(),
  costUnitId: z.string().nullish(),
  quantity,
  sellingPrice: money,
  currencyId: z.string().min(1, 'Choose a currency.'),
  source: z.enum(QUOTATION_LINE_SOURCES).default('MANUAL'),
  priceSourceRateLineId: z.string().nullish(),
  priceSourceLocalChargeId: z.string().nullish(),
  remarks: z.string().trim().max(1000).nullish(),
});

export type QuotationLineInput = z.infer<typeof quotationLineInputSchema>;

export const quotationCreateSchema = z.object({
  /** §5.3 rule 1: a quotation cannot exist without an inquiry. */
  inquiryId: z.string().min(1, 'Choose the inquiry this quotation answers.'),
  carrierId: z.string().min(1, 'Choose the carrier.'),
  quotationDate: isoDate,
  validityDate: isoDate.nullish(),
  firstVesselId: z.string().nullish(),
  transitType: z.enum(TRANSIT_TYPES).nullish(),
  etd: isoDate.nullish(),
  eta: isoDate.nullish(),
  localCurrencyId: z.string().min(1, 'Choose the billing currency.'),
  /**
   * What the freight is called on the customer's document.
   *
   * The price table prices the box but does not name the charge: freight_rate
   * has no cost head, only rate_local_charge does. Naming the freight is a
   * sales decision rather than a purchasing one, so it is asked here — see the
   * §11 note. Optional: without it the local charges still pull and the freight
   * lines are left for the user to add.
   */
  freightCostHeadId: z.string().nullish(),
  sourceAgentQuoteId: z.string().nullish(),
});

export type QuotationCreateInput = z.infer<typeof quotationCreateSchema>;

export const quotationUpdateSchema = z.object({
  quotationDate: isoDate.optional(),
  validityDate: isoDate.nullish(),
  carrierId: z.string().min(1).optional(),
  firstVesselId: z.string().nullish(),
  transitType: z.enum(TRANSIT_TYPES).nullish(),
  etd: isoDate.nullish(),
  eta: isoDate.nullish(),
  placeOfReceipt: z.string().trim().max(1000).nullish(),
  tosId: z.string().nullish(),
  modeId: z.string().nullish(),
  goodsTypeId: z.string().nullish(),
  /**
   * §5.4: the frozen rate is editable before sending and never after. The route
   * enforces the "never after" half — a schema cannot see the status.
   */
  conversionRate: money.optional(),
  lines: z.array(quotationLineInputSchema).optional(),
});

export type QuotationUpdateInput = z.infer<typeof quotationUpdateSchema>;

export const quotationSendSchema = z.object({
  recipients: z
    .array(
      z.object({
        email: z.string().trim().email('That is not an email address.'),
        kind: z.enum(['TO', 'CC']).default('TO'),
      }),
    )
    .min(1, 'Add at least one address to send it to.'),
});

export type QuotationSendInput = z.infer<typeof quotationSendSchema>;

export const quotationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().optional(),
  status: z.enum(QUOTATION_STATUSES).optional(),
  customerId: z.string().optional(),
  mine: z.coerce.boolean().optional(),
});

export type QuotationListQuery = z.infer<typeof quotationListQuerySchema>;

/**
 * §6.6's three standing notes, as the product's default wording.
 *
 * The spec says they are "stored as editable tenant text, not hardcoded", and
 * the storage is notification_setting.quotation_notes. This is what a workspace
 * that has never touched them is offered — a default, not a fallback nobody can
 * reach: the settings screen pre-fills with it and the tenant edits from there.
 *
 * Kept here rather than in the PDF renderer so the screen that edits them and
 * the document that prints them cannot disagree about what the default is.
 */
export const DEFAULT_QUOTATION_NOTES = [
  'This is a quotation only; the final freight invoice follows the shipment.',
  'Excludes all VAT & TAX; if TDS is deducted, 1% is added to total invoice value.',
  'Payment before BL release by pay order, cash, or online transfer.',
].join('\n');

/**
 * The notes to print: the tenant's own, or the product default.
 *
 * Null and empty are different answers. Null is a workspace that has never
 * touched them, and gets the product's wording; an empty string is one that
 * cleared them on purpose, and gets none. `??` rather than `||` is what keeps
 * the two apart.
 */
export function quotationNotes(stored: string | null | undefined): string[] {
  const text = stored ?? DEFAULT_QUOTATION_NOTES;
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}
