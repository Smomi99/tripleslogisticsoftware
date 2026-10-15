import { Router } from 'express';

import {
  type ApiSuccess,
  AWB_ORIGINALS,
  billTerms,
  type BlDraftDto,
  type BlDraftPrefillDto,
  type BlTemplateDto,
  blDraftCancelSchema,
  blDraftInputSchema,
  blDraftSendSchema,
  blTemplateInputSchema,
  CODE_PREFIX,
  freightTermsOf,
  seaBillGaps,
  type ShipmentType,
} from '@ff/shared';

import { adviseMembers, liveAdviseOf } from '../lib/advise-group';
import { type AwbPdfInput, renderAwbPdf } from '../lib/awb-pdf';
import {
  airRouteOf,
  type BlDraftRow,
  billBookings,
  blDraftPrefill,
  containersForShipments,
  loadBlDraftById,
  loadLiveBlDraft,
} from '../lib/bl-draft-view';
import { type BlDraftPdfInput, type BlPrintMark, renderBlDraftPdf } from '../lib/bl-draft-pdf';
import { letterheadOf, logoOf } from '../lib/letterhead';
import { logger } from '../lib/logger';
import { putFile } from '../lib/storage';
import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { queueMail } from '../lib/email-queue';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { houseBlPrefixFor, nextBlDraftNo, seriesYearOf } from '../lib/inquiry-no';
import { parseId } from '../lib/request';
import { transitionShipment } from '../lib/shipment-status';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { tenantDayOf } from '../lib/tenant-day';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * BL Draft — docs/MODULE_DOCUMENTATION.md §2.3, §5, §14.
 *
 * One record for the staff copy and the customer's (§3.6): what differs is
 * `origin`, the status it moves through, and which router may touch it. A sea
 * booking's is a bill of lading; an air booking's is a House Air Waybill
 * (§14) — the same row and the same lifecycle, printed on the waybill.
 */
export const blDraftRouter: Router = Router();

const FEATURE = 'DOCUMENTATION.BL_DRAFT';
const TEMPLATE_FEATURE = 'DOCUMENTATION.BL_TEMPLATE';

blDraftRouter.use(authenticate);

/**
 * Writes the container block from the finalised plans of every booking on the
 * bill's advise (CR-005).
 */
export async function writeContainers(
  db: TenantDb,
  tenantId: bigint,
  blDraftId: bigint,
  adviseId: bigint,
  userId: bigint,
): Promise<void> {
  const members = await adviseMembers(db, adviseId);
  const containers = await containersForShipments(db, members.map((m) => m.id));
  await db.blDraftContainer.updateMany({
    where: { blDraftId, deletedAt: null },
    data: { deletedAt: new Date(), updatedBy: userId },
  });
  if (containers.length === 0) return;
  await db.blDraftContainer.createMany({
    data: containers.map((c) => ({
      tenantId,
      blDraftId,
      clpId: c.clpId,
      containerNo: c.containerNo,
      containerSize: c.containerSize,
      sealNo: c.sealNo,
      ctnQty: c.ctnQty,
      grossWeightKg: c.grossWeightKg,
      measurementCbm: c.measurementCbm,
      createdBy: userId,
      updatedBy: userId,
    })),
  });
}

/**
 * A sea bill's starred boxes (B34, F34), which the schema cannot require
 * because an air waybill has neither (§14). Refused in the same shape as any
 * other field error, naming what is missing.
 */
export function assertBillComplete(
  input: ReturnType<typeof blDraftInputSchema.parse>,
  shipmentType: ShipmentType,
): void {
  if (shipmentType === 'AIR') return;
  const gaps = seaBillGaps(input);
  if (gaps !== null) {
    throw new HttpError(400, 'VALIDATION_ERROR', Object.values(gaps).flat().join(' '), gaps);
  }
}

/**
 * The columns both the staff form and the customer form write.
 *
 * An air waybill (§14) has no pre-carriage, place of receipt or ocean vessel,
 * and is always issued in three originals; a sea bill has no pieces or
 * chargeable weight boxes. Whatever the form sent for the other mode's boxes
 * is not kept, so a row never carries a figure its document cannot print.
 */
export function blDraftWriteData(
  input: ReturnType<typeof blDraftInputSchema.parse>,
  shipmentType: ShipmentType,
) {
  const isAir = shipmentType === 'AIR';
  return {
    manifestNo: input.manifestNo ?? null,
    shipperText: input.shipperText,
    consigneeText: input.consigneeText,
    notifyText: input.notifyText,
    alsoNotifyText: input.alsoNotifyText ?? null,
    exportReferences: input.exportReferences ?? null,
    forwardingAgentReferences: input.forwardingAgentReferences ?? null,
    pointCountryOfOrigin: input.pointCountryOfOrigin ?? null,
    preCarriageByModeId:
      isAir || input.preCarriageByModeId == null ? null : BigInt(input.preCarriageByModeId),
    placeOfReceipt: isAir ? null : (input.placeOfReceipt ?? null),
    oceanVesselVoyage: isAir ? null : (input.oceanVesselVoyage ?? null),
    polId: BigInt(input.polId),
    podId: BigInt(input.podId),
    placeOfDelivery: input.placeOfDelivery ?? null,
    packagesDescription: input.packagesDescription ?? null,
    marksAndNumbers: input.marksAndNumbers ?? null,
    grossWeightKg: input.grossWeightKg == null ? null : new Prisma.Decimal(input.grossWeightKg),
    measurementCbm: input.measurementCbm == null ? null : new Prisma.Decimal(input.measurementCbm),
    packageCount: isAir ? (input.packageCount ?? null) : null,
    chargeableWeightKg:
      isAir && input.chargeableWeightKg != null ? new Prisma.Decimal(input.chargeableWeightKg) : null,
    freightPayableAt: input.freightPayableAt ?? null,
    originalBlCount: isAir ? AWB_ORIGINALS.length : (input.originalBlCount ?? null),
    ladenOnBoardDate: input.ladenOnBoardDate == null ? null : new Date(input.ladenOnBoardDate),
  };
}

/**
 * A draft is approved once, and never after it was cancelled.
 *
 * SENT without an approval is the ordinary case, not an odd one: the draft went
 * to the customer to check, watermarked, and approving it once they confirm is
 * what moves the booking on to BL Print (§13). Refusing it — as the edit guard
 * below rightly does for edits — left that booking with no way forward but a
 * cancellation and a second draft of the same bill.
 */
function assertBlApprovable(row: { code: string; status: string; approvedAt: Date | null }): void {
  if (row.status === 'CANCELLED') {
    throw new HttpError(409, 'BL_DRAFT_CANCELLED', `${row.code} was cancelled.`);
  }
  if (row.approvedAt !== null) {
    throw new HttpError(409, 'BL_DRAFT_SETTLED', `${row.code} has already been approved.`);
  }
}

/** An approved or sent draft is the document, not a form. §5 rule 3. */
export function assertBlEditable(row: { code: string; status: string }): void {
  if (row.status === 'APPROVED' || row.status === 'SENT') {
    throw new HttpError(
      409,
      'BL_DRAFT_SETTLED',
      `${row.code} has been ${row.status.toLowerCase()}. Cancel it and draft another rather than editing it.`,
    );
  }
  if (row.status === 'CANCELLED') {
    throw new HttpError(409, 'BL_DRAFT_CANCELLED', `${row.code} was cancelled.`);
  }
}

/**
 * Creates the row. Shared with the customer portal, which passes
 * origin: 'CUSTOMER' — the one field that tells the two sheets apart.
 */
export async function createBlDraft(
  db: TenantDb,
  args: {
    tenantId: bigint;
    userId: bigint;
    shipmentId: bigint;
    origin: 'STAFF' | 'CUSTOMER';
    input: ReturnType<typeof blDraftInputSchema.parse>;
    deliveryAgentId: bigint | null;
    deliveryAgentText: string | null;
  },
): Promise<bigint> {
  const shipment = await db.shipment.findFirst({
    where: { id: args.shipmentId, deletedAt: null },
    select: { id: true, code: true, shipmentType: true },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');

  assertBillComplete(args.input, shipment.shipmentType);
  const terms = billTerms(shipment.shipmentType);

  // CR-005: the advise this booking is on, made from it or from another
  // booking of its EFR. The bill is that advise's, one for all its bookings.
  const advise = await liveAdviseOf(db, args.shipmentId, 'SENT');
  if (advise === null) {
    throw new HttpError(
      409,
      'NO_ADVISE',
      `${shipment.code} has no sent shipment advise. The ${terms.short} number is allocated there.`,
    );
  }

  const existing = await db.blDraft.findFirst({
    where: { adviseId: advise.id, deletedAt: null, status: { not: 'CANCELLED' } },
    select: { code: true },
  });
  if (existing !== null) {
    throw new HttpError(
      409,
      'ALREADY_DRAFTED',
      `${shipment.code} already has ${existing.code}. Work that one rather than starting another.`,
    );
  }

  const seriesYear = seriesYearOf(new Date());
  let created: { id: bigint } | null = null;
  for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
    const code = await nextBlDraftNo(db, args.tenantId, seriesYear);
    try {
      created = await db.blDraft.create({
        data: {
          tenantId: args.tenantId,
          code,
          seriesYear,
          // The advise's own booking — the database holds the bill to it.
          shipmentId: advise.shipmentId,
          adviseId: advise.id,
          origin: args.origin,
          blNo: advise.houseBlNo,
          deliveryAgentId: args.deliveryAgentId,
          deliveryAgentText: args.deliveryAgentText,
          ...blDraftWriteData(args.input, shipment.shipmentType),
          status: 'DRAFT',
          createdBy: args.userId,
          updatedBy: args.userId,
        },
        select: { id: true },
      });
      break;
    } catch (error) {
      if (attempt === CODE_RETRY_LIMIT - 1 || !isUniqueViolation(error, 'code')) throw error;
    }
  }
  if (created === null) {
    throw new HttpError(500, 'CODE_EXHAUSTED', 'Could not allocate a BL draft number.');
  }

  // An air waybill has no containers to write: air has no load plan (§14).
  if (shipment.shipmentType === 'SEA') {
    await writeContainers(db, args.tenantId, created.id, advise.id, args.userId);
  }
  return created.id;
}

// ------------------------------------------------------------------- reading

blDraftRouter.get(
  '/bookings/:id/bl-draft',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const data = await withTenant(auth.tenantId, (db) => loadLiveBlDraft(db, shipmentId));
    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.json(payload);
  },
);

blDraftRouter.get(
  '/bookings/:id/bl-draft/prefill',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const data = await withTenant(auth.tenantId, (db) => blDraftPrefill(db, shipmentId));
    const payload: ApiSuccess<BlDraftPrefillDto> = { success: true, data };
    res.json(payload);
  },
);

// ------------------------------------------------------------------- writing

/** POST /bookings/:id/bl-draft — the client's `Make BL draft`. */
blDraftRouter.post(
  '/bookings/:id/bl-draft',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = blDraftInputSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      await createBlDraft(db, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        shipmentId,
        origin: 'STAFF',
        input,
        // G34, and H37's "There will be an option to select the agent" — a
        // staff-only field: the customer's sheet does not have it (§2.4).
        deliveryAgentId: input.deliveryAgentId == null ? null : BigInt(input.deliveryAgentId),
        deliveryAgentText: input.deliveryAgentText ?? null,
      });
      return loadLiveBlDraft(db, shipmentId);
    });

    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.status(201).json(payload);
  },
);

blDraftRouter.patch('/bl-drafts/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'BL draft');
  const input = blDraftInputSchema.parse(req.body);

  const data = await withTenant(auth.tenantId, async (db) => {
    const row = await loadBlDraftById(db, id);
    assertBlEditable(row);
    assertBillComplete(input, row.shipment.shipmentType);

    await db.blDraft.update({
      where: { id },
      data: {
        ...blDraftWriteData(input, row.shipment.shipmentType),
        deliveryAgentId: input.deliveryAgentId == null ? null : BigInt(input.deliveryAgentId),
        deliveryAgentText: input.deliveryAgentText ?? null,
        updatedBy: auth.userId,
      },
    });
    return loadLiveBlDraft(db, row.shipmentId);
  });

  const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
  res.json(payload);
});

/** POST /bl-drafts/:id/rebuild-containers — re-pull B40 from the load plans. */
blDraftRouter.post(
  '/bl-drafts/:id/rebuild-containers',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'BL draft');

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadBlDraftById(db, id);
      assertBlEditable(row);
      await writeContainers(db, auth.tenantId, id, row.adviseId, auth.userId);
      return loadLiveBlDraft(db, row.shipmentId);
    });

    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /bl-drafts/:id/approve — the forwarder accepting the draft.
 *
 * What moves the booking to BL_DRAFTED (§3.8), and the point after which the
 * document stops being a form.
 */
blDraftRouter.post(
  '/bl-drafts/:id/approve',
  requirePermission(`${FEATURE}.APPROVE`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'BL draft');

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadBlDraftById(db, id);
      assertBlApprovable(row);

      await db.blDraft.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedBy: auth.userId,
          updatedBy: auth.userId,
        },
      });
      // CR-005 §3: every booking the bill covers moves with it.
      for (const m of await adviseMembers(db, row.adviseId)) {
        await transitionShipment(db, { shipmentId: m.id, to: 'BL_DRAFTED', userId: auth.userId });
      }
      return loadLiveBlDraft(db, row.shipmentId);
    });

    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.json(payload);
  },
);

/** POST /bl-drafts/:id/send — the sheet's `Save & Send`. */
blDraftRouter.post('/bl-drafts/:id/send', requirePermission(`${FEATURE}.SEND`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'BL draft');
  const input = blDraftSendSchema.parse(req.body);

  const sent = await withTenant(auth.tenantId, async (db) => {
    const row = await loadBlDraftById(db, id);
    if (row.status === 'CANCELLED') {
      throw new HttpError(409, 'BL_DRAFT_CANCELLED', `${row.code} was cancelled.`);
    }
    await db.blDraft.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date(), sentBy: auth.userId, updatedBy: auth.userId },
    });
    return loadBlDraftById(db, id);
  });

  // The draft itself travels with the letter — a BL sent for confirmation with
  // nothing to confirm is the case §9 calls half a letter.
  const attachments = await withTenant(auth.tenantId, async (db) => {
    try {
      const doc = await blDraftDocument(db, auth.tenantId, sent);
      const stored = await putFile(auth.tenantId, 'bl-draft', {
        buffer: doc.pdf,
        originalname: doc.filename,
        mimetype: 'application/pdf',
        size: doc.pdf.length,
      });
      await db.blDraft.update({
        where: { id },
        data: { pdfFile: stored.key, updatedBy: auth.userId },
      });
      return [{ filename: doc.filename, contentType: 'application/pdf', storageKey: stored.key }];
    } catch (error) {
      logger.error({ err: error, blDraftId: id.toString() }, 'BL draft PDF not attached');
      return [];
    }
  });

  const bookingNos = billBookings(sent).map((b) => b.code).join(', ');
  const terms = billTerms(sent.shipment.shipmentType);
  await queueMail({
    attachments,
    tenantId: auth.tenantId,
    templateKey: 'BL_DRAFT_SENT',
    to: input.to.map((r) => r.email),
    cc: (input.cc ?? []).map((r) => r.email),
    variables: {
      bookingNo: bookingNos,
      blNo: sent.blNo,
      customerName: sent.shipment.customer.name,
      polName: sent.pol.name,
      podName: sent.pod.name,
      note: input.note ?? '',
    },
    relatedType: 'bl_draft',
    relatedId: id,
    actorId: auth.userId,
    fallback: {
      subject: `${terms.draft} ${sent.blNo} — booking ${bookingNos}`,
      bodyText:
        `The ${terms.draft} for booking ${bookingNos} (${sent.pol.name} to ${sent.pod.name}) ` +
        `is attached to your file under ${terms.short} number ${sent.blNo}. Please check it and confirm.`,
    },
  });

  const data = await withTenant(auth.tenantId, (db) => loadLiveBlDraft(db, sent.shipmentId));
  const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
  res.json(payload);
});

blDraftRouter.post(
  '/bl-drafts/:id/cancel',
  requirePermission(`${FEATURE}.CANCEL`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'BL draft');
    const input = blDraftCancelSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await loadBlDraftById(db, id);
      if (row.status === 'CANCELLED') {
        throw new HttpError(409, 'BL_DRAFT_CANCELLED', `${row.code} was already cancelled.`);
      }

      await db.blDraft.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy: auth.userId,
          cancelReason: input.reason,
          updatedBy: auth.userId,
        },
      });

      /*
       * Back to the advise it still has — a booking with no live draft is one
       * waiting for one.
       *
       * Only an approved draft ever moved the booking on: to BL_DRAFTED, and to
       * BL_ISSUED once BL Print issued it (§13), so cancelling an issued bill
       * lands here too and voids the issue. A draft that was only sent to the
       * customer to check never moved it, and the booking is still ADVISED —
       * keying this on SENT asked for ADVISED -> ADVISED and refused the cancel.
       */
      if (row.approvedAt !== null) {
        for (const m of await adviseMembers(db, row.adviseId)) {
          await transitionShipment(db, { shipmentId: m.id, to: 'ADVISED', userId: auth.userId });
        }
      }
      return loadLiveBlDraft(db, row.shipmentId);
    });

    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.json(payload);
  },
);

// ----------------------------------------------------------------- templates

function templateDto(
  row: Prisma.BlTemplateGetPayload<{
    include: { customer: { select: { name: true } }; deliveryAgent: { select: { name: true } } };
  }>,
): BlTemplateDto {
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    customerId: row.customerId?.toString() ?? null,
    customerName: row.customer?.name ?? null,
    shipperText: row.shipperText,
    consigneeText: row.consigneeText,
    notifyText: row.notifyText,
    alsoNotifyText: row.alsoNotifyText,
    freightPayableAt: row.freightPayableAt,
    originalBlCount: row.originalBlCount,
    deliveryAgentId: row.deliveryAgentId?.toString() ?? null,
    deliveryAgentName: row.deliveryAgent?.name ?? null,
    isActive: row.isActive,
  };
}

const templateArgs = {
  include: {
    customer: { select: { name: true } },
    deliveryAgent: { select: { name: true } },
  },
} satisfies { include: Prisma.BlTemplateInclude };

/**
 * GET /bl-templates — `Use Templet` (N13).
 *
 * Narrowed by customer when one is given: a template saved for ABC Ltd is
 * noise on every other customer's draft, and the workspace-wide ones (null
 * customer) always come back.
 */
blDraftRouter.get(
  '/bl-templates',
  requirePermission(`${TEMPLATE_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = typeof req.query['customerId'] === 'string' ? req.query['customerId'] : null;

    const data = await withTenant(auth.tenantId, async (db) => {
      // The picker wants live templates; the management screen asks for all of
      // them with ?includeInactive=1, so a retired one can be seen to be retired.
      const includeInactive = req.query['includeInactive'] === '1';
      const rows = await db.blTemplate.findMany({
        where: {
          deletedAt: null,
          ...(includeInactive ? {} : { isActive: true }),
          ...(customerId === null || !/^\d+$/.test(customerId)
            ? {}
            : { OR: [{ customerId: null }, { customerId: BigInt(customerId) }] }),
        },
        orderBy: [{ name: 'asc' }],
        ...templateArgs,
      });
      return rows.map(templateDto);
    });

    const payload: ApiSuccess<BlTemplateDto[]> = { success: true, data };
    res.json(payload);
  },
);

/** POST /bl-templates — `Make Templet` (B61). */
blDraftRouter.post(
  '/bl-templates',
  requirePermission(`${TEMPLATE_FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const input = blTemplateInputSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      let created: { id: bigint } | null = null;
      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
        const code = await nextCode(db, 'blTemplate', CODE_PREFIX.blTemplate, auth.tenantId);
        try {
          created = await db.blTemplate.create({
            data: {
              tenantId: auth.tenantId,
              code,
              name: input.name,
              customerId: input.customerId == null ? null : BigInt(input.customerId),
              shipperText: input.shipperText ?? null,
              consigneeText: input.consigneeText ?? null,
              notifyText: input.notifyText ?? null,
              alsoNotifyText: input.alsoNotifyText ?? null,
              freightPayableAt: input.freightPayableAt ?? null,
              originalBlCount: input.originalBlCount ?? null,
              deliveryAgentId:
                input.deliveryAgentId == null ? null : BigInt(input.deliveryAgentId),
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
      if (created === null) {
        throw new HttpError(500, 'CODE_EXHAUSTED', 'Could not allocate a template code.');
      }
      const row = await db.blTemplate.findFirstOrThrow({
        where: { id: created.id },
        ...templateArgs,
      });
      return templateDto(row);
    });

    const payload: ApiSuccess<BlTemplateDto> = { success: true, data };
    res.status(201).json(payload);
  },
);

/** PATCH /bl-templates/:id — rename one, or correct the block it holds. */
blDraftRouter.patch(
  '/bl-templates/:id',
  requirePermission(`${TEMPLATE_FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'template');
    const input = blTemplateInputSchema.parse(req.body);

    const data = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.blTemplate.findFirst({ where: { id, deletedAt: null } });
      if (existing === null) throw HttpError.notFound('Template not found.');

      await db.blTemplate.update({
        where: { id },
        data: {
          name: input.name,
          customerId: input.customerId == null ? null : BigInt(input.customerId),
          shipperText: input.shipperText ?? null,
          consigneeText: input.consigneeText ?? null,
          notifyText: input.notifyText ?? null,
          alsoNotifyText: input.alsoNotifyText ?? null,
          freightPayableAt: input.freightPayableAt ?? null,
          originalBlCount: input.originalBlCount ?? null,
          deliveryAgentId: input.deliveryAgentId == null ? null : BigInt(input.deliveryAgentId),
          updatedBy: auth.userId,
        },
      });
      const row = await db.blTemplate.findFirstOrThrow({ where: { id }, ...templateArgs });
      return templateDto(row);
    });

    const payload: ApiSuccess<BlTemplateDto> = { success: true, data };
    res.json(payload);
  },
);

/**
 * §4 rule 3 and §8's Action column: retired, never removed.
 *
 * A template that was typed twice goes inactive and stops appearing in the
 * picker. It is not deleted, because a BL drafted from it copied its text and
 * the trail should still say where that text came from.
 */
blDraftRouter.post(
  '/bl-templates/:id/deactivate',
  requirePermission(`${TEMPLATE_FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'template');

    await withTenant(auth.tenantId, async (db) => {
      const row = await db.blTemplate.findFirst({ where: { id, deletedAt: null } });
      if (row === null) throw HttpError.notFound('Template not found.');
      await db.blTemplate.update({
        where: { id },
        data: { isActive: false, updatedBy: auth.userId },
      });
    });

    const payload: ApiSuccess<null> = { success: true, data: null };
    res.json(payload);
  },
);

/**
 * "For Delivery of Goods Please Apply to:" for the chosen agent — the agent's
 * own Delivery agent details from CRM, as written (client, 2026-10-06), with
 * the name above them when they do not already open with it. An agent with no
 * details prints the name alone. Text typed on the draft prints instead.
 */
export function deliveryAgentBlock(
  agent: { name: string; deliveryAgentDetails: string | null } | null,
): string | null {
  if (agent === null) return null;
  const name = agent.name.trim();
  const details = (agent.deliveryAgentDetails ?? '').trim();
  if (details === '') return name;
  return details.toLowerCase().startsWith(name.toLowerCase()) ? details : `${name}\n${details}`;
}

/**
 * What the bill says, read from the saved row.
 *
 * One reading for the draft and for BL Print's originals (§13), so an issued
 * bill prints exactly the page that was approved — only the marking differs.
 */
export async function blDocumentInput(
  db: TenantDb,
  tenantId: bigint,
  row: BlDraftRow,
): Promise<Omit<BlDraftPdfInput, 'isDraft'>> {
  const [head, logo] = await Promise.all([letterheadOf(db, tenantId), logoOf(db, tenantId)]);
  const dayOf = (d: Date | null): string | null =>
    d === null ? null : d.toISOString().slice(0, 10);

  /*
   * The client's rules for the printed bill (§13.4, 2026-10-05). Pre-carriage
   * is the first leg's vessel and voyage, as the advise recorded them, on a
   * route that transships — a direct sailing leaves it empty (2026-10-06); the
   * place of receipt is the port of loading; and who pays the freight follows
   * the booking's Incoterms — payable at destination when collect, at the port
   * of loading when prepaid. A booking with no TOS keeps what the draft typed.
   */
  const preCarriage =
    row.advise.transitType === 'DIRECT'
      ? ''
      : [row.advise.firstVessel?.name, row.advise.voyageNo]
          .filter((v) => (v ?? '').trim() !== '')
          .join(' / ');
  const freightTerms = freightTermsOf(row.shipment.tos?.code ?? null);
  const freightPayableAt =
    freightTerms === null
      ? row.freightPayableAt
      : freightTerms === 'COLLECT'
        ? 'DESTINATION'
        : row.pol.name.toUpperCase();

  return {
    // The name only: the letterhead's second line is the email signature block,
    // which the client does not want on the bill.
    companyName: head.companyName,
    logo,
    serialNo: row.code,
    blNo: row.blNo,
    manifestNo: row.manifestNo,
    bookingNo: billBookings(row).map((b) => b.code).join(', '),
    shipperText: row.shipperText,
    consigneeText: row.consigneeText,
    notifyText: row.notifyText,
    alsoNotifyText: row.alsoNotifyText,
    exportReferences: row.exportReferences,
    forwardingAgentReferences: row.forwardingAgentReferences,
    pointCountryOfOrigin: row.pointCountryOfOrigin,
    preCarriageVesselVoyage: preCarriage === '' ? null : preCarriage,
    placeOfReceipt: row.pol.name,
    deliveryAgentText: row.deliveryAgentText ?? deliveryAgentBlock(row.deliveryAgent),
    oceanVesselVoyage: row.oceanVesselVoyage,
    polName: row.pol.name,
    podName: row.pod.name,
    placeOfDelivery: row.placeOfDelivery,
    packagesDescription: row.packagesDescription,
    marksAndNumbers: row.marksAndNumbers,
    grossWeightKg: row.grossWeightKg?.toString() ?? null,
    measurementCbm: row.measurementCbm?.toString() ?? null,
    containers: row.containers.map((c) => ({
      containerNo: c.containerNo,
      containerSize: c.containerSize,
      sealNo: c.sealNo,
      ctnQty: c.ctnQty,
      grossWeightKg: c.grossWeightKg?.toString() ?? null,
      measurementCbm: c.measurementCbm?.toString() ?? null,
    })),
    freightPayableAt,
    freightTerms,
    originalBlCount: row.originalBlCount,
    ladenOnBoardDate: dayOf(row.ladenOnBoardDate),
  };
}

/**
 * The currency an air waybill's charges are stated in (§14): the one the
 * booking's quotation lines are priced in — the first line's, when they mix.
 */
async function chargesCurrencyOf(db: TenantDb, shipmentId: bigint): Promise<string | null> {
  const line = await db.quotationLine.findFirst({
    where: {
      deletedAt: null,
      isActive: true,
      quotation: { shipments: { some: { id: shipmentId } } },
    },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { currencyCode: true },
  });
  return line?.currencyCode ?? null;
}

/**
 * What the House Air Waybill says, read from the saved row (§14).
 *
 * The air counterpart of blDocumentInput: the same parties, figures and
 * Incoterms rule, plus what only a waybill prints — the routing and flights
 * from the advise, the MAWB, the pieces and chargeable weight, and the
 * issuer's address and licence lines.
 */
export async function awbDocumentInput(
  db: TenantDb,
  tenantId: bigint,
  row: BlDraftRow,
): Promise<Omit<AwbPdfInput, 'isDraft'>> {
  /*
   * Each read degrades to nothing rather than failing: a customer printing
   * their draft cannot see the settings, the tenant row, the airline or the
   * quotation (CR-004), and gets the waybill without those boxes filled.
   */
  const [head, logo, settings, tenant, airline, currency, dayOf] = await Promise.all([
    letterheadOf(db, tenantId),
    logoOf(db, tenantId),
    db.notificationSetting.findFirst({ select: { awbIssuerDetails: true } }),
    db.tenant.findFirst({ where: { id: tenantId }, select: { slug: true } }),
    db.carrier.findFirst({ where: { id: row.advise.carrierId }, select: { name: true } }),
    chargesCurrencyOf(db, row.shipmentId),
    tenantDayOf(db, tenantId),
  ]);

  const route = airRouteOf(row.advise, airline?.name ?? null);
  const freightTerms = freightTermsOf(row.shipment.tos?.code ?? null);
  // The sample's At (Place) is where the freight is payable — the bill of
  // lading's rule, by the booking's Incoterms.
  const executedAt =
    freightTerms === null
      ? row.freightPayableAt
      : freightTerms === 'COLLECT'
        ? 'DESTINATION'
        : row.pol.name.toUpperCase();
  const airport = (port: { name: string; country: string }): string =>
    [port.name, port.country].filter((v) => v.trim() !== '').join(', ');

  return {
    companyName: head.companyName,
    issuerDetails: settings?.awbIssuerDetails ?? null,
    logo,
    hawbNo: row.blNo,
    mawbNo: row.advise.mblNo,
    bookingNo: billBookings(row).map((b) => b.code).join(', '),
    shipperText: row.shipperText,
    consigneeText: row.consigneeText,
    notifyText: row.notifyText,
    departureAirport: airport(row.pol),
    destinationAirport: row.pod.name,
    routing: [route[0]?.fromCode ?? row.pol.portCode, ...route.map((leg) => leg.toCode)].join('-'),
    legs: route.map((leg) => ({
      toCode: leg.toCode,
      toName: leg.toName,
      carrier: leg.carrier,
      flightNo: leg.flightNo,
      departure: leg.departure === null ? null : dayOf(new Date(leg.departure)),
    })),
    currency,
    freightTerms,
    packageCount: row.packageCount,
    grossWeightKg: row.grossWeightKg?.toString() ?? null,
    chargeableWeightKg: row.chargeableWeightKg?.toString() ?? null,
    measurementCbm: row.measurementCbm?.toString() ?? null,
    goodsDescription: row.packagesDescription,
    deliveryAgentText: row.deliveryAgentText ?? deliveryAgentBlock(row.deliveryAgent),
    executedOn: row.ladenOnBoardDate?.toISOString().slice(0, 10) ?? null,
    executedAt,
    // "TSL/DAC": the prefix the house numbers carry, at the airport of departure.
    // A customer cannot read the tenant row; the number itself starts with it.
    issuingOffice: `${
      tenant === null
        ? row.blNo.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
        : houseBlPrefixFor(tenant.slug)
    }/${row.pol.portCode}`,
  };
}

/**
 * The printed bill for any row: a bill of lading on sea, a House Air Waybill
 * on air (§14). The one place that chooses, so the draft's Print, Save & Send
 * and BL Print can never draw a sea booking's bill on the air form.
 */
export async function renderBill(
  db: TenantDb,
  tenantId: bigint,
  row: BlDraftRow,
  marks: { isDraft: boolean; copies?: BlPrintMark[]; issuedOn?: string | null },
): Promise<Buffer> {
  if (row.shipment.shipmentType === 'AIR') {
    return renderAwbPdf({ ...(await awbDocumentInput(db, tenantId, row)), ...marks });
  }
  return renderBlDraftPdf({ ...(await blDocumentInput(db, tenantId, row)), ...marks });
}

/**
 * The bytes of the BL draft, built from the saved row.
 *
 * Shared by the print endpoint and by `Save & Send`, so what the customer
 * receives is the page the operator printed. The watermark follows the status:
 * anything not yet approved prints as a draft.
 */
export async function blDraftDocument(
  db: TenantDb,
  tenantId: bigint,
  row: BlDraftRow,
): Promise<{ filename: string; pdf: Buffer }> {
  const pdf = await renderBill(db, tenantId, row, {
    isDraft: row.status === 'DRAFT' || row.status === 'SUBMITTED',
  });

  return { filename: `${row.code}.pdf`, pdf };
}

/** GET /bl-drafts/:id/pdf — the sheet's `Print`. */
blDraftRouter.get(
  '/bl-drafts/:id/pdf',
  requirePermission(`${FEATURE}.EXPORT_PDF`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'BL draft');

    const doc = await withTenant(auth.tenantId, async (db) => {
      const row = await loadBlDraftById(db, id);
      return blDraftDocument(db, auth.tenantId, row);
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.send(doc.pdf);
  },
);
