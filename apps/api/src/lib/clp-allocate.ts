import { CLP_OVER_VOLUME } from '@ff/shared';

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

/**
 * What actually arrived, as the figures a plan has to add up to.
 *
 * This is the remainder basis, and getting it from the BOOKED line was a bug
 * with teeth. §2.4 draws the pool from what was received, so a line is
 * "complete" once every RECEIVED carton is allocated — but the completing
 * allocation was then given `booked total - used`, which is the volume and
 * weight of cartons that never turned up.
 *
 * Seen in the field: 200 cartons booked at 33.00 CBM, 180 received, split
 * 169 + 11. The first container took 169 x 0.165 = 27.885 CBM correctly; the
 * second was handed 33.00 - 27.885 = 5.115 CBM for 11 cartons that measure
 * 1.815. The 3.3 CBM of the 20 undelivered cartons had to land somewhere and
 * landed on the last container — on the document that gets declared.
 *
 * `received_*` columns are used where the CFS recorded them, because what was
 * weighed and measured on arrival beats any calculation. Where they are null,
 * the booked per-carton rate multiplied by the received count is the honest
 * fallback: it describes the cartons that are actually there.
 */
interface ReceivedBasis {
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: Prisma.Decimal | null;
  grossWeightKg: Prisma.Decimal | null;
  volumeCbm: Prisma.Decimal | null;
}

async function receivedBasis(db: TenantDb, cargoLineId: bigint): Promise<ReceivedBasis> {
  const rows = await db.cargoReceiptLine.findMany({
    where: {
      shipmentCargoLineId: cargoLineId,
      deletedAt: null,
      lineStatus: 'ACCEPTED',
      receipt: { status: 'CONFIRMED', deletedAt: null },
    },
    select: {
      receivedCtnQty: true,
      receivedPcsQty: true,
      receivedNetWeightKg: true,
      receivedGrossWeightKg: true,
      receivedVolumeCbm: true,
    },
  });

  /*
    Summed only over the receipts that recorded the column. A partial delivery
    where one receipt weighed the goods and another did not cannot be added up
    into a meaningful total, so in that case the column is treated as not
    recorded at all rather than under-counted.
  */
  const total = (
    pick: (r: (typeof rows)[number]) => Prisma.Decimal | null,
  ): Prisma.Decimal | null => {
    if (rows.length === 0 || rows.some((r) => pick(r) === null)) return null;
    return rows.reduce((sum, r) => sum.plus(D(pick(r))), ZERO);
  };

  const pcs =
    rows.length === 0 || rows.some((r) => r.receivedPcsQty === null)
      ? null
      : rows.reduce((sum, r) => sum + (r.receivedPcsQty ?? 0), 0);

  return {
    ctnQty: rows.reduce((sum, r) => sum + r.receivedCtnQty, 0),
    pcsQty: pcs,
    netWeightKg: total((r) => r.receivedNetWeightKg),
    grossWeightKg: total((r) => r.receivedGrossWeightKg),
    volumeCbm: total((r) => r.receivedVolumeCbm),
  };
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
    select: {
      id: true,
      clpId: true,
      ctnQty: true,
      // The stored figures, needed for a row this recompute may not rewrite.
      pcsQty: true,
      netWeightKg: true,
      grossWeightKg: true,
      volumeCbm: true,
      clp: { select: { status: true } },
    },
  });

  /*
    A finalised or cancelled plan is frozen — §4.3's "FINAL has no edit path",
    applied to the rows as well as the columns.

    Its allocations still COUNT: they hold cartons, so they stay in
    `liveAllocations` and in `allocated` below, and the space they occupy is
    not offered to anyone else. What changes is that they are never rewritten.
    Before this, a second delivery against the same cargo line moved the
    per-carton rate, and the next allocation into any draft container silently
    re-priced the cartons on a plan that had already been printed and signed.

    The remainder therefore lands on the last DRAFT row rather than the last
    row overall. That is what keeps both promises at once: the frozen rows
    keep the figures they were signed off on, and the parts still sum to what
    arrived, because the difference is carried by a row nobody has committed
    to paper yet.
  */
  const editable = rows.filter((r) => r.clp.status === 'DRAFT');
  const lastEditableId = editable.length === 0 ? null : editable[editable.length - 1]!.id;

  const arrived = await receivedBasis(db, cargoLineId);
  const received = arrived.ctnQty;
  const allocated = rows.reduce((sum, r) => sum + r.ctnQty, 0);

  /*
    The figures the parts must sum to, and the per-carton rates that get there.

    Both come from what arrived. Where the CFS recorded a received total the
    rate is derived from it, so the splits and the remainder describe the same
    goods; where it did not, the booked per-carton rate stands and the total is
    that rate across the cartons that turned up. Either way the basis is never
    the booked total for a quantity that was never delivered.
  */
  const rate = (total: Prisma.Decimal | null, bookedPer: Prisma.Decimal | null) =>
    total !== null && received > 0 ? total.dividedBy(received) : bookedPer === null ? null : D(bookedPer);

  const basisPcs =
    arrived.pcsQty ??
    (booked.pcsPerCarton === null
      ? null
      : D(booked.pcsPerCarton).times(received).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber());
  const pcsRate =
    arrived.pcsQty !== null && received > 0
      ? new Prisma.Decimal(arrived.pcsQty).dividedBy(received)
      : booked.pcsPerCarton === null
        ? null
        : D(booked.pcsPerCarton);

  const basisNwt =
    arrived.netWeightKg ??
    (booked.netWeightPerCarton === null ? null : D(booked.netWeightPerCarton).times(received));
  const nwtRate = rate(arrived.netWeightKg, booked.netWeightPerCarton);

  const basisGwt =
    arrived.grossWeightKg ??
    (booked.grossWeightPerCarton === null ? null : D(booked.grossWeightPerCarton).times(received));
  const gwtRate = rate(arrived.grossWeightKg, booked.grossWeightPerCarton);

  const basisCbm =
    arrived.volumeCbm ??
    (booked.cbmPerCarton === null ? null : D(booked.cbmPerCarton).times(received));
  const cbmRate = rate(arrived.volumeCbm, booked.cbmPerCarton);
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

  for (const row of rows) {
    /*
      A frozen row contributes what it already holds and is not touched. Its
      `is_final_allocation` flag can go stale when the remainder moves to a
      draft row; nothing reads that flag to make a decision, and rewriting it
      would mean writing to the very record this is protecting.
    */
    if (row.clp.status !== 'DRAFT') {
      if (row.pcsQty !== null) usedPcs += row.pcsQty;
      usedNwt = usedNwt.plus(D(row.netWeightKg));
      usedGwt = usedGwt.plus(D(row.grossWeightKg));
      usedCbm = usedCbm.plus(D(row.volumeCbm));
      continue;
    }

    const carriesRemainder = row.id === lastEditableId && complete;
    const n = new Prisma.Decimal(row.ctnQty);

    // Intermediate splits multiply out and round to the column's own scale;
    // the final one takes whatever is left, which is what makes the parts sum.
    const pcs =
      basisPcs === null || pcsRate === null
        ? null
        : carriesRemainder
          ? basisPcs - usedPcs
          : pcsRate.times(n).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();

    const nwt =
      basisNwt === null || nwtRate === null
        ? null
        : carriesRemainder
          ? basisNwt.minus(usedNwt)
          : nwtRate.times(n).toDecimalPlaces(3);

    const gwt =
      basisGwt === null || gwtRate === null
        ? null
        : carriesRemainder
          ? basisGwt.minus(usedGwt)
          : gwtRate.times(n).toDecimalPlaces(3);

    const cbm =
      basisCbm === null || cbmRate === null
        ? null
        : carriesRemainder
          ? basisCbm.minus(usedCbm)
          : cbmRate.times(n).toDecimalPlaces(4);

    /*
      The balance cannot be negative. It only can be if what the frozen plans
      already hold exceeds what the receipts now say arrived — a receipt
      edited downwards after a plan was finalised on it. That is a real
      contradiction in the data, not a rounding artefact, and the check
      constraint on this table would refuse the write anyway; saying so here
      names the cargo line instead of surfacing a constraint violation.
    */
    if (
      carriesRemainder &&
      ((nwt !== null && nwt.lessThan(0)) ||
        (gwt !== null && gwt.lessThan(0)) ||
        (cbm !== null && cbm.lessThan(0)) ||
        (pcs !== null && pcs < 0))
    ) {
      throw HttpError.conflict(
        'Finalised containers on this cargo line already hold more than the receipts ' +
          'now say arrived. Check the cargo receipt before planning any more of it.',
      );
    }

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

  /*
    Only the plans this actually rewrote. A frozen plan's rollups describe
    what it held, so handing its id back would invite the caller to recompute
    totals that must not move.
  */
  return [...new Set(editable.map((r) => r.clpId.toString()))].map((id) => BigInt(id));
}

/**
 * Re-adds one plan's lines onto its own totals (§3.2).
 *
 * Stored rather than summed at read time, so the list screen, the virtual
 * container and the printed document cannot each arrive at a different figure.
 */
export interface ClpLoad {
  sizeCode: string;
  volumeCbm: Prisma.Decimal;
  grossWeightKg: Prisma.Decimal;
  maxVolumeCbm: Prisma.Decimal | null;
  maxWeightKg: Prisma.Decimal | null;
}

async function recomputeClp(db: TenantDb, actor: Actor, clpId: bigint): Promise<ClpLoad> {
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
      select: {
        status: true,
        totalGrossWeightKg: true,
        totalVolumeCbm: true,
        containerSize: {
          select: { code: true, maxVolumeCbm: true, maxWeightKg: true },
        },
      },
    }),
  ]);

  /*
    A plan that is not a draft keeps the rollups it was closed with. Callers
    still get a ClpLoad so the capacity wording downstream has something to
    read; it describes the plan as it stands, which for a frozen plan is what
    it held. The backstop for the loop above, in the one function that writes
    these columns.
  */
  if (plan.status !== 'DRAFT') {
    return {
      sizeCode: plan.containerSize.code,
      volumeCbm: D(plan.totalVolumeCbm),
      grossWeightKg: D(plan.totalGrossWeightKg),
      maxVolumeCbm: plan.containerSize.maxVolumeCbm,
      maxWeightKg: plan.containerSize.maxWeightKg,
    };
  }

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

  return {
    sizeCode: plan.containerSize.code,
    volumeCbm: cbm,
    grossWeightKg: gwt,
    maxVolumeCbm: plan.containerSize.maxVolumeCbm,
    maxWeightKg: plan.containerSize.maxWeightKg,
  };
}

/**
 * What a plan may not do — MODULE_CLP.md §4.2.
 *
 * Both limits block. The difference is what can be done about it:
 *
 *   Weight is never overridable. An overweight container is a legal and
 *   safety matter at the port, and no reason typed into this system makes a
 *   crane lift it.
 *
 *   Volume blocks too, but somebody holding OVERRIDE_CAPACITY may proceed in
 *   writing — cartons do compress, and a supervisor standing in the warehouse
 *   knows something the CBM column does not.
 *
 * Exactly 100% is allowed and only above it is an exception. The client plans
 * a 20STD to exactly 28.0 CBM, so treating full as over would trip on every
 * plan they make.
 */
function assertWithinCapacity(
  load: ClpLoad,
  /*
    How to name the container in the refusal. "CLP 1" for a plan that belongs
    to one booking; its document number for a consolidated one, which has no
    position within any single booking (CR-002).
  */
  label: string,
  override: { reason: string } | null,
): { overVolume: boolean } {
  const fmt = (v: Prisma.Decimal, dp: number) =>
    Number(v.toFixed(dp)).toLocaleString('en-US', {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });

  if (load.maxWeightKg !== null && load.grossWeightKg.greaterThan(load.maxWeightKg)) {
    throw HttpError.conflict(
      `That would put ${label} at ${fmt(load.grossWeightKg, 0)} kg in a ` +
        `${fmt(load.maxWeightKg, 0)} kg ${load.sizeCode} — ` +
        `${fmt(load.grossWeightKg.minus(load.maxWeightKg), 0)} kg over. ` +
        'An overweight container cannot be loaded, and this one cannot be overridden.',
    );
  }

  const overVolume =
    load.maxVolumeCbm !== null && load.volumeCbm.greaterThan(load.maxVolumeCbm);

  if (overVolume && override === null) {
    throw new HttpError(
      409,
      CLP_OVER_VOLUME,
      `That would put ${label} at ${fmt(load.volumeCbm, 2)} CBM in a ` +
        `${fmt(load.maxVolumeCbm!, 0)} CBM ${load.sizeCode} — ` +
        `${fmt(load.volumeCbm.minus(load.maxVolumeCbm!), 2)} CBM over. ` +
        'A supervisor can override this with a reason.',
    );
  }

  return { overVolume };
}

/**
 * Keeps the override flag telling the truth about the container it is on.
 *
 * It is set only where the load really is over volume — a reason sent with an
 * allocation that fits would otherwise brand a perfectly legal container as
 * over-stuffed — and cleared as soon as it is not, so a box that has had
 * cargo taken back out stops carrying somebody's stale excuse.
 *
 * audit_log keeps the whole history either way; this column only ever
 * describes the container as it stands now.
 */
async function syncOverride(
  db: TenantDb,
  actor: Actor,
  clpId: bigint,
  overVolume: boolean,
  override: { reason: string } | null,
): Promise<void> {
  /*
    Frozen plans keep the reason they were closed with. `deallocate` allows a
    line to be taken off a CANCELLED plan, and clearing the excuse off that
    record would rewrite why a container was signed for the way it was.
  */
  const plan = await db.clp.findFirstOrThrow({ where: { id: clpId }, select: { status: true } });
  if (plan.status !== 'DRAFT') return;

  if (overVolume && override !== null) {
    await db.clp.update({
      where: { id: clpId },
      data: {
        capacityOverrideBy: actor.userId,
        capacityOverrideReason: override.reason,
        updatedBy: actor.userId,
      },
    });
    return;
  }

  if (!overVolume) {
    // clp_override_ck requires the pair to move together.
    await db.clp.updateMany({
      where: { id: clpId, capacityOverrideBy: { not: null } },
      data: { capacityOverrideBy: null, capacityOverrideReason: null, updatedBy: actor.userId },
    });
  }
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
  input: {
    cargoLineId: bigint;
    clpId: bigint;
    ctnQty: number;
    /*
      §4.2. The ROUTE decides whether this user may override — permissions are
      not this function's business — and passes the reason through if so. Null
      means no override was offered, which is the ordinary case.
    */
    override?: { reason: string } | null;
  },
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
    select: { id: true, status: true, clpSeq: true, code: true },
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
  const loads = new Map<string, ClpLoad>();
  for (const id of touched) loads.set(id.toString(), await recomputeClp(db, actor, id));

  /*
    Checked against what was actually written rather than against a prediction.
    withTenant is a transaction, so a refusal here unwinds the insert and the
    rollups with it — the plan is left exactly as the planner found it, and
    there is no second arithmetic to disagree with the first.
  */
  const load = loads.get(input.clpId.toString());
  if (load !== undefined) {
    const label = plan.clpSeq === null ? plan.code : `CLP ${plan.clpSeq}`;
    const { overVolume } = assertWithinCapacity(load, label, input.override ?? null);
    // §4.2: recorded on the plan, and in audit_log by the row trigger.
    await syncOverride(db, actor, input.clpId, overVolume, input.override ?? null);
  }

  return { clpLineId };
}

/**
 * Cancel a load plan, releasing its cargo — MODULE_CLP.md §4.3.
 *
 * "Cancelling a FINAL CLP releases its allocations back to the pool and
 * creates a fresh clp_seq; the cancelled record is retained with its lines
 * for audit."
 *
 * The release is not a delete. `liveAllocations` already ignores lines whose
 * plan is CANCELLED, so flipping the status is what frees the cartons — and
 * the rows stay exactly as they were, which is what "retained for audit"
 * has to mean if anyone is ever going to reconstruct what was in that box.
 *
 * The lock matters as much as the status. A cancel that releases 60 cartons
 * while another request is allocating the same line would let both succeed
 * against a stale balance, so this takes the same row locks `allocate` takes,
 * in the same order.
 */
export async function cancelClp(
  db: TenantDb,
  actor: Actor,
  input: {
    clpId: bigint;
    reason: string;
    /*
      §4.3 makes FINAL → CANCELLED privileged. The ROUTE decides whether this
      user holds that right; this function only refuses to do it unasked.
    */
    mayCancelFinal: boolean;
  },
): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw HttpError.badRequest('Say why this load plan is being cancelled.');
  }

  const plan = await db.clp.findFirst({
    where: { id: input.clpId, deletedAt: null },
    select: {
      id: true,
      code: true,
      clpSeq: true,
      status: true,
      stuffingStartedAt: true,
      lines: {
        where: { deletedAt: null },
        select: { shipmentCargoLineId: true },
      },
    },
  });
  if (plan === null) throw HttpError.notFound('That load plan no longer exists.');

  if (plan.status === 'CANCELLED') {
    throw HttpError.conflict(`CLP ${plan.clpSeq} is already cancelled.`);
  }

  if (plan.status === 'FINAL' && !input.mayCancelFinal) {
    throw HttpError.forbidden(
      `CLP ${plan.clpSeq} is final. Cancelling a finalised load plan needs a supervisor.`,
    );
  }

  /*
    §4.3 — blocked once stuffing has started. Past that point the cartons are
    physically going into the box, and a system that "released" them would be
    describing a warehouse that no longer exists.
  */
  if (plan.stuffingStartedAt !== null) {
    throw HttpError.conflict(
      `Stuffing has already started on CLP ${plan.clpSeq}. It cannot be cancelled — ` +
        'stop the stuffing first if the load is wrong.',
    );
  }

  /*
    Lock every cargo line this plan touches before anything changes, in id
    order so two cancels can never take them in opposite orders and deadlock.

    FOR UPDATE rather than a read: the balance another request is about to
    compute depends on rows this transaction is about to free.
  */
  const cargoLineIds = [...new Set(plan.lines.map((l) => l.shipmentCargoLineId))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const id of cargoLineIds) {
    await db.$queryRaw`SELECT id FROM shipment_cargo_line WHERE id = ${id} FOR UPDATE`;
  }

  await db.clp.update({
    where: { id: plan.id },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy: actor.userId,
      cancelReason: reason,
      isActive: false,
      updatedBy: actor.userId,
    },
  });

  /*
    Re-derive every cargo line the plan held. The cancelled plan's own lines
    are no longer "live", so the remainder that was attached to them moves to
    whichever allocation now completes the line — §2.3's rule, applied to a
    plan disappearing rather than a line being removed.

    The cancelled plan itself is deliberately NOT recomputed: its totals are
    the record of what it held.
  */
  const touched = new Set<bigint>();
  for (const id of cargoLineIds) {
    for (const clpId of await recomputeCargoLine(db, actor, id)) touched.add(clpId);
  }
  for (const clpId of touched) {
    if (clpId !== plan.id) await recomputeClp(db, actor, clpId);
  }
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
  for (const id of new Set([...touched, row.clpId])) {
    const load = await recomputeClp(db, actor, id);
    /*
      Taking cargo out can bring a container back under its limit. The excuse
      for going over should not outlive the reason for it.
    */
    const stillOver =
      load.maxVolumeCbm !== null && load.volumeCbm.greaterThan(load.maxVolumeCbm);
    await syncOverride(db, actor, id, stillOver, null);
  }
}
