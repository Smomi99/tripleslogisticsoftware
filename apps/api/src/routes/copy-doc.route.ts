import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  type CopyDocDetailDto,
  copyDocListQuerySchema,
  type CopyDocRow,
  COPY_DOCUMENT_KINDS,
  type CopyDocumentDto,
  type CopyDocumentKind,
  copyDocumentKindSchema,
  copyDocumentLabel,
  type MovementType,
  type ShipmentType,
} from '@ff/shared';

import { LIVE_MEMBERSHIP } from '../lib/advise-group';
import { liveBlDraftRow } from '../lib/bl-draft-view';
import { HttpError } from '../lib/http-error';
import { milestonePicks, milestoneRows } from '../lib/milestone';
import { parseId } from '../lib/request';
import { contentTypeOf, displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requireAnyPermission, requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';
import { blPrintDocument } from './bl-print.route';

/**
 * Documentation → Copy Doc upload (docs/DESIGN-UPDATE-2026-10-28.md §3).
 *
 * The list is every booking that has an approved schedule or an advise, sea
 * and air, inbound and outbound — the sheet's two sample rows are a sea export
 * and an air import. `Upload Doc` opens the nine papers (C16–C24).
 *
 * What a paper shows, in order of preference:
 *   a copy uploaded here    always wins
 *   what the system holds   House bill: Pre-Alert's upload, else the approved
 *                           bill (BL Print's COPY); Master bill: Pre-Alert's
 *                           upload; IGM: IGM Update's file; Delivery Order:
 *                           the issued DO letter
 * so nothing has to be uploaded twice. CO, commercial invoice, packing list,
 * GSP and EXP exist nowhere else and are uploads only.
 */

export const copyDocRouter: Router = Router();
copyDocRouter.use(authenticate);

const FEATURE = 'DOCUMENTATION.COPY_DOC_UPLOAD';

interface Booking {
  id: bigint;
  shipmentType: ShipmentType;
  movementType: MovementType;
}

/** Everything the nine papers could be drawn from, for one booking. */
interface Sources {
  uploads: Map<CopyDocumentKind, { key: string; at: Date; by: string | null }>;
  preAlertHouse: string | null;
  preAlertMaster: string | null;
  approvedBillNo: string | null;
  igm: { key: string | null; hblNo: string | null } | null;
  deliveryOrder: { key: string; code: string } | null;
}

/** One read per table for the whole page, so the list's count and the form agree. */
async function loadSources(db: TenantDb, ids: bigint[]): Promise<Map<string, Sources>> {
  const out = new Map<string, Sources>();
  for (const id of ids) {
    out.set(id.toString(), {
      uploads: new Map(),
      preAlertHouse: null,
      preAlertMaster: null,
      approvedBillNo: null,
      igm: null,
      deliveryOrder: null,
    });
  }
  if (ids.length === 0) return out;

  const [uploads, preAlert, igms, orders, bills] = await Promise.all([
    db.copyDocument.findMany({
      where: { shipmentId: { in: ids }, deletedAt: null },
      select: { shipmentId: true, kind: true, fileKey: true, updatedAt: true, updatedByUser: { select: { username: true } } },
    }),
    db.preAlertDocument.findMany({
      where: { shipmentId: { in: ids }, deletedAt: null, kind: { in: ['HBL', 'HAWB', 'MBL', 'MAWB'] } },
      select: { shipmentId: true, kind: true, fileKey: true },
    }),
    db.igmUpdate.findMany({ where: { shipmentId: { in: ids }, deletedAt: null }, select: { shipmentId: true, igmFile: true, hblNo: true } }),
    db.deliveryOrder.findMany({
      where: { shipmentId: { in: ids }, deletedAt: null, status: 'ISSUED', pdfFile: { not: null } },
      select: { shipmentId: true, code: true, pdfFile: true },
    }),
    // The bill a booking travels on, approved: what BL Print can copy. CR-005:
    // the bill covers every booking on its advise.
    db.blDraft.findMany({
      where: {
        deletedAt: null,
        status: { not: 'CANCELLED' },
        approvedAt: { not: null },
        advise: { bookings: { some: { shipmentId: { in: ids }, ...LIVE_MEMBERSHIP } } },
      },
      select: { blNo: true, advise: { select: { bookings: { where: { shipmentId: { in: ids }, ...LIVE_MEMBERSHIP }, select: { shipmentId: true } } } } },
    }),
  ]);

  for (const u of uploads) {
    out.get(u.shipmentId.toString())?.uploads.set(u.kind, { key: u.fileKey, at: u.updatedAt, by: u.updatedByUser?.username ?? null });
  }
  for (const p of preAlert) {
    const s = out.get(p.shipmentId.toString());
    if (s === undefined) continue;
    if (p.kind === 'HBL' || p.kind === 'HAWB') s.preAlertHouse = p.fileKey;
    else s.preAlertMaster = p.fileKey;
  }
  for (const g of igms) {
    const s = out.get(g.shipmentId.toString());
    if (s !== undefined) s.igm = { key: g.igmFile, hblNo: g.hblNo };
  }
  for (const d of orders) {
    const s = out.get(d.shipmentId.toString());
    if (s !== undefined && d.pdfFile !== null) s.deliveryOrder = { key: d.pdfFile, code: d.code };
  }
  for (const b of bills) {
    for (const m of b.advise.bookings) {
      const s = out.get(m.shipmentId.toString());
      if (s !== undefined) s.approvedBillNo = b.blNo;
    }
  }
  return out;
}

interface Resolved {
  dto: CopyDocumentDto;
  storageKey?: string;
  /** The approved bill, drawn by BL Print on demand. */
  fromBill?: true;
}

function resolve(kind: CopyDocumentKind, booking: Booking, src: Sources): Resolved {
  const label = copyDocumentLabel(kind, booking.shipmentType);
  const none = (note: string): Resolved => ({
    dto: { kind, label, source: null, fileName: null, note, uploadedAt: null, uploadedByName: null },
  });
  const held = (key: string, note: string, fileName = displayNameFromKey(key)): Resolved => ({
    dto: { kind, label, source: 'SYSTEM', fileName, note, uploadedAt: null, uploadedByName: null },
    storageKey: key,
  });

  const upload = src.uploads.get(kind);
  if (upload !== undefined) {
    return {
      dto: {
        kind,
        label,
        source: 'UPLOAD',
        fileName: displayNameFromKey(upload.key),
        note: null,
        uploadedAt: upload.at.toISOString(),
        uploadedByName: upload.by,
      },
      storageKey: upload.key,
    };
  }

  switch (kind) {
    case 'HOUSE_BL':
      if (src.preAlertHouse !== null) return held(src.preAlertHouse, 'Uploaded on Pre-Alert.');
      if (booking.shipmentType === 'SEA' && src.approvedBillNo !== null) {
        return {
          dto: {
            kind,
            label,
            source: 'SYSTEM',
            fileName: `${src.approvedBillNo}-copy.pdf`,
            note: 'A non-negotiable copy of the approved bill, from BL Print.',
            uploadedAt: null,
            uploadedByName: null,
          },
          fromBill: true,
        };
      }
      return none(
        booking.shipmentType === 'SEA' && booking.movementType === 'OUTBOUND'
          ? 'No approved BL yet. Approve it, or upload a copy.'
          : `Upload the ${label.toLowerCase()}.`,
      );
    case 'MASTER_BL':
      if (src.preAlertMaster !== null) return held(src.preAlertMaster, 'Uploaded on Pre-Alert.');
      return none(`Upload the ${label.toLowerCase()} as the carrier issued it.`);
    case 'IGM':
      if (src.igm?.key != null) return held(src.igm.key, 'From IGM Update.');
      return none(booking.movementType === 'INBOUND' ? 'Not on IGM Update yet. Upload a copy, or upload it there.' : 'Upload a copy.');
    case 'DELIVERY_ORDER':
      if (src.deliveryOrder !== null) {
        return held(src.deliveryOrder.key, 'The DO as it was issued.', `${src.deliveryOrder.code}.pdf`);
      }
      return none(booking.movementType === 'INBOUND' ? 'No DO issued yet. Upload a copy, or issue it on DO Issue.' : 'Upload a copy.');
    default:
      return none('Upload a copy.');
  }
}

copyDocRouter.get('/copy-docs', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = copyDocListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const found = await milestonePicks(
      db,
      auth.tenantId,
      {
        kind: 'DEPARTED',
        view: 'ALL',
        requireDeparture: false,
        shipmentType: query.shipmentType,
        movementType: query.movementType,
        search: query.search,
      },
      { by: query.sortBy ?? 'date', order: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
    const ids = found.picks.map((p) => p.shipmentId);
    const adviseIds = found.picks.flatMap((p) => (p.adviseId === null ? [] : [p.adviseId]));

    const [base, shipments, commodities, advises, sources] = await Promise.all([
      milestoneRows(db, 'DEPARTED', found.picks),
      db.shipment.findMany({
        where: { id: { in: ids } },
        select: { id: true, shipmentType: true, importerName: true, quotation: { select: { movementType: true } } },
      }),
      db.shipmentCommodity.findMany({
        where: { shipmentId: { in: ids } },
        orderBy: { id: 'asc' },
        select: { shipmentId: true, commodityItem: { select: { name: true } } },
      }),
      db.shipmentAdvise.findMany({ where: { id: { in: adviseIds } }, select: { id: true, houseBlNo: true, mblNo: true } }),
      loadSources(db, ids),
    ]);
    const shipmentOf = new Map(shipments.map((s) => [s.id.toString(), s]));
    const adviseOf = new Map(advises.map((a) => [a.id.toString(), a]));
    const pickOf = new Map(found.picks.map((p) => [p.shipmentId.toString(), p]));

    const withDocs: CopyDocRow[] = base.flatMap((row) => {
      const s = shipmentOf.get(row.shipmentId);
      const src = sources.get(row.shipmentId);
      if (s === undefined || src === undefined) return [];
      const booking: Booking = { id: s.id, shipmentType: s.shipmentType, movementType: s.quotation.movementType };
      const adviseId = pickOf.get(row.shipmentId)?.adviseId;
      const advise = adviseId == null ? undefined : adviseOf.get(adviseId.toString());
      const names = commodities.filter((c) => c.shipmentId.toString() === row.shipmentId).map((c) => c.commodityItem.name);
      return [
        {
          ...row,
          importerName: s.importerName,
          commodity: names.length === 0 ? null : names.join(', '),
          houseBlNo: advise?.houseBlNo ?? src.igm?.hblNo ?? null,
          mblNo: advise?.mblNo ?? null,
          movementType: booking.movementType,
          onFile: COPY_DOCUMENT_KINDS.filter((k) => resolve(k, booking, src).dto.source !== null).length,
        },
      ];
    });
    return { rows: withDocs, total: found.total };
  });

  const payload: ApiSuccess<CopyDocRow[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

/** A booking this screen may work on — on the list — with the reason when not. */
async function bookingOf(db: TenantDb, tenantId: bigint, shipmentId: bigint): Promise<Booking & { code: string }> {
  const s = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: { id: true, code: true, shipmentType: true, quotation: { select: { movementType: true } } },
  });
  if (s === null) throw HttpError.notFound('Booking not found.');
  const { picks } = await milestonePicks(
    db,
    tenantId,
    { kind: 'DEPARTED', view: 'ALL', requireDeparture: false, shipmentId },
    { by: 'date', order: 'asc' },
    { page: 1, limit: 1 },
  );
  if (picks.length === 0) {
    throw new HttpError(409, 'NO_SCHEDULE', `${s.code} is cancelled, or has no approved schedule or advise yet.`);
  }
  return { id: s.id, code: s.code, shipmentType: s.shipmentType, movementType: s.quotation.movementType };
}

async function detailOf(db: TenantDb, tenantId: bigint, shipmentId: bigint): Promise<CopyDocDetailDto> {
  const booking = await bookingOf(db, tenantId, shipmentId);
  const src = (await loadSources(db, [shipmentId])).get(shipmentId.toString())!;
  return {
    shipmentId: shipmentId.toString(),
    bookingCode: booking.code,
    shipmentType: booking.shipmentType,
    documents: COPY_DOCUMENT_KINDS.map((k) => resolve(k, booking, src).dto),
  };
}

copyDocRouter.get('/copy-docs/:shipmentId', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.shipmentId, 'booking');
  const data = await withTenant(auth.tenantId, (db) => detailOf(db, auth.tenantId, shipmentId));
  const payload: ApiSuccess<CopyDocDetailDto> = { success: true, data };
  res.json(payload);
});

/**
 * "browse and upload": one paper per request, the kind beside the file. The
 * first copy of a paper needs CREATE; replacing one needs EDIT.
 */
copyDocRouter.post(
  '/copy-docs/:shipmentId/documents',
  requireAnyPermission(`${FEATURE}.CREATE`, `${FEATURE}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.shipmentId, 'booking');
    const { kind } = copyDocumentKindSchema.parse(req.body);
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose a file to upload.');

    const { data, replaced } = await withTenant(auth.tenantId, async (db) => {
      await bookingOf(db, auth.tenantId, shipmentId);
      const existing = await db.copyDocument.findFirst({ where: { shipmentId, kind, deletedAt: null }, select: { id: true, fileKey: true } });
      const needed = existing === null ? `${FEATURE}.CREATE` : `${FEATURE}.EDIT`;
      if (!auth.isSuperadmin && !auth.permissions.has(needed)) {
        throw HttpError.forbidden(
          existing === null ? 'You may replace a copy but not upload a new one.' : 'You may upload a copy but not replace one.',
        );
      }
      const stored = await putFile(auth.tenantId, 'copy-doc', file);
      if (existing === null) {
        await db.copyDocument.create({
          data: { tenantId: auth.tenantId, shipmentId, kind, fileKey: stored.key, createdBy: auth.userId, updatedBy: auth.userId },
        });
      } else {
        await db.copyDocument.update({ where: { id: existing.id }, data: { fileKey: stored.key, updatedBy: auth.userId } });
      }
      return { data: await detailOf(db, auth.tenantId, shipmentId), replaced: existing?.fileKey ?? null };
    });

    // Removed once the row points at the new file, so the record never names a deleted one.
    if (replaced !== null) await removeFile(auth.tenantId, replaced).catch(() => undefined);

    const payload: ApiSuccess<CopyDocDetailDto> = { success: true, data };
    res.status(201).json(payload);
  },
);

copyDocRouter.get('/copy-docs/:shipmentId/documents/:kind', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.shipmentId, 'booking');
  const { kind } = copyDocumentKindSchema.parse({ kind: req.params.kind });

  const result = await withTenant(auth.tenantId, async (db) => {
    const booking = await bookingOf(db, auth.tenantId, shipmentId);
    const src = (await loadSources(db, [shipmentId])).get(shipmentId.toString())!;
    const doc = resolve(kind, booking, src);
    if (doc.dto.source === null) throw HttpError.notFound(doc.dto.note ?? 'Not on file.');
    if (doc.fromBill === true) {
      const bill = await liveBlDraftRow(db, shipmentId);
      if (bill === null) throw HttpError.notFound('No approved BL yet.');
      const rendered = await blPrintDocument(db, auth.tenantId, bill, 'COPY');
      return { pdf: rendered.pdf, filename: rendered.filename, key: null };
    }
    return { pdf: null, filename: doc.dto.fileName ?? 'document', key: doc.storageKey ?? null };
  });

  res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/"/g, '')}"`);
  if (result.pdf !== null) {
    res.setHeader('Content-Type', 'application/pdf');
    res.send(result.pdf);
    return;
  }
  const { stream, sizeBytes } = await openFile(auth.tenantId, result.key!);
  res.setHeader('Content-Type', contentTypeOf(result.key!));
  res.setHeader('Content-Length', sizeBytes);
  stream.pipe(res);
});

/**
 * Takes the uploaded copy off. A soft delete (§4 rule 3): the file and the row
 * stay. What the system holds, if anything, shows again.
 */
copyDocRouter.delete('/copy-docs/:shipmentId/documents/:kind', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.shipmentId, 'booking');
  const { kind } = copyDocumentKindSchema.parse({ kind: req.params.kind });

  const data = await withTenant(auth.tenantId, async (db) => {
    await bookingOf(db, auth.tenantId, shipmentId);
    const row = await db.copyDocument.findFirst({ where: { shipmentId, kind, deletedAt: null }, select: { id: true } });
    if (row === null) throw HttpError.notFound('No copy of that document has been uploaded.');
    await db.copyDocument.update({ where: { id: row.id }, data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId } });
    return detailOf(db, auth.tenantId, shipmentId);
  });

  const payload: ApiSuccess<CopyDocDetailDto> = { success: true, data };
  res.json(payload);
});
