import { z } from 'zod';

/**
 * The Employee Performance Report — client wireframe, 2026-09-07.
 *
 * Clicking an employee's name opens what they have done over a period: how
 * many customers, inquiries, shipments and leads they handled, and what that
 * was worth. Every figure is clickable and opens the rows behind it, because a
 * count nobody can check is a number people argue about.
 *
 * Two kinds of metric live here, and the difference is not cosmetic. Six are
 * counts of work, computable from tables that exist. Three are money —
 * revenue, gross profit, and the incentive that is a percentage of it — and the
 * client's own note says where they come from: "Total Revenue will calculate
 * the sum of each booking debit note value" and "Total Gross profit Generation
 * will calculate the sum of invoice margin (selling - buying)". There is no
 * debit note table and no invoice table; the Accounts module has not been
 * built. Those three are declared here and reported as pending rather than
 * quietly dropped, so the report shows its own shape and nobody wonders
 * whether the number is zero or missing.
 */

// ------------------------------------------------------------------ periods

/**
 * The ranges the client asked for: "monthly weekly, 3 month, 6 month, 1 year
 * etc", plus any two dates.
 *
 * Presets rather than free dates alone because the question is almost always
 * "this month" or "this quarter", and making somebody pick two dates to ask it
 * is friction on the common case. CUSTOM is the escape hatch.
 */
export const REPORT_PERIODS = [
  'THIS_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'LAST_3_MONTHS',
  'LAST_6_MONTHS',
  'LAST_12_MONTHS',
  'THIS_YEAR',
  'CUSTOM',
] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_PERIOD_LABEL: Record<ReportPeriod, string> = {
  THIS_WEEK: 'This week',
  THIS_MONTH: 'This month',
  LAST_MONTH: 'Last month',
  LAST_3_MONTHS: 'Last 3 months',
  LAST_6_MONTHS: 'Last 6 months',
  LAST_12_MONTHS: 'Last 12 months',
  THIS_YEAR: 'This year',
  CUSTOM: 'Custom dates',
};

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');

export const performanceQuerySchema = z
  .object({
    period: z.enum(REPORT_PERIODS).default('THIS_MONTH'),
    /** Only read when period is CUSTOM. Inclusive of both days. */
    from: isoDay.optional(),
    to: isoDay.optional(),
  })
  .refine((v) => v.period !== 'CUSTOM' || (v.from !== undefined && v.to !== undefined), {
    message: 'Choose both dates, or pick a period.',
    path: ['from'],
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'The end date cannot be before the start date.',
    path: ['to'],
  });

export type PerformanceQuery = z.infer<typeof performanceQuerySchema>;

/**
 * A preset resolved to two days, inclusive.
 *
 * Here rather than on the server so the screen can show the dates a preset
 * means before asking for it — "Last 3 months" is a promise about a range, and
 * an operator comparing two reports needs to know which one.
 *
 * Weeks start Monday: Bangladesh's working week runs Sunday to Thursday, but a
 * report period is a calendar convention rather than a roster, and ISO is what
 * every other date in the product follows.
 */
export function resolvePeriod(
  period: ReportPeriod,
  today: Date,
  custom?: { from?: string; to?: string },
): { from: string; to: string } {
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  // Work in UTC throughout: the stored dates are UTC (§9) and drifting by a
  // timezone would move a shipment between two months.
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);

  switch (period) {
    case 'CUSTOM':
      return { from: custom?.from ?? day(end), to: custom?.to ?? day(end) };
    case 'THIS_WEEK': {
      // getUTCDay: 0 is Sunday, so Monday is 1 and Sunday walks back 6 days.
      const weekday = (end.getUTCDay() + 6) % 7;
      start.setUTCDate(end.getUTCDate() - weekday);
      return { from: day(start), to: day(end) };
    }
    case 'THIS_MONTH':
      return { from: day(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))), to: day(end) };
    case 'LAST_MONTH': {
      const first = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
      // Day 0 of this month is the last day of the previous one.
      const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0));
      return { from: day(first), to: day(last) };
    }
    case 'LAST_3_MONTHS':
      start.setUTCMonth(end.getUTCMonth() - 3);
      return { from: day(start), to: day(end) };
    case 'LAST_6_MONTHS':
      start.setUTCMonth(end.getUTCMonth() - 6);
      return { from: day(start), to: day(end) };
    case 'LAST_12_MONTHS':
      start.setUTCFullYear(end.getUTCFullYear() - 1);
      return { from: day(start), to: day(end) };
    case 'THIS_YEAR':
      return { from: day(new Date(Date.UTC(end.getUTCFullYear(), 0, 1))), to: day(end) };
  }
}

// ------------------------------------------------------------------ metrics

/**
 * The nine figures on the wireframe, in its own order and wording.
 *
 * `drillable` says whether clicking it opens the rows behind it. The client's
 * note — "Each report will show the details list" — asks for all nine; the
 * money three have no rows to show until Accounts exists.
 */
export const PERFORMANCE_METRICS = [
  { key: 'CUSTOMERS', label: 'Customer Handle', kind: 'COUNT', drillable: true },
  { key: 'INQUIRIES', label: 'Inquiry Handle', kind: 'COUNT', drillable: true },
  { key: 'COMMODITY_CATEGORIES', label: 'Commodity Category Handle', kind: 'COUNT', drillable: true },
  { key: 'AIR_SHIPMENTS', label: 'Air Shipment Handle', kind: 'COUNT', drillable: true },
  { key: 'SEA_SHIPMENTS', label: 'Sea Shipment Handle', kind: 'COUNT', drillable: true },
  { key: 'SALES_LEADS', label: 'Sales Lead Generation', kind: 'COUNT', drillable: true },
  { key: 'REVENUE', label: 'Total Revenue Generation', kind: 'MONEY', drillable: false },
  { key: 'GROSS_PROFIT', label: 'Total Gross Profit Generation', kind: 'MONEY', drillable: false },
  { key: 'INCENTIVE', label: 'Incentive accumulation', kind: 'MONEY', drillable: false },
] as const satisfies readonly {
  key: string;
  label: string;
  kind: 'COUNT' | 'MONEY';
  drillable: boolean;
}[];

export type PerformanceMetricKey = (typeof PERFORMANCE_METRICS)[number]['key'];

/** The six a drill-down exists for. */
export const DRILLABLE_METRICS = PERFORMANCE_METRICS.filter((m) => m.drillable).map((m) => m.key);

export function isDrillableMetric(value: string): value is PerformanceMetricKey {
  return (DRILLABLE_METRICS as readonly string[]).includes(value);
}

export interface PerformanceMetricDto {
  key: PerformanceMetricKey;
  label: string;
  kind: 'COUNT' | 'MONEY';
  /** The figure, or null when it cannot be computed yet. */
  value: number | null;
  drillable: boolean;
  /**
   * Why there is no figure. Null when there is one — so a screen never has to
   * guess whether zero means "none" or "not built".
   */
  pendingReason: string | null;
}

export interface EmployeePerformanceDto {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  /** Null when they are not on the incentive scheme. */
  incentivePercentage: string | null;
  period: ReportPeriod;
  from: string;
  to: string;
  metrics: PerformanceMetricDto[];
}

/** One row of a drill-down. Deliberately flat: six lists, one shape. */
export interface PerformanceDetailRow {
  id: string;
  /** The business code, or the closest thing this record has to one. */
  code: string;
  title: string;
  /** Whatever the row is best identified by after its name. */
  subtitle: string | null;
  date: string | null;
  /** Where the row lives, so the screen can link to it. */
  href: string | null;
}
