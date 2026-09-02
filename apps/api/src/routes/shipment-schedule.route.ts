import { Router } from 'express';

import {
  type ApiSuccess,
  CODE_PREFIX,
  type ShipmentScheduleDto,
  shipmentScheduleInputSchema,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { queueMail } from '../lib/email-queue';
import { HttpError } from '../lib/http-error';
import { parseId, parseRefId } from '../lib/request';
import { transitionShipment } from '../lib/shipment-status';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Vessel / Flight Booking (docs/MODULE_BOOKING_CARGO.md §6.4) — phase E.
 *
 * One set of routes for both modes, like everything else in this module: sea
 * fills vessel and voyage on a leg, air fills flight number and time, and
 * nothing here branches on which.
 *
 * §4.2's rule shapes the whole file: "A rejected schedule is never edited in
 * place." Proposing again supersedes what was there and writes a new version,
 * so the customer can always see what they turned down and why. There is no
 * PATCH — an edit to a live proposal is a new proposal.
 */
export const shipmentScheduleRouter: Router = Router();

const FEATURE = 'CUSTOMER_SERVICE.SCHEDULE';
const BOOKING_FEATURE = 'CUSTOMER_SERVICE.CARGO_BOOKING';

shipmentScheduleRouter.use(authenticate);

const scheduleArgs = {
  include: {
    carrier: { select: { id: true, name: true } },
    legs: {
      where: { deletedAt: null },
      orderBy: { legNo: 'asc' },
      select: {
        id: true,
        legNo: true,
        vesselId: true,
        voyageNo: true,
        flightNo: true,
        flightTime: true,
        originPortId: true,
        destinationPortId: true,
        etd: true,
        eta: true,
        vessel: { select: { name: true } },
        originPort: { select: { name: true } },
        destinationPort: { select: { name: true } },
      },
    },
  },
} satisfies { include: Prisma.ShipmentScheduleInclude };

/** Exactly what the queries below return, so toDto needs no casts. */
type ScheduleRow = Prisma.ShipmentScheduleGetPayload<typeof scheduleArgs>;

function toDto(row: ScheduleRow): ShipmentScheduleDto {
  return {
    id: row.id.toString(),
    code: row.code,
    shipmentId: row.shipmentId.toString(),
    versionNo: row.versionNo,
    status: row.status,
    carrierId: row.carrierId.toString(),
    carrierName: row.carrier.name,
    cutOffDate: row.cutOffDate === null ? null : row.cutOffDate.toISOString(),
    vgmDate: row.vgmDate === null ? null : row.vgmDate.toISOString().slice(0, 10),
    siDate: row.siDate === null ? null : row.siDate.toISOString().slice(0, 10),
    transitType: row.transitType,
    proposedAt: row.proposedAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    rejectionComments: row.rejectionComments,
    legs: row.legs.map((leg) => ({
      id: leg.id.toString(),
      legNo: leg.legNo,
      vesselId: leg.vesselId === null ? null : leg.vesselId.toString(),
      vesselName: leg.vessel?.name ?? null,
      voyageNo: leg.voyageNo,
      flightNo: leg.flightNo,
      flightTime: leg.flightTime,
      originPortId: leg.originPortId.toString(),
      originPortName: leg.originPort.name,
      destinationPortId: leg.destinationPortId.toString(),
      destinationPortName: leg.destinationPort.name,
      etd: leg.etd === null ? null : leg.etd.toISOString(),
      eta: leg.eta === null ? null : leg.eta.toISOString(),
    })),
  };
}

const toStamp = (v: string | null | undefined): Date | null =>
  v == null || v === '' ? null : new Date(v);
const toDay = (v: string | null | undefined): Date | null =>
  v == null || v === '' ? null : new Date(`${v}T00:00:00.000Z`);

/**
 * GET /bookings/:id/schedules — every version, newest first.
 *
 * The history is the feature, not a debugging aid: §4.2 keeps a rejected
 * version so the customer can see what they turned down, and §6.4's screen
 * shows it above the form the replacement is typed into.
 */
shipmentScheduleRouter.get(
  '/bookings/:id/schedules',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');

    const data = await withTenant(auth.tenantId, async (db) => {
      const shipment = await db.shipment.findFirst({
        where: { id: shipmentId, deletedAt: null },
        select: { id: true },
      });
      if (shipment === null) throw HttpError.notFound('Booking not found.');

      const rows = await db.shipmentSchedule.findMany({
        where: { shipmentId, deletedAt: null },
        orderBy: { versionNo: 'desc' },
        ...scheduleArgs,
      });
      return rows.map((row) => toDto(row));
    });

    const payload: ApiSuccess<ShipmentScheduleDto[]> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /bookings/:id/schedules — propose a sailing (§6.4).
 *
 * Four things happen together, in one transaction, because a customer who was
 * told about a schedule that did not save would be reading a letter about
 * nothing:
 *
 *   1. any live proposal is superseded (§4.2 — never edited in place);
 *   2. the new version is written with its legs;
 *   3. the booking transitions to VESSEL_PROPOSED through §5.1's service;
 *   4. the customer is notified.
 *
 * The leg continuity §6.4 asks for is enforced by the shared schema, so the
 * client and the server refuse exactly the same schedules.
 */
shipmentScheduleRouter.post(
  '/bookings/:id/schedules',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');
    const input = shipmentScheduleInputSchema.parse(req.body);

    const { data, mail } = await withTenant(auth.tenantId, async (db) => {
      const shipment = await db.shipment.findFirst({
        where: { id: shipmentId, deletedAt: null },
        select: {
          id: true,
          code: true,
          shipmentType: true,
          customerId: true,
          customer: { select: { name: true } },
        },
      });
      if (shipment === null) throw HttpError.notFound('Booking not found.');

      // §4.2: supersede BEFORE inserting. The live index is partial and checked
      // per statement, so two live rows never exist even for an instant.
      await db.shipmentSchedule.updateMany({
        where: { shipmentId, deletedAt: null, status: { in: ['PROPOSED', 'APPROVED'] } },
        data: { status: 'SUPERSEDED', updatedBy: auth.userId },
      });

      const highest = await db.shipmentSchedule.aggregate({
        where: { shipmentId },
        _max: { versionNo: true },
      });
      const versionNo = (highest._max.versionNo ?? 0) + 1;

      let scheduleId: bigint | null = null;
      for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
        const code = await nextCode(db, 'shipmentSchedule', CODE_PREFIX.shipmentSchedule, auth.tenantId);
        try {
          const created = await db.shipmentSchedule.create({
            data: {
              tenantId: auth.tenantId,
              code,
              shipmentId,
              carrierId: parseRefId(input.carrierId, 'carrier'),
              cutOffDate: toStamp(input.cutOffDate),
              vgmDate: toDay(input.vgmDate),
              siDate: toDay(input.siDate),
              transitType: input.transitType,
              versionNo,
              status: 'PROPOSED',
              proposedBy: auth.userId,
              proposedAt: new Date(),
              createdBy: auth.userId,
              updatedBy: auth.userId,
              legs: {
                create: input.legs.map((leg) => ({
                  legNo: leg.legNo,
                  vesselId: leg.vesselId == null || leg.vesselId === '' ? null : parseRefId(leg.vesselId, 'vessel'),
                  voyageNo: leg.voyageNo || null,
                  flightNo: leg.flightNo || null,
                  flightTime: leg.flightTime || null,
                  originPortId: parseRefId(leg.originPortId, 'origin port'),
                  destinationPortId: parseRefId(leg.destinationPortId, 'destination port'),
                  etd: toStamp(leg.etd),
                  eta: toStamp(leg.eta),
                  createdBy: auth.userId,
                  updatedBy: auth.userId,
                })),
              },
            },
            select: { id: true },
          });
          scheduleId = created.id;
          break;
        } catch (error) {
          if (attempt === CODE_RETRY_LIMIT - 1 || !isUniqueViolation(error, 'code')) throw error;
        }
      }
      if (scheduleId === null) {
        throw new HttpError(500, 'CODE_EXHAUSTED', 'Could not allocate a schedule number.');
      }

      // §5.1's service, not a status write. BOOKING_RECEIVED and REJECTED both
      // lead here; anything else is refused with the reason.
      await transitionShipment(db, {
        shipmentId,
        to: 'VESSEL_PROPOSED',
        userId: auth.userId,
      });

      const row = await db.shipmentSchedule.findFirstOrThrow({
        where: { id: scheduleId },
        ...scheduleArgs,
      });
      const dto = toDto(row);

      // Addresses come from the customer's contact list, the way the quotation
      // does it — the booking has no recipient list of its own.
      const contacts = await db.customerPic.findMany({
        where: { customerId: shipment.customerId, deletedAt: null, isActive: true },
        select: { email: true },
      });
      const to = [...new Set(contacts.map((c) => c.email).filter((e): e is string => !!e))];

      const first = dto.legs[0];
      const last = dto.legs[dto.legs.length - 1];
      const routing = dto.legs
        .map((l) => `${l.originPortName} → ${l.destinationPortName}`)
        .join(', then ');

      return {
        data: dto,
        mail:
          to.length === 0
            ? null
            : {
                to,
                variables: {
                  customerName: shipment.customer.name,
                  bookingNo: shipment.code,
                  modeWord: shipment.shipmentType === 'AIR' ? 'flight' : 'vessel',
                  carrierName: dto.carrierName,
                  routing,
                  etd: first?.etd ?? '—',
                  eta: last?.eta ?? '—',
                  link: `/cs/shipment-booking/${shipmentId.toString()}`,
                },
              },
      };
    });

    // Queued after the transaction commits: a customer told about a schedule
    // that rolled back would be reading a letter about nothing.
    if (mail !== null) {
      await queueMail({
        tenantId: auth.tenantId,
        templateKey: 'SHIPMENT_SCHEDULE_PROPOSED',
        to: mail.to,
        variables: mail.variables,
        relatedType: 'shipment',
        relatedId: shipmentId,
        actorId: auth.userId,
        fallback: {
          subject: `Schedule proposed for booking ${String(mail.variables.bookingNo)}`,
          bodyText:
            `We have proposed a ${String(mail.variables.modeWord)} schedule for your booking ` +
            `${String(mail.variables.bookingNo)}. Please review and approve it.`,
        },
      });
    }

    const payload: ApiSuccess<ShipmentScheduleDto> = { success: true, data };
    res.status(201).json(payload);
  },
);

/** The booking header and cargo summary §6.4 draws read-only above the form. */
shipmentScheduleRouter.get(
  '/bookings/:id/schedule-context',
  requirePermission(`${BOOKING_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const shipmentId = parseId(req.params.id, 'booking');

    const data = await withTenant(auth.tenantId, async (db) => {
      const shipment = await db.shipment.findFirst({
        where: { id: shipmentId, deletedAt: null },
        select: {
          id: true,
          code: true,
          status: true,
          shipmentType: true,
          transitType: true,
          carrierId: true,
          polId: true,
          podId: true,
          customer: { select: { name: true } },
          carrier: { select: { name: true } },
          quotation: { select: { code: true } },
          pol: { select: { name: true, portCode: true } },
          pod: { select: { name: true, portCode: true } },
          cargoLines: {
            where: { deletedAt: null },
            select: { ctnQty: true, grossWeightKg: true, volumeCbm: true, chargeableWtKg: true },
          },
        },
      });
      if (shipment === null) throw HttpError.notFound('Booking not found.');

      const lines = shipment.cargoLines;
      const sum = (pick: (l: (typeof lines)[number]) => unknown): string => {
        let total = 0;
        for (const line of lines) total += Number(pick(line) ?? 0);
        return total.toString();
      };

      return {
        id: shipment.id.toString(),
        code: shipment.code,
        status: shipment.status,
        shipmentType: shipment.shipmentType,
        transitType: shipment.transitType,
        carrierId: shipment.carrierId.toString(),
        /*
         * Named, not just referenced. A workspace can switch a SHARED carrier
         * off (§7A rule 7), and the picker then would not contain the one this
         * booking already uses — so the select would fall back to whatever came
         * first and silently change the carrier on save. The screen puts this
         * name back into the list when it is missing.
         */
        carrierName: shipment.carrier.name,
        polId: shipment.polId.toString(),
        podId: shipment.podId.toString(),
        customerName: shipment.customer.name,
        quotationCode: shipment.quotation.code,
        polName: shipment.pol.name,
        podName: shipment.pod.name,
        cargo: {
          lines: shipment.cargoLines.length,
          ctnQty: sum((l) => l.ctnQty),
          grossWeightKg: sum((l) => l.grossWeightKg),
          volumeCbm: sum((l) => l.volumeCbm),
          chargeableWtKg: sum((l) => l.chargeableWtKg),
        },
      };
    });

    const payload: ApiSuccess<typeof data> = { success: true, data };
    res.json(payload);
  },
);
