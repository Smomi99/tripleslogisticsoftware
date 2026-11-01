import { z } from 'zod';

import { listQuerySchema } from './api';
import type { LookupOption } from './cost-head';
import type { InquiryStatus, MovementType } from './inquiry';
import type { QuotationStatus } from './quotation';
import type { RateMode } from './rate-lookups';

/**
 * Sales & Marketing → Business Matrix (docs/DESIGN-UPDATE-2026-10-28.md §1).
 *
 * Transcribed from the client's `Business Matrix` sheet: trade lanes defined
 * as one POL to many PODs (OUTBOUND SHIPMENT) or many POLs to one POD (INBOUND
 * SHIPMENT), each shown as a table of Inquiry Received · No of Quotation ·
 * Shipment Volume (TEUs) · Total Revenue per port pair.
 */

/** The sheet's two sections, E4 and E25. Cross Border has none (§6 Q4). */
export const TRADE_LANE_DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const satisfies readonly MovementType[];
export type TradeLaneDirection = (typeof TRADE_LANE_DIRECTIONS)[number];

export const TRADE_LANE_DIRECTION_LABEL: Record<TradeLaneDirection, string> = {
  OUTBOUND: 'Outbound shipment',
  INBOUND: 'Inbound shipment',
};

/**
 * Which side of a lane is the single port, by direction: rows 5–6 "Single POL /
 * Muliple POD" outbound, and the mirror image inbound (row 27's labels are
 * swapped on the sheet; its sample rows are many POLs into Chittagong).
 */
export const TRADE_LANE_SIDES: Record<TradeLaneDirection, { single: 'POL' | 'POD'; many: 'POL' | 'POD' }> = {
  OUTBOUND: { single: 'POL', many: 'POD' },
  INBOUND: { single: 'POD', many: 'POL' },
};

/** A lane holds up to this many ports on its many side. */
export const TRADE_LANE_MAX_PORTS = 100;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');
const portId = z.string().regex(/^\d+$/, 'Choose a port from the list.');

export const tradeLaneSaveSchema = z
  .object({
    /** E5 "Trade lane name". */
    name: z.string().trim().min(1, 'Name the trade lane.').max(200, 'A lane name is at most 200 characters.'),
    movementType: z.enum(TRADE_LANE_DIRECTIONS),
    /** The single side: C6 "Single POL" outbound, the POD inbound. */
    portId: z.string().regex(/^\d+$/, 'Choose the port.'),
    /** The many side, in the order the matrix reads them. */
    portIds: z
      .array(portId)
      .min(1, 'Choose at least one port.')
      .max(TRADE_LANE_MAX_PORTS, `A lane holds up to ${TRADE_LANE_MAX_PORTS} ports.`)
      .refine((ids) => new Set(ids).size === ids.length, 'Each port goes on the lane once.'),
  })
  .refine((lane) => !lane.portIds.includes(lane.portId), {
    message: 'A port cannot be on both sides of the lane.',
    path: ['portIds'],
  });
export type TradeLaneSaveInput = z.input<typeof tradeLaneSaveSchema>;

export const BUSINESS_MATRIX_SORT_FIELDS = ['name', 'code'] as const;
export type BusinessMatrixSortField = (typeof BUSINESS_MATRIX_SORT_FIELDS)[number];

/**
 * The sheet has no period (§6 Q1). From and To are optional and inclusive;
 * each figure is counted by its own date.
 */
export const businessMatrixQuerySchema = listQuerySchema
  .extend({
    movementType: z.enum(TRADE_LANE_DIRECTIONS).default('OUTBOUND'),
    sortBy: z.enum(BUSINESS_MATRIX_SORT_FIELDS).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'The From date must be on or before the To date.',
    path: ['to'],
  });

export interface TradeLanePortDto {
  id: string;
  name: string;
  portCode: string;
  country: string;
}

/** One row of a lane's table — sheet rows 10–14 and 18–19 (outbound), 30–34 (inbound). */
export interface BusinessMatrixRowDto {
  pol: TradeLanePortDto;
  pod: TradeLanePortDto;
  /**
   * "Live Rate" (client, 2026-11-01), the column after POD: purchase rates on
   * this POL → POD live today, by the rule the Live Inquiry's lane check uses —
   * PUBLISHED, valid from ≤ today ≤ valid to, sea modes on a sea lane and air
   * on an air lane. As of today whatever the period, like any balance.
   */
  liveRates: number;
  /** E9 "Inquiry Received". */
  inquiries: number;
  /** F9 "No of Quotation". */
  quotations: number;
  /** G9 "Shipment Volume ( TEUs)", a decimal string. Null on an air lane, which has no containers. */
  teus: string | null;
  /** H9 "Total Revenue", in the workspace's base currency, a decimal string. */
  revenue: string;
}

export interface TradeLaneDto {
  id: string;
  code: string;
  name: string;
  movementType: TradeLaneDirection;
  isActive: boolean;
  /** The single side. */
  port: TradeLanePortDto;
  /** The many side, in order. */
  ports: TradeLanePortDto[];
  /** All its ports are airports (§6 Q3). */
  isAir: boolean;
  /** ISO code of the base currency Total Revenue is in, e.g. "BDT". */
  revenueCurrency: string;
  rows: BusinessMatrixRowDto[];
}

// ---------------------------------------------------------------------------
// Opening a figure (client, 2026-11-01): "all the count on business matrix …
// pop up and show the specific information". Each cell opens the records it
// counted, matched by the same statement that counted them.
// ---------------------------------------------------------------------------

/** The matrix's figures, in column order. */
export const BUSINESS_MATRIX_FIGURES = ['liveRates', 'inquiries', 'quotations', 'teus', 'revenue'] as const;
export type BusinessMatrixFigure = (typeof BUSINESS_MATRIX_FIGURES)[number];

/** The column headers, as the sheet writes them. */
export const BUSINESS_MATRIX_FIGURE_LABEL: Record<BusinessMatrixFigure, string> = {
  liveRates: 'Live Rate',
  inquiries: 'Inquiry Received',
  quotations: 'No of Quotation',
  teus: 'Shipment Volume (TEUs)',
  revenue: 'Total Revenue',
};

/** Which price list a live rate of each mode belongs to. */
export const BUSINESS_MATRIX_RATE_PERMISSION: Record<RateMode, string> = {
  SEA_FCL: 'PURCHASE.PRICE_LIST_SEA_FCL.VIEW',
  SEA_LCL: 'PURCHASE.PRICE_LIST_SEA_LCL.VIEW',
  AIR: 'PURCHASE.PRICE_LIST_AIR.VIEW',
};

/** A sea lane is rated FCL and LCL, an air lane air — the lane check's split. */
export const businessMatrixRateModes = (isAir: boolean): RateMode[] => (isAir ? ['AIR'] : ['SEA_FCL', 'SEA_LCL']);

/**
 * A cell opens records from another screen, so it takes that screen's VIEW
 * (CLAUDE.md §7) — any one of these keys. The matrix's own VIEW shows the
 * number; it does not show the customers and prices behind it.
 */
export function businessMatrixDetailPermissions(figure: BusinessMatrixFigure, isAir: boolean): string[] {
  switch (figure) {
    case 'liveRates':
      return businessMatrixRateModes(isAir).map((mode) => BUSINESS_MATRIX_RATE_PERMISSION[mode]);
    case 'inquiries':
      return ['SALES.INQUIRY.VIEW'];
    case 'quotations':
      return ['CUSTOMER_SERVICE.QUOTATION.VIEW'];
    case 'teus':
      return ['OPERATION.CONTAINER_LOAD_PLAN.VIEW'];
    case 'revenue':
      return ['ACCOUNTS.DEBIT_INVOICE.VIEW'];
  }
}

/** A popup lists this many records at most; it says how many more there are. */
export const BUSINESS_MATRIX_DETAIL_LIMIT = 200;

export const businessMatrixDetailQuerySchema = z
  .object({
    figure: z.enum(BUSINESS_MATRIX_FIGURES),
    movementType: z.enum(TRADE_LANE_DIRECTIONS),
    polId: portId,
    podId: portId,
    from: isoDate.optional(),
    to: isoDate.optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'The From date must be on or before the To date.',
    path: ['to'],
  });
export type BusinessMatrixDetailQuery = z.input<typeof businessMatrixDetailQuerySchema>;

/** A live purchase rate, as the Price List offers it: selling side only. */
export interface MatrixRateRow {
  id: string;
  code: string;
  mode: RateMode;
  carrierName: string;
  goodsTypeName: string;
  validFrom: string;
  validTo: string;
  transitDays: number | null;
  route: string | null;
  currencyCode: string;
  /** Each tier's sell price, e.g. 20' 1250.0000. Null until a price is set. */
  lines: { label: string; sellPrice: string | null }[];
}

export interface MatrixInquiryRow {
  id: string;
  code: string;
  inquiryDate: string;
  customerName: string;
  salesmanName: string | null;
  status: InquiryStatus;
  /** OPEN past its valid-to, which the Live Inquiry list reads as "Lapsed". */
  isLapsed: boolean;
}

/** One per quotation number: its latest counted revision. */
export interface MatrixQuotationRow {
  id: string;
  code: string;
  revisionNo: number;
  quotationDate: string;
  customerName: string;
  carrierName: string;
  status: QuotationStatus;
}

/** A finalised container, counted once at its size's TEU factor. */
export interface MatrixLoadPlanRow {
  id: string;
  code: string;
  containerNo: string | null;
  containerSize: string;
  teus: string;
  /** The date it is counted by: loaded, or finalised when no load time was kept. */
  loadedOn: string;
  carrierName: string;
  /** The bookings on this port pair inside the box. */
  bookings: string[];
}

export interface MatrixInvoiceRow {
  id: string;
  code: string;
  invoiceDate: string;
  customerName: string;
  bookingCode: string;
  currencyCode: string;
  totalAmount: string;
  /** In the workspace's base currency — what Total Revenue adds up. */
  totalAmountBase: string;
}

interface MatrixDetailBase {
  pol: TradeLanePortDto;
  pod: TradeLanePortDto;
  /** Records this user may open; `rows` holds the first BUSINESS_MATRIX_DETAIL_LIMIT of them. */
  total: number;
  /**
   * Counted in the cell but not this user's to open: colleagues' inquiries and
   * quotations without VIEW_ALL, or rates on a price list they do not hold.
   */
  hidden: number;
}

export type BusinessMatrixDetailDto =
  | (MatrixDetailBase & { figure: 'liveRates'; /** The day "live" was judged on. */ asOf: string; rows: MatrixRateRow[] })
  | (MatrixDetailBase & { figure: 'inquiries'; rows: MatrixInquiryRow[] })
  | (MatrixDetailBase & { figure: 'quotations'; rows: MatrixQuotationRow[] })
  | (MatrixDetailBase & { figure: 'teus'; /** The cell's figure. */ sum: string; rows: MatrixLoadPlanRow[] })
  | (MatrixDetailBase & { figure: 'revenue'; /** ISO code of the base currency. */ currency: string; sum: string; rows: MatrixInvoiceRow[] });

export interface TradeLanePortOption extends LookupOption {
  portCode: string;
  type: 'SEAPORT' | 'AIRPORT';
}

export interface TradeLaneOptionsDto {
  ports: TradeLanePortOption[];
}
