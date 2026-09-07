import {
  type EmployeePerformanceDto,
  PERFORMANCE_METRICS,
  type PerformanceDetailRow,
  type PerformanceMetricDto,
  type PerformanceMetricKey,
  resolvePeriod,
  type ReportPeriod,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import type { TenantDb } from './tenant-client';

/**
 * The Employee Performance Report — client wireframe, 2026-09-07.
 *
 * What one person did over a period, and the rows behind every figure.
 *
 * Two things decide the shape of this file. First, "handled" has a different
 * meaning per metric and none of them is invented here: a customer is handled
 * by the salesman who owns the relationship, an inquiry by the salesman on it,
 * a shipment by the salesman of the inquiry it came from, and a lead by
 * whoever created it. Those links already existed; this only reads them.
 *
 * Second, the counts and the details must never disagree. So each metric is
 * one `where` clause used twice — once by `count`, once by `findMany` — rather
 * than a count here and a list somewhere else that drift the first time
 * somebody edits one of them.
 */

/** Where the period bites for each metric — they do not share a date column. */
function range(from: string, to: string): { gte: Date; lte: Date } {
  return {
    gte: new Date(`${from}T00:00:00.000Z`),
    // Inclusive of the end day, which is what "to 30 September" means to
    // everyone who is not a database.
    lte: new Date(`${to}T23:59:59.999Z`),
  };
}

/** The same range as bare dates, for DATE columns that carry no time. */
function dayRange(from: string, to: string): { gte: Date; lte: Date } {
  return { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) };
}

/**
 * The user accounts belonging to this employee.
 *
 * A lead records who created it as a USER; the report is about an EMPLOYEE.
 * One employee can hold more than one login, so this is a list rather than a
 * lookup — and an employee with no login has generated no leads through the
 * product, which is a true answer rather than a missing one.
 */
async function userIdsFor(db: TenantDb, employeeId: bigint): Promise<bigint[]> {
  const users = await db.user.findMany({
    where: { employeeId, deletedAt: null },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

interface Scope {
  employeeId: bigint;
  from: string;
  to: string;
  userIds: bigint[];
}

/** Customers whose relationship this employee owns, taken on in the period. */
function customerWhere(s: Scope): Prisma.CustomerWhereInput {
  return { deletedAt: null, salesmanId: s.employeeId, createdAt: range(s.from, s.to) };
}

/** Inquiries they are the salesman on, by the date the inquiry carries. */
function inquiryWhere(s: Scope): Prisma.InquiryWhereInput {
  return { deletedAt: null, salesmanId: s.employeeId, inquiryDate: dayRange(s.from, s.to) };
}

/**
 * Shipments that trace back to them.
 *
 * A booking has no salesman of its own — it belongs to a quotation, which
 * answers an inquiry, which has one. Following that chain is what makes the
 * figure the salesman's rather than the operator's who keyed the booking in.
 */
function shipmentWhere(s: Scope, type: 'AIR' | 'SEA'): Prisma.ShipmentWhereInput {
  return {
    deletedAt: null,
    shipmentType: type,
    createdAt: range(s.from, s.to),
    quotation: { inquiry: { salesmanId: s.employeeId } },
  };
}

/** Leads they raised. Empty when they hold no login — see userIdsFor. */
function leadWhere(s: Scope): Prisma.SalesLeadWhereInput {
  return {
    deletedAt: null,
    createdBy: s.userIds.length === 0 ? { in: [] } : { in: s.userIds },
    createdAt: range(s.from, s.to),
  };
}

/**
 * Which commodity categories they worked across.
 *
 * Counted over the customers they took on, because that is where the category
 * lives — customer.industry_sector_id, the table CLAUDE.md §5 calls
 * Table_Commodity_Class and the screens label "Commodity". Distinct, so a
 * salesman with thirty garment customers has handled one category, not thirty.
 */
async function commodityCategoryIds(db: TenantDb, s: Scope): Promise<bigint[]> {
  const rows = await db.customer.findMany({
    where: customerWhere(s),
    select: { industrySectorId: true },
    distinct: ['industrySectorId'],
  });
  return rows.map((r) => r.industrySectorId);
}

/**
 * The three figures that cannot be computed yet, and why.
 *
 * The client's own note defines them: revenue is "the sum of each booking
 * debit note value", gross profit "the sum of invoice margin (selling -
 * buying)", and the incentive a percentage of that profit. Accounts has no
 * tables — no invoice, no debit note — so there is nothing to sum.
 *
 * Reported as pending rather than as zero. A zero here would be a lie an
 * operator could act on.
 */
const PENDING: Record<string, string> = {
  REVENUE: 'Needs the Accounts module — revenue is the sum of each booking debit note.',
  GROSS_PROFIT: 'Needs the Accounts module — gross profit is the sum of invoice margin.',
  INCENTIVE: 'Needs the Accounts module — the incentive is a share of gross profit.',
};

export async function employeePerformance(
  db: TenantDb,
  employeeId: bigint,
  period: ReportPeriod,
  custom: { from?: string; to?: string },
  today: Date,
): Promise<EmployeePerformanceDto | null> {
  const employee = await db.employee.findFirst({
    where: { id: employeeId, deletedAt: null },
    select: {
      id: true,
      code: true,
      name: true,
      department: true,
      designation: true,
      incentivePercentage: true,
    },
  });
  if (employee === null) return null;

  const { from, to } = resolvePeriod(period, today, custom);
  const s: Scope = { employeeId, from, to, userIds: await userIdsFor(db, employeeId) };

  const [customers, inquiries, categories, air, sea, leads] = await Promise.all([
    db.customer.count({ where: customerWhere(s) }),
    db.inquiry.count({ where: inquiryWhere(s) }),
    commodityCategoryIds(db, s),
    db.shipment.count({ where: shipmentWhere(s, 'AIR') }),
    db.shipment.count({ where: shipmentWhere(s, 'SEA') }),
    db.salesLead.count({ where: leadWhere(s) }),
  ]);

  const counts: Record<string, number> = {
    CUSTOMERS: customers,
    INQUIRIES: inquiries,
    COMMODITY_CATEGORIES: categories.length,
    AIR_SHIPMENTS: air,
    SEA_SHIPMENTS: sea,
    SALES_LEADS: leads,
  };

  const metrics: PerformanceMetricDto[] = PERFORMANCE_METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    kind: m.kind,
    value: m.kind === 'COUNT' ? (counts[m.key] ?? 0) : null,
    drillable: m.drillable,
    pendingReason: PENDING[m.key] ?? null,
  }));

  return {
    employeeId: employee.id.toString(),
    employeeCode: employee.code,
    employeeName: employee.name,
    department: employee.department,
    designation: employee.designation,
    incentivePercentage: employee.incentivePercentage?.toString() ?? null,
    period,
    from,
    to,
    metrics,
  };
}

/**
 * The rows behind one figure — the client's "Each report will show the details
 * list".
 *
 * Every branch reuses the same `where` the count used, so the list can never
 * show a different number of rows than the figure that opened it.
 */
export async function performanceDetail(
  db: TenantDb,
  employeeId: bigint,
  metric: PerformanceMetricKey,
  period: ReportPeriod,
  custom: { from?: string; to?: string },
  today: Date,
  limit: number,
): Promise<PerformanceDetailRow[]> {
  const { from, to } = resolvePeriod(period, today, custom);
  const s: Scope = { employeeId, from, to, userIds: await userIdsFor(db, employeeId) };
  const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

  switch (metric) {
    case 'CUSTOMERS': {
      const rows = await db.customer.findMany({
        where: customerWhere(s),
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          code: true,
          name: true,
          country: true,
          createdAt: true,
          industrySector: { select: { name: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id.toString(),
        code: r.code,
        title: r.name,
        subtitle: [r.country, r.industrySector?.name].filter(Boolean).join(' · ') || null,
        date: day(r.createdAt),
        href: '/crm/customer',
      }));
    }

    case 'INQUIRIES': {
      const rows = await db.inquiry.findMany({
        where: inquiryWhere(s),
        orderBy: { inquiryDate: 'desc' },
        take: limit,
        select: {
          id: true,
          code: true,
          inquiryDate: true,
          status: true,
          customer: { select: { name: true } },
          pol: { select: { name: true } },
          pod: { select: { name: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id.toString(),
        code: r.code,
        title: r.customer?.name ?? '—',
        subtitle: `${r.pol?.name ?? '—'} → ${r.pod?.name ?? '—'} · ${r.status}`,
        date: day(r.inquiryDate),
        href: '/sales/inquiry',
      }));
    }

    case 'COMMODITY_CATEGORIES': {
      const ids = await commodityCategoryIds(db, s);
      if (ids.length === 0) return [];
      const rows = await db.industrySector.findMany({
        where: { id: { in: ids }, deletedAt: null },
        orderBy: { name: 'asc' },
        select: { id: true, code: true, name: true },
      });
      // How many of this employee's customers sit in each category — the
      // figure that makes the row worth opening.
      const counts = await db.customer.groupBy({
        by: ['industrySectorId'],
        where: customerWhere(s),
        _count: { _all: true },
      });
      const byId = new Map(counts.map((c) => [c.industrySectorId.toString(), c._count._all]));
      return rows.map((r) => {
        const n = byId.get(r.id.toString()) ?? 0;
        return {
          id: r.id.toString(),
          code: r.code,
          title: r.name,
          subtitle: `${n} customer${n === 1 ? '' : 's'}`,
          date: null,
          href: '/setting/commodity',
        };
      });
    }

    case 'AIR_SHIPMENTS':
    case 'SEA_SHIPMENTS': {
      const rows = await db.shipment.findMany({
        where: shipmentWhere(s, metric === 'AIR_SHIPMENTS' ? 'AIR' : 'SEA'),
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          code: true,
          status: true,
          createdAt: true,
          customer: { select: { name: true } },
          pol: { select: { name: true } },
          pod: { select: { name: true } },
        },
      });
      return rows.map((r) => ({
        id: r.id.toString(),
        code: r.code,
        title: r.customer?.name ?? '—',
        subtitle: `${r.pol?.name ?? '—'} → ${r.pod?.name ?? '—'} · ${r.status}`,
        date: day(r.createdAt),
        href: `/cs/shipment-booking/${r.id}`,
      }));
    }

    case 'SALES_LEADS': {
      const rows = await db.salesLead.findMany({
        where: leadWhere(s),
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, code: true, name: true, notes: true, createdAt: true },
      });
      return rows.map((r) => ({
        id: r.id.toString(),
        code: r.code,
        title: r.name,
        subtitle: r.notes === null || r.notes === '' ? null : r.notes.slice(0, 120),
        date: day(r.createdAt),
        href: '/sales/sales-lead',
      }));
    }

    default:
      // The money metrics have no rows to show until Accounts exists. The
      // route refuses them before reaching here; this keeps the switch total.
      return [];
  }
}
