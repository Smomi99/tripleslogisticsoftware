import { z } from 'zod';

import type { InquiryStatus, ShipmentType } from './inquiry';
import type { ShipmentStatus } from './shipment';

/**
 * Overview — the first screen after sign-in: the business at a glance.
 *
 * Every figure here is one an existing screen already defines, counted the
 * same way, and each section is returned only to a user who may open that
 * screen (CLAUDE.md §7):
 *
 *   sales       Live Inquiry        SALES.INQUIRY.VIEW
 *   bookings    Shipment Booking    CUSTOMER_SERVICE.CARGO_BOOKING.VIEW
 *   invoicing   Debit Invoice       ACCOUNTS.DEBIT_INVOICE.VIEW
 *               (cost only with     ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE)
 *   balances    Receivable-Payable  ACCOUNTS.RECEIVABLE_PAYABLE.VIEW
 *
 * A section the user may not see is null, not empty — "no access" and
 * "nothing happened" must not look alike.
 */

/**
 * The period filter: four presets, or a custom range. A preset is resolved on
 * the server, in the workspace's own time zone, so "today" is the office's
 * today and not the browser's.
 *
 *   today    today                          compared with yesterday
 *   month    the 1st of this month to today the same days last month
 *   6months  the last 6 calendar months     the 6 months before, to the same day
 *   year     1 January to today             the same dates last year
 *   custom   from–to, both days included    the same number of days just before
 */
export const OVERVIEW_PRESETS = ['today', 'month', '6months', 'year'] as const;
export type OverviewPreset = (typeof OVERVIEW_PRESETS)[number];
export type OverviewPeriod = OverviewPreset | 'custom';

export const OVERVIEW_PERIOD_LABEL: Record<OverviewPeriod, string> = {
  today: 'Today',
  month: 'This month',
  '6months': 'Last 6 months',
  year: 'This year',
  custom: 'Custom range',
};

/** A custom range covers at most three years — 36 monthly columns. */
export const OVERVIEW_MAX_RANGE_DAYS = 1096;

/** A range up to this many days is counted day by day; anything longer, month by month. */
export const OVERVIEW_DAILY_MAX_DAYS = 62;

const overviewDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');

/** Whole days from one YYYY-MM-DD to another, both included. */
export function overviewRangeDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export const overviewQuerySchema = z
  .object({
    period: z.enum([...OVERVIEW_PRESETS, 'custom']).default('6months'),
    from: overviewDate.optional(),
    to: overviewDate.optional(),
  })
  .superRefine((q, ctx) => {
    if (q.period !== 'custom') return;
    if (q.from === undefined) ctx.addIssue({ code: 'custom', path: ['from'], message: 'Choose the first day of the range.' });
    if (q.to === undefined) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Choose the last day of the range.' });
    if (q.from === undefined || q.to === undefined) return;
    const days = overviewRangeDays(q.from, q.to);
    if (days < 1) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The last day must be on or after the first.' });
    else if (days > OVERVIEW_MAX_RANGE_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Choose a range of three years or less.' });
    }
  });
export type OverviewQuery = z.input<typeof overviewQuerySchema>;

/** Columns are days (YYYY-MM-DD) or months (YYYY-MM), by the range's length. */
export type OverviewBucket = 'day' | 'month';

export interface OverviewRangeDto {
  period: OverviewPeriod;
  /** YYYY-MM-DD, both days included. */
  from: string;
  to: string;
  /** The comparison period, same shape. */
  previousFrom: string;
  previousTo: string;
  bucket: OverviewBucket;
}

/** The permissions behind each section — the API guard and the page read the same list. */
export const OVERVIEW_SECTION_PERMISSIONS = {
  sales: 'SALES.INQUIRY.VIEW',
  bookings: 'CUSTOMER_SERVICE.CARGO_BOOKING.VIEW',
  invoicing: 'ACCOUNTS.DEBIT_INVOICE.VIEW',
  balances: 'ACCOUNTS.RECEIVABLE_PAYABLE.VIEW',
} as const;

/** One column's count — a day or a month — split the way every list splits shipments. */
export type OverviewModeCounts = { bucket: string } & Record<ShipmentType, number>;

/**
 * An inquiry's status as the Live Inquiry list shows it: OPEN past its
 * valid-to date reads "Lapsed" there (inquiry §4 rule 11), so it does here.
 */
export type OverviewInquiryStatus = InquiryStatus | 'LAPSED';

export const OVERVIEW_INQUIRY_STATUS_ORDER: readonly OverviewInquiryStatus[] = [
  'OPEN',
  'LAPSED',
  'RFQ_SENT',
  'PRICED',
  'QUOTED',
  'WON',
  'LOST',
  'EXPIRED',
  'CANCELLED',
];

export interface OverviewSalesDto {
  /** Inquiries dated in each day or month of the range, oldest first. */
  byBucket: OverviewModeCounts[];
  /** Inquiries dated in the range, and in the comparison period. */
  total: number;
  previousTotal: number;
  /** Inquiries dated in the range, by status; zero counts left out. */
  byStatus: { status: OverviewInquiryStatus; count: number }[];
  /** WON ÷ (WON + LOST) over the range, 0–1; null when nothing was decided. */
  winRate: number | null;
}

export interface OverviewRankedDto {
  id: string;
  name: string;
  /** A second line — a port's country. */
  detail?: string;
  count: number;
}

export interface OverviewBookingsDto {
  /** Bookings opened in each day or month of the range, cancelled ones left out. */
  byBucket: OverviewModeCounts[];
  /** Bookings opened in the range, and in the comparison period, cancelled ones left out. */
  total: number;
  previousTotal: number;
  /** Bookings opened in the range, by status, in the booking's own order. */
  byStatus: { status: ShipmentStatus; count: number }[];
  /** The five customers with the most bookings in the range. */
  topCustomers: OverviewRankedDto[];
  /** The five ports of discharge with the most bookings in the range. */
  topDestinations: OverviewRankedDto[];
}

export interface OverviewInvoicingDto {
  /** The workspace's base currency code, which every amount here is in. */
  currency: string;
  /**
   * ISSUED debit invoices by invoice day or month, in base — the Business
   * Matrix's "Total Revenue". `cost` is null for a user without VIEW_BUY_PRICE.
   */
  byBucket: { bucket: string; revenue: string; cost: string | null }[];
  /** Invoiced in the range, and in the comparison period. */
  total: string;
  previousTotal: string;
}

/** Balances are as of now, whatever range is chosen: they are running totals, not events. */
export interface OverviewBalancesDto {
  currency: string;
  /** The Receivable-Payable list's "Total =" row, in base. */
  receivable: string;
  unbilled: string;
  payable: string;
}

export interface OverviewDto {
  range: OverviewRangeDto;
  /** The range's columns, oldest first: YYYY-MM-DD by day, YYYY-MM by month. */
  buckets: string[];
  sales: OverviewSalesDto | null;
  bookings: OverviewBookingsDto | null;
  invoicing: OverviewInvoicingDto | null;
  balances: OverviewBalancesDto | null;
}
