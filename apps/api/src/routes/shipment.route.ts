import { Router } from 'express';

import {
  type ApiSuccess,
  type ShipmentCargoLineDto,
  type ShipmentCargoLineInput,
  shipmentCancelSchema,
  shipmentCreateSchema,
  type ShipmentDto,
  SHIPMENT_EDITABLE,
  type ShipmentPrefillDto,
  shipmentUpdateSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { nextBookingNo, seriesYearOf } from '../lib/inquiry-no';
import { parseId, parseRefId } from '../lib/request';
import { transitionShipment } from '../lib/shipment-status';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Shipment Booking (docs/MODULE_BOOKING_CARGO.md §6.1) — phase B.
 *
 * §2.1: the booking is the shipment file, so this router owns the record every
 * later module will hang off. §3 says sea and air are one screen with
 * mode-conditional fields, and they are one set of routes for the same reason —
 * `shipment_type` comes down from the quotation and nothing here branches on it.
 *
 * §2.2's hierarchy is the shape worth understanding. The screen draws one flat
 * grid; the database holds PO -> line. The grid therefore sends a PO NUMBER on
 * every row and this router resolves it, creating the `shipment_po` the first
 * time a number appears and retiring the ones no row mentions any more.
 */
export const shipmentRouter: Router = Router();

const FEATURE = 'CUSTOMER_SERVICE.CARGO_BOOKING';

shipmentRouter.use(authenticate);

/** Dates cross the wire as YYYY-MM-DD and are stored at UTC midnight. */
function toDate(value: string | null | undefined): Date | null {
  return value == null || value === '' ? null : new Date(`${value}T00:00:00.000Z`);
}

function dateOut(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function refOrNull(value: string | null | undefined, label: string): bigint | null {
  return value == null || value === '' ? null : parseRefId(value, label);
}

const shipmentArgs = {
  include: {
  quotation: { select: { id: true, code: true, movementType: true } },
  customer: { select: { id: true, name: true } },
  carrier: { select: { id: true, name: true } },
  pol: { select: { id: true, name: true, portCode: true } },
  pod: { select: { id: true, name: true, portCode: true } },
  goodsType: { select: { id: true, name: true } },
  tos: { select: { id: true, name: true } },
  mode: { select: { id: true, name: true } },
  commodities: {
    where: { isActive: true },
    select: {
      id: true,
      commodityItemId: true,
      hsCode: true,
      commodityItem: { select: { name: true } },
    },
  },
  pos: {
    where: { deletedAt: null },
    orderBy: { poNo: 'asc' },
    select: {
      id: true,
      poNo: true,
      approvalStatus: true,
      approvedAt: true,
      rejectionComments: true,
    },
  },
  cargoLines: {
    where: { deletedAt: null },
    orderBy: [{ shipmentPoId: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      shipmentPoId: true,
      itemCode: true,
      sku: true,
      ctnQty: true,
      pcsQty: true,
      netWeightKg: true,
      grossWeightKg: true,
      cartonLengthCm: true,
      cartonWidthCm: true,
      cartonHeightCm: true,
      volumeCbm: true,
      chargeableWtKg: true,
      dc: true,
      soCtnQty: true,
      shipmentPo: { select: { poNo: true } },
    },
  },
  },
} satisfies { include: Prisma.ShipmentInclude };

/** Exactly what the query above returns, so toDto needs no casts. */
type ShipmentRow = Prisma.ShipmentGetPayload<typeof shipmentArgs>;

function toDto(row: ShipmentRow): ShipmentDto {
  return {
    id: row.id.toString(),
    code: row.code,
    seriesYear: row.seriesYear,
    status: row.status,
    submittedAt: row.submittedAt === null ? null : row.submittedAt.toISOString(),
    cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
    cancelReason: row.cancelReason,

    quotationId: row.quotationId.toString(),
    quotationCode: row.quotation.code,
    shipmentType: row.shipmentType,
    // §5.4's inbound SKIP S/O reads this. Not stored on the booking: §4.1's
    // column list has no movement_type, and the quotation already carries it.
    movementType: row.quotation.movementType,

    customerId: row.customerId.toString(),
    customerName: row.customer.name,
    exporterName: row.exporterName,
    exporterAddress: row.exporterAddress,
    importerName: row.importerName,
    importerAddress: row.importerAddress,

    goodsTypeId: row.goodsTypeId === null ? null : row.goodsTypeId.toString(),
    goodsTypeName: row.goodsType?.name ?? null,
    placeOfReceipt: row.placeOfReceipt,
    loadingType: row.loadingType,
    tosId: row.tosId === null ? null : row.tosId.toString(),
    tosName: row.tos?.name ?? null,
    modeId: row.modeId === null ? null : row.modeId.toString(),
    modeName: row.mode?.name ?? null,

    carrierId: row.carrierId.toString(),
    carrierName: row.carrier.name,
    polId: row.polId.toString(),
    polName: row.pol.name,
    polCode: row.pol.portCode,
    podId: row.podId.toString(),
    podName: row.pod.name,
    podCode: row.pod.portCode,

    etd: dateOut(row.etd),
    eta: dateOut(row.eta),
    goodsHandoverDate: dateOut(row.goodsHandoverDate),
    transitType: row.transitType,
    warehouseCfs: row.warehouseCfs,

    commodities: row.commodities.map((c) => ({
      id: c.id.toString(),
      commodityItemId: c.commodityItemId.toString(),
      commodityName: c.commodityItem?.name ?? '—',
      hsCode: c.hsCode,
    })),
    pos: row.pos.map((p) => ({
      id: p.id.toString(),
      poNo: p.poNo,
      approvalStatus: p.approvalStatus,
      approvedAt: p.approvedAt === null ? null : p.approvedAt.toISOString(),
      rejectionComments: p.rejectionComments,
    })),
    cargoLines: row.cargoLines.map(
      (l): ShipmentCargoLineDto => ({
        id: l.id.toString(),
        shipmentPoId: l.shipmentPoId.toString(),
        poNo: l.shipmentPo.poNo,
        itemCode: l.itemCode,
        sku: l.sku,
        ctnQty: l.ctnQty,
        pcsQty: l.pcsQty,
        netWeightKg: l.netWeightKg?.toString() ?? null,
        grossWeightKg: l.grossWeightKg?.toString() ?? null,
        cartonLengthCm: l.cartonLengthCm?.toString() ?? null,
        cartonWidthCm: l.cartonWidthCm?.toString() ?? null,
        cartonHeightCm: l.cartonHeightCm?.toString() ?? null,
        volumeCbm: l.volumeCbm?.toString() ?? null,
        chargeableWtKg: l.chargeableWtKg?.toString() ?? null,
        dc: l.dc,
        soCtnQty: l.soCtnQty,
      }),
    ),
  };
}

async function loadShipment(db: TenantDb, id: bigint): Promise<ShipmentDto> {
  const row = await db.shipment.findFirst({ where: { id, deletedAt: null }, ...shipmentArgs });
  if (row === null) throw HttpError.notFound('Booking not found.');
  return toDto(row);
}

/**
 * Reconciles the flat grid onto §2.2's PO -> line hierarchy, in one pass.
 *
 * The screen has no concept of a PO row; it has a PO column. So every distinct
 * number in the grid becomes or finds a `shipment_po`, every line is written
 * under the right one, and anything the grid no longer mentions is soft
 * deleted. Lines go first — a PO with a live line under it cannot be retired.
 */
async function reconcileCargo(
  db: TenantDb,
  tenantId: bigint,
  shipmentId: bigint,
  userId: bigint,
  lines: readonly ShipmentCargoLineInput[],
): Promise<void> {
  const existingPos = await db.shipmentPo.findMany({
    where: { shipmentId, deletedAt: null },
    select: { id: true, poNo: true },
  });
  const poByNo = new Map(existingPos.map((p) => [p.poNo, p.id]));

  const wantedNos = [...new Set(lines.map((l) => l.poNo.trim()))];
  for (const poNo of wantedNos) {
    if (poByNo.has(poNo)) continue;
    const created = await db.shipmentPo.create({
      data: { tenantId, shipmentId, poNo, createdBy: userId, updatedBy: userId },
      select: { id: true },
    });
    poByNo.set(poNo, created.id);
  }

  const existingLines = await db.shipmentCargoLine.findMany({
    where: { shipmentId, deletedAt: null },
    select: { id: true },
  });
  const keptLineIds = new Set<bigint>();

  for (const line of lines) {
    const poId = poByNo.get(line.poNo.trim())!;
    const data = {
      shipmentPoId: poId,
      itemCode: line.itemCode,
      sku: line.sku || null,
      ctnQty: line.ctnQty,
      pcsQty: line.pcsQty ?? null,
      netWeightKg: line.netWeightKg ?? null,
      grossWeightKg: line.grossWeightKg ?? null,
      cartonLengthCm: line.cartonLengthCm ?? null,
      cartonWidthCm: line.cartonWidthCm ?? null,
      cartonHeightCm: line.cartonHeightCm ?? null,
      dc: line.dc || null,
      updatedBy: userId,
    };

    if (line.id !== undefined && line.id !== '') {
      const id = parseRefId(line.id, 'cargo line');
      const owned = await db.shipmentCargoLine.findFirst({
        where: { id, shipmentId, deletedAt: null },
        select: { id: true },
      });
      if (owned === null) throw HttpError.notFound('That cargo line is not on this booking.');
      await db.shipmentCargoLine.update({ where: { id }, data });
      keptLineIds.add(id);
    } else {
      const created = await db.shipmentCargoLine.create({
        data: { tenantId, shipmentId, ...data, createdBy: userId },
        select: { id: true },
      });
      keptLineIds.add(created.id);
    }
  }

  const droppedLines = existingLines.filter((l) => !keptLineIds.has(l.id)).map((l) => l.id);
  if (droppedLines.length > 0) {
    await db.shipmentCargoLine.updateMany({
      where: { id: { in: droppedLines } },
      data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
    });
  }

  // A PO nothing points at any more. Soft, like everything here (§4 rule 3),
  // and only ever one still awaiting a decision — §5.3 approves POs, and an
  // approved one is a decision somebody made, not a row to tidy away.
  const orphanPos = await db.shipmentPo.findMany({
    where: {
      shipmentId,
      deletedAt: null,
      approvalStatus: 'PENDING',
      cargoLines: { none: { deletedAt: null } },
    },
    select: { id: true },
  });
  if (orphanPos.length > 0) {
    await db.shipmentPo.updateMany({
      where: { id: { in: orphanPos.map((p) => p.id) } },
      data: { deletedAt: new Date(), isActive: false, updatedBy: userId },
    });
  }
}

/**
 * GET /booking-options — the lookups §6.1's header selects from.
 *
 * Its own endpoint rather than borrowing the purchase or quotation one: those
 * are guarded by their own features, and a customer-service user who may raise
 * a booking should not need a PURCHASE permission to see a port. Ports carry
 * their code alongside the name so every select can read "Chittagong - BDCGP",
 * name first, the way the rest of the product does.
 */
shipmentRouter.get('/booking-options', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;

  const data = await withTenant(auth.tenantId, async (db) => {
    const active = { deletedAt: null, isActive: true } as const;
    const [carriers, ports, goodsTypes, tos, modes] = await Promise.all([
      db.carrier.findMany({ where: active, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      db.port.findMany({
        where: active,
        select: { id: true, name: true, portCode: true },
        orderBy: { name: 'asc' },
      }),
      db.goodsType.findMany({ where: active, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      db.tos.findMany({ where: active, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      db.mode.findMany({ where: active, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);

    const plain = (rows: { id: bigint; name: string }[]) =>
      rows.map((r) => ({ id: r.id.toString(), name: r.name }));

    return {
      carriers: plain(carriers),
      ports: ports.map((p) => ({ id: p.id.toString(), name: p.name, portCode: p.portCode })),
      goodsTypes: plain(goodsTypes),
      tos: plain(tos),
      modes: plain(modes),
    };
  });

  const payload: ApiSuccess<typeof data> = { success: true, data };
  res.json(payload);
});

/**
 * GET /prefill/:quotationId — the header §5.2 rule 2 copies down.
 *
 * Read fresh from the quotation each time the form opens, and written onto the
 * booking only when it saves. Edits on the booking never travel back.
 */
shipmentRouter.get(
  '/bookings/prefill/:quotationId',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const quotationId = parseId(req.params.quotationId, 'quotation');

    const data = await withTenant(auth.tenantId, async (db) => {
      const q = await db.quotation.findFirst({
        where: { id: quotationId, deletedAt: null },
        include: {
          customer: { select: { id: true, name: true } },
          carrier: { select: { id: true, name: true } },
          pol: { select: { id: true, name: true, portCode: true } },
          pod: { select: { id: true, name: true, portCode: true } },
          goodsType: { select: { id: true, name: true } },
          tos: { select: { id: true, name: true } },
          mode: { select: { id: true, name: true } },
          commodities: {
            where: { isActive: true },
            select: { id: true, commodityItemId: true, commodityName: true, hsCode: true },
          },
        },
      });
      if (q === null) throw HttpError.notFound('Quotation not found.');

      const prefill: ShipmentPrefillDto = {
        quotationId: q.id.toString(),
        quotationCode: q.code,
        shipmentType: q.shipmentType,
        movementType: q.movementType,
        customerId: q.customerId.toString(),
        customerName: q.customer.name,
        goodsTypeId: q.goodsTypeId === null ? null : q.goodsTypeId.toString(),
        goodsTypeName: q.goodsType?.name ?? null,
        placeOfReceipt: q.placeOfReceipt,
        loadingType: q.loadingType,
        tosId: q.tosId === null ? null : q.tosId.toString(),
        tosName: q.tos?.name ?? null,
        modeId: q.modeId === null ? null : q.modeId.toString(),
        modeName: q.mode?.name ?? null,
        carrierId: q.carrierId.toString(),
        carrierName: q.carrier.name,
        polId: q.polId.toString(),
        polName: q.pol.name,
        polCode: q.pol.portCode,
        podId: q.podId.toString(),
        podName: q.pod.name,
        podCode: q.pod.portCode,
        etd: dateOut(q.etd),
        eta: dateOut(q.eta),
        transitType: q.transitType,
        commodities: q.commodities.map((c) => ({
          id: c.id.toString(),
          commodityItemId: c.commodityItemId.toString(),
          commodityName: c.commodityName,
          hsCode: c.hsCode,
        })),
      };
      return prefill;
    });

    const payload: ApiSuccess<ShipmentPrefillDto> = { success: true, data };
    res.json(payload);
  },
);

shipmentRouter.get('/bookings/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'booking');
  const data = await withTenant(auth.tenantId, (db) => loadShipment(db, id));
  const payload: ApiSuccess<ShipmentDto> = { success: true, data };
  res.json(payload);
});

shipmentRouter.post('/bookings', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = shipmentCreateSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const quotationId = parseRefId(input.quotationId, 'quotation');
    const quotation = await db.quotation.findFirst({
      where: { id: quotationId, deletedAt: null },
      select: { id: true, shipmentType: true, customerId: true },
    });
    if (quotation === null) throw HttpError.notFound('Quotation not found.');

    // §5.2 rule 1: no unique on quotation_id. One quotation with several
    // exporters yields several bookings, so this is deliberately unguarded.
    let shipmentId: bigint | null = null;
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const seriesYear = seriesYearOf(new Date());
      const code = await nextBookingNo(db, auth.tenantId, seriesYear);
      try {
        const created = await db.shipment.create({
          data: {
            tenantId: auth.tenantId,
            code,
            seriesYear,
            quotationId: quotation.id,
            shipmentType: quotation.shipmentType,
            customerId: quotation.customerId,
            exporterName: input.exporterName || null,
            exporterAddress: input.exporterAddress || null,
            importerName: input.importerName || null,
            importerAddress: input.importerAddress || null,
            goodsTypeId: refOrNull(input.goodsTypeId, 'goods type'),
            placeOfReceipt: input.placeOfReceipt || null,
            loadingType: input.loadingType ?? null,
            tosId: refOrNull(input.tosId, 'terms of shipment'),
            modeId: refOrNull(input.modeId, 'mode'),
            carrierId: parseRefId(input.carrierId, 'carrier'),
            polId: parseRefId(input.polId, 'port of loading'),
            podId: parseRefId(input.podId, 'port of discharge'),
            etd: toDate(input.etd),
            eta: toDate(input.eta),
            goodsHandoverDate: toDate(input.goodsHandoverDate),
            transitType: input.transitType ?? null,
            warehouseCfs: input.warehouseCfs || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: { id: true },
        });
        shipmentId = created.id;
        break;
      } catch (error) {
        if (attempt === CODE_RETRY_LIMIT - 1 || !isUniqueViolation(error, 'code')) throw error;
      }
    }
    if (shipmentId === null) {
      throw new HttpError(500, 'CODE_EXHAUSTED', 'Could not allocate a booking number.');
    }

    // §5.2 rule 2's commodities, inherited from the quotation.
    const commodities = await db.quotationCommodity.findMany({
      where: { quotationId: quotation.id, isActive: true },
      select: { commodityItemId: true, hsCode: true },
    });
    if (commodities.length > 0) {
      await db.shipmentCommodity.createMany({
        data: commodities.map((c) => ({
          tenantId: auth.tenantId,
          shipmentId,
          commodityItemId: c.commodityItemId,
          hsCode: c.hsCode,
        })),
      });
    }

    await reconcileCargo(db, auth.tenantId, shipmentId, auth.userId, input.cargoLines);
    return loadShipment(db, shipmentId);
  });

  const payload: ApiSuccess<ShipmentDto> = { success: true, data };
  res.status(201).json(payload);
});

shipmentRouter.patch('/bookings/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'booking');
  const input = shipmentUpdateSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.shipment.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, code: true },
    });
    if (existing === null) throw HttpError.notFound('Booking not found.');
    assertEditable(existing.status, existing.code);

    await db.shipment.update({
      where: { id },
      data: {
        exporterName: input.exporterName === undefined ? undefined : input.exporterName || null,
        exporterAddress:
          input.exporterAddress === undefined ? undefined : input.exporterAddress || null,
        importerName: input.importerName === undefined ? undefined : input.importerName || null,
        importerAddress:
          input.importerAddress === undefined ? undefined : input.importerAddress || null,
        goodsTypeId:
          input.goodsTypeId === undefined ? undefined : refOrNull(input.goodsTypeId, 'goods type'),
        placeOfReceipt:
          input.placeOfReceipt === undefined ? undefined : input.placeOfReceipt || null,
        loadingType: input.loadingType === undefined ? undefined : (input.loadingType ?? null),
        tosId: input.tosId === undefined ? undefined : refOrNull(input.tosId, 'terms of shipment'),
        modeId: input.modeId === undefined ? undefined : refOrNull(input.modeId, 'mode'),
        carrierId: input.carrierId === undefined ? undefined : parseRefId(input.carrierId, 'carrier'),
        polId: input.polId === undefined ? undefined : parseRefId(input.polId, 'port of loading'),
        podId: input.podId === undefined ? undefined : parseRefId(input.podId, 'port of discharge'),
        etd: input.etd === undefined ? undefined : toDate(input.etd),
        eta: input.eta === undefined ? undefined : toDate(input.eta),
        goodsHandoverDate:
          input.goodsHandoverDate === undefined ? undefined : toDate(input.goodsHandoverDate),
        transitType: input.transitType === undefined ? undefined : (input.transitType ?? null),
        warehouseCfs: input.warehouseCfs === undefined ? undefined : input.warehouseCfs || null,
        updatedBy: auth.userId,
      },
    });

    if (input.cargoLines !== undefined) {
      await reconcileCargo(db, auth.tenantId, id, auth.userId, input.cargoLines);
    }
    return loadShipment(db, id);
  });

  const payload: ApiSuccess<ShipmentDto> = { success: true, data };
  res.json(payload);
});

/**
 * POST /:id/submit — the hand-off to operations.
 *
 * §5.2 rule 4 is the only rule it enforces and it is worth enforcing here
 * rather than on the form: a booking with no cargo on it is not a booking, and
 * the screen is not the last thing that can create one.
 */
shipmentRouter.post(
  '/bookings/:id/submit',
  requirePermission(`${FEATURE}.SUBMIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'booking');

    const data = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.shipment.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, status: true, code: true, submittedAt: true },
      });
      if (existing === null) throw HttpError.notFound('Booking not found.');
      assertEditable(existing.status, existing.code);
      if (existing.submittedAt !== null) {
        throw new HttpError(409, 'ALREADY_SUBMITTED', `${existing.code} has already been submitted.`);
      }

      const lines = await db.shipmentCargoLine.count({ where: { shipmentId: id, deletedAt: null } });
      if (lines === 0) {
        throw new HttpError(
          422,
          'NO_CARGO',
          'Add at least one cargo line before submitting this booking.',
        );
      }

      await db.shipment.update({
        where: { id },
        data: { submittedAt: new Date(), submittedBy: auth.userId, updatedBy: auth.userId },
      });
      return loadShipment(db, id);
    });

    const payload: ApiSuccess<ShipmentDto> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /:id/cancel — §5.1's `any -> CANCELLED`.
 *
 * The only status transition with a trigger today; the rest arrive with the
 * screens that cause them (a schedule in phase E, an approval in G, a shipping
 * order in H, a receipt in I). All of them will come through the same service,
 * because §5.1's "never let the frontend decide what the next state is" is only
 * true if there is exactly one place that decides.
 *
 * CANCEL is its own permission for §7's reason — it is marked privileged, and
 * it stops a booking somebody else is working on.
 */
shipmentRouter.post(
  '/bookings/:id/cancel',
  requirePermission(`${FEATURE}.CANCEL`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'booking');
    const input = shipmentCancelSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      await transitionShipment(db, {
        shipmentId: id,
        to: 'CANCELLED',
        userId: auth.userId,
        reason: input.reason,
      });
      return loadShipment(db, id);
    });

    const payload: ApiSuccess<ShipmentDto> = { success: true, data };
    res.json(payload);
  },
);

/**
 * §5.1 stops the booking being rewritten the moment a schedule has gone to the
 * customer. Everything after VESSEL_PROPOSED has somebody downstream relying on
 * these figures, and §2.4's whole point is that each stage keeps its own.
 */
function assertEditable(status: string, code: string): void {
  if (SHIPMENT_EDITABLE.includes(status as never)) return;
  throw new HttpError(
    409,
    'NOT_EDITABLE',
    `${code} has moved on and can no longer be edited. Its schedule or shipping order depends on these figures.`,
  );
}
