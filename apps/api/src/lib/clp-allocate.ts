import { Prisma } from '../generated/prisma/client';
import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * CLP allocation — MODULE_CLP.md §2.2, §2.3, §2.4 and §4.1.
 *
 * The one piece of this module that is arithmetic rather than screens: it
 * decides what physically goes into a steel box, and the spec says so —
 * "the rounding rule is where it will fail quietly if it fails".
 *
 * Three rules, and everything here exists to serve them:
 *
 *   §2.2  `add` and `Split` are the same operation. `add` passes the whole
 *         remaining balance; nothing else differs, because two code paths
 *         means two places for conservation to break and only one gets fixed.
 *
 *   §2.3  The carton is the only quantity anyone types. Pieces and weights
 *         follow from the per-carton values, and the allocation that COMPLETES
 *         a line carries the remainder so the parts sum back to the whole
 *         exactly. Confirmed 2026-09-13: the remainder reconciles against the
 *         BOOKED totals, while the pool comes from the receipt.
 *
 *   §4.1  Conservation, under a real lock. Two planners on one booking in two
 *         tabs is the realistic case.
 */

const ZERO = new Prisma.Decimal(0);
const D = (v: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal =>
  v === null || v === undefined ? ZERO : new Prisma.Decimal(v.toString());

export interface Actor {
  tenantId: bigint;
  userId: bigint | null;
}

/**
 * Cartons of this line that arrived and were accepted.
 *
 * §2.4: the pool is what was received, never what was booked. A draft receipt
 * is not goods in — nobody has confirmed them — and a declined line never
 * enters the pool at all.
 */
async function receivedCartons(db: TenantDb, cargoLineId: bigint): Promise<number> {
  const rows = await db.cargoReceiptLine.findMany({
    where: {
      shipmentCargoLineId: cargoLineId,
      deletedAt: null,
      lineStatus: 'ACCEPTED',
      receipt: { status: 'CONFIRMED', deletedAt: null },
    },
    select: { receivedCtnQty: true },
  });
  return rows.reduce((sum, r) => sum + r.receivedCtnQty, 0);
}

/** Allocations that still count — a cancelled plan holds nothing (§4.1). */
function liveAllocations(cargoLineId: bigint) {
  return {
    shipmentCargoLineId: cargoLineId,
    deletedAt: null,
    clp: { status: { not: 'CANCELLED' as const }, deletedAt: null },
  };
}

/** Cartons of this line still free to plan. */
export async function availableCartons(db: TenantDb, cargoLineId: bigint): Promise<number> {
  const [received, allocated] = await Promise.all([
    receivedCartons(db, cargoLineId),
    db.clpLine.aggregate({
      where: liveAllocations(cargoLineId),
      _sum: { ctnQty: true },
    }),
  ]);
  return received - (allocated._sum.ctnQty ?? 0);
}

/**
 * Re-derives every allocation of one cargo line.
 *
 * §2.3 says to recompute the whole line rather than patch one row: the
 * remainder belongs to whichever allocation completes the line, and removing
 * an earlier one leaves it attached to a split that is no longer last.
 *
 * Ordered by id — creation order is what "last" means here, and it is stable
 * across reruns, which a recompute has to be.
 */
async function recomputeCargoLine(
  db: TenantDb,
  actor: Actor,
  cargoLineId: bigint,
): Promise<bigint[]> {
  const booked = await db.shipmentCargoLine.findFirstOrThrow({
    where: { id: cargoLineId },
    select: {
      pcsQty: true,
      netWeightKg: true,
      grossWeightKg: true,
      volumeCbm: true,
      pcsPerCarton: true,
      netWeightPerCarton: true,
      grossWeightPerCarton: true,
      cbmPerCarton: true,
    },
  });

  const rows = await db.clpLine.findMany({
    where: liveAllocations(cargoLineId),
    orderBy: { id: 'asc' },
    select: { id: true, clpId: true, ctnQty: true },
  });

  const received = await receivedCartons(db, cargoLineId);
  const allocated = rows.reduce((sum, r) => sum + r.ctnQty, 0);
  /*
    Only a line with nothing left to plan has a remainder to hand out. While
    cartons are still unallocated every row is an intermediate split, and
    giving one of them the balance would claim pieces that are not on board.
  */
  const complete = received > 0 && allocated === received;

  let usedPcs = 0;
  let usedNwt = ZERO;
  let usedGwt = ZERO;
  let usedCbm = ZERO;

  for (const [index, row] of rows.entries()) {
    const isLast = index === rows.length - 1;
    const carriesRemainder = isLast && complete;
    const n = new Prisma.Decimal(row.ctnQty);

    // Intermediate splits multiply out and round to the column's own scale;
    // the final one takes whatever is left, which is what makes the parts sum.
    const pcs =
      booked.pcsQty === null
        ? null
        : carriesRemainder
          ? booked.pcsQty - usedPcs
          : D(booked.pcsPerCarton).times(n).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();

    const nwt =
      booked.netWeightKg === null
        ? null
        : carriesRemainder
          ? D(booked.netWeightKg).minus(usedNwt)
          : D(booked.netWeightPerCarton).times(n).toDecimalPlaces(3);

    const gwt =
      booked.grossWeightKg === null
        ? null
        : carriesRemainder
          ? D(booked.grossWeightKg).minus(usedGwt)
          : D(booked.grossWeightPerCarton).times(n).toDecimalPlaces(3);

    const cbm =
      booked.volumeCbm === null
        ? null
        : carriesRemainder
          ? D(booked.volumeCbm).minus(usedCbm)
          : D(booked.cbmPerCarton).times(n).toDecimalPlaces(4);

    await db.clpLine.update({
      where: { id: row.id },
      data: {
        pcsQty: pcs,
        netWeightKg: nwt,
        grossWeightKg: gwt,
        volumeCbm: cbm,
        // A split is an allocation of part of what arrived, not of all of it.
        isSplit: row.ctnQty < received,
        isFinalAllocation: carriesRemainder,
        updatedBy: actor.userId,
      },
    });

    if (pcs !== null) usedPcs += pcs;
    if (nwt !== null) usedNwt = usedNwt.plus(nwt);
    if (gwt !== null) usedGwt = usedGwt.plus(gwt);
    if (cbm !== null) usedCbm = usedCbm.plus(cbm);
  }

  return [...new Set(rows.map((r) => r.clpId.toString()))].map((id) => BigInt(id));
}

/**
 * Re-adds one plan's lines onto its own totals (§3.2).
 *
 * Stored rather than summed at read time, so the list screen, the virtual
 * container and the printed document cannot each arrive at a different figure.
 */
async function recomputeClp(db: TenantDb, actor: Actor, clpId: bigint): Promise<void> {
  const [lines, plan] = await Promise.all([
    db.clpLine.findMany({
      where: { clpId, deletedAt: null },
      select: {
        ctnQty: true,
        pcsQty: true,
        netWeightKg: true,
        grossWeightKg: true,
        volumeCbm: true,
      },
    }),
    db.clp.findFirstOrThrow({
      where: { id: clpId },
      select: { containerSize: { select: { maxVolumeCbm: true, maxWeightKg: true } } },
    }),
  ]);

  const ctn = lines.reduce((s, l) => s + l.ctnQty, 0);
  const pcs = lines.reduce((s, l) => s + (l.pcsQty ?? 0), 0);
  const nwt = lines.reduce((s, l) => s.plus(D(l.netWeightKg)), ZERO);
  const gwt = lines.reduce((s, l) => s.plus(D(l.grossWeightKg)), ZERO);
  const cbm = lines.reduce((s, l) => s.plus(D(l.volumeCbm)), ZERO);

  /*
    Utilisation is null where the size has no limit recorded — §4.2 must be
    able to say "capacity not set" rather than read silence as room to spare.
    Capped at the column's ceiling: NUMERIC(5,4) holds 9.9999, and a plan at
    a thousand percent is already as wrong as the bar can show.
  */
  const ratio = (used: Prisma.Decimal, limit: Prisma.Decimal | null): Prisma.Decimal | null => {
    if (limit === null || limit.isZero()) return null;
    const value = used.dividedBy(limit).toDecimalPlaces(4);
    return value.greaterThan('9.9999') ? new Prisma.Decimal('9.9999') : value;
  };

  await db.clp.update({
    where: { id: clpId },
    data: {
      totalCtnQty: ctn,
      totalPcsQty: lines.length === 0 ? null : pcs,
      totalNetWeightKg: nwt,
      totalGrossWeightKg: gwt,
      totalVolumeCbm: cbm,
      volumeUtilisation: ratio(cbm, plan.containerSize.maxVolumeCbm),
      weightUtilisation: ratio(gwt, plan.containerSize.maxWeightKg),
      updatedBy: actor.userId,
    },
  });
}

/**
 * Puts cartons of a cargo line into a container.
 *
 * `add` and `Split` both land here (§2.2) — `add` simply passes the whole
 * remaining balance. Allocating into a container that already holds this line
 * adds to it rather than failing: two allocations into one box is one
 * allocation with a bigger number, which is also what the unique index says.
 *
 * MUST be called inside `withTenant`, which opens the transaction the lock
 * below depends on.
 */
export async function allocate(
  db: TenantDb,
  actor: Actor,
  input: { cargoLineId: bigint; clpId: bigint; ctnQty: number },
): Promise<{ clpLineId: bigint }> {
  if (!Number.isInteger(input.ctnQty) || input.ctnQty <= 0) {
    throw HttpError.badRequest('Enter a whole number of cartons, greater than zero.');
  }

  /*
    §4.1 wants a lock, and names the SELECT on clp_line FOR UPDATE. That alone
    does not hold: with no allocations yet there are no rows to lock, both
    planners read zero and both insert — the classic phantom. Locking the cargo
    line instead works because that row always exists, and every allocation of
    this line contends for it whether or not any allocation exists yet.
  */
  await db.$queryRaw`SELECT id FROM shipment_cargo_line WHERE id = ${input.cargoLineId} FOR UPDATE`;

  const cargo = await db.shipmentCargoLine.findFirst({
    where: { id: input.cargoLineId, deletedAt: null },
    select: {
      id: true,
      shipmentPoId: true,
      itemCode: true,
      sku: true,
      cartonLengthCm: true,
      cartonWidthCm: true,
      cartonHeightCm: true,
      shipmentPo: { select: { poNo: true } },
    },
  });
  if (cargo === null) throw HttpError.notFound('That cargo line no longer exists.');

  const plan = await db.clp.findFirst({
    where: { id: input.clpId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (plan === null) throw HttpError.notFound('That load plan no longer exists.');
  if (plan.status !== 'DRAFT') {
    // §4.3: FINAL has no edit path, and a cancelled plan is not a destination.
    throw HttpError.conflict(
      plan.status === 'FINAL'
        ? 'This load plan is final. Cancel it and make a new one to change what it carries.'
        : 'This load plan has been cancelled.',
    );
  }

  const remaining = await availableCartons(db, input.cargoLineId);
  const existing = await db.clpLine.findFirst({
    where: { clpId: input.clpId, shipmentCargoLineId: input.cargoLineId, deletedAt: null },
    select: { id: true, ctnQty: true },
  });

  if (input.ctnQty > remaining) {
    // §4.1: concrete, naming the PO and the balance. "Too many" tells a
    // planner nothing they can act on.
    throw HttpError.conflict(
      `${cargo.shipmentPo.poNo} has ${remaining} cartons left to allocate. ` +
        `You entered ${input.ctnQty}.`,
    );
  }

  const clpLineId =
    existing === null
      ? (
          await db.clpLine.create({
            data: {
              tenantId: actor.tenantId,
              clpId: input.clpId,
              shipmentCargoLineId: cargo.id,
              shipmentPoId: cargo.shipmentPoId,
              // Snapshotted for the printed document (§5.3): the cargo line
              // can change after a plan is finalised, and a finalised plan
              // never does.
              poNo: cargo.shipmentPo.poNo,
              itemCode: cargo.itemCode,
              sku: cargo.sku,
              cartonLengthCm: cargo.cartonLengthCm,
              cartonWidthCm: cargo.cartonWidthCm,
              cartonHeightCm: cargo.cartonHeightCm,
              ctnQty: input.ctnQty,
              createdBy: actor.userId,
              updatedBy: actor.userId,
            },
            select: { id: true },
          })
        ).id
      : (
          await db.clpLine.update({
            where: { id: existing.id },
            data: { ctnQty: existing.ctnQty + input.ctnQty, updatedBy: actor.userId },
            select: { id: true },
          })
        ).id;

  const touched = await recomputeCargoLine(db, actor, cargo.id);
  for (const id of touched) await recomputeClp(db, actor, id);

  return { clpLineId };
}

/**
 * Takes an allocation back out, releasing its cartons to the pool.
 *
 * Soft-deleted (§4 rule 3), which is why the unique index on this table is
 * scoped to live rows — otherwise a line taken out of a container could never
 * be put back into it.
 */
export async function deallocate(
  db: TenantDb,
  actor: Actor,
  clpLineId: bigint,
): Promise<void> {
  const row = await db.clpLine.findFirst({
    where: { id: clpLineId, deletedAt: null },
    select: { id: true, clpId: true, shipmentCargoLineId: true, clp: { select: { status: true } } },
  });
  if (row === null) throw HttpError.notFound('That allocation no longer exists.');
  if (row.clp.status === 'FINAL') {
    throw HttpError.conflict(
      'This load plan is final. Cancel it and make a new one to change what it carries.',
    );
  }

  await db.$queryRaw`SELECT id FROM shipment_cargo_line WHERE id = ${row.shipmentCargoLineId} FOR UPDATE`;

  await db.clpLine.update({
    where: { id: row.id },
    data: { deletedAt: new Date(), isActive: false, updatedBy: actor.userId },
  });

  const touched = await recomputeCargoLine(db, actor, row.shipmentCargoLineId);
  for (const id of new Set([...touched, row.clpId])) await recomputeClp(db, actor, id);
}
