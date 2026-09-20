import type { BlDraftContainerDto, BlDraftDto, BlDraftPrefillDto } from '@ff/shared';

import { Prisma } from '../generated/prisma/client';

import { HttpError } from './http-error';
import type { TenantDb } from './tenant-client';

/**
 * Reading a BL draft — docs/MODULE_DOCUMENTATION.md §2.3, §2.4.
 *
 * Shared by the staff router and the customer portal on purpose. §3.6 makes
 * both sheets one document in different states, and two readers of one table
 * would be two chances to disagree about what it says. What differs between
 * them is who may call which route and which rows RLS admits — never the shape
 * of the answer.
 */

const dec = (d: Prisma.Decimal | null): string | null => (d === null ? null : d.toString());
const stamp = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

export const blDraftArgs = {
  include: {
    shipment: {
      select: {
        id: true,
        code: true,
        shipmentType: true,
        exporterName: true,
        exporterAddress: true,
        importerName: true,
        importerAddress: true,
        placeOfReceipt: true,
        customer: { select: { id: true, name: true } },
      },
    },
    advise: { select: { id: true, houseBlNo: true, mblNo: true, status: true } },
    preCarriage: { select: { name: true } },
    deliveryAgent: { select: { name: true } },
    pol: { select: { name: true } },
    pod: { select: { name: true } },
    containers: {
      where: { deletedAt: null },
      orderBy: { id: 'asc' },
    },
  },
} satisfies { include: Prisma.BlDraftInclude };

export type BlDraftRow = Prisma.BlDraftGetPayload<typeof blDraftArgs>;

function containerDto(row: BlDraftRow['containers'][number]): BlDraftContainerDto {
  return {
    id: row.id.toString(),
    containerNo: row.containerNo,
    containerSize: row.containerSize,
    sealNo: row.sealNo,
    ctnQty: row.ctnQty,
    grossWeightKg: dec(row.grossWeightKg),
    measurementCbm: dec(row.measurementCbm),
  };
}

export function blDraftDto(
  row: BlDraftRow,
  recipients: { name: string | null; email: string }[],
): BlDraftDto {
  return {
    id: row.id.toString(),
    code: row.code,
    status: row.status,
    origin: row.origin,
    shipmentId: row.shipmentId.toString(),
    bookingNo: row.shipment.code,
    customerName: row.shipment.customer.name,
    blNo: row.blNo,
    mblNo: row.advise.mblNo,
    manifestNo: row.manifestNo,
    shipperText: row.shipperText,
    consigneeText: row.consigneeText,
    notifyText: row.notifyText,
    alsoNotifyText: row.alsoNotifyText,
    exportReferences: row.exportReferences,
    forwardingAgentReferences: row.forwardingAgentReferences,
    pointCountryOfOrigin: row.pointCountryOfOrigin,
    preCarriageByModeId: row.preCarriageByModeId.toString(),
    preCarriageByModeName: row.preCarriage.name,
    placeOfReceipt: row.placeOfReceipt,
    deliveryAgentId: row.deliveryAgentId?.toString() ?? null,
    deliveryAgentName: row.deliveryAgent?.name ?? null,
    deliveryAgentText: row.deliveryAgentText,
    oceanVesselVoyage: row.oceanVesselVoyage,
    polId: row.polId.toString(),
    polName: row.pol.name,
    podId: row.podId.toString(),
    podName: row.pod.name,
    placeOfDelivery: row.placeOfDelivery,
    packagesDescription: row.packagesDescription,
    marksAndNumbers: row.marksAndNumbers,
    grossWeightKg: dec(row.grossWeightKg),
    measurementCbm: dec(row.measurementCbm),
    freightPayableAt: row.freightPayableAt,
    originalBlCount: row.originalBlCount,
    ladenOnBoardDate: day(row.ladenOnBoardDate),
    submittedAt: stamp(row.submittedAt),
    approvedAt: stamp(row.approvedAt),
    sentAt: stamp(row.sentAt),
    cancelReason: row.cancelReason,
    containers: row.containers.map(containerDto),
    recipients,
  };
}

export async function recipientsOfCustomer(
  db: TenantDb,
  customerId: bigint,
): Promise<{ name: string | null; email: string }[]> {
  const pics = await db.customerPic.findMany({
    where: { customerId, deletedAt: null, isActive: true, email: { not: null } },
    orderBy: { id: 'asc' },
    select: { name: true, email: true },
  });
  return pics
    .filter((p): p is { name: string; email: string } => (p.email ?? '').trim() !== '')
    .map((p) => ({ name: p.name, email: p.email }));
}

export async function loadLiveBlDraft(
  db: TenantDb,
  shipmentId: bigint,
): Promise<BlDraftDto | null> {
  const row = await db.blDraft.findFirst({
    where: { shipmentId, deletedAt: null, status: { not: 'CANCELLED' } },
    orderBy: { id: 'desc' },
    ...blDraftArgs,
  });
  if (row === null) return null;
  return blDraftDto(row, await recipientsOfCustomer(db, row.shipment.customer.id));
}

export async function loadBlDraftById(db: TenantDb, id: bigint): Promise<BlDraftRow> {
  const row = await db.blDraft.findFirst({ where: { id, deletedAt: null }, ...blDraftArgs });
  if (row === null) throw HttpError.notFound('BL draft not found.');
  return row;
}

/**
 * The container block (B40), pulled from the booking's finalised plans.
 *
 * Filtered through the load plan's own lines for this booking, so a
 * consolidated box lists the container once and not once per participant.
 */
export async function containersForShipment(db: TenantDb, shipmentId: bigint) {
  const clps = await db.clp.findMany({
    where: {
      deletedAt: null,
      status: 'FINAL',
      lines: { some: { deletedAt: null, shipmentPo: { shipmentId, deletedAt: null } } },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      containerNo: true,
      sealNo: true,
      containerSize: { select: { name: true } },
      lines: {
        where: { deletedAt: null, shipmentPo: { shipmentId, deletedAt: null } },
        select: { ctnQty: true, grossWeightKg: true, volumeCbm: true },
      },
    },
  });

  return clps.map((clp) => {
    const ctnQty = clp.lines.reduce((acc, l) => acc + l.ctnQty, 0);
    const gross = clp.lines.reduce(
      (acc, l) => (l.grossWeightKg === null ? acc : acc.add(l.grossWeightKg)),
      new Prisma.Decimal(0),
    );
    const cbm = clp.lines.reduce(
      (acc, l) => (l.volumeCbm === null ? acc : acc.add(l.volumeCbm)),
      new Prisma.Decimal(0),
    );
    return {
      clpId: clp.id,
      containerNo: clp.containerNo,
      containerSize: clp.containerSize.name,
      sealNo: clp.sealNo,
      ctnQty,
      grossWeightKg: gross,
      measurementCbm: cbm,
    };
  });
}

/**
 * What the form opens on before anything is typed (§2.4's `Pull`).
 *
 * The party blocks come from the booking — exporter as shipper, importer as
 * consignee and notify — and belong to the document from that moment on (§3.4).
 */
export async function blDraftPrefill(
  db: TenantDb,
  shipmentId: bigint,
): Promise<BlDraftPrefillDto> {
  const shipment = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: {
      id: true,
      code: true,
      shipmentType: true,
      exporterName: true,
      exporterAddress: true,
      importerName: true,
      importerAddress: true,
      placeOfReceipt: true,
      modeId: true,
      polId: true,
      podId: true,
      customer: { select: { id: true, name: true } },
      mode: { select: { name: true } },
      pol: { select: { name: true } },
      pod: { select: { name: true } },
    },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');

  const advise = await db.shipmentAdvise.findFirst({
    where: { shipmentId, deletedAt: null, status: 'SENT' },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      houseBlNo: true,
      mblNo: true,
      firstVessel: { select: { name: true } },
      voyageNo: true,
      polId: true,
      podId: true,
      pol: { select: { name: true } },
      pod: { select: { name: true } },
    },
  });

  const containers = advise === null ? [] : await containersForShipment(db, shipmentId);
  const gross = containers.reduce((acc, c) => acc.add(c.grossWeightKg), new Prisma.Decimal(0));
  const cbm = containers.reduce((acc, c) => acc.add(c.measurementCbm), new Prisma.Decimal(0));

  const blocked =
    advise === null
      ? `${shipment.code} has no sent shipment advise yet. The BL number is allocated there.`
      : shipment.shipmentType === 'AIR'
        ? 'Both BL Draft sheets say "Only for Outbound shipment-Sea". An air equivalent is open question 8.'
        : null;

  const party = (name: string | null, address: string | null): string =>
    [name, address].filter((v) => (v ?? '').trim() !== '').join('\n');

  return {
    shipmentId: shipment.id.toString(),
    bookingNo: shipment.code,
    customerName: shipment.customer.name,
    blNo: advise?.houseBlNo ?? '',
    mblNo: advise?.mblNo ?? null,
    manifestNo: null,
    shipperText: party(shipment.exporterName, shipment.exporterAddress),
    consigneeText: party(shipment.importerName, shipment.importerAddress),
    notifyText: party(shipment.importerName, shipment.importerAddress),
    alsoNotifyText: null,
    exportReferences: null,
    forwardingAgentReferences: null,
    pointCountryOfOrigin: null,
    preCarriageByModeId: shipment.modeId?.toString() ?? '',
    preCarriageByModeName: shipment.mode?.name ?? '',
    placeOfReceipt: shipment.placeOfReceipt ?? '',
    deliveryAgentId: null,
    deliveryAgentName: null,
    deliveryAgentText: null,
    oceanVesselVoyage:
      advise === null
        ? null
        : [advise.firstVessel?.name, advise.voyageNo].filter((v) => (v ?? '') !== '').join(' / ') ||
          null,
    polId: (advise?.polId ?? shipment.polId).toString(),
    polName: advise?.pol.name ?? shipment.pol.name,
    podId: (advise?.podId ?? shipment.podId).toString(),
    podName: advise?.pod.name ?? shipment.pod.name,
    placeOfDelivery: null,
    packagesDescription: null,
    marksAndNumbers: null,
    grossWeightKg: containers.length === 0 ? null : gross.toString(),
    measurementCbm: containers.length === 0 ? null : cbm.toString(),
    freightPayableAt: null,
    originalBlCount: null,
    ladenOnBoardDate: null,
    containers: containers.map((c, index) => ({
      id: `draft-${index}`,
      containerNo: c.containerNo,
      containerSize: c.containerSize,
      sealNo: c.sealNo,
      ctnQty: c.ctnQty,
      grossWeightKg: c.grossWeightKg.toString(),
      measurementCbm: c.measurementCbm.toString(),
    })),
    recipients: await recipientsOfCustomer(db, shipment.customer.id),
    blockedReason: blocked,
  };
}
