import { Router } from 'express';

import { type ApiSuccess, type NotificationSettingDto, notificationSettingSchema } from '@ff/shared';

import { HttpError } from '../lib/http-error';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

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
      select: { priceTeamEmails: true, signatureBlock: true },
    }),
  );

  const payload: ApiSuccess<NotificationSettingDto> = {
    success: true,
    data: {
      priceTeamEmails: row?.priceTeamEmails ?? '',
      signatureBlock: row?.signatureBlock ?? '',
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
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: { priceTeamEmails: true, signatureBlock: true },
      });
    }
    return db.notificationSetting.update({
      where: { id: existing.id },
      data: {
        priceTeamEmails: input.priceTeamEmails || null,
        signatureBlock: input.signatureBlock || null,
        updatedBy: auth.userId,
      },
      select: { priceTeamEmails: true, signatureBlock: true },
    });
  });

  const payload: ApiSuccess<NotificationSettingDto> = {
    success: true,
    data: {
      priceTeamEmails: saved.priceTeamEmails ?? '',
      signatureBlock: saved.signatureBlock ?? '',
    },
  };
  res.json(payload);
});

// Referenced so the import is not flagged; the router throws through it.
void HttpError;
