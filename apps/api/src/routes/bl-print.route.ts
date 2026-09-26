import { Router } from 'express';

import {
  type ApiSuccess,
  type BlPrintDto,
  type BlPrintKind,
  blIssueSchema,
  blPrintQuerySchema,
} from '@ff/shared';

import { type BlDraftRow, blDraftArgs } from '../lib/bl-draft-view';
import { type BlPrintMark, renderBlDraftPdf } from '../lib/bl-draft-pdf';
import { HttpError } from '../lib/http-error';
import { parseId } from '../lib/request';
import { transitionShipment } from '../lib/shipment-status';
import { tenantDayOf } from '../lib/tenant-day';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { blDocumentInput } from './bl-draft.route';

/**
 * BL Print (Menu K7) — docs/MODULE_DOCUMENTATION.md §13.
 *
 * The chain on the Menu sheet (F22) runs "… SI Submission > BL Issue > Debit
 * Note", and this is the BL Issue. It works from the approved BL draft and adds
 * nothing to it: issuing records who issued the bill and when, and moves the
 * booking to BL_ISSUED; printing draws the approved bill once per original,
 * each stamped with its number, or once as a non-negotiable copy.
 *
 * Routes are keyed by booking, like the worklist rows that call them — the
 * booking has one live bill, and the operator is looking at the booking.
 */
export const blPrintRouter: Router = Router();

const FEATURE = 'DOCUMENTATION.BL_PRINT';

blPrintRouter.use(authenticate);

const stamp = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

/**
 * The booking's live bill, approved — or a refusal that says what is missing.
 *
 * Approval is the whole precondition (§13.3 rule 1): it is what froze the
 * draft, and what BL Print prints is that frozen page.
 */
async function approvedBill(db: TenantDb, shipmentId: bigint): Promise<BlDraftRow> {
  const shipment = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: { code: true },
  });
  if (shipment === null) throw HttpError.notFound('Booking not found.');

  const row = await db.blDraft.findFirst({
    where: { shipmentId, deletedAt: null, status: { not: 'CANCELLED' } },
    orderBy: { id: 'desc' },
    ...blDraftArgs,
  });
  if (row === null) {
    throw new HttpError(
      409,
      'NO_BL_DRAFT',
      `${shipment.code} has no BL draft. Draft it and approve it on the BL Draft screen first.`,
    );
  }
  if (row.approvedAt === null) {
    throw new HttpError(
      409,
      'BL_NOT_APPROVED',
      `${row.code} has not been approved. BL Print issues and prints an approved draft only.`,
    );
  }
  return row;
}

function printDto(row: BlDraftRow): BlPrintDto {
  return {
    shipmentId: row.shipmentId.toString(),
    bookingNo: row.shipment.code,
    customerName: row.shipment.customer.name,
    draftId: row.id.toString(),
    draftCode: row.code,
    draftStatus: row.status,
    blNo: row.blNo,
    mblNo: row.advise.mblNo,
    polName: row.pol.name,
    podName: row.pod.name,
    originalBlCount: row.originalBlCount,
    ladenOnBoardDate: day(row.ladenOnBoardDate),
    approvedAt: stamp(row.approvedAt),
    issuedAt: stamp(row.issuedAt),
    issuedByName: row.issuedByUser?.username ?? null,
  };
}

/** How many pages, and what each one says it is (§13.4). */
function marksFor(row: BlDraftRow, kind: BlPrintKind): BlPrintMark[] {
  if (kind === 'COPY') {
    return [{ mark: 'COPY', note: 'NON-NEGOTIABLE', watermark: 'COPY' }];
  }

  // §13.3 rule 4: an original exists once the bill is issued, and not before.
  if (row.issuedAt === null) {
    throw new HttpError(
      409,
      'BL_NOT_ISSUED',
      `${row.blNo} has not been issued. Issue it to print the originals; a non-negotiable copy prints now.`,
    );
  }
  const n = row.originalBlCount ?? 0;
  if (n === 0) {
    throw new HttpError(
      409,
      'NO_ORIGINALS',
      `${row.blNo} was issued with no originals. Print a copy instead.`,
    );
  }
  return Array.from({ length: n }, (_, i) => ({
    mark: 'ORIGINAL',
    note: `${i + 1} of ${n}`,
    watermark: null,
  }));
}

/** The printed bill: the approved page, once per mark. */
export async function blPrintDocument(
  db: TenantDb,
  tenantId: bigint,
  row: BlDraftRow,
  kind: BlPrintKind,
): Promise<{ filename: string; pdf: Buffer }> {
  const copies = marksFor(row, kind);
  const dayOf = await tenantDayOf(db, tenantId);
  const issuedOn = row.issuedAt === null ? null : dayOf(row.issuedAt);

  const pdf = await renderBlDraftPdf({
    ...(await blDocumentInput(db, tenantId, row)),
    status: issuedOn === null ? 'Approved, not issued' : `Issued ${issuedOn}`,
    isDraft: false,
    copies,
    issuedOn,
  });

  // A BL number is the carrier's or ours, and not always filename-safe.
  const safe = row.blNo.replace(/[^A-Za-z0-9._-]+/g, '-');
  return { filename: `${safe}-${kind === 'ORIGINAL' ? 'originals' : 'copy'}.pdf`, pdf };
}

// ------------------------------------------------------------------ reading

/** GET /bookings/:id/bl — what `Issue BL` confirms, and what the tab shows. */
blPrintRouter.get('/bookings/:id/bl', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const shipmentId = parseId(req.params.id, 'booking');
  const data = await withTenant(auth.tenantId, async (db) =>
    printDto(await approvedBill(db, shipmentId)),
  );
  const payload: ApiSuccess<BlPrintDto> = { success: true, data };
  res.json(payload);
});

// ------------------------------------------------------------------ issuing

/**
 * POST /bookings/:id/bl/issue — the chain's "BL Issue".
 *
 * One-way, like issuing a shipping order: the bill is out, and a correction is
 * cancel and redraft on the BL Draft screen (§5 rule 3), which voids the issue
 * and returns the booking to its advise.
 */
blPrintRouter.post(
  '/bookings/:id/bl/issue',
  requirePermission(`${FEATURE}.ISSUE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = blIssueSchema.parse(req.body ?? {});

    const data = await withTenant(auth.tenantId, async (db) => {
      const row = await approvedBill(db, shipmentId);

      if (row.issuedAt !== null) {
        const dayOf = await tenantDayOf(db, auth.tenantId);
        throw new HttpError(
          409,
          'BL_ALREADY_ISSUED',
          `${row.blNo} was issued on ${dayOf(row.issuedAt)}. Print its originals again from BL Print; ` +
            'to correct it, cancel the draft and draft it again.',
        );
      }

      /*
       * §13.3 rule 3. The number of originals is the approved draft's. Asked
       * for only when the draft left it empty — a bill has to say how many
       * originals exist, and the approved draft can no longer be edited to say
       * it. Never changed here: that would be editing the approved bill.
       */
      const asked = input.originalBlCount ?? null;
      let originals = row.originalBlCount;
      if (originals === null) {
        if (asked === null) {
          throw new HttpError(
            422,
            'ORIGINALS_REQUIRED',
            `${row.code} leaves No. of Original BL empty. Say how many originals are being issued.`,
            { originalBlCount: ['How many originals are being issued?'] },
          );
        }
        originals = asked;
      } else if (asked !== null && asked !== originals) {
        throw new HttpError(
          409,
          'ORIGINALS_FIXED',
          `${row.code} was approved with ${originals} original${originals === 1 ? '' : 's'}. ` +
            'Changing that changes the bill — cancel the draft and draft it again.',
        );
      }

      await db.blDraft.update({
        where: { id: row.id },
        data: {
          issuedAt: new Date(),
          issuedBy: auth.userId,
          originalBlCount: originals,
          updatedBy: auth.userId,
        },
      });
      await transitionShipment(db, { shipmentId, to: 'BL_ISSUED', userId: auth.userId });

      return printDto(await approvedBill(db, shipmentId));
    });

    const payload: ApiSuccess<BlPrintDto> = { success: true, data };
    res.json(payload);
  },
);

// ----------------------------------------------------------------- printing

/**
 * GET /bookings/:id/bl/pdf?kind=ORIGINAL|COPY — `Print`.
 *
 * Reprinting originals is allowed to the same permission (§13, open question
 * 3): the stationery jams, and the answer to that is not a support ticket.
 */
blPrintRouter.get(
  '/bookings/:id/bl/pdf',
  requirePermission(`${FEATURE}.EXPORT_PDF`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const { kind } = blPrintQuerySchema.parse(req.query);

    const doc = await withTenant(auth.tenantId, async (db) =>
      blPrintDocument(db, auth.tenantId, await approvedBill(db, shipmentId), kind),
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.send(doc.pdf);
  },
);
