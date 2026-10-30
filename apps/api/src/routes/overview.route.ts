import { Router } from 'express';

import {
  type ApiSuccess,
  isoCurrency,
  OVERVIEW_DAILY_MAX_DAYS,
  OVERVIEW_INQUIRY_STATUS_ORDER,
  OVERVIEW_SECTION_PERMISSIONS,
  type OverviewBalancesDto,
  type OverviewBookingsDto,
  type OverviewDto,
  type OverviewInquiryStatus,
  type OverviewInvoicingDto,
  type OverviewModeCounts,
  overviewQuerySchema,
  overviewRangeDays,
  type OverviewRangeDto,
  type OverviewRankedDto,
  type OverviewSalesDto,
  SHIPMENT_STATUSES,
  type ShipmentStatus,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { baseCurrency } from '../lib/currency-rate';
import { workspaceZone } from '../lib/milestone';
import { partyBalances, totalsOf } from '../lib/receivable-payable';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate, type AuthContext } from '../middleware/authenticate';
import { requireAnyPermission } from '../middleware/require-permission';

/**
 * Overview — the business at a glance (packages/shared/src/overview.ts).
 *
 * One endpoint, four sections, each computed only for a user who may open
 * the screen whose figure it repeats, and each counted exactly the way that
 * screen counts it. The route is open to anyone holding at least one of the
 * four; a section the user may not see comes back null.
 *
 * tenant_id is named on every table in the raw queries even though RLS
 * filters them too: the application is the first line (CLAUDE.md §7A rule 2),
 * and a raw query has no Prisma extension to add it.
 */

export const overviewRouter: Router = Router();
overviewRouter.use(authenticate);

const BUY_PRICE = 'ACCOUNTS.DEBIT_INVOICE.VIEW_BUY_PRICE';

const holds = (auth: AuthContext, key: string): boolean => auth.isSuperadmin || auth.permissions.has(key);

// ---------------------------------------------------------------------------
// Calendar arithmetic on YYYY-MM-DD strings. These are calendar days in the
// workspace's zone, never instants; UTC midnight is only a carrier.
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);
const asDay = (date: Date) => date.toISOString().slice(0, 10);

function addDays(day: string, n: number): string {
  return asDay(new Date(asDate(day).getTime() + n * 86_400_000));
}

/** The same day n months away, clipped to the month's end (31 Mar − 1 month = 28 or 29 Feb). */
function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad(month + 1)}-${pad(Math.min(d, last))}`;
}

/** Today's calendar date in the workspace's zone. */
function todayIn(now: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The range a request asks for, and the one it is compared with. */
function resolveRange(query: ReturnType<typeof overviewQuerySchema.parse>, today: string): OverviewRangeDto {
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  let from: string;
  let to = today;
  let previousFrom: string;
  let previousTo: string;

  switch (query.period) {
    case 'today':
      from = today;
      previousFrom = addDays(today, -1);
      previousTo = previousFrom;
      break;
    case 'month':
      from = firstOfMonth;
      previousFrom = addMonths(from, -1);
      previousTo = addMonths(to, -1);
      break;
    case '6months':
      from = addMonths(firstOfMonth, -5);
      previousFrom = addMonths(from, -6);
      previousTo = addMonths(to, -6);
      break;
    case 'year':
      from = `${today.slice(0, 4)}-01-01`;
      previousFrom = addMonths(from, -12);
      previousTo = addMonths(to, -12);
      break;
    case 'custom': {
      // The schema has already required both days and checked their order.
      from = query.from ?? today;
      to = query.to ?? today;
      const days = overviewRangeDays(from, to);
      previousFrom = addDays(from, -days);
      previousTo = addDays(from, -1);
      break;
    }
  }

  return {
    period: query.period,
    from,
    to,
    previousFrom,
    previousTo,
    bucket: overviewRangeDays(from, to) <= OVERVIEW_DAILY_MAX_DAYS ? 'day' : 'month',
  };
}

/** Every column the range spans, oldest first — so a quiet day or month still shows, at zero. */
function bucketsOf(range: OverviewRangeDto): string[] {
  const out: string[] = [];
  if (range.bucket === 'day') {
    for (let day = range.from; day <= range.to; day = addDays(day, 1)) out.push(day);
  } else {
    const last = range.to.slice(0, 7);
    for (let day = `${range.from.slice(0, 7)}-01`; day.slice(0, 7) <= last; day = addMonths(day, 1)) {
      out.push(day.slice(0, 7));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

interface Window {
  tenantId: bigint;
  range: OverviewRangeDto;
  buckets: string[];
  /** The to_char pattern for the range's columns. */
  pattern: string;
}

const between = (column: Prisma.Sql, from: string, to: string) =>
  Prisma.sql`${column} BETWEEN ${from}::date AND ${to}::date`;

function byMode(buckets: string[], rows: { bucket: string; type: string; n: number }[]): OverviewModeCounts[] {
  return buckets.map((bucket) => {
    const of = (type: string) => rows.find((r) => r.bucket === bucket && r.type === type)?.n ?? 0;
    return { bucket, SEA: of('SEA'), AIR: of('AIR') };
  });
}

async function salesSection(db: TenantDb, w: Window, today: string): Promise<OverviewSalesDto> {
  const scope = Prisma.sql`i.tenant_id = ${w.tenantId} AND i.deleted_at IS NULL`;
  const dated = Prisma.sql`i.inquiry_date`;

  const [columns, statuses, previous] = await Promise.all([
    db.$queryRaw<{ bucket: string; type: string; n: number }[]>`
      SELECT to_char(${dated}, ${w.pattern}) AS bucket, i.shipment_type::text AS type, COUNT(*)::int AS n
        FROM inquiry i
       WHERE ${scope} AND ${between(dated, w.range.from, w.range.to)}
       GROUP BY 1, 2`,
    // OPEN past its valid-to reads "Lapsed" on the Live Inquiry list; so here.
    db.$queryRaw<{ status: string; n: number }[]>`
      SELECT CASE WHEN i.status = 'OPEN' AND i.valid_to IS NOT NULL AND i.valid_to < ${today}::date
                  THEN 'LAPSED' ELSE i.status::text END AS status,
             COUNT(*)::int AS n
        FROM inquiry i
       WHERE ${scope} AND ${between(dated, w.range.from, w.range.to)}
       GROUP BY 1`,
    db.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
        FROM inquiry i
       WHERE ${scope} AND ${between(dated, w.range.previousFrom, w.range.previousTo)}`,
  ]);

  const count = (status: OverviewInquiryStatus) => statuses.find((s) => s.status === status)?.n ?? 0;
  const won = count('WON');
  const lost = count('LOST');
  return {
    byBucket: byMode(w.buckets, columns),
    total: columns.reduce((n, r) => n + r.n, 0),
    previousTotal: previous[0]?.n ?? 0,
    byStatus: OVERVIEW_INQUIRY_STATUS_ORDER.map((status) => ({ status, count: count(status) })).filter((s) => s.count > 0),
    winRate: won + lost === 0 ? null : won / (won + lost),
  };
}

async function bookingsSection(db: TenantDb, w: Window, zone: string): Promise<OverviewBookingsDto> {
  // A booking belongs to the day it was opened, in the workspace's own zone.
  const openedOn = Prisma.sql`(s.created_at AT TIME ZONE ${zone})::date`;
  const scope = Prisma.sql`s.tenant_id = ${w.tenantId} AND s.deleted_at IS NULL`;
  const inRange = Prisma.sql`${scope} AND ${between(openedOn, w.range.from, w.range.to)}`;

  const [columns, previous, statuses, customers, destinations] = await Promise.all([
    db.$queryRaw<{ bucket: string; type: string; n: number }[]>`
      SELECT to_char(${openedOn}, ${w.pattern}) AS bucket, s.shipment_type::text AS type, COUNT(*)::int AS n
        FROM shipment s
       WHERE ${inRange} AND s.status <> 'CANCELLED'
       GROUP BY 1, 2`,
    db.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
        FROM shipment s
       WHERE ${scope} AND ${between(openedOn, w.range.previousFrom, w.range.previousTo)}
         AND s.status <> 'CANCELLED'`,
    db.$queryRaw<{ status: string; n: number }[]>`
      SELECT s.status::text AS status, COUNT(*)::int AS n
        FROM shipment s
       WHERE ${inRange}
       GROUP BY 1`,
    db.$queryRaw<{ id: bigint; name: string; n: number }[]>`
      SELECT c.id, c.name, COUNT(*)::int AS n
        FROM shipment s
        JOIN customer c ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
       WHERE ${inRange} AND s.status <> 'CANCELLED'
       GROUP BY c.id, c.name
       ORDER BY n DESC, c.name
       LIMIT 5`,
    // Ports may be shared rows (tenant_id NULL, §7A rule 7), so the port join
    // is on id alone; the shipment side is already scoped to this tenant.
    db.$queryRaw<{ id: bigint; name: string; country: string; n: number }[]>`
      SELECT p.id, p.name, p.country, COUNT(*)::int AS n
        FROM shipment s
        JOIN port p ON p.id = s.pod_id
       WHERE ${inRange} AND s.status <> 'CANCELLED'
       GROUP BY p.id, p.name, p.country
       ORDER BY n DESC, p.name
       LIMIT 5`,
  ]);

  const ranked = (rows: { id: bigint; name: string; country?: string; n: number }[]): OverviewRankedDto[] =>
    rows.map((r) => ({
      id: r.id.toString(),
      name: r.name,
      ...(r.country === undefined ? {} : { detail: r.country }),
      count: r.n,
    }));

  return {
    byBucket: byMode(w.buckets, columns),
    total: columns.reduce((n, r) => n + r.n, 0),
    previousTotal: previous[0]?.n ?? 0,
    byStatus: SHIPMENT_STATUSES.map((status: ShipmentStatus) => ({
      status,
      count: statuses.find((s) => s.status === status)?.n ?? 0,
    })).filter((s) => s.count > 0),
    topCustomers: ranked(customers),
    topDestinations: ranked(destinations),
  };
}

async function invoicingSection(
  db: TenantDb,
  w: Window,
  showCost: boolean,
  currency: string,
): Promise<OverviewInvoicingDto> {
  // ISSUED only, in base — the Business Matrix's "Total Revenue". A draft is
  // not yet a bill, and a cancelled one never was.
  const scope = Prisma.sql`d.tenant_id = ${w.tenantId} AND d.deleted_at IS NULL AND d.status = 'ISSUED'`;
  const dated = Prisma.sql`d.invoice_date`;

  const [columns, totals] = await Promise.all([
    db.$queryRaw<{ bucket: string; revenue: Prisma.Decimal; cost: Prisma.Decimal }[]>`
      SELECT to_char(${dated}, ${w.pattern}) AS bucket,
             COALESCE(SUM(d.total_amount_base), 0) AS revenue,
             COALESCE(SUM(d.cost_total_base), 0) AS cost
        FROM debit_invoice d
       WHERE ${scope} AND ${between(dated, w.range.from, w.range.to)}
       GROUP BY 1`,
    db.$queryRaw<{ current: Prisma.Decimal; previous: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(d.total_amount_base) FILTER (WHERE ${between(dated, w.range.from, w.range.to)}), 0) AS current,
             COALESCE(SUM(d.total_amount_base) FILTER (WHERE ${between(dated, w.range.previousFrom, w.range.previousTo)}), 0) AS previous
        FROM debit_invoice d
       WHERE ${scope}`,
  ]);

  const zero = new Prisma.Decimal(0);
  return {
    currency,
    byBucket: w.buckets.map((bucket) => {
      const row = columns.find((r) => r.bucket === bucket);
      return {
        bucket,
        revenue: (row?.revenue ?? zero).toFixed(2),
        // The buying side is VIEW_BUY_PRICE's to show, exactly as on the invoice.
        cost: showCost ? (row?.cost ?? zero).toFixed(2) : null,
      };
    }),
    total: (totals[0]?.current ?? zero).toFixed(2),
    previousTotal: (totals[0]?.previous ?? zero).toFixed(2),
  };
}

async function balancesSection(db: TenantDb, tenantId: bigint): Promise<OverviewBalancesDto> {
  const base = await baseCurrency(db, tenantId);
  const totals = totalsOf([...(await partyBalances(db, tenantId, base)).values()]);
  return {
    currency: base === null ? '' : isoCurrency(base.currency),
    receivable: totals.receivableBase,
    unbilled: totals.unbilledBase,
    payable: totals.payableBase,
  };
}

overviewRouter.get(
  '/',
  requireAnyPermission(...Object.values(OVERVIEW_SECTION_PERMISSIONS)),
  async (req, res) => {
    const auth = req.auth!;
    const query = overviewQuerySchema.parse(req.query);
    const may = {
      sales: holds(auth, OVERVIEW_SECTION_PERMISSIONS.sales),
      bookings: holds(auth, OVERVIEW_SECTION_PERMISSIONS.bookings),
      invoicing: holds(auth, OVERVIEW_SECTION_PERMISSIONS.invoicing),
      balances: holds(auth, OVERVIEW_SECTION_PERMISSIONS.balances),
    };

    const data = await withTenant(auth.tenantId, async (db): Promise<OverviewDto> => {
      const zone = await workspaceZone(db, auth.tenantId);
      const today = todayIn(new Date(), zone);
      const range = resolveRange(query, today);
      const window: Window = {
        tenantId: auth.tenantId,
        range,
        buckets: bucketsOf(range),
        pattern: range.bucket === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM',
      };
      const base = may.invoicing ? await baseCurrency(db, auth.tenantId) : null;
      const currency = base === null ? '' : isoCurrency(base.currency);

      const [sales, bookings, invoicing, balances] = await Promise.all([
        may.sales ? salesSection(db, window, today) : null,
        may.bookings ? bookingsSection(db, window, zone) : null,
        may.invoicing ? invoicingSection(db, window, holds(auth, BUY_PRICE), currency) : null,
        may.balances ? balancesSection(db, auth.tenantId) : null,
      ]);
      return { range, buckets: window.buckets, sales, bookings, invoicing, balances };
    });

    const payload: ApiSuccess<OverviewDto> = { success: true, data };
    res.json(payload);
  },
);
