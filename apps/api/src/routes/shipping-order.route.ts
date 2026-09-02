import { Router } from 'express';

import {
  type ApiSuccess,
  type ShippingOrderDto,
  shippingOrderIssueSchema,
  shippingOrderQrPayload,
  shippingOrderSkipSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { nextShippingOrderNo, seriesYearOf } from '../lib/inquiry-no';
import { parseId } from '../lib/request';
import { renderShippingOrderPdf } from '../lib/shipping-order-pdf';
import { transitionShipment } from '../lib/shipment-status';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Shipping Order (docs/MODULE_BOOKING_CARGO.md §4.3, §5.4, §6.6) — phase H.
 *
 * §5.4 rule 2 is the spine: "Numbered on issue, never on draft. Issuing is a
 * one-way action; a mistake is cancelled and reissued with a new number." So
 * there is no draft, no PATCH, and no way to edit an issued document — only
 * cancel it and issue another.
 *
 * §5.4 rule 1 is the other half: an S/O pulls the APPROVED POs only. A PO the
 * customer held back is not on the paper the warehouse works to, which is the
 * whole point of §5.3 approving them one at a time.
 */
export const shippingOrderRouter: Router = Router();

const FEATURE = 'CUSTOMER_SERVICE.SHIPPING_ORDER';

shippingOrderRouter.use(authenticate);

const soArgs = {
  include: {
    issuedByUser: { select: { username: true } },
  },
} satisfies { include: Prisma.ShippingOrderInclude };

type SoRow = Prisma.ShippingOrderGetPayload<typeof soArgs>;

const stamp = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

function toDto(row: SoRow, poNumbers: string[]): ShippingOrderDto {
  return {
    id: row.id.toString(),
    code: row.code,
    status: row.status,
    issueDate: day(row.issueDate),
    issuedByName: row.issuedByUser?.username ?? null,
    firstVesselName: row.firstVesselName,
    firstFlightNo: row.firstFlightNo,
    cutOff: stamp(row.cutOff),
    etd: stamp(row.etd),
    eta: stamp(row.eta),
    warehouseCfs: row.warehouseCfs,
    qrPayload: row.qrPayload,
    skipReason: row.skipReason,
    cancelReason: row.cancelReason,
    poNumbers,
  };
}

/** The live S/O for a booking, and the approved POs travelling on it. */
async function loadLive(
  db: TenantDb,
  shipmentId: bigint,
): Promise<ShippingOrderDto | null> {
  const row = await db.shippingOrder.findFirst({
    where: { shipmentId, deletedAt: null, status: { in: ['ISSUED', 'SKIPPED'] } },
    ...soArgs,
  });
  if (row === null) return null;

  const pos = await db.shipmentPo.findMany({
    where: { shipmentId, deletedAt: null, approvalStatus: 'APPROVED' },
    orderBy: { poNo: 'asc' },
    select: { poNo: true },
  });
  return toDto(row, pos.map((p) => p.poNo));
}

/** Everything the document needs, gathered once. */
async function gather(db: TenantDb, shipmentId: bigint) {
  const shipment = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: {
      id: true,
      code: true,
      status: true,
      shipmentType: true,
      exporterName: true,
      exporterAddress: true,
      importerName: true,
      importerAddress: true,
      warehouseCfs: true,
      customer: { select: { name: true } },
      carrier: { select: { name: true } },
      quotation: { select: { code: true, movementType: true } },
      pol: { select: { name: true } },
      pod: { select: { name: true } },
    },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');
  return shipment;
}

/**
 * GET /bookings/:id/shipping-order — the live one, or null.
 *
 * Null is an answer, not an error: a booking that has not reached the point of
 * issuing one is the ordinary case, and the screen says so.
 */
shippingOrderRouter.get(
  '/bookings/:id/shipping-order',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');

    const data = await withTenant(auth.tenantId, async (db) => {
      await gather(db, shipmentId);
      return loadLive(db, shipmentId);
    });

    const payload: ApiSuccess<ShippingOrderDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /bookings/:id/shipping-order — issue it (§5.4).
 *
 * Everything the paper says is snapshotted here rather than joined. §5.4 rule 2
 * makes this a document: the vessel, the timings and the cargo figures are what
 * they were at the moment of issue, and an edit to the schedule afterwards must
 * not silently rewrite the page a warehouse is holding.
 */
shippingOrderRouter.post(
  '/bookings/:id/shipping-order',
  requirePermission(`${FEATURE}.ISSUE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = shippingOrderIssueSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const shipment = await gather(db, shipmentId);

      const existing = await db.shippingOrder.findFirst({
        where: { shipmentId, deletedAt: null, status: { in: ['ISSUED', 'SKIPPED'] } },
        select: { code: true },
      });
      if (existing !== null) {
        throw new HttpError(
          409,
          'ALREADY_ISSUED',
          `${shipment.code} already has ${existing.code}. Cancel it before issuing another.`,
        );
      }

      const schedule = await db.shipmentSchedule.findFirst({
        where: { shipmentId, deletedAt: null, status: 'APPROVED' },
        select: {
          id: true,
          cutOffDate: true,
          legs: {
            where: { deletedAt: null },
            orderBy: { legNo: 'asc' },
            select: {
              vesselId: true,
              flightNo: true,
              etd: true,
              eta: true,
              vessel: { select: { name: true } },
            },
          },
        },
      });
      if (schedule === null) {
        throw new HttpError(
          409,
          'NO_APPROVED_SCHEDULE',
          `${shipment.code} has no approved schedule. A shipping order follows the customer's approval.`,
        );
      }

      // §5.4 rule 1: the approved POs only.
      const approved = await db.shipmentPo.findMany({
        where: { shipmentId, deletedAt: null, approvalStatus: 'APPROVED' },
        orderBy: { poNo: 'asc' },
        select: { id: true, poNo: true },
      });
      if (approved.length === 0) {
        throw new HttpError(
          409,
          'NOTHING_APPROVED',
          `No PO on ${shipment.code} has been approved, so there is nothing to instruct.`,
        );
      }

      const totals = await db.shipmentCargoLine.aggregate({
        where: { shipmentId, deletedAt: null, shipmentPoId: { in: approved.map((p) => p.id) } },
        _sum: { ctnQty: true, grossWeightKg: true, volumeCbm: true },
      });

      const first = schedule.legs[0];
      const last = schedule.legs[schedule.legs.length - 1];
      const seriesYear = seriesYearOf(new Date());

      let created: { id: bigint } | null = null;
      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
        const code = await nextShippingOrderNo(db, auth.tenantId, seriesYear);
        // §9 Q5: the compact offline payload, built from what is being issued.
        const qrPayload = shippingOrderQrPayload({
          soNo: code,
          bookingNo: shipment.code,
          carrierName: shipment.carrier.name,
          ctnQty: totals._sum.ctnQty ?? 0,
          grossWeightKg: Number(totals._sum.grossWeightKg ?? 0),
          volumeCbm: Number(totals._sum.volumeCbm ?? 0),
        });
        try {
          created = await db.shippingOrder.create({
            data: {
              tenantId: auth.tenantId,
              code,
              seriesYear,
              shipmentId,
              scheduleId: schedule.id,
              issueDate: new Date(),
              issuedBy: auth.userId,
              firstVesselId: first?.vesselId ?? null,
              firstVesselName: first?.vessel?.name ?? null,
              firstFlightNo: first?.flightNo ?? null,
              cutOff: schedule.cutOffDate,
              etd: first?.etd ?? null,
              eta: last?.eta ?? null,
              warehouseCfs: input.warehouseCfs || shipment.warehouseCfs || null,
              qrPayload,
              status: 'ISSUED',
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: { id: true },
          });
          break;
        } catch (error) {
          if (attempt === CODE_RETRY_LIMIT - 1 || !isUniqueViolation(error, 'code')) throw error;
        }
      }
      if (created === null) {
        throw new HttpError(500, 'CODE_EXHAUSTED', 'Could not allocate a shipping order number.');
      }

      await transitionShipment(db, { shipmentId, to: 'SO_ISSUED', userId: auth.userId });
      return loadLive(db, shipmentId);
    });

    const payload: ApiSuccess<ShippingOrderDto | null> = { success: true, data };
    res.status(201).json(payload);
  },
);

/**
 * POST /bookings/:id/shipping-order/skip — §5.4 rule 3.
 *
 * "Inbound shipments skip the S/O. Show a SKIP S/O button when the movement is
 * Inbound; it sets SO_SKIPPED and requires no document." A row is still written,
 * because "we deliberately issued none, and here is why" is a fact the file has
 * to carry — and §4.4's cargo receipt works with a null shipping_order_id.
 */
shippingOrderRouter.post(
  '/bookings/:id/shipping-order/skip',
  requirePermission(`${FEATURE}.SKIP`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = shippingOrderSkipSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const shipment = await gather(db, shipmentId);

      // The button only shows on inbound (§6.6), and the route holds the same
      // line — a screen rule that the API does not share is a suggestion.
      if (shipment.quotation.movementType !== 'INBOUND') {
        throw new HttpError(
          409,
          'NOT_INBOUND',
          `${shipment.code} is an outbound shipment and needs a shipping order.`,
        );
      }

      const existing = await db.shippingOrder.findFirst({
        where: { shipmentId, deletedAt: null, status: { in: ['ISSUED', 'SKIPPED'] } },
        select: { code: true },
      });
      if (existing !== null) {
        throw new HttpError(409, 'ALREADY_ISSUED', `${shipment.code} already has ${existing.code}.`);
      }

      const seriesYear = seriesYearOf(new Date());
      const code = await nextShippingOrderNo(db, auth.tenantId, seriesYear);
      await db.shippingOrder.create({
        data: {
          tenantId: auth.tenantId,
          code,
          seriesYear,
          shipmentId,
          status: 'SKIPPED',
          skipReason: input.reason,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
      });

      await transitionShipment(db, { shipmentId, to: 'SO_SKIPPED', userId: auth.userId });
      return loadLive(db, shipmentId);
    });

    const payload: ApiSuccess<ShippingOrderDto | null> = { success: true, data };
    res.status(201).json(payload);
  },
);

/**
 * POST /bookings/:id/shipping-order/cancel — §5.4 rule 2's way back.
 *
 * The number is not reused. A warehouse that has already seen SO-2026-000001
 * must never be handed a different document wearing the same number.
 */
shippingOrderRouter.post(
  '/bookings/:id/shipping-order/cancel',
  requirePermission(`${FEATURE}.CANCEL`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = shippingOrderSkipSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      await gather(db, shipmentId);
      const live = await db.shippingOrder.findFirst({
        where: { shipmentId, deletedAt: null, status: { in: ['ISSUED', 'SKIPPED'] } },
        select: { id: true },
      });
      if (live === null) throw HttpError.notFound('There is no shipping order to cancel.');

      await db.shippingOrder.update({
        where: { id: live.id },
        data: { status: 'CANCELLED', cancelReason: input.reason, updatedBy: auth.userId },
      });

      // Back to where it was before, so C/S can issue a corrected one.
      await transitionShipment(db, {
        shipmentId,
        to: 'APPROVED_FOR_SHIPMENT',
        userId: auth.userId,
      });
      return loadLive(db, shipmentId);
    });

    const payload: ApiSuccess<ShippingOrderDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * GET /bookings/:id/shipping-order/pdf — §6.6's print-ready document.
 *
 * §5.4 rule 4: the letterhead comes from tenant settings, never hardcoded.
 */
shippingOrderRouter.get(
  '/bookings/:id/shipping-order/pdf',
  requirePermission(`${FEATURE}.EXPORT_PDF`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');

    const { pdf, code } = await withTenant(auth.tenantId, async (db) => {
      const shipment = await gather(db, shipmentId);
      const so = await db.shippingOrder.findFirst({
        where: { shipmentId, deletedAt: null, status: 'ISSUED' },
        ...soArgs,
      });
      if (so === null) {
        throw HttpError.notFound('This booking has no issued shipping order to print.');
      }

      const approved = await db.shipmentPo.findMany({
        where: { shipmentId, deletedAt: null, approvalStatus: 'APPROVED' },
        select: { id: true },
      });
      const lines = await db.shipmentCargoLine.findMany({
        where: { shipmentId, deletedAt: null, shipmentPoId: { in: approved.map((p) => p.id) } },
        orderBy: [{ shipmentPoId: 'asc' }, { id: 'asc' }],
        select: {
          itemCode: true,
          sku: true,
          ctnQty: true,
          pcsQty: true,
          netWeightKg: true,
          grossWeightKg: true,
          volumeCbm: true,
          chargeableWtKg: true,
          shipmentPo: { select: { poNo: true } },
        },
      });

      // §5.4 rule 4: the tenant's own letterhead. The signature block is where
      // a workspace already keeps its address, so the two cannot disagree.
      const settings = await db.notificationSetting.findFirst({
        select: { signatureBlock: true },
      });
      const tenant = await db.tenant.findFirst({
        where: { id: auth.tenantId },
        select: { name: true },
      });

      const sum = (pick: (l: (typeof lines)[number]) => unknown, dp: number): string => {
        let total = 0;
        for (const line of lines) total += Number(pick(line) ?? 0);
        return total.toFixed(dp);
      };

      const isAir = shipment.shipmentType === 'AIR';
      const pdfBuffer = await renderShippingOrderPdf({
        companyName: tenant?.name ?? 'Freight Forwarder',
        companyAddress: settings?.signatureBlock ?? null,
        soNo: so.code,
        bookingNo: shipment.code,
        quotationNo: shipment.quotation.code,
        issueDate: day(so.issueDate) ?? '',
        qrPayload: so.qrPayload ?? so.code,
        customerName: shipment.customer.name,
        exporterName: shipment.exporterName,
        exporterAddress: shipment.exporterAddress,
        importerName: shipment.importerName,
        importerAddress: shipment.importerAddress,
        isAir,
        carrierName: shipment.carrier.name,
        firstVesselOrFlight: isAir ? so.firstFlightNo : so.firstVesselName,
        polName: shipment.pol.name,
        podName: shipment.pod.name,
        cutOff: stamp(so.cutOff),
        etd: stamp(so.etd),
        eta: stamp(so.eta),
        warehouseCfs: so.warehouseCfs,
        lines: lines.map((l) => ({
          poNo: l.shipmentPo.poNo,
          itemCode: l.itemCode,
          sku: l.sku,
          ctnQty: l.ctnQty,
          pcsQty: l.pcsQty,
          netWeightKg: l.netWeightKg?.toString() ?? null,
          grossWeightKg: l.grossWeightKg?.toString() ?? null,
          volumeCbm: l.volumeCbm?.toString() ?? null,
          chargeableWtKg: l.chargeableWtKg?.toString() ?? null,
        })),
        totals: {
          ctnQty: lines.reduce((n, l) => n + l.ctnQty, 0),
          pcsQty: lines.reduce((n, l) => n + (l.pcsQty ?? 0), 0),
          netWeightKg: sum((l) => l.netWeightKg, 3),
          grossWeightKg: sum((l) => l.grossWeightKg, 3),
          volumeCbm: sum((l) => l.volumeCbm, 4),
          chargeableWtKg: sum((l) => l.chargeableWtKg, 3),
        },
      });

      return { pdf: pdfBuffer, code: so.code };
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${code}.pdf"`);
    res.send(pdf);
  },
);
