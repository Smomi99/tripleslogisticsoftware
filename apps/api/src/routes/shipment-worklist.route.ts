import { type RequestHandler, Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  SHIPMENT_WORKLISTS,
  type ShipmentStatus,
  type ShipmentWorklistId,
  type ShipmentWorklistRow,
  shipmentWorklistQuerySchema,
  worklistStatuses,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { renderVolumes } from '../lib/render-volumes';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * The three direct list screens — client decision, 2026-09-03.
 *
 * Approval, Shipping Order and Cargo Receipt were reachable only as tabs on a
 * booking, which meant an operator had to already know which booking they
 * wanted before the product would tell them anything. These answer the
 * question they actually start the day with: what is waiting on me?
 *
 * Every row is a BOOKING, not a new record. The worklist is the booking list
 * narrowed to the states where this stage is the next thing that happens, and
 * §5.1's status machine decides which those are — so a worklist cannot drift
 * from the tab it leads to.
 *
 * Three endpoints rather than one with a parameter, because each carries a
 * different §7 permission and a permission is not something to pass in a query
 * string. The work behind them is one function.
 */

export const shipmentWorklistRouter: Router = Router();
export const opsWorklistRouter: Router = Router();

shipmentWorklistRouter.use(authenticate);
opsWorklistRouter.use(authenticate);

function dateOut(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** Plural that reads like English rather than like a template. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What this worklist needs to say about each booking, beyond its status.
 *
 * One aggregate query per page rather than one per row: a worklist is read
 * every few minutes by every operator on the floor, and N+1 on a
 * twenty-five-row page is twenty-five round trips to say one sentence each.
 */
async function detailsFor(
  db: TenantDb,
  worklist: ShipmentWorklistId,
  ids: bigint[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  if (worklist === 'APPROVAL') {
    // §5.3: the decision is per PO, so the count IS the state of play.
    const grouped = await db.shipmentPo.groupBy({
      by: ['shipmentId', 'approvalStatus'],
      where: { shipmentId: { in: ids }, deletedAt: null },
      _count: { _all: true },
    });
    const tally = new Map<string, { pending: number; approved: number; rejected: number }>();
    for (const row of grouped) {
      const key = row.shipmentId.toString();
      const seen = tally.get(key) ?? { pending: 0, approved: 0, rejected: 0 };
      if (row.approvalStatus === 'APPROVED') seen.approved += row._count._all;
      else if (row.approvalStatus === 'REJECTED') seen.rejected += row._count._all;
      else seen.pending += row._count._all;
      tally.set(key, seen);
    }
    for (const [id, t] of tally) {
      const total = t.pending + t.approved + t.rejected;
      if (t.pending === total) out.set(id, `${count(total, 'PO')} awaiting a decision`);
      else if (t.pending > 0) out.set(id, `${t.approved} approved, ${count(t.pending, 'PO')} still pending`);
      else if (t.rejected === 0) out.set(id, `All ${count(total, 'PO')} approved`);
      else out.set(id, `${t.approved} of ${count(total, 'PO')} approved`);
    }
    return out;
  }

  if (worklist === 'SHIPPING_ORDER') {
    const [orders, pos] = await Promise.all([
      db.shippingOrder.findMany({
        where: { shipmentId: { in: ids }, deletedAt: null, status: { in: ['ISSUED', 'SKIPPED'] } },
        orderBy: { id: 'desc' },
        select: { shipmentId: true, code: true, status: true, issueDate: true },
      }),
      db.shipmentPo.groupBy({
        by: ['shipmentId'],
        where: { shipmentId: { in: ids }, deletedAt: null, approvalStatus: 'APPROVED' },
        _count: { _all: true },
      }),
    ]);
    for (const order of orders) {
      const key = order.shipmentId.toString();
      // Newest first, so the first one seen for a booking is the live one.
      if (out.has(key)) continue;
      out.set(
        key,
        order.status === 'SKIPPED'
          ? 'Skipped — inbound shipment, no order needed'
          : `${order.code} issued ${dateOut(order.issueDate) ?? ''}`.trim(),
      );
    }
    for (const po of pos) {
      const key = po.shipmentId.toString();
      if (out.has(key)) continue;
      out.set(key, `${count(po._count._all, 'approved PO')} ready to instruct`);
    }
    return out;
  }

  // CARGO_RECEIPT — §5.5's balance, the figure the whole screen turns on.
  const [booked, received] = await Promise.all([
    db.shipmentCargoLine.groupBy({
      by: ['shipmentId'],
      where: { shipmentId: { in: ids }, deletedAt: null },
      _sum: { ctnQty: true },
    }),
    db.cargoReceiptLine.findMany({
      where: {
        deletedAt: null,
        lineStatus: 'ACCEPTED',
        // Only a confirmed receipt counts: a draft is somebody still counting.
        receipt: { shipmentId: { in: ids }, deletedAt: null, status: 'CONFIRMED' },
      },
      select: { receivedCtnQty: true, receipt: { select: { shipmentId: true } } },
    }),
  ]);

  const inHand = new Map<string, number>();
  for (const line of received) {
    const key = line.receipt.shipmentId.toString();
    inHand.set(key, (inHand.get(key) ?? 0) + line.receivedCtnQty);
  }
  for (const row of booked) {
    const key = row.shipmentId.toString();
    const total = row._sum.ctnQty ?? 0;
    const got = inHand.get(key) ?? 0;
    const balance = total - got;
    out.set(
      key,
      got === 0
        ? `${total} CTN booked, nothing received yet`
        : balance > 0
          ? `${got} of ${total} CTN received — ${balance} outstanding`
          : `All ${total} CTN received`,
    );
  }
  return out;
}

/** One handler; the three routes below differ only in permission and id. */
function handler(worklist: ShipmentWorklistId) {
  const config = SHIPMENT_WORKLISTS[worklist];

  const route: RequestHandler = async (req, res) => {
    const auth = req.auth!;
    const query = shipmentWorklistQuerySchema.parse(req.query);

    const covered = worklistStatuses(worklist);
    /*
     * A status filter outside this worklist is refused rather than quietly
     * ignored. Asking the Shipping Order screen for CANCELLED bookings is a
     * mistake, and an empty table would look like an answer.
     */
    if (query.status !== undefined && !covered.includes(query.status)) {
      throw new HttpError(
        400,
        'STATUS_OUT_OF_SCOPE',
        `${config.label} does not cover ${query.status} bookings. It shows: ${covered.join(', ')}.`,
      );
    }

    const wanted: ShipmentStatus[] =
      query.status !== undefined
        ? [query.status]
        : query.show === 'AWAITING'
          ? [...config.awaiting]
          : covered;

    const { rows, total, details } = await withTenant(auth.tenantId, async (db) => {
      /*
       * No ownership scope here, deliberately — the one place a worklist
       * departs from the Booking List.
       *
       * §7's VIEW_ALL asks "whose bookings are yours to look at", which is the
       * right question for a sales list and the wrong one for a queue. The
       * person who approves a schedule is hardly ever the person who raised
       * the booking, so scoping this by CARGO_BOOKING.VIEW_ALL would hand an
       * approver an empty screen with no way to tell it from a quiet day.
       *
       * Holding this screen's own §7 permission is what entitles you to work
       * its queue, and the route checks exactly that.
       */
      const where: Prisma.ShipmentWhereInput = {
        deletedAt: null,
        status: { in: wanted },
        ...(query.shipmentType === undefined ? {} : { shipmentType: query.shipmentType }),
        ...(query.search === undefined
          ? {}
          : {
              OR: [
                { code: { contains: query.search, mode: 'insensitive' } },
                { quotation: { code: { contains: query.search, mode: 'insensitive' } } },
                { customer: { name: { contains: query.search, mode: 'insensitive' } } },
                { exporterName: { contains: query.search, mode: 'insensitive' } },
              ],
            }),
      };

      const sortable: Record<string, Prisma.ShipmentOrderByWithRelationInput> = {
        code: { code: query.sortOrder },
        etd: { etd: query.sortOrder },
        eta: { eta: query.sortOrder },
        status: { status: query.sortOrder },
        customer: { customer: { name: query.sortOrder } },
      };
      /*
       * Oldest first, unlike the Booking List.
       *
       * A worklist is a queue, and the thing that has been waiting longest is
       * the thing most likely to be late. Newest-first would bury it.
       */
      const orderBy = sortable[query.sortBy ?? ''] ?? { id: 'asc' as const };

      const [found, counted] = await Promise.all([
        db.shipment.findMany({
          where,
          orderBy,
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          select: {
            id: true,
            code: true,
            shipmentType: true,
            status: true,
            transitType: true,
            goodsHandoverDate: true,
            etd: true,
            eta: true,
            cancelReason: true,
            customer: { select: { name: true } },
            pol: { select: { name: true, portCode: true } },
            pod: { select: { name: true, portCode: true } },
            commodities: {
              where: { isActive: true },
              select: { commodityItem: { select: { name: true } } },
            },
            quotation: {
              select: {
                code: true,
                inquiry: {
                  select: {
                    volumes: {
                      where: { deletedAt: null },
                      select: {
                        quantity: true,
                        cbm: true,
                        weightKg: true,
                        containerSizeNote: true,
                        containerSize: { select: { name: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
        db.shipment.count({ where }),
      ]);

      const detail = await detailsFor(
        db,
        worklist,
        found.map((r) => r.id),
      );
      return { rows: found, total: counted, details: detail };
    });

    const awaiting = new Set<string>(config.awaiting);
    const data: ShipmentWorklistRow[] = rows.map((row) => ({
      id: row.id.toString(),
      quotationCode: row.quotation.code,
      code: row.code,
      customerName: row.customer.name,
      commodity: row.commodities.map((c) => c.commodityItem.name).join(', ') || '—',
      shipmentType: row.shipmentType,
      polName: row.pol.name,
      polCode: row.pol.portCode,
      podName: row.pod.name,
      podCode: row.pod.portCode,
      requiredContainer: renderVolumes(row.quotation.inquiry.volumes),
      transitType: row.transitType,
      goodsHandoverDate: dateOut(row.goodsHandoverDate),
      etd: dateOut(row.etd),
      eta: dateOut(row.eta),
      status: row.status,
      cancelReason: row.cancelReason,
      awaiting: awaiting.has(row.status),
      detail: details.get(row.id.toString()) ?? '—',
    }));

    const payload: ApiSuccess<ShipmentWorklistRow[]> = {
      success: true,
      data,
      meta: buildMeta(query.page, query.limit, total),
    };
    res.json(payload);
  };
  return route;
}

shipmentWorklistRouter.get(
  '/shipment-approvals',
  requirePermission(`${SHIPMENT_WORKLISTS.APPROVAL.feature}.VIEW`),
  handler('APPROVAL'),
);

shipmentWorklistRouter.get(
  '/shipping-orders',
  requirePermission(`${SHIPMENT_WORKLISTS.SHIPPING_ORDER.feature}.VIEW`),
  handler('SHIPPING_ORDER'),
);

opsWorklistRouter.get(
  '/cargo-receipts',
  requirePermission(`${SHIPMENT_WORKLISTS.CARGO_RECEIPT.feature}.VIEW`),
  handler('CARGO_RECEIPT'),
);
