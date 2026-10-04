import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  PRE_ALERT_DOCUMENT_LABEL,
  PRE_ALERT_DOCUMENTS_FOR,
  type PreAlertAgentOption,
  type PreAlertDetailDto,
  type PreAlertDocumentDto,
  type PreAlertDocumentKind,
  preAlertDocumentUploadSchema,
  preAlertListQuerySchema,
  type PreAlertRow,
  preAlertSendSchema,
  type PreAlertView,
  type ShipmentType,
} from '@ff/shared';

import { Prisma } from '../generated/prisma/client';
import { liveBlDraftRow } from '../lib/bl-draft-view';
import { queueMail } from '../lib/email-queue';
import { HttpError } from '../lib/http-error';
import { logger } from '../lib/logger';
import { day, milestonePicks, milestoneRows } from '../lib/milestone';
import { parseId } from '../lib/request';
import { displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';
import { blPrintDocument } from './bl-print.route';

/**
 * Customer Service → Pre-Alert (docs/DESIGN-UPDATE-2026-10-04.md §3).
 *
 * The list is the On board sheet's booking row for OUTBOUND bookings (§11
 * Q9: a pre-alert is what we send the destination agent; an inbound one is
 * theirs to send us), with the sheet's Status — Awaiting until one is sent.
 *
 * What can be attached, in order of preference:
 *   an upload       anything the operator uploaded for the booking wins
 *   the system's    HBL — a non-negotiable copy of the approved bill (BL
 *                   Print's COPY); Debit Note — the freight invoice as it was
 *                   sent to the customer
 * Booking confirmation, MBL, HAWB, MAWB and the air manifest are papers the
 * system does not make, so they are uploads only (§11 Q7, Q8).
 */

export const preAlertRouter: Router = Router();
preAlertRouter.use(authenticate);

const FEATURE = 'CUSTOMER_SERVICE.PRE_ALERT';

const SENT = Prisma.sql`EXISTS (
  SELECT 1 FROM pre_alert p
   WHERE p.tenant_id = s.tenant_id AND p.shipment_id = s.id AND p.deleted_at IS NULL
)`;

function viewConditions(view: PreAlertView): Prisma.Sql[] {
  if (view === 'AWAITING') return [Prisma.sql`NOT ${SENT}`];
  if (view === 'SENT') return [SENT];
  return [];
}

preAlertRouter.get('/pre-alerts', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = preAlertListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const found = await milestonePicks(
      db,
      auth.tenantId,
      {
        kind: 'DEPARTED',
        view: 'ALL',
        movementType: 'OUTBOUND',
        shipmentType: query.shipmentType,
        search: query.search,
        extra: viewConditions(query.view),
      },
      { by: query.sortBy ?? 'date', order: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
    const [base, sends] = await Promise.all([
      milestoneRows(db, 'DEPARTED', found.picks),
      db.preAlert.findMany({
        where: { shipmentId: { in: found.picks.map((p) => p.shipmentId) }, deletedAt: null },
        orderBy: { sentAt: 'desc' },
        select: { shipmentId: true, sentAt: true, agent: { select: { name: true } } },
      }),
    ]);
    const withSends: PreAlertRow[] = base.map((row) => {
      const mine = sends.filter((s) => s.shipmentId.toString() === row.shipmentId);
      const last = mine[0];
      return {
        ...row,
        lastSent: last === undefined ? null : { sentAt: last.sentAt.toISOString(), agentName: last.agent.name },
        sentCount: mine.length,
      };
    });
    return { rows: withSends, total: found.total };
  });

  const payload: ApiSuccess<PreAlertRow[]> = { success: true, data: rows, meta: buildMeta(query.page, query.limit, total) };
  res.json(payload);
});

/** A booking this screen may work on, with the reason when it may not. */
async function assertOutbound(
  db: TenantDb,
  tenantId: bigint,
  shipmentId: bigint,
): Promise<{ code: string; shipmentType: ShipmentType; podId: bigint; adviseId: bigint | null; plannedOn: Date | null }> {
  const booking = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: { code: true, shipmentType: true, podId: true, quotation: { select: { movementType: true } } },
  });
  if (booking === null) throw HttpError.notFound('Booking not found.');
  if (booking.quotation.movementType !== 'OUTBOUND') {
    throw new HttpError(
      409,
      'NOT_OUTBOUND',
      `${booking.code} is an inbound booking. A pre-alert is what we send the destination agent for an outbound one.`,
    );
  }
  const { picks } = await milestonePicks(
    db,
    tenantId,
    { kind: 'DEPARTED', view: 'ALL', movementType: 'OUTBOUND', shipmentId },
    { by: 'date', order: 'asc' },
    { page: 1, limit: 1 },
  );
  const pick = picks[0];
  if (pick === undefined) {
    throw new HttpError(409, 'NO_SCHEDULE', `${booking.code} is cancelled, or has no approved schedule or advise yet.`);
  }
  return { code: booking.code, shipmentType: booking.shipmentType, podId: booking.podId, adviseId: pick.adviseId, plannedOn: pick.plannedOn };
}

interface Resolved {
  dto: PreAlertDocumentDto;
  /** A file already in storage. */
  storageKey?: string;
  /** A document the system draws on demand. */
  render?: () => Promise<{ filename: string; pdf: Buffer }>;
}

async function resolveDocuments(
  db: TenantDb,
  tenantId: bigint,
  shipmentId: bigint,
  shipmentType: ShipmentType,
): Promise<Map<PreAlertDocumentKind, Resolved>> {
  const uploads = await db.preAlertDocument.findMany({
    where: { shipmentId, deletedAt: null },
    select: { kind: true, fileKey: true },
  });
  const uploadOf = new Map(uploads.map((u) => [u.kind, u.fileKey]));
  const out = new Map<PreAlertDocumentKind, Resolved>();

  for (const kind of PRE_ALERT_DOCUMENTS_FOR[shipmentType]) {
    const uploaded = uploadOf.get(kind);
    if (uploaded !== undefined) {
      out.set(kind, {
        dto: { kind, source: 'UPLOAD', fileName: displayNameFromKey(uploaded), note: null },
        storageKey: uploaded,
      });
      continue;
    }
    if (kind === 'HBL') {
      const bill = await liveBlDraftRow(db, shipmentId);
      if (bill !== null && bill.approvedAt !== null) {
        out.set(kind, {
          dto: { kind, source: 'SYSTEM', fileName: `${bill.blNo}-copy.pdf`, note: 'A non-negotiable copy of the approved bill.' },
          render: () => blPrintDocument(db, tenantId, bill, 'COPY'),
        });
        continue;
      }
      out.set(kind, { dto: { kind, source: null, fileName: null, note: 'No approved BL yet. Approve it, or upload a copy.' } });
      continue;
    }
    if (kind === 'DEBIT_NOTE') {
      const invoice = await db.debitInvoice.findFirst({
        where: { shipmentId, kind: 'FREIGHT', status: 'ISSUED', deletedAt: null, pdfFile: { not: null } },
        orderBy: { id: 'desc' },
        select: { code: true, pdfFile: true },
      });
      if (invoice?.pdfFile != null) {
        out.set(kind, {
          dto: { kind, source: 'SYSTEM', fileName: `${invoice.code}.pdf`, note: 'The freight invoice as it was sent to the customer.' },
          storageKey: invoice.pdfFile,
        });
        continue;
      }
      out.set(kind, { dto: { kind, source: null, fileName: null, note: 'The debit invoice has not been sent yet. Send it, or upload one.' } });
      continue;
    }
    out.set(kind, { dto: { kind, source: null, fileName: null, note: `Upload the ${PRE_ALERT_DOCUMENT_LABEL[kind]}.` } });
  }
  return out;
}

async function detailOf(db: TenantDb, tenantId: bigint, shipmentId: bigint): Promise<PreAlertDetailDto> {
  const booking = await assertOutbound(db, tenantId, shipmentId);
  const [documents, agents, sends] = await Promise.all([
    resolveDocuments(db, tenantId, shipmentId, booking.shipmentType),
    db.agent.findMany({
      where: { deletedAt: null, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        country: true,
        pics: { where: { deletedAt: null, isActive: true, email: { not: null } }, select: { email: true } },
        portCoverages: { where: { portId: booking.podId }, select: { portId: true } },
      },
    }),
    db.preAlert.findMany({
      where: { shipmentId, deletedAt: null },
      orderBy: { sentAt: 'desc' },
      select: {
        id: true,
        sentAt: true,
        toAddresses: true,
        documents: true,
        emailLogId: true,
        agent: { select: { name: true } },
        sentByUser: { select: { username: true } },
      },
    }),
  ]);

  const options: PreAlertAgentOption[] = agents
    .map((a) => ({
      id: a.id.toString(),
      name: a.name,
      country: a.country,
      emails: a.pics.flatMap((p) => (p.email === null || p.email.trim() === '' ? [] : [p.email.trim()])),
      coversPod: a.portCoverages.length > 0,
    }))
    // The agents at the destination first: they are the ones a pre-alert is for.
    .sort((x, y) => Number(y.coversPod) - Number(x.coversPod));

  return {
    shipmentId: shipmentId.toString(),
    bookingCode: booking.code,
    shipmentType: booking.shipmentType,
    documents: [...documents.values()].map((d) => d.dto),
    agents: options,
    sends: sends.map((s) => ({
      id: s.id.toString(),
      sentAt: s.sentAt.toISOString(),
      sentByName: s.sentByUser?.username ?? null,
      agentName: s.agent.name,
      to: s.toAddresses,
      documents: s.documents,
      emailed: s.emailLogId !== null,
    })),
  };
}

preAlertRouter.get('/pre-alerts/:shipmentId', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.shipmentId, 'booking');
  const data = await withTenant(auth.tenantId, (db) => detailOf(db, auth.tenantId, shipmentId));
  const payload: ApiSuccess<PreAlertDetailDto> = { success: true, data };
  res.json(payload);
});

/** Upload (or replace) one of the papers the system does not make. */
preAlertRouter.post(
  '/pre-alerts/:shipmentId/documents',
  requirePermission(`${FEATURE}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.shipmentId, 'booking');
    const { kind } = preAlertDocumentUploadSchema.parse(req.body);
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose a file to upload.');

    const { data, replaced } = await withTenant(auth.tenantId, async (db) => {
      const booking = await assertOutbound(db, auth.tenantId, shipmentId);
      if (!PRE_ALERT_DOCUMENTS_FOR[booking.shipmentType].includes(kind)) {
        throw HttpError.badRequest(
          `A ${PRE_ALERT_DOCUMENT_LABEL[kind]} does not belong to a ${booking.shipmentType === 'AIR' ? 'air' : 'sea'} shipment.`,
        );
      }
      const existing = await db.preAlertDocument.findFirst({
        where: { shipmentId, kind, deletedAt: null },
        select: { id: true, fileKey: true },
      });
      const stored = await putFile(auth.tenantId, 'pre-alert', file);
      if (existing === null) {
        await db.preAlertDocument.create({
          data: { tenantId: auth.tenantId, shipmentId, kind, fileKey: stored.key, createdBy: auth.userId, updatedBy: auth.userId },
        });
      } else {
        await db.preAlertDocument.update({ where: { id: existing.id }, data: { fileKey: stored.key, updatedBy: auth.userId } });
      }
      return { data: await detailOf(db, auth.tenantId, shipmentId), replaced: existing?.fileKey ?? null };
    });

    // Removed once the row points at the new file. A sent pre-alert's copy
    // already lives in the outbox record's attachment list as its own key.
    if (replaced !== null) await removeFile(auth.tenantId, replaced).catch(() => undefined);

    const payload: ApiSuccess<PreAlertDetailDto> = { success: true, data };
    res.status(201).json(payload);
  },
);

preAlertRouter.get(
  '/pre-alerts/:shipmentId/documents/:kind',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.shipmentId, 'booking');
    const { kind } = preAlertDocumentUploadSchema.parse({ kind: req.params.kind });

    const result = await withTenant(auth.tenantId, async (db) => {
      const booking = await assertOutbound(db, auth.tenantId, shipmentId);
      const doc = (await resolveDocuments(db, auth.tenantId, shipmentId, booking.shipmentType)).get(kind);
      if (doc === undefined || doc.dto.source === null) throw HttpError.notFound(doc?.dto.note ?? 'Not available.');
      if (doc.render !== undefined) {
        const rendered = await doc.render();
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
    res.setHeader('Content-Length', sizeBytes);
    stream.pipe(res);
  },
);

function contentTypeOf(fileName: string): string {
  if (/\.pdf$/i.test(fileName)) return 'application/pdf';
  if (/\.jpe?g$/i.test(fileName)) return 'image/jpeg';
  if (/\.png$/i.test(fileName)) return 'image/png';
  if (/\.docx$/i.test(fileName)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\.doc$/i.test(fileName)) return 'application/msword';
  return 'application/octet-stream';
}

/**
 * The sheet's `Send`: the ticked documents to the chosen agent's addresses,
 * from the Sales Team (I20; TEMPLATE_TEAM). A document that cannot be found
 * refuses the send and names itself — a pre-alert missing its MBL is a
 * pre-alert the agent has to chase.
 */
preAlertRouter.post('/pre-alerts/:shipmentId/send', requirePermission(`${FEATURE}.SEND`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.shipmentId, 'booking');
  const input = preAlertSendSchema.parse(req.body);
  const documents = [...new Set(input.documents)];

  const prepared = await withTenant(auth.tenantId, async (db) => {
    const booking = await assertOutbound(db, auth.tenantId, shipmentId);
    const agent = await db.agent.findFirst({
      where: { id: BigInt(input.agentId), deletedAt: null },
      select: { id: true, name: true },
    });
    if (agent === null) throw HttpError.badRequest('That agent is not available.');

    const offered = PRE_ALERT_DOCUMENTS_FOR[booking.shipmentType];
    const resolved = await resolveDocuments(db, auth.tenantId, shipmentId, booking.shipmentType);
    const attachments: { filename: string; contentType: string; storageKey: string }[] = [];
    for (const kind of offered.filter((k) => documents.includes(k))) {
      const doc = resolved.get(kind);
      if (doc === undefined || doc.dto.source === null) {
        throw new HttpError(409, 'DOCUMENT_MISSING', `${PRE_ALERT_DOCUMENT_LABEL[kind]}: ${doc?.dto.note ?? 'not available.'}`);
      }
      if (doc.render !== undefined) {
        // Drawn now and stored, so the outbox carries it by key like the rest.
        const rendered = await doc.render();
        const stored = await putFile(auth.tenantId, 'pre-alert', {
          buffer: rendered.pdf,
          originalname: rendered.filename,
          mimetype: 'application/pdf',
          size: rendered.pdf.length,
        });
        attachments.push({ filename: rendered.filename, contentType: 'application/pdf', storageKey: stored.key });
      } else {
        const name = doc.dto.fileName ?? 'document';
        attachments.push({ filename: name, contentType: contentTypeOf(name), storageKey: doc.storageKey! });
      }
    }
    const notOffered = documents.filter((k) => !offered.includes(k));
    if (notOffered.length > 0) {
      throw HttpError.badRequest(`${notOffered.map((k) => PRE_ALERT_DOCUMENT_LABEL[k]).join(', ')} is not part of this shipment's pre-alert.`);
    }

    const sent = await db.preAlert.create({
      data: {
        tenantId: auth.tenantId,
        shipmentId,
        agentId: agent.id,
        toAddresses: [...new Set(input.to.map((a) => a.trim()))],
        documents: offered.filter((k) => documents.includes(k)),
        sentBy: auth.userId,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      },
      select: { id: true },
    });

    const [row] = await milestoneRows(db, 'DEPARTED', [
      { shipmentId, adviseId: booking.adviseId, scheduleId: null, plannedOn: booking.plannedOn, confirmedOn: null },
    ]);
    const extra = await db.shipment.findFirst({ where: { id: shipmentId }, select: { importerName: true } });
    const advise =
      booking.adviseId === null
        ? null
        : await db.shipmentAdvise.findFirst({ where: { id: booking.adviseId }, select: { houseBlNo: true, mblNo: true, eta: true } });
    return { id: sent.id, agent, attachments, row, importerName: extra?.importerName ?? null, advise, booking };
  });

  const { row } = prepared;
  const containers = (row?.containers ?? [])
    .map((c) => [c.containerNo, c.size, c.sealNo === null ? null : `seal ${c.sealNo}`].filter(Boolean).join(' / '))
    .join('\n');
  let emailLogId: bigint | null = null;
  try {
    const queued = await queueMail({
      tenantId: auth.tenantId,
      templateKey: 'PRE_ALERT_SENT',
      to: input.to,
      attachments: prepared.attachments,
      variables: {
        agentName: prepared.agent.name,
        bookingNo: prepared.booking.code,
        shipperName: row?.exporterName ?? row?.customerName ?? '',
        consigneeName: prepared.importerName ?? '',
        polName: row?.polName ?? '',
        podName: row?.podName ?? '',
        modeWord: prepared.booking.shipmentType === 'AIR' ? 'Flight' : 'Vessel',
        legLabel: row?.legLabel ?? '',
        etd: day(prepared.booking.plannedOn) ?? '',
        eta: day(prepared.advise?.eta ?? null) ?? '',
        houseBlNo: prepared.advise?.houseBlNo ?? '',
        mblNo: prepared.advise?.mblNo ?? '',
        containers,
        documents: prepared.attachments.map((a) => a.filename).join(', '),
      },
      relatedType: 'pre_alert',
      relatedId: prepared.id,
      actorId: auth.userId,
      fallback: {
        subject: `Pre-alert — ${prepared.booking.code}${row === undefined ? '' : `, ${row.polName} to ${row.podName}`}`,
        bodyText: `Please find attached the pre-alert documents for booking ${prepared.booking.code}.`,
      },
    });
    emailLogId = queued.id ?? null;
  } catch (error) {
    logger.error({ err: error, preAlertId: prepared.id.toString() }, 'pre-alert not queued');
  }

  const data = await withTenant(auth.tenantId, async (db) => {
    await db.preAlert.update({ where: { id: prepared.id }, data: { emailLogId } });
    return detailOf(db, auth.tenantId, shipmentId);
  });
  const payload: ApiSuccess<PreAlertDetailDto> = { success: true, data };
  res.status(201).json(payload);
});
