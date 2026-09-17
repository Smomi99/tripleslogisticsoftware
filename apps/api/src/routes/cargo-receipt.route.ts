import { Router } from 'express';

import {
  type ApiSuccess,
  type CargoReceiptBoard,
  type CargoReceiptDto,
  cargoReceiptCorrectSchema,
  cargoReceiptSaveSchema,
  describeShortClose,
  type ReceiptGridRow,
  SHIPMENT_STATUS_LABEL,
  type ShipmentStatus,
  shortCloseSchema,
} from '@ff/shared';

import { billingBasisOf } from '../lib/clp-billing';
import { plansOfBooking } from '../lib/clp-participants';
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
    correctedByUser: { select: { username: true } },
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
  // The receipt being looked at: left out of "already in", and its lines drawn
  // when given. Only the id is needed to check a save against the balance.
  receipt: { id: bigint; lines?: ReceiptRow['lines'] } | null,
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
      grossWeightPerCarton: true,
      cartonLengthCm: true,
      cartonWidthCm: true,
      cartonHeightCm: true,
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
      bookedGrossWeightPerCartonKg: dec(line.grossWeightPerCarton),
      bookedCartonLengthCm: dec(line.cartonLengthCm),
      bookedCartonWidthCm: dec(line.cartonWidthCm),
      bookedCartonHeightCm: dec(line.cartonHeightCm),
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
    correctionReason: receipt.correctionReason,
    correctedAt: receipt.correctedAt?.toISOString() ?? null,
    correctedByName: receipt.correctedByUser?.username ?? null,
    rows: await buildRows(db, receipt.shipmentId, receipt),
  };
}

/**
 * Why this booking's confirmed receipts cannot be edited now, or null.
 *
 * Client decision 2026-09-17: editable until the booking is on a CLP. A plan
 * takes its cartons, weight and CBM from confirmed receipts, and its cost split
 * from those figures, so once one exists the receipt stops being the only
 * record of them. A cancelled plan holds nothing (MODULE_CLP.md §4.1).
 */
async function editLockOf(
  db: TenantDb,
  shipment: { id: bigint; code: string; status: ShipmentStatus },
): Promise<string | null> {
  if (shipment.status === 'SHORT_CLOSED') {
    return (
      `${shipment.code} was short closed against these receipts, so they are locked. ` +
      'The shortfall on record is worked out from them.'
    );
  }
  if (shipment.status !== 'PART_RECEIVED' && shipment.status !== 'CARGO_RECEIVED') {
    return (
      `${shipment.code} is ${SHIPMENT_STATUS_LABEL[shipment.status].toLowerCase()}, ` +
      'so its receipts cannot be edited.'
    );
  }

  const plans = await db.clp.findMany({
    where: { deletedAt: null, status: { not: 'CANCELLED' }, ...plansOfBooking(shipment.id) },
    orderBy: { id: 'asc' },
    select: { code: true },
  });
  if (plans.length > 0) {
    const codes = plans.map((p) => p.code).join(', ');
    return (
      `${shipment.code} is on ${codes}, which is built from these receipts. ` +
      `Remove it from ${plans.length === 1 ? 'that plan' : 'those plans'} before editing a receipt.`
    );
  }
  return null;
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

    const data = await withTenant(auth.tenantId, async (db): Promise<CargoReceiptBoard> => {
      const shipment = await assertBooking(db, shipmentId);
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
        editLock: rows.some((r) => r.status === 'CONFIRMED')
          ? await editLockOf(db, shipment)
          : null,
      };
    });

    const payload: ApiSuccess<CargoReceiptBoard> = { success: true, data };
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
  // Without this receipt: an edit to a confirmed one is checked against what
  // the OTHER receipts left owed, not against a balance its own old figures
  // already reduced. For a draft it changes nothing, as drafts never count.
  const rows = await buildRows(db, shipmentId, { id: receiptId });
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

    const already = existingByLine.get(line.cargoLineId);
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

    /*
      `received_volume_cbm` is GENERATED from the carton the CFS measured, so
      it is the database that decides whether this line has a measurement —
      not this code. Selecting it back means the basis recorded below agrees
      with the figure billing actually uses, rather than with a second guess
      made from the dimensions on the way in.
    */
    const saved =
      already === undefined
        ? await db.cargoReceiptLine.create({
            data: {
              tenantId: await currentTenant(db),
              cargoReceiptId: receiptId,
              shipmentCargoLineId: parseRefId(line.cargoLineId, 'cargo line'),
              ...data,
              createdBy: auth.userId,
            },
            select: { id: true, receivedVolumeCbm: true, billingBasis: true },
          })
        : await db.cargoReceiptLine.update({
            where: { id: already },
            data,
            select: { id: true, receivedVolumeCbm: true, billingBasis: true },
          });
    kept.add(saved.id);

    /*
      §7's decision, written down. The column existed and carried a default
      of BOOKED that nothing ever changed, so every line recorded since the
      consolidation migration claimed the charge rested on a booked figure
      even where the CFS had re-measured. The computed billing CBM was right
      throughout — it reads the measurement directly — but the stored answer
      to "and why" was not, which is the one thing the column exists for.

      Written only when it actually differs: the audit trigger files an entry
      for every UPDATE, and a receipt saved twice should not grow a history of
      changes nobody made.
    */
    const basis = billingBasisOf({ receivedVolumeCbm: saved.receivedVolumeCbm });
    if (saved.billingBasis !== basis) {
      await db.cargoReceiptLine.update({
        where: { id: saved.id },
        data: { billingBasis: basis, updatedBy: auth.userId },
      });
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

/**
 * PUT /bookings/:id/cargo-receipts/:receiptId — edit a CONFIRMED receipt.
 *
 * Client decision 2026-09-17: a receipt confirmed with a mistake in it may be
 * put right by a user holding EDIT, with a reason, until the booking is on a
 * CLP (`editLockOf`). The lines go through the same `writeLines` a draft does,
 * so §5.5 rule 6's over-receipt check and the decline permission still hold,
 * now measured against what the other receipts left owed.
 *
 * Then §5.5 rule 3 again, over every confirmed receipt: an edit that leaves
 * cartons owed moves a Cargo received booking back to Part received, and one
 * that clears the balance moves it forward.
 */
cargoReceiptRouter.put(
  '/bookings/:id/cargo-receipts/:receiptId',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const receiptId = parseId(req.params.receiptId, 'receipt');
    const input = cargoReceiptCorrectSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const shipment = await assertBooking(db, shipmentId);
      const receipt = await db.cargoReceipt.findFirst({
        where: { id: receiptId, shipmentId, deletedAt: null },
        select: { id: true, code: true, status: true },
      });
      if (receipt === null) throw HttpError.notFound('Receipt not found.');
      if (receipt.status !== 'CONFIRMED') {
        throw new HttpError(
          409,
          'NOT_CONFIRMED',
          `${receipt.code} is still a draft. Change it in the form and save it there.`,
        );
      }

      const lock = await editLockOf(db, shipment);
      if (lock !== null) throw new HttpError(409, 'RECEIPT_LOCKED', lock);

      await db.cargoReceipt.update({
        where: { id: receiptId },
        data: {
          receiveDate: new Date(`${input.receiveDate}T00:00:00.000Z`),
          unloadLocation: input.unloadLocation || null,
          efrNo: input.efrNo || null,
          correctionReason: input.reason,
          correctedBy: auth.userId,
          correctedAt: new Date(),
          updatedBy: auth.userId,
        },
      });

      await writeLines(db, auth, shipmentId, receiptId, input.lines);

      const rows = await buildRows(db, shipmentId, null);
      const outstanding = rows.reduce((n, r) => n + r.balanceCtnQty, 0);
      const to = outstanding > 0 ? 'PART_RECEIVED' : 'CARGO_RECEIVED';
      if (to !== shipment.status) {
        await transitionShipment(db, { shipmentId, to, userId: auth.userId });
      }

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

/**
 * POST /bookings/:id/short-close — §5.5 rule 5.
 *
 * "A privileged user may close the remaining balance with a reason, setting
 * SHORT_CLOSED. The balance stays visible on the record — never delete it."
 *
 * So this writes nothing to the cargo lines. The outstanding quantity stays
 * exactly where it was and stays derivable forever; all that changes is that
 * somebody has said the shipment is not waiting for it any more. §5.5 is
 * explicit about why: "this is what accounts and the customer will argue about
 * later, and the trail is the answer".
 *
 * SHORT_CLOSE is its own permission because §7 says so in as many words — it
 * writes off cargo the customer paid to move, and belongs with a supervisor
 * rather than the warehouse clerk.
 */
cargoReceiptRouter.post(
  '/bookings/:id/short-close',
  requirePermission(`${FEATURE}.SHORT_CLOSE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = shortCloseSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const shipment = await assertBooking(db, shipmentId);

      const open = await db.cargoReceipt.findFirst({
        where: { shipmentId, deletedAt: null, status: 'DRAFT' },
        select: { code: true },
      });
      if (open !== null) {
        throw new HttpError(
          409,
          'RECEIPT_OPEN',
          `${open.code} is still open. Confirm or clear it before closing the balance — ` +
            'what it holds would change the shortfall.',
        );
      }

      const rows = await buildRows(db, shipmentId, null);
      const outstanding = rows.reduce((n, r) => n + r.balanceCtnQty, 0);
      if (outstanding === 0) {
        throw new HttpError(
          409,
          'NOTHING_OUTSTANDING',
          `Everything booked on ${shipment.code} has arrived. There is no balance to close.`,
        );
      }

      // §5.1 refuses this from anywhere but PART_RECEIVED, which is the only
      // state where a balance can meaningfully be outstanding.
      await transitionShipment(db, {
        shipmentId,
        to: 'SHORT_CLOSED',
        userId: auth.userId,
        reason: input.reason,
        data: {
          shortClosedAt: new Date(),
          shortClosedBy: auth.userId,
          shortCloseReason: input.reason,
        },
      });

      return {
        shortClosed: outstanding,
        summary: describeShortClose(rows, input.reason),
        // Still derivable, still whole — nothing was written off.
        rows,
      };
    });

    const payload: ApiSuccess<typeof data> = { success: true, data };
    res.json(payload);
  },
);
