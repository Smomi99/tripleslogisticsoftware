import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  BUSINESS_MATRIX_DETAIL_LIMIT,
  BUSINESS_MATRIX_RATE_PERMISSION,
  type BusinessMatrixDetailDto,
  businessMatrixDetailPermissions,
  businessMatrixDetailQuerySchema,
  type BusinessMatrixFigure,
  businessMatrixQuerySchema,
  businessMatrixRateModes,
  type BusinessMatrixRowDto,
  CODE_PREFIX,
  type InquiryStatus,
  isoCurrency,
  type MatrixInquiryRow,
  type MatrixInvoiceRow,
  type MatrixLoadPlanRow,
  type MatrixQuotationRow,
  type MatrixRateRow,
  type QuotationStatus,
  type RateMode,
  TRADE_LANE_DIRECTION_LABEL,
  type TradeLaneDirection,
  type TradeLaneDto,
  type TradeLaneOptionsDto,
  type TradeLanePortDto,
  tradeLaneSaveSchema,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { CODE_RETRY_LIMIT, inSavepoint, isUniqueViolation, nextCode } from '../lib/codes';
import { baseCurrency } from '../lib/currency-rate';
import { HttpError } from '../lib/http-error';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { workspaceZone } from '../lib/milestone';
import { parseId } from '../lib/request';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate, type AuthContext } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';

/**
 * Sales & Marketing → Business Matrix (docs/DESIGN-UPDATE-2026-10-28.md §1).
 *
 * A trade lane is one port on one side and many on the other: one POL to many
 * PODs outbound, many POLs to one POD inbound. Its table has a row per port
 * pair, and every figure on it is counted when the lane is read:
 *
 *   Live Rate           purchase rates live today on that POL → POD
 *   Inquiry Received    inquiries of the lane's direction on that POL → POD
 *   No of Quotation     quotations likewise, past DRAFT, one per number
 *                       however many revisions it went through
 *   Shipment Volume     FINAL load plans holding a booking on that
 *                       POL → POD, at the container size's TEU factor, a
 *                       container counted once
 *   Total Revenue       ISSUED debit invoices of those bookings, in base
 *
 * Each record is matched on its own ports and dated by its own date (§6 Q1).
 */

export const businessMatrixRouter: Router = Router();
businessMatrixRouter.use(authenticate);

const FEATURE = 'SALES.BUSINESS_MATRIX';

const PORT_SELECT = { id: true, name: true, portCode: true, country: true, type: true } as const;

const LANE_SELECT = {
  id: true,
  code: true,
  name: true,
  movementType: true,
  isActive: true,
  port: { select: PORT_SELECT },
  ports: {
    where: { deletedAt: null },
    // Written 0, 1, 2… on every save, so the order is unique within a lane.
    orderBy: { sortOrder: 'asc' },
    select: { port: { select: PORT_SELECT } },
  },
} as const;

type LaneRecord = Prisma.TradeLaneGetPayload<{ select: typeof LANE_SELECT }>;
type PortRecord = LaneRecord['port'];

function portDto(p: PortRecord): TradeLanePortDto {
  return { id: p.id.toString(), name: p.name, portCode: p.portCode, country: p.country };
}

/** The lane's port pairs, POL first, in the order its table reads. */
function pairsOf(lane: LaneRecord): { pol: PortRecord; pod: PortRecord }[] {
  return lane.ports.map(({ port }) =>
    lane.movementType === 'INBOUND' ? { pol: port, pod: lane.port } : { pol: lane.port, pod: port },
  );
}

interface Period {
  from?: string | undefined;
  to?: string | undefined;
}

function within(column: Prisma.Sql, period: Period): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (period.from !== undefined) parts.push(Prisma.sql`${column} >= ${period.from}::date`);
  if (period.to !== undefined) parts.push(Prisma.sql`${column} <= ${period.to}::date`);
  return parts.length === 0 ? Prisma.empty : Prisma.sql`AND ${Prisma.join(parts, ' AND ')}`;
}

// ---------------------------------------------------------------------------
// What each figure counts, written once.
//
// The matrix counts with these and a cell's popup lists with them, so the
// number on the screen and the records behind it cannot disagree. Each one is
// a WHERE condition over a fixed alias; the pair it matches is SQL, a column
// of the matrix's VALUES list or a bound parameter for one popup.
//
// tenant_id is named on every table even though RLS filters them too: the
// application is the first line (CLAUDE.md §7A rule 2), and a raw query has
// no Prisma extension to add it.
// ---------------------------------------------------------------------------

interface PairRef {
  pol: Prisma.Sql;
  pod: Prisma.Sql;
  direction: Prisma.Sql;
  isAir: Prisma.Sql;
}

/** Inquiry Received — inquiries of the lane's direction on that POL → POD. Alias i. */
function inquiryMatch(tenantId: bigint, p: PairRef, period: Period): Prisma.Sql {
  return Prisma.sql`i.tenant_id = ${tenantId} AND i.deleted_at IS NULL
    AND i.movement_type = ${p.direction} AND i.pol_id = ${p.pol} AND i.pod_id = ${p.pod}
    ${within(Prisma.sql`i.inquiry_date`, period)}`;
}

/** No of Quotation — past DRAFT, counted once per number (COUNT DISTINCT q.code). Alias q. */
function quotationMatch(tenantId: bigint, p: PairRef, period: Period): Prisma.Sql {
  return Prisma.sql`q.tenant_id = ${tenantId} AND q.deleted_at IS NULL AND q.status <> 'DRAFT'
    AND q.movement_type = ${p.direction} AND q.pol_id = ${p.pol} AND q.pod_id = ${p.pod}
    -- A cancelled number was withdrawn (2026-10-29): the inquiry's new
    -- quotation is the one that counts, not both.
    AND NOT EXISTS (SELECT 1 FROM quotation qc
                     WHERE qc.tenant_id = q.tenant_id AND qc.code = q.code
                       AND qc.deleted_at IS NULL AND qc.status = 'CANCELLED')
    ${within(Prisma.sql`q.quotation_date`, period)}`;
}

/** The bookings on the pair inside load plan k — clp_booking is what is in the box (CR-002 §2). */
const BOOKINGS_IN_BOX = Prisma.sql`clp_booking cb
  JOIN shipment s   ON s.tenant_id = cb.tenant_id AND s.id = cb.shipment_id
  JOIN quotation sq ON sq.tenant_id = s.tenant_id AND sq.id = s.quotation_id`;

function bookingOnPair(p: PairRef): Prisma.Sql {
  return Prisma.sql`cb.tenant_id = k.tenant_id AND cb.clp_id = k.id AND cb.deleted_at IS NULL
    AND s.deleted_at IS NULL
    AND sq.movement_type = ${p.direction} AND s.pol_id = ${p.pol} AND s.pod_id = ${p.pod}`;
}

/** The day a load plan is counted on: loaded, or finalised when no load time was kept. */
const loadedOn = (zone: string) => Prisma.sql`(COALESCE(k.load_datetime, k.finalised_at) AT TIME ZONE ${zone})::date`;

/** Shipment Volume — FINAL load plans holding a booking on the pair, a container once. Alias k. */
function loadPlanMatch(tenantId: bigint, p: PairRef, period: Period, zone: string): Prisma.Sql {
  return Prisma.sql`k.tenant_id = ${tenantId} AND k.deleted_at IS NULL AND k.status = 'FINAL'
    ${within(loadedOn(zone), period)}
    AND EXISTS (SELECT 1 FROM ${BOOKINGS_IN_BOX} WHERE ${bookingOnPair(p)})`;
}

/** Total Revenue reads an invoice through its booking and the booking's quotation. */
const INVOICES = Prisma.sql`debit_invoice d
  JOIN shipment s   ON s.tenant_id = d.tenant_id AND s.id = d.shipment_id
  JOIN quotation sq ON sq.tenant_id = s.tenant_id AND sq.id = s.quotation_id`;

/** Total Revenue — ISSUED debit invoices of bookings on the pair. Over INVOICES. */
function invoiceMatch(tenantId: bigint, p: PairRef, period: Period): Prisma.Sql {
  return Prisma.sql`d.tenant_id = ${tenantId} AND d.deleted_at IS NULL AND d.status = 'ISSUED'
    AND s.deleted_at IS NULL
    AND sq.movement_type = ${p.direction} AND s.pol_id = ${p.pol} AND s.pod_id = ${p.pod}
    ${within(Prisma.sql`d.invoice_date`, period)}`;
}

/**
 * Live Rate (client, 2026-11-01) — the purchase rates live on the pair today,
 * by the rule of the Live Inquiry's lane check (liveRatesForLane): PUBLISHED,
 * today within validity, the sea modes on a sea lane and air on an air lane.
 * Freight rates carry no direction; POL → POD already says which way.
 * Alias r.
 */
function liveRateMatch(tenantId: bigint, p: PairRef, today: string): Prisma.Sql {
  return Prisma.sql`r.tenant_id = ${tenantId} AND r.deleted_at IS NULL AND r.status = 'PUBLISHED'
    AND r.pol_id = ${p.pol} AND r.pod_id = ${p.pod}
    AND (r.mode = 'AIR') = ${p.isAir}
    AND r.valid_from <= ${today}::date AND r.valid_to >= ${today}::date`;
}

/**
 * "Today" for a rate is the UTC calendar day, as on the Price List and the
 * lane check — a rate shown live there is live here.
 */
const rateToday = (): string => new Date().toISOString().slice(0, 10);

/** Today's calendar date in the workspace's zone, for an inquiry's validity. */
const todayIn = (zone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

interface PairFigures {
  liveRates: number;
  inquiries: number;
  quotations: number;
  teus: Prisma.Decimal;
  revenue: Prisma.Decimal;
}

const pairKey = (pol: bigint, pod: bigint, direction: string) => `${direction}:${pol}:${pod}`;

/** The five figures for every pair on the page, in one statement. */
async function figuresFor(
  db: TenantDb,
  tenantId: bigint,
  pairs: { pol: bigint; pod: bigint; direction: TradeLaneDirection; isAir: boolean }[],
  period: Period,
): Promise<Map<string, PairFigures>> {
  const out = new Map<string, PairFigures>();
  if (pairs.length === 0) return out;
  const zone = await workspaceZone(db, tenantId);
  const values = Prisma.join(
    pairs.map((p) => Prisma.sql`(${p.pol}::bigint, ${p.pod}::bigint, ${p.direction}::movement_type, ${p.isAir}::boolean)`),
  );
  const ref: PairRef = {
    pol: Prisma.sql`p.pol_id`,
    pod: Prisma.sql`p.pod_id`,
    direction: Prisma.sql`p.direction`,
    isAir: Prisma.sql`p.is_air`,
  };

  const rows = await db.$queryRaw<
    {
      pol_id: bigint;
      pod_id: bigint;
      direction: string;
      live_rates: bigint;
      inquiries: bigint;
      quotations: bigint;
      teus: Prisma.Decimal;
      revenue: Prisma.Decimal;
    }[]
  >`
    WITH pair(pol_id, pod_id, direction, is_air) AS (VALUES ${values})
    SELECT p.pol_id, p.pod_id, p.direction::text AS direction,
           (SELECT COUNT(*) FROM freight_rate r WHERE ${liveRateMatch(tenantId, ref, rateToday())}) AS live_rates,
           (SELECT COUNT(*) FROM inquiry i WHERE ${inquiryMatch(tenantId, ref, period)}) AS inquiries,
           (SELECT COUNT(DISTINCT q.code) FROM quotation q WHERE ${quotationMatch(tenantId, ref, period)}) AS quotations,
           (SELECT COALESCE(SUM(cs.teu_factor), 0)
              FROM clp k
              JOIN container_size cs ON cs.id = k.container_size_id
             WHERE ${loadPlanMatch(tenantId, ref, period, zone)}) AS teus,
           (SELECT COALESCE(SUM(d.total_amount_base), 0) FROM ${INVOICES} WHERE ${invoiceMatch(tenantId, ref, period)}) AS revenue
      FROM pair p
  `;
  for (const r of rows) {
    out.set(pairKey(r.pol_id, r.pod_id, r.direction), {
      liveRates: Number(r.live_rates),
      inquiries: Number(r.inquiries),
      quotations: Number(r.quotations),
      teus: new Prisma.Decimal(r.teus),
      revenue: new Prisma.Decimal(r.revenue),
    });
  }
  return out;
}

async function lanesWithFigures(db: TenantDb, tenantId: bigint, lanes: LaneRecord[], period: Period): Promise<TradeLaneDto[]> {
  const base = await baseCurrency(db, tenantId);
  const revenueCurrency = base === null ? '' : isoCurrency(base.currency);
  const pairs = lanes.flatMap((lane) =>
    pairsOf(lane).map(({ pol, pod }) => ({
      pol: pol.id,
      pod: pod.id,
      direction: lane.movementType as TradeLaneDirection,
      isAir: lane.port.type === 'AIRPORT',
    })),
  );
  const figures = await figuresFor(db, tenantId, pairs, period);

  return lanes.map((lane) => {
    const direction = lane.movementType as TradeLaneDirection;
    const isAir = lane.port.type === 'AIRPORT';
    const rows: BusinessMatrixRowDto[] = pairsOf(lane).map(({ pol, pod }) => {
      const f = figures.get(pairKey(pol.id, pod.id, direction));
      return {
        pol: portDto(pol),
        pod: portDto(pod),
        liveRates: f?.liveRates ?? 0,
        inquiries: f?.inquiries ?? 0,
        quotations: f?.quotations ?? 0,
        teus: isAir ? null : (f?.teus ?? new Prisma.Decimal(0)).toFixed(2),
        revenue: (f?.revenue ?? new Prisma.Decimal(0)).toFixed(4),
      };
    });
    return {
      id: lane.id.toString(),
      code: lane.code,
      name: lane.name,
      movementType: direction,
      isActive: lane.isActive,
      port: portDto(lane.port),
      ports: lane.ports.map(({ port }) => portDto(port)),
      isAir,
      revenueCurrency,
      rows,
    };
  });
}

businessMatrixRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = businessMatrixQuerySchema.parse(req.query);

  const { lanes, total } = await withTenant(auth.tenantId, async (db) => {
    const where: Prisma.TradeLaneWhereInput = {
      deletedAt: null,
      movementType: query.movementType,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              { port: { name: { contains: query.search, mode: 'insensitive' } } },
              { port: { portCode: { contains: query.search, mode: 'insensitive' } } },
              { ports: { some: { deletedAt: null, port: { name: { contains: query.search, mode: 'insensitive' } } } } },
              { ports: { some: { deletedAt: null, port: { portCode: { contains: query.search, mode: 'insensitive' } } } } },
            ],
          }),
    };
    const order: Prisma.TradeLaneOrderByWithRelationInput =
      query.sortBy === 'code' ? { code: query.sortOrder } : { name: query.sortOrder };
    const [found, counted] = await Promise.all([
      db.tradeLane.findMany({
        where,
        orderBy: [order, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: LANE_SELECT,
      }),
      db.tradeLane.count({ where }),
    ]);
    return { lanes: await lanesWithFigures(db, auth.tenantId, found, query), total: counted };
  });

  const payload: ApiSuccess<TradeLaneDto[]> = { success: true, data: lanes, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

// ---------------------------------------------------------------------------
// GET /details — what a cell counted (client, 2026-11-01)
//
// Opening a figure lists records from another screen, so the request needs
// that screen's VIEW as well as the matrix's (businessMatrixDetailPermissions),
// and the list keeps that screen's row scope: without VIEW_ALL a salesman sees
// their own inquiries and quotations, and how many others the cell counted.
// ---------------------------------------------------------------------------

const holds = (auth: AuthContext, key: string): boolean => auth.isSuperadmin || auth.permissions.has(key);
const LIMIT = BUSINESS_MATRIX_DETAIL_LIMIT;

interface DetailContext {
  db: TenantDb;
  auth: AuthContext;
  ref: PairRef;
  period: Period;
  isAir: boolean;
  base: { pol: TradeLanePortDto; pod: TradeLanePortDto };
}

/** The user's employee record, which §7's OWN scope is keyed on — read fresh, as the screens do. */
async function employeeOf(ctx: DetailContext): Promise<bigint | null> {
  const user = await ctx.db.user.findFirst({ where: { id: ctx.auth.userId }, select: { employeeId: true } });
  return user?.employeeId ?? null;
}

async function liveRateDetails(ctx: DetailContext): Promise<BusinessMatrixDetailDto> {
  const { db, auth } = ctx;
  const today = rateToday();
  const match = liveRateMatch(auth.tenantId, ctx.ref, today);
  // A sea lane is two price lists; a user holding one sees that one's rates.
  const modes: string[] = businessMatrixRateModes(ctx.isAir).filter((m) => holds(auth, BUSINESS_MATRIX_RATE_PERMISSION[m]));

  const [rows, [counts]] = await Promise.all([
    db.$queryRaw<
      {
        id: bigint;
        code: string;
        mode: RateMode;
        carrier_name: string;
        goods_type_name: string;
        valid_from: string;
        valid_to: string;
        transit_days: number | null;
        route: string | null;
        currency: string;
      }[]
    >`
      SELECT r.id, r.code, r.mode::text AS mode, c.name AS carrier_name, g.name AS goods_type_name,
             to_char(r.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(r.valid_to, 'YYYY-MM-DD') AS valid_to,
             r.transit_days, r.route, cur.currency
        FROM freight_rate r
        JOIN carrier c    ON c.id = r.carrier_id
        JOIN goods_type g ON g.id = r.goods_type_id
        JOIN currency cur ON cur.id = r.currency_id
       WHERE ${match} AND r.mode::text = ANY(${modes}::text[])
       ORDER BY c.name, r.code
       LIMIT ${LIMIT}`,
    db.$queryRaw<{ seen: number; counted: number }[]>`
      SELECT COUNT(*) FILTER (WHERE r.mode::text = ANY(${modes}::text[]))::int AS seen, COUNT(*)::int AS counted
        FROM freight_rate r
       WHERE ${match}`,
  ]);

  // Sell side only, whoever asks: buy price has its own permission on the Price List.
  const lines = await db.freightRateLine.findMany({
    where: { rateId: { in: rows.map((r) => r.id) }, deletedAt: null },
    select: { rateId: true, sellPrice: true, tier: { select: { label: true } } },
    orderBy: [{ tier: { sortOrder: 'asc' } }, { id: 'asc' }],
  });

  const out: MatrixRateRow[] = rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    mode: r.mode,
    carrierName: r.carrier_name,
    goodsTypeName: r.goods_type_name,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    transitDays: r.transit_days,
    route: r.route,
    currencyCode: isoCurrency(r.currency),
    lines: lines
      .filter((l) => l.rateId === r.id)
      .map((l) => ({ label: l.tier.label, sellPrice: l.sellPrice === null ? null : l.sellPrice.toFixed(4) })),
  }));
  const seen = counts?.seen ?? 0;
  return { figure: 'liveRates', ...ctx.base, asOf: today, total: seen, hidden: (counts?.counted ?? 0) - seen, rows: out };
}

async function inquiryDetails(ctx: DetailContext): Promise<BusinessMatrixDetailDto> {
  const { db, auth } = ctx;
  const match = inquiryMatch(auth.tenantId, ctx.ref, ctx.period);
  // The Live Inquiry list's own scope (inquiry.route.ts scopeClause).
  let scope = Prisma.sql`TRUE`;
  if (!holds(auth, 'SALES.INQUIRY.VIEW_ALL')) {
    const employeeId = await employeeOf(ctx);
    scope = employeeId === null ? Prisma.sql`FALSE` : Prisma.sql`i.salesman_id = ${employeeId}`;
  }
  const today = todayIn(await workspaceZone(db, auth.tenantId));

  const [rows, [counts]] = await Promise.all([
    db.$queryRaw<
      { id: bigint; code: string; inquiry_date: string; customer_name: string; salesman_name: string | null; status: InquiryStatus; is_lapsed: boolean }[]
    >`
      SELECT i.id, i.code, to_char(i.inquiry_date, 'YYYY-MM-DD') AS inquiry_date,
             c.name AS customer_name, e.name AS salesman_name, i.status::text AS status,
             (i.status = 'OPEN' AND i.valid_to IS NOT NULL AND i.valid_to < ${today}::date) AS is_lapsed
        FROM inquiry i
        JOIN customer c      ON c.tenant_id = i.tenant_id AND c.id = i.customer_id
        LEFT JOIN employee e ON e.tenant_id = i.tenant_id AND e.id = i.salesman_id
       WHERE ${match} AND ${scope}
       ORDER BY i.inquiry_date DESC, i.id DESC
       LIMIT ${LIMIT}`,
    db.$queryRaw<{ seen: number; counted: number }[]>`
      SELECT COUNT(*) FILTER (WHERE ${scope})::int AS seen, COUNT(*)::int AS counted
        FROM inquiry i
       WHERE ${match}`,
  ]);

  const out: MatrixInquiryRow[] = rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    inquiryDate: r.inquiry_date,
    customerName: r.customer_name,
    salesmanName: r.salesman_name,
    status: r.status,
    isLapsed: r.is_lapsed,
  }));
  const seen = counts?.seen ?? 0;
  return { figure: 'inquiries', ...ctx.base, total: seen, hidden: (counts?.counted ?? 0) - seen, rows: out };
}

async function quotationDetails(ctx: DetailContext): Promise<BusinessMatrixDetailDto> {
  const { db, auth } = ctx;
  const match = quotationMatch(auth.tenantId, ctx.ref, ctx.period);
  // The quotation list's own scope (quotation.route.ts scopeFor): the ones
  // you raised, and the ones on inquiries you are the salesman for.
  let scope = Prisma.sql`TRUE`;
  if (!holds(auth, 'CUSTOMER_SERVICE.QUOTATION.VIEW_ALL')) {
    const employeeId = await employeeOf(ctx);
    scope =
      employeeId === null
        ? Prisma.sql`q.created_by = ${auth.userId}`
        : Prisma.sql`(q.created_by = ${auth.userId} OR EXISTS (
            SELECT 1 FROM inquiry si
             WHERE si.tenant_id = q.tenant_id AND si.id = q.inquiry_id AND si.salesman_id = ${employeeId}))`;
  }

  const [rows, [counts]] = await Promise.all([
    db.$queryRaw<
      { id: bigint; code: string; revision_no: number; quotation_date: string; customer_name: string; carrier_name: string; status: QuotationStatus }[]
    >`
      SELECT x.* FROM (
        -- One row per number, as it is counted: its latest counted revision.
        SELECT DISTINCT ON (q.code)
               q.id, q.code, q.revision_no, to_char(q.quotation_date, 'YYYY-MM-DD') AS quotation_date,
               c.name AS customer_name, car.name AS carrier_name, q.status::text AS status
          FROM quotation q
          JOIN customer c  ON c.tenant_id = q.tenant_id AND c.id = q.customer_id
          JOIN carrier car ON car.id = q.carrier_id
         WHERE ${match} AND ${scope}
         ORDER BY q.code, q.revision_no DESC
      ) x
      ORDER BY x.quotation_date DESC, x.code DESC
      LIMIT ${LIMIT}`,
    db.$queryRaw<{ seen: number; counted: number }[]>`
      SELECT COUNT(DISTINCT q.code) FILTER (WHERE ${scope})::int AS seen, COUNT(DISTINCT q.code)::int AS counted
        FROM quotation q
       WHERE ${match}`,
  ]);

  const out: MatrixQuotationRow[] = rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    revisionNo: r.revision_no,
    quotationDate: r.quotation_date,
    customerName: r.customer_name,
    carrierName: r.carrier_name,
    status: r.status,
  }));
  const seen = counts?.seen ?? 0;
  return { figure: 'quotations', ...ctx.base, total: seen, hidden: (counts?.counted ?? 0) - seen, rows: out };
}

async function loadPlanDetails(ctx: DetailContext): Promise<BusinessMatrixDetailDto> {
  const { db, auth } = ctx;
  const zone = await workspaceZone(db, auth.tenantId);
  const match = loadPlanMatch(auth.tenantId, ctx.ref, ctx.period, zone);

  const [rows, [counts]] = await Promise.all([
    db.$queryRaw<
      {
        id: bigint;
        code: string;
        container_no: string | null;
        size_code: string;
        teu_factor: Prisma.Decimal;
        loaded_on: string;
        carrier_name: string;
        bookings: string[];
      }[]
    >`
      SELECT k.id, k.code, k.container_no, cs.code AS size_code, cs.teu_factor,
             to_char(${loadedOn(zone)}, 'YYYY-MM-DD') AS loaded_on, car.name AS carrier_name,
             ARRAY(SELECT s.code FROM ${BOOKINGS_IN_BOX} WHERE ${bookingOnPair(ctx.ref)} ORDER BY s.code) AS bookings
        FROM clp k
        JOIN container_size cs ON cs.id = k.container_size_id
        JOIN carrier car       ON car.id = k.carrier_id
       WHERE ${match}
       ORDER BY loaded_on DESC, k.code DESC
       LIMIT ${LIMIT}`,
    db.$queryRaw<{ n: number; teus: Prisma.Decimal }[]>`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(cs.teu_factor), 0) AS teus
        FROM clp k
        JOIN container_size cs ON cs.id = k.container_size_id
       WHERE ${match}`,
  ]);

  const out: MatrixLoadPlanRow[] = rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    containerNo: r.container_no,
    containerSize: r.size_code,
    teus: new Prisma.Decimal(r.teu_factor).toFixed(2),
    loadedOn: r.loaded_on,
    carrierName: r.carrier_name,
    bookings: r.bookings,
  }));
  return {
    figure: 'teus',
    ...ctx.base,
    total: counts?.n ?? 0,
    hidden: 0,
    sum: new Prisma.Decimal(counts?.teus ?? 0).toFixed(2),
    rows: out,
  };
}

async function invoiceDetails(ctx: DetailContext): Promise<BusinessMatrixDetailDto> {
  const { db, auth } = ctx;
  const match = invoiceMatch(auth.tenantId, ctx.ref, ctx.period);
  const base = await baseCurrency(db, auth.tenantId);

  const [rows, [counts]] = await Promise.all([
    db.$queryRaw<
      {
        id: bigint;
        code: string;
        invoice_date: string;
        customer_name: string;
        booking_code: string;
        currency_code: string;
        total_amount: Prisma.Decimal;
        total_amount_base: Prisma.Decimal;
      }[]
    >`
      SELECT d.id, d.code, to_char(d.invoice_date, 'YYYY-MM-DD') AS invoice_date, cu.name AS customer_name,
             s.code AS booking_code, d.currency_code, d.total_amount, d.total_amount_base
        FROM ${INVOICES}
        JOIN customer cu ON cu.tenant_id = d.tenant_id AND cu.id = d.customer_id
       WHERE ${match}
       ORDER BY d.invoice_date DESC, d.code DESC
       LIMIT ${LIMIT}`,
    db.$queryRaw<{ n: number; revenue: Prisma.Decimal }[]>`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(d.total_amount_base), 0) AS revenue
        FROM ${INVOICES}
       WHERE ${match}`,
  ]);

  const out: MatrixInvoiceRow[] = rows.map((r) => ({
    id: r.id.toString(),
    code: r.code,
    invoiceDate: r.invoice_date,
    customerName: r.customer_name,
    bookingCode: r.booking_code,
    currencyCode: r.currency_code,
    totalAmount: new Prisma.Decimal(r.total_amount).toFixed(4),
    totalAmountBase: new Prisma.Decimal(r.total_amount_base).toFixed(4),
  }));
  return {
    figure: 'revenue',
    ...ctx.base,
    total: counts?.n ?? 0,
    hidden: 0,
    currency: base === null ? '' : isoCurrency(base.currency),
    sum: new Prisma.Decimal(counts?.revenue ?? 0).toFixed(4),
    rows: out,
  };
}

const DETAILS: Record<BusinessMatrixFigure, (ctx: DetailContext) => Promise<BusinessMatrixDetailDto>> = {
  liveRates: liveRateDetails,
  inquiries: inquiryDetails,
  quotations: quotationDetails,
  teus: loadPlanDetails,
  revenue: invoiceDetails,
};

businessMatrixRouter.get('/details', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = businessMatrixDetailQuerySchema.parse(req.query);
  const polId = BigInt(query.polId);
  const podId = BigInt(query.podId);

  const data = await withTenant(auth.tenantId, async (db) => {
    // Ports this workspace can see — a system row or its own (§7A rule 7).
    const ports = await db.port.findMany({ where: { id: { in: [polId, podId] }, deletedAt: null }, select: PORT_SELECT });
    const pol = ports.find((p) => p.id === polId);
    const pod = ports.find((p) => p.id === podId);
    if (pol === undefined || pod === undefined) throw HttpError.notFound('Port not found.');
    const isAir = pol.type === 'AIRPORT';

    if (!businessMatrixDetailPermissions(query.figure, isAir).some((key) => holds(auth, key))) {
      throw HttpError.forbidden('You do not have access to the records behind this figure.');
    }

    return DETAILS[query.figure]({
      db,
      auth,
      ref: {
        pol: Prisma.sql`${polId}::bigint`,
        pod: Prisma.sql`${podId}::bigint`,
        direction: Prisma.sql`${query.movementType}::movement_type`,
        isAir: Prisma.sql`${isAir}::boolean`,
      },
      period: query,
      isAir,
      base: { pol: portDto(pol), pod: portDto(pod) },
    });
  });

  const payload: ApiSuccess<BusinessMatrixDetailDto> = { success: true, data };
  res.json(payload);
});

/** The port picker, narrowed to what this workspace may use (§7A rule 7). */
businessMatrixRouter.get('/options', requireAnyPermission(`${FEATURE}.CREATE`, `${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const data = await withTenant(auth.tenantId, async (db): Promise<TradeLaneOptionsDto> => {
    const inactive = await inactiveMasters(db);
    const ports = await db.port.findMany({
      where: { ...excludeInactive(inactive, 'port'), deletedAt: null, isActive: true },
      select: { id: true, name: true, portCode: true, type: true },
      orderBy: { name: 'asc' },
    });
    return {
      ports: ports.map((p) => ({ id: p.id.toString(), name: `${p.name} (${p.portCode})`, portCode: p.portCode, type: p.type })),
    };
  });
  const payload: ApiSuccess<TradeLaneOptionsDto> = { success: true, data };
  res.json(payload);
});

type SaveInput = ReturnType<typeof tradeLaneSaveSchema.parse>;

/**
 * A pair already on another live, active lane of the same direction, named —
 * it would be counted twice in any total across lanes (§6 Q2). Asked on save
 * and again on activation.
 */
async function assertNoOverlap(
  db: TenantDb,
  lane: { id?: bigint; movementType: TradeLaneDirection; portId: bigint; portIds: bigint[] },
): Promise<void> {
  const clash = await db.tradeLanePort.findFirst({
    where: {
      deletedAt: null,
      portId: { in: lane.portIds },
      tradeLane: {
        deletedAt: null,
        isActive: true,
        movementType: lane.movementType,
        portId: lane.portId,
        ...(lane.id === undefined ? {} : { id: { not: lane.id } }),
      },
    },
    select: { port: { select: { name: true } }, tradeLane: { select: { name: true, port: { select: { name: true } } } } },
  });
  if (clash === null) return;
  const [pol, pod] =
    lane.movementType === 'INBOUND'
      ? [clash.port.name, clash.tradeLane.port.name]
      : [clash.tradeLane.port.name, clash.port.name];
  throw new HttpError(
    409,
    'PAIR_ON_ANOTHER_LANE',
    `${pol} to ${pod} is already on the lane "${clash.tradeLane.name}". A port pair belongs to one lane, or it would be counted twice.`,
  );
}

/**
 * Every port must be one this workspace can see and has not switched off, and
 * a lane is all seaports or all airports (§6 Q3). Asked again on the way in,
 * because a request is not a form.
 */
async function checkPorts(db: TenantDb, input: SaveInput): Promise<void> {
  const inactive = await inactiveMasters(db);
  const ids = [input.portId, ...input.portIds].map((v) => BigInt(v));
  const ports = await db.port.findMany({
    where: { AND: [{ id: { in: ids } }, excludeInactive(inactive, 'port')], deletedAt: null, isActive: true },
    select: { id: true, type: true },
  });
  if (ports.length !== ids.length) throw HttpError.badRequest('One of those ports is not available.');
  if (new Set(ports.map((p) => p.type)).size > 1) {
    throw HttpError.badRequest('A trade lane is all seaports or all airports. Choose ports of one kind.');
  }
}

async function assertNameFree(db: TenantDb, input: SaveInput, exceptId?: bigint): Promise<void> {
  const taken = await db.tradeLane.findFirst({
    where: {
      deletedAt: null,
      movementType: input.movementType,
      name: { equals: input.name, mode: 'insensitive' },
      ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (taken !== null) {
    throw HttpError.conflict(
      `There is already an ${TRADE_LANE_DIRECTION_LABEL[input.movementType].toLowerCase()} lane called "${input.name}".`,
    );
  }
}

async function writePorts(db: TenantDb, tenantId: bigint, userId: bigint, tradeLaneId: bigint, input: SaveInput): Promise<void> {
  await db.tradeLanePort.createMany({
    data: input.portIds.map((portId, index) => ({
      tenantId,
      tradeLaneId,
      portId: BigInt(portId),
      sortOrder: index,
      createdBy: userId,
      updatedBy: userId,
    })),
  });
}

async function loadLane(db: TenantDb, tenantId: bigint, id: bigint): Promise<TradeLaneDto> {
  const lane = await db.tradeLane.findFirst({ where: { id, deletedAt: null }, select: LANE_SELECT });
  if (lane === null) throw HttpError.notFound('Trade lane not found.');
  const [dto] = await lanesWithFigures(db, tenantId, [lane], {});
  return dto!;
}

const asOverlapInput = (input: SaveInput, id?: bigint) => ({
  ...(id === undefined ? {} : { id }),
  movementType: input.movementType,
  portId: BigInt(input.portId),
  portIds: input.portIds.map((v) => BigInt(v)),
});

/** The sheet's `add` (E6). */
businessMatrixRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = tradeLaneSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    await checkPorts(db, input);
    await assertNameFree(db, input);
    await assertNoOverlap(db, asOverlapInput(input));
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'tradeLane', CODE_PREFIX.tradeLane, auth.tenantId);
      try {
        const created = await inSavepoint(db, () =>
          db.tradeLane.create({
            data: {
              tenantId: auth.tenantId,
              code,
              name: input.name,
              movementType: input.movementType,
              portId: BigInt(input.portId),
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: { id: true },
          }),
        );
        await writePorts(db, auth.tenantId, auth.userId, created.id, input);
        return loadLane(db, auth.tenantId, created.id);
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a trade lane code.');
  });

  const payload: ApiSuccess<TradeLaneDto> = { success: true, data };
  res.status(201).json(payload);
});

businessMatrixRouter.put('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'trade lane');
  const input = tradeLaneSaveSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.tradeLane.findFirst({ where: { id, deletedAt: null }, select: { isActive: true } });
    if (existing === null) throw HttpError.notFound('Trade lane not found.');
    await checkPorts(db, input);
    await assertNameFree(db, input, id);
    // An inactive lane counts nowhere, so it may hold a pair until it is switched back on.
    if (existing.isActive) await assertNoOverlap(db, asOverlapInput(input, id));
    await db.tradeLane.update({
      where: { id },
      data: { name: input.name, movementType: input.movementType, portId: BigInt(input.portId), updatedBy: auth.userId },
    });
    // Retired rather than edited: the audit trail keeps the lane as it was.
    await db.tradeLanePort.updateMany({
      where: { tradeLaneId: id, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
    await writePorts(db, auth.tenantId, auth.userId, id, input);
    return loadLane(db, auth.tenantId, id);
  });

  const payload: ApiSuccess<TradeLaneDto> = { success: true, data };
  res.json(payload);
});

businessMatrixRouter.post('/:id/toggle-status', requirePermission(`${FEATURE}.TOGGLE_STATUS`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'trade lane');
  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.tradeLane.findFirst({
      where: { id, deletedAt: null },
      select: { isActive: true, movementType: true, portId: true, ports: { where: { deletedAt: null }, select: { portId: true } } },
    });
    if (existing === null) throw HttpError.notFound('Trade lane not found.');
    if (!existing.isActive) {
      await assertNoOverlap(db, {
        id,
        movementType: existing.movementType as TradeLaneDirection,
        portId: existing.portId,
        portIds: existing.ports.map((p) => p.portId),
      });
    }
    await db.tradeLane.update({ where: { id }, data: { isActive: !existing.isActive, updatedBy: auth.userId } });
    return loadLane(db, auth.tenantId, id);
  });
  const payload: ApiSuccess<TradeLaneDto> = { success: true, data };
  res.json(payload);
});
