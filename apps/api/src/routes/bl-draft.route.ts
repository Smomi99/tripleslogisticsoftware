import { Router } from 'express';

import {
  type ApiSuccess,
  type BlDraftDto,
  type BlDraftPrefillDto,
  type BlTemplateDto,
  blDraftCancelSchema,
  blDraftInputSchema,
  blDraftSendSchema,
  blTemplateInputSchema,
  CODE_PREFIX,
  freightTermsOf,
} from '@ff/shared';

import { adviseMembers, liveAdviseOf } from '../lib/advise-group';
import {
  type BlDraftRow,
  billBookings,
  blDraftPrefill,
  containersForShipments,
  loadBlDraftById,
  loadLiveBlDraft,
} from '../lib/bl-draft-view';
import { type BlDraftPdfInput, renderBlDraftPdf } from '../lib/bl-draft-pdf';
import { letterheadOf, logoOf } from '../lib/letterhead';
import { logger } from '../lib/logger';
import { putFile } from '../lib/storage';
import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { queueMail } from '../lib/email-queue';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { nextBlDraftNo, seriesYearOf } from '../lib/inquiry-no';
import { parseId } from '../lib/request';
import { transitionShipment } from '../lib/shipment-status';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * BL Draft — docs/MODULE_DOCUMENTATION.md §2.3, §5.
 *
 * Outbound sea only, as both client sheets say. One record for the staff copy
 * and the customer's (§3.6): what differs is `origin`, the status it moves
 * through, and which router may touch it.
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

/** The columns both the staff form and the customer form write. */
export function blDraftWriteData(input: ReturnType<typeof blDraftInputSchema.parse>) {
  return {
    manifestNo: input.manifestNo ?? null,
    shipperText: input.shipperText,
    consigneeText: input.consigneeText,
    notifyText: input.notifyText,
    alsoNotifyText: input.alsoNotifyText ?? null,
    exportReferences: input.exportReferences ?? null,
    forwardingAgentReferences: input.forwardingAgentReferences ?? null,
    pointCountryOfOrigin: input.pointCountryOfOrigin ?? null,
    preCarriageByModeId: BigInt(input.preCarriageByModeId),
    placeOfReceipt: input.placeOfReceipt,
    oceanVesselVoyage: input.oceanVesselVoyage ?? null,
    polId: BigInt(input.polId),
    podId: BigInt(input.podId),
    placeOfDelivery: input.placeOfDelivery ?? null,
    packagesDescription: input.packagesDescription ?? null,
    marksAndNumbers: input.marksAndNumbers ?? null,
    grossWeightKg: input.grossWeightKg == null ? null : new Prisma.Decimal(input.grossWeightKg),
    measurementCbm: input.measurementCbm == null ? null : new Prisma.Decimal(input.measurementCbm),
    freightPayableAt: input.freightPayableAt ?? null,
    originalBlCount: input.originalBlCount ?? null,
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

  if (shipment.shipmentType === 'AIR') {
    throw new HttpError(
      409,
      'SEA_ONLY',
      'Both BL Draft sheets say "Only for Outbound shipment-Sea". An air equivalent is open question 8.',
    );
  }

  // CR-005: the advise this booking is on, made from it or from another
  // booking of its EFR. The bill is that advise's, one for all its bookings.
  const advise = await liveAdviseOf(db, args.shipmentId, 'SENT');
  if (advise === null) {
    throw new HttpError(
      409,
      'NO_ADVISE',
      `${shipment.code} has no sent shipment advise. The BL number is allocated there.`,
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
          ...blDraftWriteData(args.input),
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

  await writeContainers(db, args.tenantId, created.id, advise.id, args.userId);
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

    await db.blDraft.update({
      where: { id },
      data: {
        ...blDraftWriteData(input),
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
      subject: `BL draft ${sent.blNo} — booking ${bookingNos}`,
      bodyText:
        `The BL draft for booking ${bookingNos} (${sent.pol.name} to ${sent.pod.name}) ` +
        `is attached to your file under BL number ${sent.blNo}. Please check it and confirm.`,
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
    deliveryAgentText: row.deliveryAgentText ?? row.deliveryAgent?.name ?? null,
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
  const pdf = await renderBlDraftPdf({
    ...(await blDocumentInput(db, tenantId, row)),
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
