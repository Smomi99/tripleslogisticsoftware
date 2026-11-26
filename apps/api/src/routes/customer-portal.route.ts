import { Router } from 'express';

import {
  type ApiSuccess,
  type BlDraftDto,
  type BlDraftPrefillDto,
  blDraftInputSchema,
  type PortalAdviseRow,
  type PortalApprovalRow,
  type PortalBillRow,
  type PortalCargoReceiptRow,
  type PortalInquiryRow,
  type PortalInvoiceRow,
  type PortalQuotationRow,
  type PortalShipmentRow,
  type PortalShippingOrderRow,
} from '@ff/shared';

import { blDraftPrefill, loadBlDraftById, loadLiveBlDraft } from '../lib/bl-draft-view';
import { loadInvoice } from '../lib/debit-invoice';
import { invoiceDocument } from './accounts.route';
import {
  assertBillComplete,
  assertBlEditable,
  blDraftDocument,
  blDraftWriteData,
  createBlDraft,
} from './bl-draft.route';
import { approvedBill, blPrintDocument } from './bl-print.route';
import { loadQuotationForPrint, quotationDocument } from './quotation.route';
import { adviseDocument, loadById as loadAdviseById } from './shipment-advise.route';
import { shippingOrderDocument } from './shipping-order.route';
import { HttpError } from '../lib/http-error';
import { parseId } from '../lib/request';
import { type TenantDb, withCustomer, withTenant } from '../lib/tenant-client';
import { type AuthContext, authenticateCustomer } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * The customer portal — docs/MODULE_DOCUMENTATION.md §2.4, §7, and the tabs on
 * My Shipments (owner, 2026-11-26).
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
 *
 * Every list reads a `customer_*_v` view, never the table behind it. The view
 * is where the column boundary lives (migrations 20260920110000 and
 * 20261126100000): the rows RLS opens still carry the salesman, the cost
 * total and the forwarder's own notes, and the views are what leave them out.
 */
export const customerPortalRouter: Router = Router();

customerPortalRouter.use(authenticateCustomer);

const FEATURE = 'CUSTOMER.BL_DRAFT';
const SHIPMENT_FEATURE = 'CUSTOMER.SHIPMENT';

/** The portal lists are a customer's own records; this many is years of them. */
const LIST_CAP = 200;

const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));
const stamp = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const dec = (d: { toString(): string } | null): string | null => (d === null ? null : d.toString());

function customerOf(auth: AuthContext): bigint {
  if (auth.customerId === null) throw HttpError.forbidden('This area is for customer accounts.');
  return auth.customerId;
}

/** Runs one read in the signed-in customer's own session. */
function asCustomer<T>(auth: AuthContext, fn: (db: TenantDb) => Promise<T>): Promise<T> {
  return withCustomer(auth.tenantId, customerOf(auth), fn);
}

function sendList<T>(res: { json: (body: ApiSuccess<T[]>) => void }, data: T[]): void {
  res.json({ success: true, data });
}

/**
 * Prints a document the customer has just been shown to own.
 *
 * Two sessions, deliberately. The first is the customer's: it reads the row
 * through its `customer_*_v` view, so RLS and the view's state gate decide
 * whether this customer may have this document at all — someone else's, a
 * draft, a cancelled one, all come back as nothing. Only then does the second,
 * a forwarder session, render it with the renderer staff use. The renderers
 * read the letterhead, carriers, vessels, bank details and the priced lines,
 * none of which a customer session may reach; opening all of that to print a
 * page the customer was already sent would be far more surface than this.
 *
 * The forwarder session receives nothing but the id the first one proved, and
 * the renderers write nothing. This is the second place a customer request
 * runs as staff — the first is authenticate's own account lookup (CR-004
 * §5.5) — and it stays inside this file.
 */
async function printOwned<T>(
  auth: AuthContext,
  own: (db: TenantDb) => Promise<T | undefined>,
  notFound: string,
  render: (db: TenantDb, owned: T) => Promise<{ pdf: Buffer; filename: string }>,
): Promise<{ pdf: Buffer; filename: string }> {
  const owned = await asCustomer(auth, own);
  if (owned === undefined) throw HttpError.notFound(notFound);
  return withTenant(auth.tenantId, (db) => render(db, owned));
}

function sendPdf(
  res: { setHeader: (k: string, v: string) => unknown; send: (b: Buffer) => unknown },
  doc: { pdf: Buffer; filename: string },
): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
  res.send(doc.pdf);
}

// ------------------------------------------------------------------ Inquiry

customerPortalRouter.get(
  '/inquiries',
  requirePermission('CUSTOMER.INQUIRY.VIEW'),
  async (req, res) => {
    const data = await asCustomer(req.auth!, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          inquiry_date: Date;
          shipment_type: PortalInquiryRow['shipmentType'];
          movement_type: PortalInquiryRow['movementType'];
          loading_type: PortalInquiryRow['loadingType'];
          pol_name: string | null;
          pod_name: string | null;
          expected_shipment_date: Date | null;
          valid_to: Date | null;
          status: PortalInquiryRow['status'];
        }[]
      >`
        SELECT v.id, v.code, v.inquiry_date,
               v.shipment_type::text AS shipment_type, v.movement_type::text AS movement_type,
               v.loading_type::text AS loading_type,
               pol.name AS pol_name, pod.name AS pod_name,
               v.expected_shipment_date, v.valid_to, v.status
          FROM customer_inquiry_v v
          LEFT JOIN port pol ON pol.id = v.pol_id
          LEFT JOIN port pod ON pod.id = v.pod_id
         ORDER BY v.id DESC
         LIMIT ${LIST_CAP}
      `;
      return rows.map(
        (r): PortalInquiryRow => ({
          id: r.id.toString(),
          code: r.code,
          inquiryDate: day(r.inquiry_date) ?? '',
          shipmentType: r.shipment_type,
          movementType: r.movement_type,
          loadingType: r.loading_type,
          polName: r.pol_name ?? '—',
          podName: r.pod_name ?? '—',
          expectedShipmentDate: day(r.expected_shipment_date),
          validTo: day(r.valid_to),
          status: r.status,
        }),
      );
    });
    sendList(res, data);
  },
);

// ---------------------------------------------------------------- Quotation

customerPortalRouter.get(
  '/quotations',
  requirePermission('CUSTOMER.QUOTATION.VIEW'),
  async (req, res) => {
    const data = await asCustomer(req.auth!, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          revision_no: number;
          inquiry_code: string | null;
          quotation_date: Date;
          validity_date: Date | null;
          shipment_type: PortalQuotationRow['shipmentType'];
          movement_type: PortalQuotationRow['movementType'];
          pol_name: string | null;
          pod_name: string | null;
          status: PortalQuotationRow['status'];
        }[]
      >`
        SELECT v.id, v.code, v.revision_no, v.inquiry_code, v.quotation_date, v.validity_date,
               v.shipment_type::text AS shipment_type, v.movement_type::text AS movement_type,
               pol.name AS pol_name, pod.name AS pod_name, v.status::text AS status
          FROM customer_quotation_v v
          LEFT JOIN port pol ON pol.id = v.pol_id
          LEFT JOIN port pod ON pod.id = v.pod_id
         ORDER BY v.id DESC
         LIMIT ${LIST_CAP}
      `;
      return rows.map(
        (r): PortalQuotationRow => ({
          id: r.id.toString(),
          code: r.code,
          revisionNo: r.revision_no,
          inquiryCode: r.inquiry_code,
          quotationDate: day(r.quotation_date) ?? '',
          validityDate: day(r.validity_date),
          shipmentType: r.shipment_type,
          movementType: r.movement_type,
          polName: r.pol_name ?? '—',
          podName: r.pod_name ?? '—',
          status: r.status,
        }),
      );
    });
    sendList(res, data);
  },
);

/** The quotation as sent — any revision they were sent, superseded ones too. */
customerPortalRouter.get(
  '/quotations/:id/pdf',
  requirePermission('CUSTOMER.QUOTATION.EXPORT_PDF'),
  async (req, res) => {
    const id = parseId(req.params.id, 'quotation');
    const doc = await printOwned(
      req.auth!,
      async (db) =>
        (
          await db.$queryRaw<{ id: bigint }[]>`
            SELECT id FROM customer_quotation_v WHERE id = ${id}`
        )[0]?.id,
      'Quotation not found.',
      async (db, owned) => quotationDocument(db, req.auth!.tenantId, await loadQuotationForPrint(db, owned)),
    );
    sendPdf(res, doc);
  },
);

// ------------------------------------------------------------------ Booking

/**
 * GET /portal/shipments — the Booking tab, the customer's own bookings.
 *
 * Reads `customer_shipment_v`, not `shipment`: the table carries the salesman,
 * the quotation and the forwarder's own notes on the same row, and RLS is
 * row-level. The view is where the column boundary lives.
 */
customerPortalRouter.get(
  '/shipments',
  requirePermission(`${SHIPMENT_FEATURE}.VIEW`),
  async (req, res) => {
    const data = await asCustomer(req.auth!, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          shipment_type: PortalShipmentRow['shipmentType'];
          status: PortalShipmentRow['status'];
          exporter_name: string | null;
          importer_name: string | null;
          pol_name: string | null;
          pod_name: string | null;
          etd: Date | null;
          eta: Date | null;
        }[]
      >`
        SELECT v.id, v.code, v.shipment_type::text AS shipment_type, v.status::text AS status,
               v.exporter_name, v.importer_name,
               pol.name AS pol_name, pod.name AS pod_name,
               v.etd, v.eta
          FROM customer_shipment_v v
          LEFT JOIN port pol ON pol.id = v.pol_id
          LEFT JOIN port pod ON pod.id = v.pod_id
         ORDER BY v.id DESC
         LIMIT ${LIST_CAP}
      `;

      return rows.map(
        (row): PortalShipmentRow => ({
          id: row.id.toString(),
          code: row.code,
          shipmentType: row.shipment_type,
          status: row.status,
          exporterName: row.exporter_name,
          importerName: row.importer_name,
          polName: row.pol_name ?? '—',
          podName: row.pod_name ?? '—',
          etd: day(row.etd),
          eta: day(row.eta),
        }),
      );
    });
    sendList(res, data);
  },
);

// -------------------------------------------------------- Awaiting approval

customerPortalRouter.get(
  '/approvals',
  requirePermission('CUSTOMER.APPROVAL.VIEW'),
  async (req, res) => {
    const data = await asCustomer(req.auth!, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          shipment_type: PortalApprovalRow['shipmentType'];
          pol_name: string | null;
          pod_name: string | null;
          cut_off_date: Date | null;
          etd: Date | null;
          eta: Date | null;
          voyage_no: string | null;
          flight_no: string | null;
          po_count: number;
          approved_count: number;
          rejected_count: number;
        }[]
      >`
        SELECT v.id, v.code, v.shipment_type::text AS shipment_type,
               pol.name AS pol_name, pod.name AS pod_name,
               v.cut_off_date, v.etd, v.eta, v.voyage_no, v.flight_no,
               v.po_count, v.approved_count, v.rejected_count
          FROM customer_approval_v v
          LEFT JOIN port pol ON pol.id = v.pol_id
          LEFT JOIN port pod ON pod.id = v.pod_id
         ORDER BY v.proposed_at DESC, v.id DESC
         LIMIT ${LIST_CAP}
      `;
      return rows.map(
        (r): PortalApprovalRow => ({
          id: r.id.toString(),
          code: r.code,
          shipmentType: r.shipment_type,
          polName: r.pol_name ?? '—',
          podName: r.pod_name ?? '—',
          cutOff: stamp(r.cut_off_date),
          etd: stamp(r.etd),
          eta: stamp(r.eta),
          voyageOrFlight: r.shipment_type === 'AIR' ? r.flight_no : r.voyage_no,
          poCount: r.po_count,
          approvedCount: r.approved_count,
          rejectedCount: r.rejected_count,
        }),
      );
    });
    sendList(res, data);
  },
);

// ----------------------------------------------------------- Shipping Order

customerPortalRouter.get(
  '/shipping-orders',
  requirePermission('CUSTOMER.SHIPPING_ORDER.VIEW'),
  async (req, res) => {
    const data = await asCustomer(req.auth!, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          booking_code: string;
          shipment_type: PortalShippingOrderRow['shipmentType'];
          pol_name: string | null;
          pod_name: string | null;
          issue_date: Date | null;
          first_vessel_name: string | null;
          first_flight_no: string | null;
          cut_off: Date | null;
          etd: Date | null;
          eta: Date | null;
          warehouse_cfs: string | null;
          status: PortalShippingOrderRow['status'];
        }[]
      >`
        SELECT v.id, v.code, v.booking_code, v.shipment_type::text AS shipment_type,
               pol.name AS pol_name, pod.name AS pod_name,
               v.issue_date, v.first_vessel_name, v.first_flight_no,
               v.cut_off, v.etd, v.eta, v.warehouse_cfs, v.status::text AS status
          FROM customer_shipping_order_v v
          LEFT JOIN port pol ON pol.id = v.pol_id
          LEFT JOIN port pod ON pod.id = v.pod_id
         ORDER BY v.id DESC
         LIMIT ${LIST_CAP}
      `;
      return rows.map(
        (r): PortalShippingOrderRow => ({
          id: r.id.toString(),
          code: r.code,
          bookingCode: r.booking_code,
          shipmentType: r.shipment_type,
          polName: r.pol_name ?? '—',
          podName: r.pod_name ?? '—',
          issueDate: day(r.issue_date),
          vesselOrFlight: r.shipment_type === 'AIR' ? r.first_flight_no : r.first_vessel_name,
          cutOff: stamp(r.cut_off),
          etd: stamp(r.etd),
          eta: stamp(r.eta),
          warehouseCfs: r.warehouse_cfs,
          status: r.status,
        }),
      );
    });
    sendList(res, data);
  },
);

/** An issued order only: a cancelled one was replaced and is not to be used. */
customerPortalRouter.get(
  '/shipping-orders/:id/pdf',
  requirePermission('CUSTOMER.SHIPPING_ORDER.EXPORT_PDF'),
  async (req, res) => {
    const id = parseId(req.params.id, 'shipping order');
    const doc = await printOwned(
      req.auth!,
      async (db) =>
        (
          await db.$queryRaw<{ id: bigint; shipment_id: bigint }[]>`
            SELECT id, shipment_id FROM customer_shipping_order_v
             WHERE id = ${id} AND status = 'ISSUED'`
        )[0],
      'Shipping order not found.',
      (db, owned) => shippingOrderDocument(db, req.auth!.tenantId, owned.shipment_id, owned.id),
    );
    sendPdf(res, doc);
  },
);

// ------------------------------------------------------------ Cargo Receipt

customerPortalRouter.get(
  '/cargo-receipts',
  requirePermission('CUSTOMER.CARGO_RECEIPT.VIEW'),
  async (req, res) => {
    const data = await asCustomer(req.auth!, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          booking_code: string;
          shipment_type: PortalCargoReceiptRow['shipmentType'];
          receipt_seq: number;
          receive_date: Date;
          ctn_qty: number;
          pcs_qty: number | null;
          gross_weight_kg: { toString(): string } | null;
          volume_cbm: { toString(): string } | null;
        }[]
      >`
        SELECT v.id, v.code, v.booking_code, v.shipment_type::text AS shipment_type,
               v.receipt_seq, v.receive_date, v.ctn_qty, v.pcs_qty,
               v.gross_weight_kg, v.volume_cbm
          FROM customer_cargo_receipt_v v
         ORDER BY v.receive_date DESC, v.id DESC
         LIMIT ${LIST_CAP}
      `;
      return rows.map(
        (r): PortalCargoReceiptRow => ({
          id: r.id.toString(),
          code: r.code,
          bookingCode: r.booking_code,
          shipmentType: r.shipment_type,
          receiptSeq: r.receipt_seq,
          receiveDate: day(r.receive_date) ?? '',
          ctnQty: r.ctn_qty,
          pcsQty: r.pcs_qty,
          grossWeightKg: dec(r.gross_weight_kg),
          volumeCbm: dec(r.volume_cbm),
        }),
      );
    });
    sendList(res, data);
  },
);

// ---------------------------------------------------------- Shipment Advise

customerPortalRouter.get(
  '/advises',
  requirePermission('CUSTOMER.ADVISE.VIEW'),
  async (req, res) => {
    const data = await asCustomer(req.auth!, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          shipment_type: PortalAdviseRow['shipmentType'];
          booking_codes: string | null;
          pol_name: string | null;
          pod_name: string | null;
          etd: Date | null;
          eta: Date | null;
          house_bl_no: string;
          mbl_no: string | null;
          status: PortalAdviseRow['status'];
          sent_at: Date | null;
        }[]
      >`
        SELECT v.id, v.code, v.shipment_type::text AS shipment_type, v.booking_codes,
               pol.name AS pol_name, pod.name AS pod_name,
               v.etd, v.eta, v.house_bl_no, v.mbl_no, v.status::text AS status, v.sent_at
          FROM customer_advise_v v
          LEFT JOIN port pol ON pol.id = v.pol_id
          LEFT JOIN port pod ON pod.id = v.pod_id
         ORDER BY v.sent_at DESC, v.id DESC
         LIMIT ${LIST_CAP}
      `;
      return rows.map(
        (r): PortalAdviseRow => ({
          id: r.id.toString(),
          code: r.code,
          shipmentType: r.shipment_type,
          bookingCodes: r.booking_codes ?? '—',
          polName: r.pol_name ?? '—',
          podName: r.pod_name ?? '—',
          etd: stamp(r.etd),
          eta: stamp(r.eta),
          houseBlNo: r.house_bl_no,
          mblNo: r.mbl_no,
          status: r.status,
          sentAt: stamp(r.sent_at),
        }),
      );
    });
    sendList(res, data);
  },
);

/** The advise as sent. A cancelled one is void and does not print. */
customerPortalRouter.get(
  '/advises/:id/pdf',
  requirePermission('CUSTOMER.ADVISE.EXPORT_PDF'),
  async (req, res) => {
    const id = parseId(req.params.id, 'advise');
    const doc = await printOwned(
      req.auth!,
      async (db) =>
        (
          await db.$queryRaw<{ id: bigint }[]>`
            SELECT id FROM customer_advise_v WHERE id = ${id} AND status = 'SENT'`
        )[0]?.id,
      'Shipment advise not found.',
      async (db, owned) => adviseDocument(db, req.auth!.tenantId, await loadAdviseById(db, owned)),
    );
    sendPdf(res, doc);
  },
);

// ----------------------------------------------------------------------- BL

/**
 * GET /portal/bills — the BL tab: one row per bill, numbered by a sent advise.
 * The draft is opened from the advise's own booking, the screen the customer
 * already fills in (§2.4).
 */
customerPortalRouter.get('/bills', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const data = await asCustomer(req.auth!, async (db) => {
    const rows = await db.$queryRaw<
      {
        id: bigint;
        shipment_id: bigint;
        shipment_type: PortalBillRow['shipmentType'];
        bl_no: string;
        booking_codes: string | null;
        pol_name: string | null;
        pod_name: string | null;
        draft_status: PortalBillRow['draftStatus'];
        issued_at: Date | null;
      }[]
    >`
      SELECT v.id, v.shipment_id, v.shipment_type::text AS shipment_type, v.bl_no,
             v.booking_codes, pol.name AS pol_name, pod.name AS pod_name,
             v.draft_status::text AS draft_status, v.issued_at
        FROM customer_bill_v v
        LEFT JOIN port pol ON pol.id = v.pol_id
        LEFT JOIN port pod ON pod.id = v.pod_id
       ORDER BY v.id DESC
       LIMIT ${LIST_CAP}
    `;
    return rows.map(
      (r): PortalBillRow => ({
        id: r.id.toString(),
        shipmentId: r.shipment_id.toString(),
        shipmentType: r.shipment_type,
        blNo: r.bl_no,
        bookingCodes: r.booking_codes ?? '—',
        polName: r.pol_name ?? '—',
        podName: r.pod_name ?? '—',
        draftStatus: r.draft_status,
        issuedAt: stamp(r.issued_at),
      }),
    );
  });
  sendList(res, data);
});

/**
 * GET /portal/bills/:id/pdf — a copy of the issued bill, keyed by its advise.
 *
 * Always the non-negotiable COPY. An original BL is a document of title: who
 * holds it controls the cargo, and its printing stays with the forwarder
 * (§13). Before issue there is no bill to copy; the draft prints from its own
 * screen.
 */
customerPortalRouter.get(
  '/bills/:id/pdf',
  requirePermission(`${FEATURE}.EXPORT_PDF`),
  async (req, res) => {
    const id = parseId(req.params.id, 'bill');
    const doc = await printOwned(
      req.auth!,
      async (db) =>
        (
          await db.$queryRaw<{ shipment_id: bigint }[]>`
            SELECT shipment_id FROM customer_bill_v WHERE id = ${id} AND issued_at IS NOT NULL`
        )[0]?.shipment_id,
      'Bill not found, or not issued yet.',
      async (db, shipmentId) =>
        blPrintDocument(db, req.auth!.tenantId, await approvedBill(db, shipmentId), 'COPY'),
    );
    sendPdf(res, doc);
  },
);

// ------------------------------------------------------------------ Invoice

customerPortalRouter.get(
  '/invoices',
  requirePermission('CUSTOMER.INVOICE.VIEW'),
  async (req, res) => {
    const data = await asCustomer(req.auth!, async (db) => {
      const rows = await db.$queryRaw<
        {
          id: bigint;
          code: string;
          kind: PortalInvoiceRow['kind'];
          booking_code: string | null;
          invoice_date: Date;
          currency_code: string;
          total_amount: { toString(): string };
          status: PortalInvoiceRow['status'];
        }[]
      >`
        SELECT v.id, v.code, v.kind::text AS kind, v.booking_code, v.invoice_date,
               v.currency_code, v.total_amount, v.status::text AS status
          FROM customer_invoice_v v
         ORDER BY v.invoice_date DESC, v.id DESC
         LIMIT ${LIST_CAP}
      `;
      return rows.map(
        (r): PortalInvoiceRow => ({
          id: r.id.toString(),
          code: r.code,
          kind: r.kind,
          bookingCode: r.booking_code,
          invoiceDate: day(r.invoice_date) ?? '',
          currencyCode: r.currency_code,
          totalAmount: r.total_amount.toString(),
          status: r.status,
        }),
      );
    });
    sendList(res, data);
  },
);

/** An issued invoice only. A cancelled one is no longer owed. */
customerPortalRouter.get(
  '/invoices/:id/pdf',
  requirePermission('CUSTOMER.INVOICE.EXPORT_PDF'),
  async (req, res) => {
    const id = parseId(req.params.id, 'invoice');
    const doc = await printOwned(
      req.auth!,
      async (db) =>
        (
          await db.$queryRaw<{ id: bigint }[]>`
            SELECT id FROM customer_invoice_v WHERE id = ${id} AND status = 'ISSUED'`
        )[0]?.id,
      'Invoice not found.',
      async (db, owned) => invoiceDocument(db, req.auth!.tenantId, await loadInvoice(db, owned)),
    );
    sendPdf(res, doc);
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

      assertBillComplete(input, row.shipment.shipmentType);
      await db.blDraft.update({
        where: { id },
        data: { ...blDraftWriteData(input, row.shipment.shipmentType), updatedBy: auth.userId },
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
