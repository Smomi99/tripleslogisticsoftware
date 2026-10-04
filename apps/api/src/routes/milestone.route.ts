import { Router } from 'express';

import {
  type ApiSuccess,
  buildMeta,
  MILESTONE_SCREENS,
  type MilestoneConfirmResultDto,
  type MilestoneKind,
  milestoneConfirmSchema,
  milestoneListQuerySchema,
  type MilestoneRow,
  type MilestoneSummaryDto,
} from '@ff/shared';

import { LIVE_MEMBERSHIP } from '../lib/advise-group';
import { queueMail } from '../lib/email-queue';
import { HttpError } from '../lib/http-error';
import { awaitingCount, day, milestonePicks, milestoneRows } from '../lib/milestone';
import { parseId } from '../lib/request';
import { tenantDayOf } from '../lib/tenant-day';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Customer Service → Depart-Arrive Confirmation
 * (docs/DESIGN-UPDATE-2026-10-04.md §2).
 *
 *   GET  /depart-arrive/summary        the landing page's six tile counts
 *   GET  /depart-arrive                one list: kind + mode + view
 *   POST /depart-arrive/:shipmentId    the sheets' Save — confirm, or correct
 *
 * Which bookings each list holds is lib/milestone.ts's to say; this file asks
 * it, and the confirm route asks the same question of one booking before it
 * writes anything.
 */

export const milestoneRouter: Router = Router();
milestoneRouter.use(authenticate);

const FEATURE = 'CUSTOMER_SERVICE.DEPART_ARRIVE';

milestoneRouter.get('/depart-arrive/summary', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const data = await withTenant(auth.tenantId, async (db) => {
    const counts: MilestoneSummaryDto = {};
    for (const screen of MILESTONE_SCREENS) {
      counts[screen.slug] = await awaitingCount(db, auth.tenantId, screen.kind, screen.shipmentType);
    }
    return counts;
  });
  const payload: ApiSuccess<MilestoneSummaryDto> = { success: true, data };
  res.json(payload);
});

milestoneRouter.get('/depart-arrive', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = milestoneListQuerySchema.parse(req.query);

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const found = await milestonePicks(
      db,
      auth.tenantId,
      { kind: query.kind, shipmentType: query.shipmentType, view: query.view, search: query.search },
      { by: query.sortBy ?? 'date', order: query.sortOrder },
      { page: query.page, limit: query.limit },
    );
    return { rows: await milestoneRows(db, query.kind, found.picks), total: found.total };
  });

  const payload: ApiSuccess<MilestoneRow[]> = {
    success: true,
    data: rows,
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});

/** "27 Sep 2026" — a customer reads this, not a database. */
function humanDay(iso: string | null): string {
  if (iso === null) return '';
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const NOUN: Record<MilestoneKind, string> = {
  DEPARTED: 'departure',
  TRANSSHIPPED: 'transshipment',
  ARRIVED: 'arrival',
};

/** The legs happen in this order, whichever one is being corrected. */
const SEQUENCE: Record<MilestoneKind, number> = { DEPARTED: 0, TRANSSHIPPED: 1, ARRIVED: 2 };

const DONE_WORDS: Record<MilestoneKind, string> = {
  DEPARTED: 'departed',
  TRANSSHIPPED: 'was transshipped',
  ARRIVED: 'arrived',
};

const TEMPLATE_KEY: Record<MilestoneKind, string> = {
  DEPARTED: 'SHIPMENT_DEPARTED',
  TRANSSHIPPED: 'SHIPMENT_TRANSSHIPPED',
  ARRIVED: 'SHIPMENT_ARRIVED',
};

/** Arrival-Sea N21: container number, seal and size travel in the letter. */
function containerLines(row: MilestoneRow): string {
  return row.containers
    .map((c) => {
      const detail = [c.size, c.sealNo === null ? null : `seal ${c.sealNo}`]
        .filter((v): v is string => v !== null && v !== '')
        .join(', ');
      return `${c.containerNo ?? 'Container number to follow'}${detail === '' ? '' : ` (${detail})`}`;
    })
    .join('\n');
}

/**
 * The sheets' `Save` with Departed or Arrived chosen.
 *
 * Saving again corrects the date: the row is updated, the date first pulled
 * stays as it was, and the customer is told again. Departed also becomes the
 * bill's laden-on-board date (On board-Sea M17) on every BL draft for the
 * booking that has not been issued — an issued original is never rewritten.
 */
milestoneRouter.post(
  '/depart-arrive/:shipmentId',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.shipmentId, 'booking');
    const input = milestoneConfirmSchema.parse(req.body);
    const { kind } = input;
    const date = new Date(`${input.date}T00:00:00.000Z`);

    const saved = await withTenant(auth.tenantId, async (db) => {
      const booking = await db.shipment.findFirst({
        where: { id: shipmentId, deletedAt: null },
        select: { id: true, code: true, status: true },
      });
      if (booking === null) throw HttpError.notFound('Booking not found.');
      if (booking.status === 'CANCELLED' || booking.status === 'REJECTED') {
        throw new HttpError(
          409,
          'BOOKING_CLOSED',
          `${booking.code} is ${booking.status.toLowerCase()}, so it does not sail.`,
        );
      }

      const others = await db.shipmentMilestone.findMany({
        where: { shipmentId, deletedAt: null, kind: { not: kind } },
        select: { kind: true, confirmedOn: true },
      });
      if (kind !== 'DEPARTED' && !others.some((m) => m.kind === 'DEPARTED')) {
        throw new HttpError(
          409,
          'DEPARTURE_FIRST',
          `Confirm ${booking.code}'s departure first — it cannot be transshipped or arrive before it has sailed.`,
        );
      }

      const { picks } = await milestonePicks(
        db,
        auth.tenantId,
        { kind, view: 'ALL', shipmentId },
        { by: 'date', order: 'asc' },
        { page: 1, limit: 1 },
      );
      const pick = picks[0];
      if (pick === undefined) {
        throw kind === 'TRANSSHIPPED'
          ? new HttpError(409, 'DIRECT_ROUTE', `${booking.code} sails direct, so it has no transshipment to confirm.`)
          : new HttpError(
              409,
              'NO_SCHEDULE',
              `${booking.code} has no approved schedule or advise yet, so there is no date to confirm against.`,
            );
      }

      const existing = await db.shipmentMilestone.findFirst({
        where: { shipmentId, kind, deletedAt: null },
        select: { id: true, pulledOn: true },
      });
      const pulledOn = existing === null ? pick.plannedOn : existing.pulledOn;
      const pulled = day(pulledOn);
      const moved = pulled !== null && pulled !== input.date;

      // Rule 5 is the departure sheets' ("A reason of delay / advance sail will
      // write to inform customer"). An arrival date firming up is the point of
      // the arrival screen, so it needs no excuse.
      if (moved && kind !== 'ARRIVED' && input.reason === undefined) {
        throw HttpError.badRequest(
          `The ${NOUN[kind]} was due on ${pulled}. Say why it moved — the customer is told.`,
        );
      }
      if (kind !== 'ARRIVED') {
        const today = (await tenantDayOf(db, auth.tenantId))(new Date());
        if (input.date > today) {
          throw HttpError.badRequest(
            `A ${NOUN[kind]} is confirmed once it has happened. ${input.date} is still to come.`,
          );
        }
      }
      for (const other of others) {
        const at = day(other.confirmedOn) ?? '';
        const earlier = SEQUENCE[other.kind] < SEQUENCE[kind];
        if ((earlier && input.date < at) || (!earlier && input.date > at)) {
          throw HttpError.badRequest(
            `${booking.code} ${DONE_WORDS[other.kind]} on ${at}, so its ${NOUN[kind]} cannot be ${earlier ? 'earlier' : 'later'}.`,
          );
        }
      }

      const fields = {
        confirmedOn: date,
        changeReason: input.reason ?? null,
        confirmedBy: auth.userId,
        confirmedAt: new Date(),
        updatedBy: auth.userId,
      };
      const milestone =
        existing === null
          ? await db.shipmentMilestone.create({
              data: { tenantId: auth.tenantId, shipmentId, kind, pulledOn, ...fields, createdBy: auth.userId },
              select: { id: true },
            })
          : await db.shipmentMilestone.update({ where: { id: existing.id }, data: fields, select: { id: true } });

      let blDraftsUpdated = 0;
      if (kind === 'DEPARTED') {
        const updated = await db.blDraft.updateMany({
          where: {
            deletedAt: null,
            status: { not: 'CANCELLED' },
            issuedAt: null,
            OR: [{ shipmentId }, { advise: { bookings: { some: { shipmentId, ...LIVE_MEMBERSHIP } } } }],
          },
          data: { ladenOnBoardDate: date, updatedBy: auth.userId },
        });
        blDraftsUpdated = updated.count;
      }

      return { milestoneId: milestone.id, pick, pulled, moved, blDraftsUpdated };
    });

    /*
     * Queued after the transaction commits, like every notification here: a
     * customer told about a sailing that rolled back would be reading about
     * nothing. A notice that cannot be queued does not undo the confirmation.
     */
    let emailLogId: bigint | null = null;
    if (input.notify) {
      const { row, houseBlNo } = await withTenant(auth.tenantId, async (db) => {
        const [built] = await milestoneRows(db, kind, [saved.pick]);
        const advise =
          saved.pick.adviseId === null
            ? null
            : await db.shipmentAdvise.findFirst({ where: { id: saved.pick.adviseId }, select: { houseBlNo: true } });
        return { row: built, houseBlNo: advise?.houseBlNo ?? '' };
      });
      if (row !== undefined) {
        const containers = containerLines(row);
        const reasonLine = saved.moved
          ? `It was due on ${humanDay(saved.pulled)}.${input.reason === undefined ? '' : ` ${input.reason}`}`
          : '';
        const queued = await queueMail({
          tenantId: auth.tenantId,
          templateKey: TEMPLATE_KEY[kind],
          to: row.recipients,
          variables: {
            customerName: row.customerName,
            bookingNo: row.bookingCode,
            modeWord: row.shipmentType === 'AIR' ? 'flight' : 'vessel',
            legLabel: row.legLabel ?? '',
            polName: row.polName,
            podName: row.podName,
            date: humanDay(input.date),
            reasonLine,
            containers,
            houseBlNo,
          },
          relatedType: 'shipment_milestone',
          relatedId: saved.milestoneId,
          actorId: auth.userId,
          fallback: {
            subject: `Booking ${row.bookingCode} — ${NOUN[kind]} ${humanDay(input.date)}`,
            bodyText:
              `Your shipment under booking ${row.bookingCode}, ${row.polName} to ${row.podName}: ` +
              `${NOUN[kind]} on ${humanDay(input.date)}${row.legLabel === null ? '' : `, ${row.legLabel}`}.` +
              (reasonLine === '' ? '' : `\n${reasonLine}`) +
              (containers === '' ? '' : `\n\n${containers}`),
          },
        });
        emailLogId = queued.id ?? null;
      }
    }

    const row = await withTenant(auth.tenantId, async (db) => {
      await db.shipmentMilestone.update({ where: { id: saved.milestoneId }, data: { emailLogId } });
      const [built] = await milestoneRows(db, kind, [{ ...saved.pick, confirmedOn: date }]);
      if (built === undefined) throw HttpError.notFound('Booking not found.');
      return built;
    });

    const payload: ApiSuccess<MilestoneConfirmResultDto> = {
      success: true,
      data: { row, blDraftsUpdated: saved.blDraftsUpdated, notified: emailLogId !== null },
    };
    res.json(payload);
  },
);
