import { Prisma } from '../generated/prisma/client';

import { efrNosOfCargoLines } from './clp-efr';
import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * Building the Shipment Advise's PO grid — docs/MODULE_DOCUMENTATION.md §3.2.
 *
 * The client's sheet says "PO details will pull from CLP", and this is that
 * pull. What comes back is **copied onto the advise**, not joined at read time:
 * an advise is a letter that went to a customer, and a load plan cancelled next
 * week must not rewrite the one they are holding.
 *
 * Sea and air take different sources, which §3.7 explains. Sea reads the
 * finalised container plans; air has no CLP to read — MODULE_CLP §9 made air
 * ULD build-up a separate, unbuilt module, and the Menu sheet agrees ("No need
 * CLP for Air Shipment") — so air reads the confirmed cargo receipts instead.
 * Both draw from the same pool of cartons, so the figures agree either way.
 */

export interface AdviseLineDraft {
  shipmentPoId: bigint;
  shipmentCargoLineId: bigint;
  clpId: bigint | null;
  poNo: string;
  itemCode: string;
  sku: string | null;
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: Prisma.Decimal | null;
  grossWeightKg: Prisma.Decimal | null;
  cartonLengthCm: Prisma.Decimal | null;
  cartonWidthCm: Prisma.Decimal | null;
  cartonHeightCm: Prisma.Decimal | null;
  volumeCbm: Prisma.Decimal | null;
  chargeableWtKg: Prisma.Decimal | null;
  cargoReceiptDate: Date | null;
  stuffingDate: Date | null;
  efrNo: string | null;
}

export interface AdviseTotals {
  poCount: number;
  ctnQty: number;
  pcsQty: number | null;
  netWeightKg: Prisma.Decimal | null;
  grossWeightKg: Prisma.Decimal | null;
  volumeCbm: Prisma.Decimal | null;
  chargeableWtKg: Prisma.Decimal | null;
}

function sum(values: (Prisma.Decimal | null)[]): Prisma.Decimal | null {
  const present = values.filter((v): v is Prisma.Decimal => v !== null);
  if (present.length === 0) return null;
  return present.reduce((acc, v) => acc.add(v), new Prisma.Decimal(0));
}

/** Row 21 of the sheet. Recomputed from the lines, never typed. */
export function totalsOf(lines: AdviseLineDraft[]): AdviseTotals {
  const pcs = lines.map((l) => l.pcsQty).filter((v): v is number => v !== null);
  return {
    poCount: new Set(lines.map((l) => l.poNo)).size,
    ctnQty: lines.reduce((acc, l) => acc + l.ctnQty, 0),
    pcsQty: pcs.length === 0 ? null : pcs.reduce((acc, v) => acc + v, 0),
    netWeightKg: sum(lines.map((l) => l.netWeightKg)),
    grossWeightKg: sum(lines.map((l) => l.grossWeightKg)),
    volumeCbm: sum(lines.map((l) => l.volumeCbm)),
    chargeableWtKg: sum(lines.map((l) => l.chargeableWtKg)),
  };
}

/**
 * The date each cargo line's goods arrived at CFS.
 *
 * First confirmed receipt wins: a line delivered twice was first available on
 * the earlier date, and that is what "Cargo Rvt dt" on the sheet means.
 */
async function receiptDatesOf(
  db: TenantDb,
  cargoLineIds: bigint[],
): Promise<Map<string, Date>> {
  const dates = new Map<string, Date>();
  if (cargoLineIds.length === 0) return dates;

  const rows = await db.cargoReceiptLine.findMany({
    where: {
      shipmentCargoLineId: { in: cargoLineIds },
      deletedAt: null,
      lineStatus: 'ACCEPTED',
      receipt: { status: 'CONFIRMED', deletedAt: null },
    },
    orderBy: [{ receipt: { receiveDate: 'asc' } }, { id: 'asc' }],
    select: { shipmentCargoLineId: true, receipt: { select: { receiveDate: true } } },
  });

  for (const row of rows) {
    const key = row.shipmentCargoLineId.toString();
    if (!dates.has(key)) dates.set(key, row.receipt.receiveDate);
  }
  return dates;
}

/** The chargeable weight per cargo line — the air sheet's M17 column. */
async function chargeableOf(
  db: TenantDb,
  cargoLineIds: bigint[],
): Promise<Map<string, Prisma.Decimal | null>> {
  const found = new Map<string, Prisma.Decimal | null>();
  if (cargoLineIds.length === 0) return found;
  const rows = await db.shipmentCargoLine.findMany({
    where: { id: { in: cargoLineIds }, deletedAt: null },
    select: { id: true, chargeableWtKg: true },
  });
  for (const row of rows) found.set(row.id.toString(), row.chargeableWtKg);
  return found;
}

/**
 * Sea: the booking's cartons as the finalised container plans hold them.
 *
 * Filtered through `shipmentPo`, not through `clp.shipmentId` — a consolidated
 * box carries several bookings (CR-002), and only this booking's allocations
 * belong on this booking's advise.
 */
async function buildSeaLines(db: TenantDb, shipmentId: bigint): Promise<AdviseLineDraft[]> {
  const rows = await db.clpLine.findMany({
    where: {
      deletedAt: null,
      shipmentPo: { shipmentId, deletedAt: null },
      clp: { status: 'FINAL', deletedAt: null },
    },
    orderBy: [{ poNo: 'asc' }, { id: 'asc' }],
    select: {
      shipmentPoId: true,
      shipmentCargoLineId: true,
      clpId: true,
      poNo: true,
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
      clp: { select: { loadDatetime: true } },
    },
  });

  const cargoLineIds = [...new Set(rows.map((r) => r.shipmentCargoLineId))];
  const [efrs, receiptDates] = await Promise.all([
    efrNosOfCargoLines(db, cargoLineIds),
    receiptDatesOf(db, cargoLineIds),
  ]);

  return rows.map((row) => ({
    shipmentPoId: row.shipmentPoId,
    shipmentCargoLineId: row.shipmentCargoLineId,
    clpId: row.clpId,
    poNo: row.poNo,
    itemCode: row.itemCode,
    sku: row.sku,
    ctnQty: row.ctnQty,
    pcsQty: row.pcsQty,
    netWeightKg: row.netWeightKg,
    grossWeightKg: row.grossWeightKg,
    cartonLengthCm: row.cartonLengthCm,
    cartonWidthCm: row.cartonWidthCm,
    cartonHeightCm: row.cartonHeightCm,
    volumeCbm: row.volumeCbm,
    // Sea does not carry a chargeable weight — it is an air figure.
    chargeableWtKg: null,
    cargoReceiptDate: receiptDates.get(row.shipmentCargoLineId.toString()) ?? null,
    stuffingDate: row.clp?.loadDatetime ?? null,
    efrNo: (efrs.get(row.shipmentCargoLineId.toString()) ?? []).join(', ') || null,
  }));
}

/**
 * Air: the booking's cartons as the confirmed receipts hold them (§3.7).
 *
 * Aggregated per cargo line, because a line delivered on two receipts is one
 * row of the client's grid, not two.
 */
async function buildAirLines(db: TenantDb, shipmentId: bigint): Promise<AdviseLineDraft[]> {
  const rows = await db.cargoReceiptLine.findMany({
    where: {
      deletedAt: null,
      lineStatus: 'ACCEPTED',
      receipt: { shipmentId, status: 'CONFIRMED', deletedAt: null },
    },
    orderBy: [{ id: 'asc' }],
    select: {
      shipmentCargoLineId: true,
      receivedCtnQty: true,
      receivedPcsQty: true,
      receivedNetWeightKg: true,
      receivedGrossWeightKg: true,
      cartonLengthCm: true,
      cartonWidthCm: true,
      cartonHeightCm: true,
      receivedVolumeCbm: true,
      cargoLine: {
        select: {
          id: true,
          shipmentPoId: true,
          itemCode: true,
          sku: true,
          chargeableWtKg: true,
          shipmentPo: { select: { poNo: true } },
        },
      },
    },
  });

  const merged = new Map<string, AdviseLineDraft>();
  for (const row of rows) {
    const key = row.shipmentCargoLineId.toString();
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, {
        shipmentPoId: row.cargoLine.shipmentPoId,
        shipmentCargoLineId: row.cargoLine.id,
        clpId: null,
        poNo: row.cargoLine.shipmentPo.poNo,
        itemCode: row.cargoLine.itemCode,
        sku: row.cargoLine.sku,
        ctnQty: row.receivedCtnQty,
        pcsQty: row.receivedPcsQty,
        netWeightKg: row.receivedNetWeightKg,
        grossWeightKg: row.receivedGrossWeightKg,
        cartonLengthCm: row.cartonLengthCm,
        cartonWidthCm: row.cartonWidthCm,
        cartonHeightCm: row.cartonHeightCm,
        volumeCbm: row.receivedVolumeCbm,
        chargeableWtKg: row.cargoLine.chargeableWtKg,
        cargoReceiptDate: null,
        stuffingDate: null,
        efrNo: null,
      });
      continue;
    }
    existing.ctnQty += row.receivedCtnQty;
    if (row.receivedPcsQty !== null) existing.pcsQty = (existing.pcsQty ?? 0) + row.receivedPcsQty;
    existing.netWeightKg = sum([existing.netWeightKg, row.receivedNetWeightKg]);
    existing.grossWeightKg = sum([existing.grossWeightKg, row.receivedGrossWeightKg]);
    existing.volumeCbm = sum([existing.volumeCbm, row.receivedVolumeCbm]);
  }

  const lines = [...merged.values()].sort((a, b) => a.poNo.localeCompare(b.poNo));
  const cargoLineIds = lines.map((l) => l.shipmentCargoLineId);
  const [efrs, receiptDates, chargeable] = await Promise.all([
    efrNosOfCargoLines(db, cargoLineIds),
    receiptDatesOf(db, cargoLineIds),
    chargeableOf(db, cargoLineIds),
  ]);

  for (const line of lines) {
    const key = line.shipmentCargoLineId.toString();
    line.efrNo = (efrs.get(key) ?? []).join(', ') || null;
    line.cargoReceiptDate = receiptDates.get(key) ?? null;
    line.chargeableWtKg = chargeable.get(key) ?? line.chargeableWtKg;
  }
  return lines;
}

/**
 * The PO grid for one booking, from whichever source its mode uses.
 *
 * Refuses rather than returning an empty grid: an advise with no cargo on it is
 * not a document anybody should be able to send, and the reason is something
 * the operator can act on — finalise the plan, or confirm the receipt.
 */
export async function buildAdviseLines(
  db: TenantDb,
  shipmentId: bigint,
  shipmentType: 'SEA' | 'AIR',
  bookingNo: string,
): Promise<AdviseLineDraft[]> {
  const lines =
    shipmentType === 'AIR'
      ? await buildAirLines(db, shipmentId)
      : await buildSeaLines(db, shipmentId);

  if (lines.length === 0) {
    throw new HttpError(
      409,
      'NOTHING_TO_ADVISE',
      shipmentType === 'AIR'
        ? `${bookingNo} has no confirmed cargo receipt yet, so there is nothing to advise.`
        : `${bookingNo} has no finalised container load plan yet. The advise pulls its PO grid from one.`,
    );
  }
  return lines;
}

/** Whether a booking is ready, without throwing — for the prefill screen. */
export async function adviseBlockedReason(
  db: TenantDb,
  shipmentId: bigint,
  shipmentType: 'SEA' | 'AIR',
): Promise<string | null> {
  try {
    await buildAdviseLines(db, shipmentId, shipmentType, 'This booking');
    return null;
  } catch (error) {
    if (error instanceof HttpError && error.code === 'NOTHING_TO_ADVISE') return error.message;
    throw error;
  }
}
