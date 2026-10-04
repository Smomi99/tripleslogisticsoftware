import type { ShipmentProfitabilitySortField, ShipmentType } from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import type { TenantDb } from './tenant-client';

/**
 * Shipment Profitability — docs/DESIGN-UPDATE-2026-10-04.md §8.
 *
 * A booking's revenue and cost are the sums over every ISSUED debit invoice
 * that names it: the freight invoice, and any OTHER invoice raised against the
 * same booking. Drafts have billed nobody and cancelled invoices are void, so
 * neither counts. Both figures are the invoice's own stored base totals
 * (`total_amount_base`, `cost_total_base`), so this screen and the invoice can
 * never disagree about a job.
 *
 * Summed in SQL rather than in memory, because the list sorts by the sums: the
 * page of worst jobs cannot be found without adding up every job first.
 */

export interface ProfitabilityFilter {
  search?: string | undefined;
  shipmentType?: ShipmentType | undefined;
  /** YYYY-MM-DD, inclusive, on the booking's first issued invoice date. */
  from?: string | undefined;
  to?: string | undefined;
}

export interface ProfitabilityPage {
  /** The page's bookings in display order, with their figures. */
  rows: { shipmentId: bigint; revenue: Prisma.Decimal; cost: Prisma.Decimal }[];
  total: number;
  /** Across the whole filtered list, not just this page. */
  revenue: Prisma.Decimal;
  cost: Prisma.Decimal;
}

/** Fixed expressions only — the sort field picks one, it never becomes SQL itself. */
const ORDER_BY: Record<ShipmentProfitabilitySortField, Prisma.Sql> = {
  code: Prisma.sql`r.code`,
  customer: Prisma.sql`r.customer_name`,
  revenue: Prisma.sql`r.revenue`,
  cost: Prisma.sql`r.cost`,
  gp: Prisma.sql`(r.revenue - r.cost)`,
  gpPercent: Prisma.sql`CASE WHEN r.revenue = 0 THEN NULL ELSE (r.revenue - r.cost) / r.revenue END`,
};

/** A search term as an ILIKE pattern that matches it literally, wildcards and all. */
function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The filtered set, as a CTE named `r`.
 *
 * tenant_id is named on every table even though RLS would filter them anyway:
 * CLAUDE.md §7A makes the application the first line and RLS the safety net,
 * and a raw query has no Prisma extension to add the `where` for it.
 */
function filtered(tenantId: bigint, filter: ProfitabilityFilter): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (filter.shipmentType !== undefined) {
    conditions.push(Prisma.sql`s.shipment_type = ${filter.shipmentType}::shipment_type`);
  }
  if (filter.from !== undefined) conditions.push(Prisma.sql`b.first_invoiced >= ${filter.from}::date`);
  if (filter.to !== undefined) conditions.push(Prisma.sql`b.first_invoiced <= ${filter.to}::date`);
  if (filter.search !== undefined) {
    const like = containsPattern(filter.search);
    // Booking, quotation, customer and BL No — the columns an operator would
    // read a job by.
    conditions.push(Prisma.sql`(
         s.code ILIKE ${like} ESCAPE '\\'
      OR q.code ILIKE ${like} ESCAPE '\\'
      OR c.name ILIKE ${like} ESCAPE '\\'
      OR EXISTS (
           SELECT 1
             FROM shipment_advise_booking ab
             JOIN shipment_advise a ON a.tenant_id = ab.tenant_id AND a.id = ab.advise_id
            WHERE ab.tenant_id = s.tenant_id
              AND ab.shipment_id = s.id
              AND ab.released_at IS NULL
              AND ab.deleted_at IS NULL
              AND a.house_bl_no ILIKE ${like} ESCAPE '\\'
         )
    )`);
  }
  const where = conditions.length === 0 ? Prisma.empty : Prisma.sql`AND ${Prisma.join(conditions, ' AND ')}`;

  return Prisma.sql`
    WITH billed AS (
      SELECT i.shipment_id,
             SUM(i.total_amount_base) AS revenue,
             SUM(i.cost_total_base)   AS cost,
             MIN(i.invoice_date)      AS first_invoiced
        FROM debit_invoice i
       WHERE i.tenant_id = ${tenantId}
         AND i.deleted_at IS NULL
         AND i.status = 'ISSUED'
         AND i.shipment_id IS NOT NULL
       GROUP BY i.shipment_id
    ), r AS (
      SELECT s.id, s.code, c.name AS customer_name, b.revenue, b.cost
        FROM billed b
        JOIN shipment s  ON s.tenant_id = ${tenantId} AND s.id = b.shipment_id
        JOIN quotation q ON q.tenant_id = s.tenant_id AND q.id = s.quotation_id
        JOIN customer c  ON c.tenant_id = s.tenant_id AND c.id = s.customer_id
       WHERE s.deleted_at IS NULL
         ${where}
    )`;
}

export async function profitabilityPage(
  db: TenantDb,
  tenantId: bigint,
  filter: ProfitabilityFilter,
  sort: { by: ShipmentProfitabilitySortField; order: 'asc' | 'desc' },
  page: { page: number; limit: number },
): Promise<ProfitabilityPage> {
  const set = filtered(tenantId, filter);
  const direction = Prisma.raw(sort.order === 'desc' ? 'DESC' : 'ASC');

  const [rows, totals] = await Promise.all([
    db.$queryRaw<{ id: bigint; revenue: Prisma.Decimal; cost: Prisma.Decimal }[]>`
      ${set}
      SELECT r.id, r.revenue, r.cost
        FROM r
       ORDER BY ${ORDER_BY[sort.by]} ${direction} NULLS LAST, r.id ${direction}
       LIMIT ${page.limit} OFFSET ${(page.page - 1) * page.limit}
    `,
    db.$queryRaw<{ total: bigint; revenue: Prisma.Decimal; cost: Prisma.Decimal }[]>`
      ${set}
      SELECT COUNT(*) AS total, COALESCE(SUM(r.revenue), 0) AS revenue, COALESCE(SUM(r.cost), 0) AS cost
        FROM r
    `,
  ]);

  const sum = totals[0];
  return {
    rows: rows.map((r) => ({ shipmentId: r.id, revenue: new Prisma.Decimal(r.revenue), cost: new Prisma.Decimal(r.cost) })),
    total: Number(sum?.total ?? 0),
    revenue: new Prisma.Decimal(sum?.revenue ?? 0),
    cost: new Prisma.Decimal(sum?.cost ?? 0),
  };
}

/** GP as a percentage of revenue, to one place — the sheet's 0.125 is 12.5. */
export function gpPercentOf(revenue: Prisma.Decimal, cost: Prisma.Decimal): string | null {
  if (revenue.isZero()) return null;
  return revenue.minus(cost).div(revenue).times(100).toFixed(1);
}
