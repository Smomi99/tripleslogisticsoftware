import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  type EgmDto,
  type VgmContainerDto,
  type VgmDto,
  type VgmEgmRow,
  type VgmEgmView,
  vgmEgmListQuerySchema,
  vgmSaveSchema,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { LIVE_MEMBERSHIP } from '../lib/advise-group';
import { HttpError } from '../lib/http-error';
import { milestonePicks, milestoneRows } from '../lib/milestone';
import { parseId } from '../lib/request';
import { contentTypeOf, displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * Operation → Upload VGM & EGM (docs/DESIGN-UPDATE-2026-10-28.md §2). Outbound
 * only — the Steps table: "VGM update — Outbound Yes, Inbound skip".
 *
 * The list is the On board sheet's booking row for OUTBOUND bookings (the
 * same candidates Pre-Alert draws), with two things beside it:
 *
 *   VGM   one per finalised container (clp), since a VGM is the verified
 *         gross mass of one packed box. Sea only.
 *   EGM   copies filed against the booking's live shipment advise — the BL
 *         the EGM panel names. Bookings sharing one advise share them.
 *
 * Each reads Uploaded once its file is in, Pending until then (§6 Q10).
 */

export const vgmEgmRouter: Router = Router();
vgmEgmRouter.use(authenticate);

const FEATURE = 'OPERATION.VGM_EGM';

/** The booking's finalised containers, by clp_booking (CR-002 §2). */
const FINAL_CLPS = Prisma.sql`
  SELECT k.id
    FROM clp_booking cb
    JOIN clp k ON k.tenant_id = cb.tenant_id AND k.id = cb.clp_id
   WHERE cb.tenant_id = s.tenant_id AND cb.shipment_id = s.id
     AND cb.deleted_at IS NULL AND k.deleted_at IS NULL AND k.status = 'FINAL'`;

const VGM_IN = Prisma.sql`(
  EXISTS (${FINAL_CLPS})
  AND NOT EXISTS (
    ${FINAL_CLPS}
       AND NOT EXISTS (
         SELECT 1 FROM vgm v
          WHERE v.tenant_id = k.tenant_id AND v.clp_id = k.id
            AND v.deleted_at IS NULL AND v.vgm_file IS NOT NULL
       )
  )
)`;

const EGM_IN = Prisma.sql`EXISTS (
  SELECT 1
    FROM shipment_advise_booking ab
    JOIN shipment_advise a ON a.tenant_id = ab.tenant_id AND a.id = ab.advise_id
    JOIN egm_document e    ON e.tenant_id = a.tenant_id AND e.advise_id = a.id AND e.deleted_at IS NULL
   WHERE ab.tenant_id = s.tenant_id AND ab.shipment_id = s.id
     AND ab.released_at IS NULL AND ab.deleted_at IS NULL
     AND a.deleted_at IS NULL AND a.status <> 'CANCELLED'
)`;

/** On air there is no VGM, so the EGM alone decides. */
function viewConditions(view: VgmEgmView, isAir: boolean): Prisma.Sql[] {
  const done = isAir ? EGM_IN : Prisma.sql`(${VGM_IN} AND ${EGM_IN})`;
  if (view === 'PENDING') return [Prisma.sql`NOT ${done}`];
  if (view === 'UPLOADED') return [done];
  return [];
}

const VGM_SELECT = {
  carrierBookingNo: true,
  vgmKg: true,
  grossWeightKg: true,
  signatoryName: true,
  vgmFile: true,
  updatedAt: true,
  updatedByUser: { select: { username: true } },
} as const;

type VgmRecord = Prisma.VgmGetPayload<{ select: typeof VGM_SELECT }>;

function vgmDto(row: VgmRecord): VgmDto {
  return {
    carrierBookingNo: row.carrierBookingNo,
    vgmKg: row.vgmKg.toFixed(3),
    grossWeightKg: row.grossWeightKg?.toFixed(3) ?? null,
    signatoryName: row.signatoryName,
    fileName: row.vgmFile === null ? null : displayNameFromKey(row.vgmFile),
    uploaded: row.vgmFile !== null,
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedByUser?.username ?? null,
  };
}

const EGM_SELECT = {
  id: true,
  code: true,
  houseBlNo: true,
  mblNo: true,
  carrier: { select: { name: true } },
  // CR-005: one advise, one BL, several bookings — they share its EGM.
  bookings: { where: LIVE_MEMBERSHIP, orderBy: { shipmentId: 'asc' }, select: { shipment: { select: { code: true } } } },
  egmDocuments: {
    where: { deletedAt: null },
    orderBy: { id: 'asc' },
    select: { id: true, fileKey: true, createdAt: true, createdByUser: { select: { username: true } } },
  },
} as const;

type EgmRecord = Prisma.ShipmentAdviseGetPayload<{ select: typeof EGM_SELECT }>;

function egmDto(row: EgmRecord): EgmDto {
  return {
    adviseId: row.id.toString(),
    adviseCode: row.code,
    houseBlNo: row.houseBlNo,
    mblNo: row.mblNo,
    carrierName: row.carrier.name,
    bookingCodes: row.bookings.map((b) => b.shipment.code),
    files: row.egmDocuments.map((d) => ({
      id: d.id.toString(),
      fileName: displayNameFromKey(d.fileKey),
      uploadedAt: d.createdAt.toISOString(),
      uploadedByName: d.createdByUser?.username ?? null,
    })),
  };
}

vgmEgmRouter.get('/vgm-egm', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = vgmEgmListQuerySchema.parse(req.query);
  const isAir = query.shipmentType === 'AIR';

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const found = await milestonePicks(
      db,
      auth.tenantId,
      {
        kind: 'DEPARTED',
        view: 'ALL',
        requireDeparture: false,
        movementType: 'OUTBOUND',
        shipmentType: query.shipmentType,
        search: query.search,
        extra: viewConditions(query.view, isAir),
      },
      { by: query.sortBy ?? 'date', order: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
    const ids = found.picks.map((p) => p.shipmentId);
    const adviseIds = found.picks.flatMap((p) => (p.adviseId === null ? [] : [p.adviseId]));
    const scheduleIds = found.picks.flatMap((p) => (p.scheduleId === null ? [] : [p.scheduleId]));

    const [base, commodities, boxes, advises, schedules] = await Promise.all([
      milestoneRows(db, 'DEPARTED', found.picks),
      db.shipmentCommodity.findMany({
        where: { shipmentId: { in: ids } },
        orderBy: { id: 'asc' },
        select: { shipmentId: true, commodityItem: { select: { name: true } } },
      }),
      isAir
        ? Promise.resolve([])
        : db.clpBooking.findMany({
            where: { shipmentId: { in: ids }, deletedAt: null, clp: { status: 'FINAL', deletedAt: null } },
            orderBy: { clpId: 'asc' },
            select: {
              shipmentId: true,
              clp: {
                select: {
                  id: true,
                  code: true,
                  containerNo: true,
                  sealNo: true,
                  totalGrossWeightKg: true,
                  containerSize: { select: { name: true } },
                  vgms: { where: { deletedAt: null }, select: VGM_SELECT },
                  // A consolidated box (CR-002) carries several bookings and one VGM.
                  bookings: {
                    where: { deletedAt: null, shipment: { deletedAt: null } },
                    orderBy: { shipmentId: 'asc' },
                    select: { shipment: { select: { code: true } } },
                  },
                },
              },
            },
          }),
      db.shipmentAdvise.findMany({ where: { id: { in: adviseIds } }, select: EGM_SELECT }),
      // The schedule the booking sails on: its Carrier Booking No is what a new VGM opens on.
      db.shipmentSchedule.findMany({ where: { id: { in: scheduleIds } }, select: { id: true, carrierBookingNo: true } }),
    ]);

    const adviseOf = new Map(advises.map((a) => [a.id.toString(), a]));
    const bookingNoOf = new Map(schedules.map((s) => [s.id.toString(), s.carrierBookingNo]));
    const pickOf = new Map(found.picks.map((p) => [p.shipmentId.toString(), p]));

    const withStages: VgmEgmRow[] = base.map((row) => {
      const containers: VgmContainerDto[] = boxes
        .filter((b) => b.shipmentId.toString() === row.shipmentId)
        .map(({ clp }) => {
          const vgm = clp.vgms[0];
          return {
            clpId: clp.id.toString(),
            clpCode: clp.code,
            containerNo: clp.containerNo,
            sealNo: clp.sealNo,
            size: clp.containerSize.name,
            cargoGrossWeightKg: clp.totalGrossWeightKg?.toFixed(3) ?? null,
            bookingCodes: clp.bookings.map((b) => b.shipment.code),
            vgm: vgm === undefined ? null : vgmDto(vgm),
          };
        });
      const scheduleId = pickOf.get(row.shipmentId)?.scheduleId;
      const adviseId = pickOf.get(row.shipmentId)?.adviseId;
      const advise = adviseId == null ? undefined : adviseOf.get(adviseId.toString());
      const names = commodities.filter((c) => c.shipmentId.toString() === row.shipmentId).map((c) => c.commodityItem.name);
      return {
        ...row,
        commodity: names.length === 0 ? null : names.join(', '),
        vgmContainers: containers,
        vgmStatus: isAir
          ? null
          : containers.length > 0 && containers.every((c) => c.vgm?.uploaded === true)
            ? 'UPLOADED'
            : 'PENDING',
        egm: advise === undefined ? null : egmDto(advise),
        egmStatus: advise !== undefined && advise.egmDocuments.length > 0 ? 'UPLOADED' : 'PENDING',
        scheduleCarrierBookingNo: scheduleId == null ? null : (bookingNoOf.get(scheduleId.toString()) ?? null),
      };
    });
    return { rows: withStages, total: found.total };
  });

  const payload: ApiSuccess<VgmEgmRow[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

// ===========================================================================
// VGM — one per finalised container
// ===========================================================================

/**
 * A container this screen may record a VGM for: finalised, and holding
 * outbound bookings only. Inbound skips VGM (Steps table, B43).
 */
async function assertOutboundContainer(db: TenantDb, clpId: bigint): Promise<{ code: string }> {
  const clp = await db.clp.findFirst({
    where: { id: clpId, deletedAt: null },
    select: {
      code: true,
      status: true,
      bookings: {
        where: { deletedAt: null },
        select: { shipment: { select: { code: true, status: true, deletedAt: true, quotation: { select: { movementType: true } } } } },
      },
    },
  });
  if (clp === null) throw HttpError.notFound('Load plan not found.');
  if (clp.status !== 'FINAL') {
    throw new HttpError(409, 'CLP_NOT_FINAL', `${clp.code} is not finalised. A VGM is recorded for a finalised container.`);
  }
  const live = clp.bookings.filter((b) => b.shipment.deletedAt === null);
  const inbound = live.find((b) => b.shipment.quotation.movementType !== 'OUTBOUND');
  if (inbound !== undefined) {
    throw new HttpError(409, 'NOT_OUTBOUND', `${inbound.shipment.code} is not an outbound booking. VGM is for outbound shipments only.`);
  }
  if (!live.some((b) => b.shipment.status !== 'CANCELLED' && b.shipment.status !== 'REJECTED')) {
    throw new HttpError(409, 'BOOKING_CLOSED', `Every booking in ${clp.code} is cancelled or rejected.`);
  }
  return { code: clp.code };
}

/**
 * The VGM panel's Save: JSON without a file, multipart with one. The first
 * save needs CREATE; changing what is there needs EDIT.
 */
vgmEgmRouter.post(
  '/vgm/:clpId',
  requireAnyPermission(`${FEATURE}.CREATE`, `${FEATURE}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const clpId = parseId(req.params.clpId, 'load plan');
    const input = vgmSaveSchema.parse(req.body);
    const file = req.file;

    const { saved, replacedFile } = await withTenant(auth.tenantId, async (db) => {
      await assertOutboundContainer(db, clpId);
      const existing = await db.vgm.findFirst({ where: { clpId, deletedAt: null }, select: { id: true, vgmFile: true } });
      const needed = existing === null ? `${FEATURE}.CREATE` : `${FEATURE}.EDIT`;
      if (!auth.isSuperadmin && !auth.permissions.has(needed)) {
        throw HttpError.forbidden(
          existing === null ? 'You may change a VGM but not record a new one.' : 'You may record a VGM but not change one.',
        );
      }

      const stored = file === undefined ? null : await putFile(auth.tenantId, 'vgm', file);
      const data = {
        carrierBookingNo: input.carrierBookingNo,
        vgmKg: new Prisma.Decimal(input.vgmKg),
        grossWeightKg: input.grossWeightKg === undefined ? null : new Prisma.Decimal(input.grossWeightKg),
        signatoryName: input.signatoryName,
        ...(stored === null ? {} : { vgmFile: stored.key }),
        updatedBy: auth.userId,
      };
      const row =
        existing === null
          ? await db.vgm.create({ data: { tenantId: auth.tenantId, clpId, ...data, createdBy: auth.userId }, select: VGM_SELECT })
          : await db.vgm.update({ where: { id: existing.id }, data, select: VGM_SELECT });
      return { saved: row, replacedFile: stored !== null && existing?.vgmFile != null ? existing.vgmFile : null };
    });

    // Removed after the row points at the new file, so a failure here never
    // leaves the record naming a deleted one.
    if (replacedFile !== null) await removeFile(auth.tenantId, replacedFile);

    const payload: ApiSuccess<VgmDto> = { success: true, data: vgmDto(saved) };
    res.json(payload);
  },
);

vgmEgmRouter.get('/vgm/:clpId/file', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const clpId = parseId(req.params.clpId, 'load plan');
  const key = await withTenant(auth.tenantId, async (db) => {
    const row = await db.vgm.findFirst({ where: { clpId, deletedAt: null }, select: { vgmFile: true } });
    if (row === null || row.vgmFile === null) throw HttpError.notFound('No VGM file has been uploaded.');
    return row.vgmFile;
  });
  const { stream, sizeBytes } = await openFile(auth.tenantId, key);
  res.setHeader('Content-Type', contentTypeOf(key));
  res.setHeader('Content-Length', sizeBytes);
  res.setHeader('Content-Disposition', `attachment; filename="${displayNameFromKey(key).replace(/"/g, '')}"`);
  stream.pipe(res);
});

// ===========================================================================
// EGM — copies filed against the bill
// ===========================================================================

/** A live advise covering outbound bookings only. */
async function assertOutboundAdvise(db: TenantDb, adviseId: bigint): Promise<void> {
  const advise = await db.shipmentAdvise.findFirst({
    where: { id: adviseId, deletedAt: null },
    select: {
      code: true,
      status: true,
      bookings: {
        where: { deletedAt: null, releasedAt: null },
        select: { shipment: { select: { code: true, quotation: { select: { movementType: true } } } } },
      },
    },
  });
  if (advise === null) throw HttpError.notFound('Shipment advise not found.');
  if (advise.status === 'CANCELLED') {
    throw new HttpError(409, 'ADVISE_CANCELLED', `${advise.code} is cancelled. File the EGM against the live advise.`);
  }
  const inbound = advise.bookings.find((b) => b.shipment.quotation.movementType !== 'OUTBOUND');
  if (inbound !== undefined) {
    throw new HttpError(409, 'NOT_OUTBOUND', `${inbound.shipment.code} is not an outbound booking. EGM is for outbound shipments only.`);
  }
}

async function loadEgm(db: TenantDb, adviseId: bigint): Promise<EgmDto> {
  const row = await db.shipmentAdvise.findFirst({ where: { id: adviseId, deletedAt: null }, select: EGM_SELECT });
  if (row === null) throw HttpError.notFound('Shipment advise not found.');
  return egmDto(row);
}

/** J16 "Upload EGM copy": one file per request, as many requests as there are copies. */
vgmEgmRouter.post('/egm/:adviseId/files', requirePermission(`${FEATURE}.CREATE`), uploadSingle, async (req, res) => {
  const auth = req.auth!;
  const adviseId = parseId(req.params.adviseId, 'shipment advise');
  const file = req.file;
  if (file === undefined) throw HttpError.badRequest('Choose a file to upload.');

  const data = await withTenant(auth.tenantId, async (db) => {
    await assertOutboundAdvise(db, adviseId);
    const stored = await putFile(auth.tenantId, 'egm', file);
    await db.egmDocument.create({
      data: { tenantId: auth.tenantId, adviseId, fileKey: stored.key, createdBy: auth.userId, updatedBy: auth.userId },
    });
    return loadEgm(db, adviseId);
  });

  const payload: ApiSuccess<EgmDto> = { success: true, data };
  res.status(201).json(payload);
});

vgmEgmRouter.get('/egm/:adviseId/files/:fileId', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const adviseId = parseId(req.params.adviseId, 'shipment advise');
  const fileId = parseId(req.params.fileId, 'file');
  const key = await withTenant(auth.tenantId, async (db) => {
    const row = await db.egmDocument.findFirst({ where: { id: fileId, adviseId, deletedAt: null }, select: { fileKey: true } });
    if (row === null) throw HttpError.notFound('EGM copy not found.');
    return row.fileKey;
  });
  const { stream, sizeBytes } = await openFile(auth.tenantId, key);
  res.setHeader('Content-Type', contentTypeOf(key));
  res.setHeader('Content-Length', sizeBytes);
  res.setHeader('Content-Disposition', `attachment; filename="${displayNameFromKey(key).replace(/"/g, '')}"`);
  stream.pipe(res);
});

/**
 * Takes a copy off the EGM. A soft delete (§4 rule 3): the file and the row
 * stay, so a copy removed by mistake can still be recovered.
 */
vgmEgmRouter.delete('/egm/:adviseId/files/:fileId', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const adviseId = parseId(req.params.adviseId, 'shipment advise');
  const fileId = parseId(req.params.fileId, 'file');

  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await db.egmDocument.findFirst({ where: { id: fileId, adviseId, deletedAt: null }, select: { id: true } });
    if (row === null) throw HttpError.notFound('EGM copy not found.');
    await db.egmDocument.update({ where: { id: fileId }, data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId } });
    return loadEgm(db, adviseId);
  });

  const payload: ApiSuccess<EgmDto> = { success: true, data };
  res.json(payload);
});
