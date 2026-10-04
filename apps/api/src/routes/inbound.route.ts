import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  DELIVERY_ORDER_SEA_ADDRESSEE,
  deliveryOrderCancelSchema,
  type DeliveryOrderDto,
  deliveryOrderIssueSchema,
  deliveryOrderListQuerySchema,
  type DeliveryOrderPrefillDto,
  type DeliveryOrderRow,
  type DeliveryOrderView,
  type IgmDto,
  igmListQuerySchema,
  type IgmRow,
  igmSaveSchema,
  type IgmView,
  type ShipmentType,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { containersForShipments } from '../lib/bl-draft-view';
import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { renderDeliveryOrderPdf } from '../lib/delivery-order-pdf';
import { HttpError } from '../lib/http-error';
import { nextDeliveryOrderNo, seriesYearOf } from '../lib/inquiry-no';
import { letterheadOf } from '../lib/letterhead';
import { logger } from '../lib/logger';
import { day, milestonePicks, milestoneRows } from '../lib/milestone';
import { parseId } from '../lib/request';
import { displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * Operation → IGM Submission and DO Issue — inbound bookings only
 * (docs/DESIGN-UPDATE-2026-10-04.md §4; the Steps table: "IGM update —
 * Outbound Skip, Inbound Yes", "DO issue — Outbound Skip, Inbound Yes").
 *
 * Both lists are the Arrival sheet's booking rows (lib/milestone.ts, without
 * waiting for a confirmed departure — an inbound booking's departure is the
 * overseas agent's to report), narrowed to INBOUND quotations, with the
 * stage's own state beside them.
 */

export const inboundRouter: Router = Router();
inboundRouter.use(authenticate);

const IGM = 'OPERATION.IGM_SUBMISSION';
const DO = 'OPERATION.DO_ISSUE';

const IGM_IN = Prisma.sql`EXISTS (
  SELECT 1 FROM igm_update g
   WHERE g.tenant_id = s.tenant_id AND g.shipment_id = s.id
     AND g.deleted_at IS NULL AND g.igm_file IS NOT NULL
)`;
const DO_ISSUED = Prisma.sql`EXISTS (
  SELECT 1 FROM delivery_order d
   WHERE d.tenant_id = s.tenant_id AND d.shipment_id = s.id
     AND d.deleted_at IS NULL AND d.status = 'ISSUED'
)`;

function igmViewConditions(view: IgmView): Prisma.Sql[] {
  if (view === 'AWAITING') return [Prisma.sql`NOT ${IGM_IN}`];
  if (view === 'UPDATED') return [IGM_IN];
  return [];
}

function doViewConditions(view: DeliveryOrderView): Prisma.Sql[] {
  if (view === 'AWAITING') return [Prisma.sql`NOT ${DO_ISSUED}`];
  if (view === 'ISSUED') return [DO_ISSUED];
  return [];
}

/**
 * Whether a booking may be worked on these screens, with the reason when not
 * — asked of the same query the lists use, so the two cannot disagree.
 */
async function assertInbound(db: TenantDb, tenantId: bigint, shipmentId: bigint): Promise<{ code: string; shipmentType: ShipmentType }> {
  const booking = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: { code: true, status: true, shipmentType: true, quotation: { select: { movementType: true } } },
  });
  if (booking === null) throw HttpError.notFound('Booking not found.');
  if (booking.quotation.movementType !== 'INBOUND') {
    throw new HttpError(409, 'NOT_INBOUND', `${booking.code} is an outbound booking. IGM and DO are for inbound shipments only.`);
  }
  if (booking.status === 'CANCELLED' || booking.status === 'REJECTED') {
    throw new HttpError(409, 'BOOKING_CLOSED', `${booking.code} is ${booking.status.toLowerCase()}.`);
  }
  const { picks } = await milestonePicks(
    db,
    tenantId,
    { kind: 'ARRIVED', view: 'ALL', requireDeparture: false, inboundOnly: true, shipmentId },
    { by: 'date', order: 'asc' },
    { page: 1, limit: 1 },
  );
  if (picks.length === 0) {
    throw new HttpError(409, 'NO_SCHEDULE', `${booking.code} has no approved schedule or advise yet.`);
  }
  return { code: booking.code, shipmentType: booking.shipmentType };
}

const IGM_SELECT = {
  shipmentId: true,
  hblNo: true,
  igmFile: true,
  updatedAt: true,
  updatedByUser: { select: { username: true } },
} as const;

function igmDto(row: { hblNo: string | null; igmFile: string | null; updatedAt: Date; updatedByUser: { username: string } | null }): IgmDto {
  return {
    hblNo: row.hblNo,
    fileName: row.igmFile === null ? null : displayNameFromKey(row.igmFile),
    updated: row.igmFile !== null,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedByUser?.username ?? null,
  };
}

// ===========================================================================
// IGM Update (sheet `IGM Update`, Menu I7)
// ===========================================================================

inboundRouter.get('/igm', requirePermission(`${IGM}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = igmListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const found = await milestonePicks(
      db,
      auth.tenantId,
      {
        kind: 'ARRIVED',
        view: 'ALL',
        requireDeparture: false,
        inboundOnly: true,
        shipmentType: query.shipmentType,
        search: query.search,
        extra: igmViewConditions(query.view),
      },
      { by: query.sortBy ?? 'date', order: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
    const base = await milestoneRows(db, 'ARRIVED', found.picks);
    const igms = await db.igmUpdate.findMany({
      where: { shipmentId: { in: found.picks.map((p) => p.shipmentId) }, deletedAt: null },
      select: IGM_SELECT,
    });
    const igmOf = new Map(igms.map((g) => [g.shipmentId.toString(), g]));
    const withIgm: IgmRow[] = base.map((row) => {
      const igm = igmOf.get(row.shipmentId);
      return { ...row, igm: igm === undefined ? null : igmDto(igm) };
    });
    return { rows: withIgm, total: found.total };
  });

  const payload: ApiSuccess<IgmRow[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

/**
 * The sheet's Save: the HBL No, and the IGM file when one is attached. JSON
 * without a file, multipart with one. The first save needs CREATE; changing
 * what is there needs EDIT.
 */
inboundRouter.post(
  '/igm/:shipmentId',
  requireAnyPermission(`${IGM}.CREATE`, `${IGM}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.shipmentId, 'booking');
    const input = igmSaveSchema.parse(req.body);
    const file = req.file;

    const { saved, replacedFile } = await withTenant(auth.tenantId, async (db) => {
      await assertInbound(db, auth.tenantId, shipmentId);
      const existing = await db.igmUpdate.findFirst({
        where: { shipmentId, deletedAt: null },
        select: { id: true, igmFile: true },
      });
      const needed = existing === null ? `${IGM}.CREATE` : `${IGM}.EDIT`;
      if (!auth.isSuperadmin && !auth.permissions.has(needed)) {
        throw HttpError.forbidden(
          existing === null ? 'You may change an IGM but not record a new one.' : 'You may record an IGM but not change one.',
        );
      }

      const stored = file === undefined ? null : await putFile(auth.tenantId, 'igm', file);
      const data = {
        hblNo: input.hblNo,
        ...(stored === null ? {} : { igmFile: stored.key }),
        updatedBy: auth.userId,
      };
      const row =
        existing === null
          ? await db.igmUpdate.create({
              data: { tenantId: auth.tenantId, shipmentId, ...data, createdBy: auth.userId },
              select: IGM_SELECT,
            })
          : await db.igmUpdate.update({ where: { id: existing.id }, data, select: IGM_SELECT });
      return { saved: row, replacedFile: stored !== null && existing?.igmFile != null ? existing.igmFile : null };
    });

    // Removed after the row points at the new file, so a failure here never
    // leaves the record naming a deleted one.
    if (replacedFile !== null) await removeFile(auth.tenantId, replacedFile);

    const payload: ApiSuccess<IgmDto> = { success: true, data: igmDto(saved) };
    res.json(payload);
  },
);

inboundRouter.get('/igm/:shipmentId/file', requirePermission(`${IGM}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.shipmentId, 'booking');
  const key = await withTenant(auth.tenantId, async (db) => {
    const row = await db.igmUpdate.findFirst({ where: { shipmentId, deletedAt: null }, select: { igmFile: true } });
    if (row === null || row.igmFile === null) throw HttpError.notFound('No IGM file has been uploaded.');
    return row.igmFile;
  });
  const { stream, sizeBytes } = await openFile(auth.tenantId, key);
  // Only PDF and JPEG are accepted as an IGM (M16), so the name says which.
  res.setHeader('Content-Type', /\.pdf$/i.test(key) ? 'application/pdf' : 'image/jpeg');
  res.setHeader('Content-Length', sizeBytes);
  res.setHeader('Content-Disposition', `attachment; filename="${displayNameFromKey(key).replace(/"/g, '')}"`);
  stream.pipe(res);
});

// ===========================================================================
// DO Issue (sheet `DO issue`, Menu I8)
// ===========================================================================

const DO_SELECT = {
  id: true,
  code: true,
  shipmentId: true,
  issueDate: true,
  addressee: true,
  subject: true,
  body: true,
  status: true,
  pdfFile: true,
  issuedAt: true,
  cancelledAt: true,
  cancelReason: true,
  issuedByUser: { select: { username: true } },
} as const;

type DoRecord = Prisma.DeliveryOrderGetPayload<{ select: typeof DO_SELECT }>;

function doDto(row: DoRecord): DeliveryOrderDto {
  return {
    id: row.id.toString(),
    code: row.code,
    issueDate: day(row.issueDate) ?? '',
    addressee: row.addressee,
    subject: row.subject,
    body: row.body,
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
    issuedByName: row.issuedByUser?.username ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    hasPdf: row.pdfFile !== null,
  };
}

inboundRouter.get('/delivery-orders', requirePermission(`${DO}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = deliveryOrderListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const found = await milestonePicks(
      db,
      auth.tenantId,
      {
        kind: 'ARRIVED',
        view: 'ALL',
        requireDeparture: false,
        inboundOnly: true,
        shipmentType: query.shipmentType,
        search: query.search,
        extra: doViewConditions(query.view),
      },
      { by: query.sortBy ?? 'date', order: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
    const ids = found.picks.map((p) => p.shipmentId);
    const [base, igms, orders] = await Promise.all([
      milestoneRows(db, 'ARRIVED', found.picks),
      db.igmUpdate.findMany({ where: { shipmentId: { in: ids }, deletedAt: null }, select: IGM_SELECT }),
      // Issued first, then the newest cancelled: the row shows the order that
      // stands, or the last one that did.
      db.deliveryOrder.findMany({
        where: { shipmentId: { in: ids }, deletedAt: null },
        orderBy: [{ status: 'asc' }, { id: 'desc' }],
        select: DO_SELECT,
      }),
    ]);
    const igmOf = new Map(igms.map((g) => [g.shipmentId.toString(), g]));
    const orderOf = new Map<string, DoRecord>();
    for (const order of orders) {
      const key = order.shipmentId.toString();
      if (!orderOf.has(key)) orderOf.set(key, order);
    }
    const out: DeliveryOrderRow[] = base.map((row) => {
      const igm = igmOf.get(row.shipmentId);
      const order = orderOf.get(row.shipmentId);
      return {
        ...row,
        hblNo: igm?.hblNo ?? null,
        igmUpdated: igm?.igmFile != null,
        deliveryOrder: order === undefined ? null : doDto(order),
      };
    });
    return { rows: out, total: found.total };
  });

  const payload: ApiSuccess<DeliveryOrderRow[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

/** What `ISSUE DO` opens on. Nothing is saved by reading it. */
inboundRouter.get('/delivery-orders/prefill/:shipmentId', requirePermission(`${DO}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.shipmentId, 'booking');
  const data = await withTenant(auth.tenantId, async (db): Promise<DeliveryOrderPrefillDto> => {
    const booking = await assertInbound(db, auth.tenantId, shipmentId);
    const [igm, containers] = await Promise.all([
      db.igmUpdate.findFirst({ where: { shipmentId, deletedAt: null }, select: { hblNo: true, igmFile: true } }),
      booking.shipmentType === 'AIR' ? Promise.resolve([]) : containersForShipments(db, [shipmentId]),
    ]);
    return {
      bookingCode: booking.code,
      addressee: booking.shipmentType === 'AIR' ? '' : DELIVERY_ORDER_SEA_ADDRESSEE,
      hblNo: igm?.hblNo ?? null,
      igmUpdated: igm?.igmFile != null,
      containers: containers.map((c) => ({ containerNo: c.containerNo, sealNo: c.sealNo, size: c.containerSize })),
    };
  });
  const payload: ApiSuccess<DeliveryOrderPrefillDto> = { success: true, data };
  res.json(payload);
});

async function renderFor(db: TenantDb, tenantId: bigint, order: DoRecord): Promise<{ pdf: Buffer; filename: string }> {
  const [letterhead, booking, igm, containers] = await Promise.all([
    letterheadOf(db, tenantId),
    db.shipment.findFirst({ where: { id: order.shipmentId }, select: { code: true, shipmentType: true } }),
    db.igmUpdate.findFirst({ where: { shipmentId: order.shipmentId, deletedAt: null }, select: { hblNo: true } }),
    containersForShipments(db, [order.shipmentId]),
  ]);
  const pdf = await renderDeliveryOrderPdf({
    ...letterhead,
    doNo: order.code,
    issueDate: day(order.issueDate) ?? '',
    addressee: order.addressee,
    subject: order.subject,
    body: order.body,
    bookingNo: booking?.code ?? '',
    hblNo: igm?.hblNo ?? null,
    containers:
      booking?.shipmentType === 'AIR'
        ? []
        : containers.map((c) => ({ containerNo: c.containerNo, size: c.containerSize, sealNo: c.sealNo })),
  });
  return { pdf, filename: `${order.code}.pdf` };
}

/**
 * `ISSUE DO`. Waits on the IGM (§11 Q13): a delivery order for cargo the
 * manifest has not been lodged for would be released against nothing.
 */
inboundRouter.post('/delivery-orders', requirePermission(`${DO}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = deliveryOrderIssueSchema.parse(req.body);
  const shipmentId = BigInt(input.shipmentId);
  const issueDate = new Date(`${input.issueDate}T00:00:00.000Z`);

  const order = await withTenant(auth.tenantId, async (db) => {
    const booking = await assertInbound(db, auth.tenantId, shipmentId);
    const igm = await db.igmUpdate.findFirst({ where: { shipmentId, deletedAt: null }, select: { igmFile: true } });
    if (igm?.igmFile == null) {
      throw new HttpError(409, 'IGM_FIRST', `Upload ${booking.code}'s IGM on IGM Submission before issuing its DO.`);
    }

    const year = seriesYearOf(issueDate);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextDeliveryOrderNo(db, auth.tenantId, year);
      try {
        return await db.deliveryOrder.create({
          data: {
            tenantId: auth.tenantId,
            code,
            seriesYear: year,
            shipmentId,
            issueDate,
            addressee: input.addressee,
            subject: input.subject,
            body: input.body ?? null,
            issuedBy: auth.userId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: DO_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        if (isUniqueViolation(error)) {
          throw new HttpError(409, 'ALREADY_ISSUED', `${booking.code} already has a DO. Cancel it first to issue another.`);
        }
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a DO number.');
  });

  /*
   * The letter is printed once and stored, so every reprint is the letter
   * that went. A failure here does not undo the order: it prints on demand.
   */
  const stored = await withTenant(auth.tenantId, async (db) => {
    try {
      const doc = await renderFor(db, auth.tenantId, order);
      const file = await putFile(auth.tenantId, 'delivery-order', {
        buffer: doc.pdf,
        originalname: doc.filename,
        mimetype: 'application/pdf',
        size: doc.pdf.length,
      });
      return db.deliveryOrder.update({ where: { id: order.id }, data: { pdfFile: file.key }, select: DO_SELECT });
    } catch (error) {
      logger.error({ err: error, deliveryOrderId: order.id.toString() }, 'DO letter not stored');
      return order;
    }
  });

  const payload: ApiSuccess<DeliveryOrderDto> = { success: true, data: doDto(stored) };
  res.status(201).json(payload);
});

inboundRouter.get('/delivery-orders/:id/pdf', requirePermission(`${DO}.EXPORT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'delivery order');
  const result = await withTenant(auth.tenantId, async (db) => {
    const order = await db.deliveryOrder.findFirst({ where: { id, deletedAt: null }, select: DO_SELECT });
    if (order === null) throw HttpError.notFound('Delivery order not found.');
    if (order.pdfFile !== null) return { key: order.pdfFile, filename: `${order.code}.pdf`, pdf: null };
    const doc = await renderFor(db, auth.tenantId, order);
    return { key: null, filename: doc.filename, pdf: doc.pdf };
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  if (result.pdf !== null) {
    res.send(result.pdf);
    return;
  }
  const { stream, sizeBytes } = await openFile(auth.tenantId, result.key!);
  res.setHeader('Content-Length', sizeBytes);
  stream.pipe(res);
});

/** A wrong order is cancelled with a reason and issued again; its number is kept. */
inboundRouter.post('/delivery-orders/:id/cancel', requirePermission(`${DO}.TOGGLE_STATUS`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'delivery order');
  const input = deliveryOrderCancelSchema.parse(req.body);
  const data = await withTenant(auth.tenantId, async (db) => {
    const order = await db.deliveryOrder.findFirst({ where: { id, deletedAt: null }, select: { id: true, code: true, status: true } });
    if (order === null) throw HttpError.notFound('Delivery order not found.');
    if (order.status === 'CANCELLED') throw new HttpError(409, 'ALREADY_CANCELLED', `${order.code} is already cancelled.`);
    const updated = await db.deliveryOrder.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: auth.userId,
        cancelReason: input.reason,
        updatedBy: auth.userId,
      },
      select: DO_SELECT,
    });
    return doDto(updated);
  });
  const payload: ApiSuccess<DeliveryOrderDto> = { success: true, data };
  res.json(payload);
});
