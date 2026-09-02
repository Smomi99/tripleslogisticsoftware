import { Router } from 'express';

import {
  type ApiSuccess,
  CODE_PREFIX,
  type MailSignatureLogoDto,
  mailSignatureLogoSchema,
  type NotificationSettingDto,
  notificationSettingSchema,
  DEFAULT_QUOTATION_NOTES,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { parseId } from '../lib/request';
import { displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * Settings → Notifications.
 *
 * One row per workspace, so there is no list and no code: it is read, and it is
 * saved. Gated on the same permission as the rest of Settings' own
 * configuration rather than a new one — who receives a notification is an
 * administrative setting, not a screen of its own.
 */

export const notificationSettingRouter: Router = Router();
notificationSettingRouter.use(authenticate);

const FEATURE = 'SETTING.NOTIFICATION';

notificationSettingRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const row = await withTenant(auth.tenantId, (db) =>
    db.notificationSetting.findFirst({
      select: {
        priceTeamEmails: true,
        signatureBlock: true,
        bccAddresses: true,
        quotationNotes: true,
      },
    }),
  );

  const payload: ApiSuccess<NotificationSettingDto> = {
    success: true,
    data: {
      priceTeamEmails: row?.priceTeamEmails ?? '',
      signatureBlock: row?.signatureBlock ?? '',
      bccAddresses: row?.bccAddresses ?? '',
      // Null means the workspace has never touched them, so the screen is
      // offered the product's own wording to edit from (§6.6).
      quotationNotes: row?.quotationNotes ?? DEFAULT_QUOTATION_NOTES,
    },
  };
  res.json(payload);
});

notificationSettingRouter.put('/', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const input = notificationSettingSchema.parse(req.body);

  const saved = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.notificationSetting.findFirst({ select: { id: true } });
    if (existing === null) {
      return db.notificationSetting.create({
        data: {
          tenantId: auth.tenantId,
          priceTeamEmails: input.priceTeamEmails || null,
          signatureBlock: input.signatureBlock || null,
          bccAddresses: input.bccAddresses || null,
          // NOT `|| null`. Null means "never touched, offer the default";
          // empty means "we want none". Collapsing them would make the second
          // impossible to say, and the settings screen promises it.
          quotationNotes: input.quotationNotes,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: {
          priceTeamEmails: true,
          signatureBlock: true,
          bccAddresses: true,
          quotationNotes: true,
        },
      });
    }
    return db.notificationSetting.update({
      where: { id: existing.id },
      data: {
        priceTeamEmails: input.priceTeamEmails || null,
        signatureBlock: input.signatureBlock || null,
        bccAddresses: input.bccAddresses || null,
        // NOT `|| null`. Null means "never touched, offer the default"; empty
        // means "we want none", and the PDF then prints none.
        quotationNotes: input.quotationNotes,
        updatedBy: auth.userId,
      },
      select: {
        priceTeamEmails: true,
        signatureBlock: true,
        bccAddresses: true,
        quotationNotes: true,
      },
    });
  });

  const payload: ApiSuccess<NotificationSettingDto> = {
    success: true,
    data: {
      priceTeamEmails: saved.priceTeamEmails ?? '',
      signatureBlock: saved.signatureBlock ?? '',
      bccAddresses: saved.bccAddresses ?? '',
      quotationNotes: saved.quotationNotes ?? DEFAULT_QUOTATION_NOTES,
    },
  };
  res.json(payload);
});


// ===========================================================================
// Signature logos (§ docs/Email Templet.docx)
// ===========================================================================
//
// The client's sign-off ends with three marks: their own, and the BAFFA and DP
// Alliance memberships. Those two are credentials a carrier's pricing desk
// looks for before answering a stranger, so they are managed here beside the
// text they sit under rather than buried in a branding screen.

notificationSettingRouter.get('/logos', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const rows = await withTenant(auth.tenantId, (db) =>
    db.mailSignatureLogo.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        code: true,
        fileKey: true,
        altText: true,
        heightPx: true,
        isActive: true,
      },
    }),
  );

  const payload: ApiSuccess<MailSignatureLogoDto[]> = {
    success: true,
    data: rows.map((row) => ({
      id: row.id.toString(),
      code: row.code,
      fileName: displayNameFromKey(row.fileKey),
      altText: row.altText,
      heightPx: row.heightPx,
      isActive: row.isActive,
    })),
  };
  res.json(payload);
});

notificationSettingRouter.post(
  '/logos',
  requirePermission(`${FEATURE}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose an image to upload.');
    // PDFs and Word documents are allowed uploads elsewhere; a signature logo
    // is an image or it is nothing.
    if (!file.mimetype.startsWith('image/')) {
      throw HttpError.badRequest('A signature logo has to be a PNG or a JPG.');
    }

    const parsed = mailSignatureLogoSchema.parse({
      altText: req.body?.altText,
      heightPx: req.body?.heightPx,
    });

    const created = await withTenant(auth.tenantId, async (db) => {
      const stored = await putFile(auth.tenantId, 'mail-signature', file);
      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
        const code = await nextCode(db, 'mailSignatureLogo', CODE_PREFIX.mailSignatureLogo, auth.tenantId);
        try {
          const count = await db.mailSignatureLogo.count({ where: { deletedAt: null } });
          return await db.mailSignatureLogo.create({
            data: {
              tenantId: auth.tenantId,
              code,
              fileKey: stored.key,
              altText: parsed.altText,
              heightPx: parsed.heightPx,
              // New logos land at the end of the row, where a reader's eye
              // expects the most recent membership.
              sortOrder: count,
              createdBy: auth.userId,
              updatedBy: auth.userId,
            },
            select: { id: true, code: true, fileKey: true, altText: true, heightPx: true, isActive: true },
          });
        } catch (caught) {
          if (isUniqueViolation(caught) && attempt < CODE_RETRY_LIMIT - 1) continue;
          throw caught;
        }
      }
      throw HttpError.conflict('Could not allocate a code. Try again.');
    });

    const payload: ApiSuccess<MailSignatureLogoDto> = {
      success: true,
      data: {
        id: created.id.toString(),
        code: created.code,
        fileName: displayNameFromKey(created.fileKey),
        altText: created.altText,
        heightPx: created.heightPx,
        isActive: created.isActive,
      },
    };
    res.status(201).json(payload);
  },
);

/** The image itself, so the settings screen can show what will be sent. */
notificationSettingRouter.get(
  '/logos/:id/file',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'logo');
    const key = await withTenant(auth.tenantId, async (db) => {
      const row = await db.mailSignatureLogo.findFirst({
        where: { id, deletedAt: null },
        select: { fileKey: true },
      });
      if (row === null) throw HttpError.notFound('That logo no longer exists.');
      return row.fileKey;
    });

    const file = await openFile(auth.tenantId, key);
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('Cache-Control', 'private, max-age=60');
    file.stream.pipe(res);
  },
);

/** Soft delete, per §4 rule 3, and the object goes with it. */
notificationSettingRouter.delete(
  '/logos/:id',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'logo');

    const key = await withTenant(auth.tenantId, async (db) => {
      const row = await db.mailSignatureLogo.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, fileKey: true },
      });
      if (row === null) throw HttpError.notFound('That logo no longer exists.');
      await db.mailSignatureLogo.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
      });
      return row.fileKey;
    });

    // Removed after the row stopped pointing at it, so a failure here never
    // leaves a record referencing a file that has gone.
    await removeFile(auth.tenantId, key);

    const payload: ApiSuccess<{ id: string }> = { success: true, data: { id: id.toString() } };
    res.json(payload);
  },
);
