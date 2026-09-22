import { Router } from 'express';

import {
  type ApiSuccess,
  type BlDraftDto,
  type BlDraftPrefillDto,
  blDraftInputSchema,
} from '@ff/shared';

import { blDraftPrefill, loadBlDraftById, loadLiveBlDraft } from '../lib/bl-draft-view';
import {
  assertBlEditable,
  blDraftDocument,
  blDraftWriteData,
  createBlDraft,
} from './bl-draft.route';
import { HttpError } from '../lib/http-error';
import { parseId } from '../lib/request';
import { withCustomer } from '../lib/tenant-client';
import { authenticateCustomer } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * The customer portal — docs/MODULE_DOCUMENTATION.md §2.4, §7.
 *
 * A separate router under `authenticateCustomer` and `withCustomer`, never a
 * staff route that branches on who is calling. Three layers hold it shut and
 * they move together:
 *
 *   1. the session kind, checked before any handler runs (authenticateAs);
 *   2. the CUSTOMER permission module, which no staff role should ever hold;
 *   3. RLS, where `withCustomer` declares the session and the `customer_read`
 *      and `customer_rw` policies decide what it can see.
 *
 * Layer 3 is not a net here, it is the primary row-scope control: the Prisma
 * tenant extension knows about tenants and nothing else, so it would happily
 * return every customer's bookings if a `where` were forgotten.
 */
export const customerPortalRouter: Router = Router();

customerPortalRouter.use(authenticateCustomer);

const FEATURE = 'CUSTOMER.BL_DRAFT';
const SHIPMENT_FEATURE = 'CUSTOMER.SHIPMENT';

/** One row of the customer's own shipment list. */
interface PortalShipmentRow {
  id: string;
  code: string;
  shipmentType: string;
  status: string;
  exporterName: string | null;
  importerName: string | null;
  polName: string;
  podName: string;
  etd: string | null;
  eta: string | null;
  blDraftStatus: string | null;
}

/**
 * GET /portal/shipments — the Menu sheet's Customer column, first entry built.
 *
 * Reads `customer_shipment_v`, not `shipment`: the table carries the salesman,
 * the quotation and the forwarder's own notes on the same row, and RLS is
 * row-level. The view is where the column boundary lives.
 */
customerPortalRouter.get(
  '/shipments',
  requirePermission(`${SHIPMENT_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = auth.customerId;
    if (customerId === null) throw HttpError.forbidden('This area is for customer accounts.');

    const data = await withCustomer(auth.tenantId, customerId, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          shipment_type: string;
          status: string;
          exporter_name: string | null;
          importer_name: string | null;
          pol_name: string;
          pod_name: string;
          etd: Date | null;
          eta: Date | null;
          bl_draft_status: string | null;
        }[]
      >`
        SELECT v.id, v.code, v.shipment_type::text AS shipment_type, v.status::text AS status,
               v.exporter_name, v.importer_name,
               pol.name AS pol_name, pod.name AS pod_name,
               v.etd, v.eta,
               (SELECT d.status::text
                  FROM bl_draft d
                 WHERE d.shipment_id = v.id
                   AND d.deleted_at IS NULL
                   AND d.status <> 'CANCELLED'
                 ORDER BY d.id DESC
                 LIMIT 1) AS bl_draft_status
          FROM customer_shipment_v v
          JOIN port pol ON pol.id = v.pol_id
          JOIN port pod ON pod.id = v.pod_id
         ORDER BY v.id DESC
         LIMIT 200
      `;

      return rows.map(
        (row): PortalShipmentRow => ({
          id: row.id.toString(),
          code: row.code,
          shipmentType: row.shipment_type,
          status: row.status,
          exporterName: row.exporter_name,
          importerName: row.importer_name,
          polName: row.pol_name,
          podName: row.pod_name,
          etd: row.etd === null ? null : row.etd.toISOString(),
          eta: row.eta === null ? null : row.eta.toISOString(),
          blDraftStatus: row.bl_draft_status,
        }),
      );
    });

    const payload: ApiSuccess<PortalShipmentRow[]> = { success: true, data };
    res.json(payload);
  },
);

/**
 * GET /portal/lookups — the pickers the BL form cannot draw without.
 *
 * Just the modes, for B34's Pre-Carriage By, which the client's sheet stars as
 * required. `customer_read` on `mode` exists for this and nothing else; the
 * ports come back on the prefill already named, so there is no picker to fill.
 *
 * Found by opening the screen: without this the select rendered empty and a
 * required field could not be answered, which no API test would have noticed.
 */
customerPortalRouter.get(
  '/lookups',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = auth.customerId!;

    const data = await withCustomer(auth.tenantId, customerId, async (db) => {
      const modes = await db.mode.findMany({
        where: { deletedAt: null, isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      return { modes: modes.map((m) => ({ id: m.id.toString(), name: m.name })) };
    });

    const payload: ApiSuccess<{ modes: { id: string; name: string }[] }> = {
      success: true,
      data,
    };
    res.json(payload);
  },
);

/** GET /portal/shipments/:id/bl-draft — their draft on one of their bookings. */
customerPortalRouter.get(
  '/shipments/:id/bl-draft',
  requirePermission(`${FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = auth.customerId!;
    const shipmentId = parseId(req.params.id, 'shipment');

    const data = await withCustomer(auth.tenantId, customerId, (db) =>
      loadLiveBlDraft(db, shipmentId),
    );
    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * GET /portal/shipments/:id/bl-draft/prefill — §2.4's `Pull`.
 *
 * The container block comes back empty for a customer: `clp` is not open to
 * them, deliberately, because a consolidated box carries other companies'
 * cargo. The forwarder fills that block in on their side.
 */
customerPortalRouter.get(
  '/shipments/:id/bl-draft/prefill',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = auth.customerId!;
    const shipmentId = parseId(req.params.id, 'shipment');

    const data = await withCustomer(auth.tenantId, customerId, (db) =>
      blDraftPrefill(db, shipmentId),
    );
    const payload: ApiSuccess<BlDraftPrefillDto> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /portal/shipments/:id/bl-draft — the customer starts the draft.
 *
 * `deliveryAgentId` is not read from the body. The customer's sheet has no
 * agent selector (§2.4 rule 3), and accepting one here would let a browser set
 * a field the screen does not show.
 */
customerPortalRouter.post(
  '/shipments/:id/bl-draft',
  requirePermission(`${FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = auth.customerId!;
    const shipmentId = parseId(req.params.id, 'shipment');
    const input = blDraftInputSchema.parse(req.body);

    const data = await withCustomer(auth.tenantId, customerId, async (db) => {
      await createBlDraft(db, {
        tenantId: auth.tenantId,
        userId: auth.userId,
        shipmentId,
        origin: 'CUSTOMER',
        input,
        deliveryAgentId: null,
        deliveryAgentText: null,
      });
      return loadLiveBlDraft(db, shipmentId);
    });

    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.status(201).json(payload);
  },
);

/** PATCH /portal/bl-drafts/:id — editable while it is still theirs (DRAFT). */
customerPortalRouter.patch(
  '/bl-drafts/:id',
  requirePermission(`${FEATURE}.EDIT`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = auth.customerId!;
    const id = parseId(req.params.id, 'BL draft');
    const input = blDraftInputSchema.parse(req.body);

    const data = await withCustomer(auth.tenantId, customerId, async (db) => {
      const row = await loadBlDraftById(db, id);
      assertBlEditable(row);
      /*
       * A submitted draft is read-only to the customer (§5). It is the
       * forwarder's document from that moment, and letting the customer keep
       * editing it would mean the C/S team works to a page that moves.
       */
      if (row.status === 'SUBMITTED') {
        throw new HttpError(
          409,
          'BL_DRAFT_SUBMITTED',
          `${row.code} has been submitted. Ask your forwarder to reopen it if something is wrong.`,
        );
      }

      await db.blDraft.update({
        where: { id },
        data: { ...blDraftWriteData(input), updatedBy: auth.userId },
      });
      return loadLiveBlDraft(db, row.shipmentId);
    });

    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * POST /portal/bl-drafts/:id/submit — the customer sheet's `Save & Submit`.
 *
 * The one button that differs from the staff sheet, and the whole point of the
 * customer view: they hand the draft over, and the forwarder is the only one
 * who sends anything outward.
 */
customerPortalRouter.post(
  '/bl-drafts/:id/submit',
  requirePermission(`${FEATURE}.SUBMIT`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = auth.customerId!;
    const id = parseId(req.params.id, 'BL draft');

    const data = await withCustomer(auth.tenantId, customerId, async (db) => {
      const row = await loadBlDraftById(db, id);
      if (row.status !== 'DRAFT') {
        throw new HttpError(
          409,
          'BL_DRAFT_NOT_DRAFT',
          `${row.code} is ${row.status.toLowerCase()} and cannot be submitted again.`,
        );
      }

      await db.blDraft.update({
        where: { id },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          submittedBy: auth.userId,
          updatedBy: auth.userId,
        },
      });
      return loadLiveBlDraft(db, row.shipmentId);
    });

    const payload: ApiSuccess<BlDraftDto | null> = { success: true, data };
    res.json(payload);
  },
);

/**
 * GET /portal/bl-drafts/:id/pdf — the customer sheet's `Print`.
 *
 * The same renderer the forwarder prints from, so neither side is looking at a
 * different page. RLS decides which draft this can be: the policy admits only
 * drafts on the customer's own bookings.
 */
customerPortalRouter.get(
  '/bl-drafts/:id/pdf',
  requirePermission(`${FEATURE}.EXPORT_PDF`),
  async (req, res) => {
    const auth = req.auth!;
    const customerId = auth.customerId!;
    const id = parseId(req.params.id, 'BL draft');

    const doc = await withCustomer(auth.tenantId, customerId, async (db) => {
      const row = await loadBlDraftById(db, id);
      return blDraftDocument(db, auth.tenantId, row);
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.send(doc.pdf);
  },
);
