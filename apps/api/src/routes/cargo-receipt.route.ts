import { Router } from 'express';

import {
  type ApiSuccess,
  type CargoReceiptDto,
  cargoReceiptSaveSchema,
  type ReceiptGridRow,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { nextCargoReceiptNo, seriesYearOf } from '../lib/inquiry-no';
import { parseId, parseRefId } from '../lib/request';
import { transitionShipment } from '../lib/shipment-status';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Cargo Receipt (docs/MODULE_BOOKING_CARGO.md §4.4, §5.5, §6.7) — phase I.
 *
 * §2.4 is the rule the whole file serves: booked, authorised and received are
 * three different numbers on the same PO line, and nothing here ever writes the
 * received figure back onto the booked one.
 *
 * §5.5 rule 4 is the other: a booking may have several receipts. So the balance
 * is never stored — it is booked minus the sum of everything ACCEPTED so far,
 * computed on the way past. A stored balance is a second copy of the truth, and
 * the two disagree the first time a receipt is corrected.
 */
export const cargoReceiptRouter: Router = Router();

const FEATURE = 'OPERATION.CARGO_RECEIPT';

cargoReceiptRouter.use(authenticate);

const receiptArgs = {
  include: {
    shippingOrder: { select: { code: true } },
    receivedByUser: { select: { username: true } },
    lines: {
      where: { deletedAt: null },
      select: {
        id: true,
        shipmentCargoLineId: true,
        receivedCtnQty: true,
        receivedPcsQty: true,
        receivedNetWeightKg: true,
        receivedGrossWeightKg: true,
        cartonLengthCm: true,
        cartonWidthCm: true,
        cartonHeightCm: true,
        receivedVolumeCbm: true,
        lineStatus: true,
        declineReason: true,
        remarks: true,
        overReceiptReason: true,
      },
    },
  },
} satisfies { include: Prisma.CargoReceiptInclude };

type ReceiptRow = Prisma.CargoReceiptGetPayload<typeof receiptArgs>;

const dec = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

/**
 * §6.7's grid: every booked line, with what was authorised, what has already
 * arrived, and what this receipt says about it.
 *
 * Built from the booking rather than from the receipt, so a line nobody has
 * touched yet still appears with its balance — §5.5 rule 1 wants the receiver
 * looking at the gap, and a row that is missing shows no gap at all.
 */
async function buildRows(
  db: TenantDb,
  shipmentId: bigint,
  receipt: ReceiptRow | null,
): Promise<ReceiptGridRow[]> {
  const booked = await db.shipmentCargoLine.findMany({
    where: { shipmentId, deletedAt: null },
    orderBy: [{ shipmentPoId: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      itemCode: true,
      sku: true,
      ctnQty: true,
      pcsQty: true,
      grossWeightKg: true,
      volumeCbm: true,
      soCtnQty: true,
      shipmentPo: { select: { poNo: true } },
    },
  });

  // Everything ACCEPTED on a CONFIRMED receipt, excluding this one — a draft
  // has not happened yet, and counting it would show a balance that is only
  // true if somebody presses confirm.
  const earlier = await db.cargoReceiptLine.groupBy({
    by: ['shipmentCargoLineId'],
    where: {
      deletedAt: null,
      lineStatus: 'ACCEPTED',
      receipt: {
        shipmentId,
        deletedAt: null,
        status: 'CONFIRMED',
        ...(receipt === null ? {} : { id: { not: receipt.id } }),
      },
    },
    _sum: { receivedCtnQty: true },
  });
  const alreadyIn = new Map(
    earlier.map((r) => [r.shipmentCargoLineId.toString(), r._sum.receivedCtnQty ?? 0]),
  );

  const onThis = new Map((receipt?.lines ?? []).map((l) => [l.shipmentCargoLineId.toString(), l]));

  return booked.map((line) => {
    const key = line.id.toString();
    const previous = alreadyIn.get(key) ?? 0;
    const mine = onThis.get(key) ?? null;

    return {
      cargoLineId: key,
      poNo: line.shipmentPo.poNo,
      itemCode: line.itemCode,
      sku: line.sku,
      bookedCtnQty: line.ctnQty,
      bookedPcsQty: line.pcsQty,
      bookedGrossWeightKg: dec(line.grossWeightKg),
      bookedVolumeCbm: dec(line.volumeCbm),
      soCtnQty: line.soCtnQty,
      previouslyReceivedCtnQty: previous,
      balanceCtnQty: Math.max(0, line.ctnQty - previous),
      receiptLineId: mine?.id.toString() ?? null,
      receivedCtnQty: mine?.receivedCtnQty ?? null,
      receivedPcsQty: mine?.receivedPcsQty ?? null,
      receivedNetWeightKg: mine === null ? null : dec(mine.receivedNetWeightKg),
      receivedGrossWeightKg: mine === null ? null : dec(mine.receivedGrossWeightKg),
      cartonLengthCm: mine === null ? null : dec(mine.cartonLengthCm),
      cartonWidthCm: mine === null ? null : dec(mine.cartonWidthCm),
      cartonHeightCm: mine === null ? null : dec(mine.cartonHeightCm),
      receivedVolumeCbm: mine === null ? null : dec(mine.receivedVolumeCbm),
      lineStatus: mine?.lineStatus ?? null,
      declineReason: mine?.declineReason ?? null,
      remarks: mine?.remarks ?? null,
      overReceiptReason: mine?.overReceiptReason ?? null,
    };
  });
}

async function toDto(db: TenantDb, receipt: ReceiptRow): Promise<CargoReceiptDto> {
  return {
    id: receipt.id.toString(),
    code: receipt.code,
    status: receipt.status,
    receiptSeq: receipt.receiptSeq,
    receiveDate: receipt.receiveDate.toISOString().slice(0, 10),
    unloadLocation: receipt.unloadLocation,
    efrNo: receipt.efrNo,
    shippingOrderCode: receipt.shippingOrder?.code ?? null,
    receivedByName: receipt.receivedByUser?.username ?? null,
    confirmedAt: receipt.confirmedAt?.toISOString() ?? null,
    rows: await buildRows(db, receipt.shipmentId, receipt),
  };
}

async function assertBooking(db: TenantDb, shipmentId: bigint) {
  const shipment = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: { id: true, code: true, status: true },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');
  return shipment;
}

/**
 * GET /bookings/:id/cargo-receipts — every receipt, plus the open grid.
 *
 * The grid comes back even with no receipt at all, because §6.7's screen shows
 * the booked figures and their balance before anything has been typed.
 */
cargoReceiptRouter.get(
  '/bookings/:id/cargo-receipts',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');

    const data = await withTenant(auth.tenantId, async (db) => {
      await assertBooking(db, shipmentId);
      const rows = await db.cargoReceipt.findMany({
        where: { shipmentId, deletedAt: null },
        orderBy: { receiptSeq: 'asc' },
        ...receiptArgs,
      });
      const receipts = await Promise.all(rows.map((row) => toDto(db, row)));
      return {
        receipts,
        // The grid as it stands: the open draft's figures, or the booked ones
        // with their balances when nothing is open.
        grid: await buildRows(db, shipmentId, rows.find((r) => r.status === 'DRAFT') ?? null),
      };
    });

    const payload: ApiSuccess<typeof data> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /bookings/:id/cargo-receipts — open a receipt, or save the open one.
 *
 * One endpoint rather than a create and an update, because §6.7's screen is one
 * form: a receiver types into the grid and saves, and whether that was the
 * first save is not something they should have to think about.
 */
cargoReceiptRouter.post(
  '/bookings/:id/cargo-receipts',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = cargoReceiptSaveSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const shipment = await assertBooking(db, shipmentId);
      if (!['SO_ISSUED', 'SO_SKIPPED', 'PART_RECEIVED'].includes(shipment.status)) {
        throw new HttpError(
          409,
          'NOT_RECEIVABLE',
          `${shipment.code} is not at a point where cargo can be received against it.`,
        );
      }

      let receipt = await db.cargoReceipt.findFirst({
        where: { shipmentId, deletedAt: null, status: 'DRAFT' },
        select: { id: true },
      });

      if (receipt === null) {
        const order = await db.shippingOrder.findFirst({
          where: { shipmentId, deletedAt: null, status: 'ISSUED' },
          select: { id: true },
        });
        const highest = await db.cargoReceipt.aggregate({
          where: { shipmentId },
          _max: { receiptSeq: true },
        });
        const seriesYear = seriesYearOf(new Date());

        for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
          const code = await nextCargoReceiptNo(db, auth.tenantId, seriesYear);
          try {
            receipt = await db.cargoReceipt.create({
              data: {
                tenantId: auth.tenantId,
                code,
                seriesYear,
                shipmentId,
                // Null when the S/O was skipped (§5.4 rule 3).
                shippingOrderId: order?.id ?? null,
                receiveDate: new Date(`${input.receiveDate}T00:00:00.000Z`),
                unloadLocation: input.unloadLocation || null,
                efrNo: input.efrNo || null,
                receiptSeq: (highest._max.receiptSeq ?? 0) + 1,
                status: 'DRAFT',
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
        if (receipt === null) {
          throw new HttpError(500, 'CODE_EXHAUSTED', 'Could not allocate a receipt number.');
        }
      } else {
        await db.cargoReceipt.update({
          where: { id: receipt.id },
          data: {
            receiveDate: new Date(`${input.receiveDate}T00:00:00.000Z`),
            unloadLocation: input.unloadLocation || null,
            efrNo: input.efrNo || null,
            updatedBy: auth.userId,
          },
        });
      }

      await writeLines(db, auth, shipmentId, receipt.id, input.lines);

      const row = await db.cargoReceipt.findFirstOrThrow({
        where: { id: receipt.id },
        ...receiptArgs,
      });
      return toDto(db, row);
    });

    const payload: ApiSuccess<CargoReceiptDto> = { success: true, data };
    res.json(payload);
  },
);

/**
 * The grid, reconciled onto the receipt's lines.
 *
 * §5.5 rule 6 lives here: "Never let received exceed booked without an explicit
 * override and a reason." Checked against the BALANCE rather than the booked
 * figure, because on a second receipt what is still owed is what matters.
 */
async function writeLines(
  db: TenantDb,
  auth: { userId: bigint; isSuperadmin: boolean; permissions: ReadonlySet<string> },
  shipmentId: bigint,
  receiptId: bigint,
  lines: readonly import('@ff/shared').ReceiptLineInput[],
): Promise<void> {
  /*
   * No early return on an empty list. The grid is sent entire, so an empty one
   * means "nothing arrived after all" — and returning here would leave the last
   * line a receiver had just taken back sitting on the receipt.
   */
  const rows = await buildRows(db, shipmentId, null);
  const byLine = new Map(rows.map((r) => [r.cargoLineId, r]));
  const mayOverride =
    auth.isSuperadmin || auth.permissions.has(`${FEATURE}.OVERRIDE_QTY`);
  const mayDecline = auth.isSuperadmin || auth.permissions.has(`${FEATURE}.DECLINE_LINE`);

  const existing = await db.cargoReceiptLine.findMany({
    where: { cargoReceiptId: receiptId, deletedAt: null },
    select: { id: true, shipmentCargoLineId: true },
  });
  const existingByLine = new Map(
    existing.map((e) => [e.shipmentCargoLineId.toString(), e.id]),
  );
  const kept = new Set<bigint>();

  for (const line of lines) {
    const context = byLine.get(line.cargoLineId);
    if (context === undefined) {
      throw HttpError.notFound('One of those lines is not on this booking.');
    }
    if (line.lineStatus === 'DECLINED' && !mayDecline) {
      throw HttpError.forbidden('You may record a receipt but not decline a line.');
    }

    // §5.5 rule 6, and it is a rule about the OUTSTANDING quantity.
    if (line.lineStatus === 'ACCEPTED' && line.receivedCtnQty > context.balanceCtnQty) {
      const reason = (line.overReceiptReason ?? '').trim();
      if (!mayOverride) {
        throw new HttpError(
          403,
          'OVER_RECEIPT',
          `${line.receivedCtnQty} cartons is more than the ${context.balanceCtnQty} still owed on ` +
            `${context.poNo} / ${context.itemCode}. Recording an over-receipt is a supervisor's call.`,
        );
      }
      if (reason === '') {
        throw new HttpError(
          422,
          'OVER_RECEIPT_REASON',
          `Say why ${line.receivedCtnQty} cartons arrived against ${context.balanceCtnQty} owed on ` +
            `${context.poNo} / ${context.itemCode}.`,
          { overReceiptReason: ['A reason is required.'] },
        );
      }
    }

    const data = {
      receivedCtnQty: line.receivedCtnQty,
      receivedPcsQty: line.receivedPcsQty ?? null,
      receivedNetWeightKg: line.receivedNetWeightKg ?? null,
      receivedGrossWeightKg: line.receivedGrossWeightKg ?? null,
      cartonLengthCm: line.cartonLengthCm ?? null,
      cartonWidthCm: line.cartonWidthCm ?? null,
      cartonHeightCm: line.cartonHeightCm ?? null,
      lineStatus: line.lineStatus,
      declineReason: line.lineStatus === 'DECLINED' ? (line.declineReason ?? null) : null,
      remarks: line.remarks || null,
      overReceiptReason: line.overReceiptReason || null,
      updatedBy: auth.userId,
    };

    const already = existingByLine.get(line.cargoLineId);
    if (already !== undefined) {
      await db.cargoReceiptLine.update({ where: { id: already }, data });
      kept.add(already);
    } else {
      const made = await db.cargoReceiptLine.create({
        data: {
          tenantId: await currentTenant(db),
          cargoReceiptId: receiptId,
          shipmentCargoLineId: parseRefId(line.cargoLineId, 'cargo line'),
          ...data,
          createdBy: auth.userId,
        },
        select: { id: true },
      });
      kept.add(made.id);
    }
  }

  const dropped = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);
  if (dropped.length > 0) {
    await db.cargoReceiptLine.updateMany({
      where: { id: { in: dropped } },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  }
}

/** The tenant the extension is already scoped to, for an explicit create. */
async function currentTenant(db: TenantDb): Promise<bigint> {
  const rows = await db.$queryRaw<{ tenant_id: bigint }[]>`
    SELECT app_current_tenant() AS tenant_id`;
  const id = rows[0]?.tenant_id;
  if (id == null) throw new HttpError(500, 'NO_TENANT', 'No workspace in scope.');
  return id;
}

/**
 * POST /bookings/:id/cargo-receipts/:receiptId/confirm — §5.5 rule 3.
 *
 * "After confirming a receipt, recompute per PO line: balance = booked − Σ
 * accepted received. Any balance > 0 → PART_RECEIVED, booking stays open. All
 * balances = 0 → CARGO_RECEIVED."
 *
 * The recompute reads every confirmed receipt rather than only this one, which
 * is what makes §5.5 rule 4's several-receipts case work without a stored
 * running total to fall out of step.
 */
cargoReceiptRouter.post(
  '/bookings/:id/cargo-receipts/:receiptId/confirm',
  requirePermission(`${FEATURE}.CONFIRM`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const receiptId = parseId(req.params.receiptId, 'receipt');

    const data = await withTenant(auth.tenantId, async (db) => {
      await assertBooking(db, shipmentId);
      const receipt = await db.cargoReceipt.findFirst({
        where: { id: receiptId, shipmentId, deletedAt: null },
        select: { id: true, code: true, status: true },
      });
      if (receipt === null) throw HttpError.notFound('Receipt not found.');
      if (receipt.status === 'CONFIRMED') {
        throw new HttpError(409, 'ALREADY_CONFIRMED', `${receipt.code} is already confirmed.`);
      }

      const lineCount = await db.cargoReceiptLine.count({
        where: { cargoReceiptId: receiptId, deletedAt: null },
      });
      if (lineCount === 0) {
        throw new HttpError(
          422,
          'NO_LINES',
          'Record what arrived before confirming this receipt.',
        );
      }

      await db.cargoReceipt.update({
        where: { id: receiptId },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
          receivedBy: auth.userId,
          updatedBy: auth.userId,
        },
      });

      // §5.5 rule 3, over every confirmed receipt including the one just closed.
      const rows = await buildRows(db, shipmentId, null);
      const outstanding = rows.reduce((n, r) => n + r.balanceCtnQty, 0);
      await transitionShipment(db, {
        shipmentId,
        to: outstanding > 0 ? 'PART_RECEIVED' : 'CARGO_RECEIVED',
        userId: auth.userId,
      });

      const row = await db.cargoReceipt.findFirstOrThrow({
        where: { id: receiptId },
        ...receiptArgs,
      });
      return toDto(db, row);
    });

    const payload: ApiSuccess<CargoReceiptDto> = { success: true, data };
    res.json(payload);
  },
);
