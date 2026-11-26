'use client';

import {
  ADVISE_STATUS_LABEL,
  BL_DRAFT_STATUS_LABEL,
  billTerms,
  type BlDraftStatus,
  LOADING_TYPE_LABEL,
  MOVEMENT_TYPE_LABEL,
  type PortalAdviseRow,
  type PortalApprovalRow,
  type PortalBillRow,
  type PortalCargoReceiptRow,
  PORTAL_INQUIRY_STATUS_LABEL,
  PORTAL_QUOTATION_STATUS_LABEL,
  type PortalInquiryRow,
  type PortalInquiryStatus,
  type PortalInvoiceRow,
  type PortalQuotationRow,
  type PortalShipmentRow,
  type PortalShippingOrderRow,
  type QuotationStatus,
  SHIPMENT_STATUS_LABEL,
  SHIPPING_ORDER_STATUS_LABEL,
  type ShipmentStatus,
  type ShipmentType,
} from '@ff/shared';
import { type ReactNode, useEffect, useState } from 'react';

import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Status, type StatusTone } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The tabs on the customer's My Shipments page (owner, 2026-11-26), one list
 * per kind of record. Every list is the signed-in customer's own: the API
 * reads it through RLS and a `customer_*_v` view, and this screen enforces
 * nothing on its own.
 *
 * Read only. Print opens the document the forwarder issued, in a new tab.
 */

// ------------------------------------------------------------------ helpers

/** Stored UTC, read in Dhaka (CLAUDE.md §9). `YYYY-MM-DD`. */
function dhakaDay(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
}

/** A moment — a cut-off, a flight — read in Dhaka. `YYYY-MM-DD HH:mm`. */
function dhakaStamp(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const time = d.toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${date} ${time}`;
}

/** A DATE column arrives as `YYYY-MM-DD` already: no time zone to apply. */
const plainDay = (value: string | null): string => value ?? '—';

const typeLabel = (t: ShipmentType): string => (t === 'AIR' ? 'Air' : 'Sea');

function Dash({ value }: { value: string | null }) {
  return value === null || value === '' ? <span className="text-steel">—</span> : <>{value}</>;
}

function figure(value: string | null, dp: number): string {
  if (value === null) return '—';
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
    : '—';
}

/** "1st", "2nd" — how the warehouse numbers a booking's receipts (§5.5 rule 4). */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Loads one tab's rows once, when the tab is first opened. */
function usePortalList<T>(path: string, failure: string) {
  const { authorizedRequest } = useSession();
  const [rows, setRows] = useState<T[]>([]);
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPending(true);
    void authorizedRequest<T[]>(path)
      .then((data) => {
        if (live) setRows(data);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof ApiError ? e.message : failure);
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, path, failure]);

  return { rows, isPending, error };
}

/** Opens a PDF from the portal in a new tab, or says why it could not. */
function usePrint() {
  const { authorizedObjectUrl } = useSession();
  const [printing, setPrinting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function print(key: string, path: string, what: string): Promise<void> {
    setError(null);
    setPrinting(key);
    try {
      const url = await authorizedObjectUrl(path);
      window.open(url, '_blank', 'noopener');
    } catch {
      setError(`Could not open the ${what}. Try again, or ask your forwarder for a copy.`);
    } finally {
      setPrinting(null);
    }
  }

  return { print, printing, error };
}

function ErrorLine({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p
      role="alert"
      className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
    >
      {message}
    </p>
  );
}

/** One tab's table: the rows the API returned, all on one page. */
function PortalTable<T extends { id: string }>({
  rows,
  isPending,
  columns,
  getCode,
  codeHeader,
  actions,
  empty,
}: {
  rows: T[];
  isPending: boolean;
  columns: DataTableColumn<T>[];
  getCode: (row: T) => string;
  codeHeader?: string;
  actions?: (row: T) => ReactNode;
  empty: { title: string; description: string };
}) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getCode={getCode}
      {...(codeHeader === undefined ? {} : { codeHeader })}
      total={rows.length}
      page={1}
      limit={rows.length === 0 ? 25 : rows.length}
      sortOrder="desc"
      onSortChange={() => undefined}
      onPageChange={() => undefined}
      isPending={isPending}
      {...(actions === undefined ? {} : { actions })}
      empty={<EmptyState title={empty.title} description={empty.description} />}
    />
  );
}

function PrintButton({
  busy,
  onClick,
  label = 'Print',
}: {
  busy: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="text-body text-harbour hover:underline disabled:opacity-60"
      disabled={busy}
      onClick={onClick}
    >
      {busy ? 'Opening…' : label}
    </button>
  );
}

// ------------------------------------------------------------------ Inquiry

const INQUIRY_TONE: Record<PortalInquiryStatus, StatusTone> = {
  IN_PROGRESS: 'pending',
  QUOTED: 'pending',
  CONFIRMED: 'active',
  CLOSED: 'inactive',
  EXPIRED: 'inactive',
  CANCELLED: 'overdue',
};

export function InquiryTab() {
  const { rows, isPending, error } = usePortalList<PortalInquiryRow>(
    '/api/tenant/portal/inquiries',
    'Could not load your inquiries.',
  );

  const columns: DataTableColumn<PortalInquiryRow>[] = [
    { id: 'date', header: 'Inquiry date', numeric: true, cell: (r) => plainDay(r.inquiryDate) },
    {
      id: 'type',
      header: 'Type',
      cell: (r) =>
        r.loadingType === null
          ? typeLabel(r.shipmentType)
          : `${typeLabel(r.shipmentType)} · ${LOADING_TYPE_LABEL[r.loadingType]}`,
    },
    { id: 'movement', header: 'Movement', cell: (r) => MOVEMENT_TYPE_LABEL[r.movementType] },
    { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
    { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
    {
      id: 'expected',
      header: 'Expected shipment',
      numeric: true,
      cell: (r) => plainDay(r.expectedShipmentDate),
    },
    { id: 'valid', header: 'Valid until', numeric: true, cell: (r) => plainDay(r.validTo) },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => <Status tone={INQUIRY_TONE[r.status]}>{PORTAL_INQUIRY_STATUS_LABEL[r.status]}</Status>,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.code}
        codeHeader="Inquiry no"
        empty={{
          title: 'No inquiries yet',
          description: 'Inquiries your forwarder records for you will appear here.',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Quotation

const QUOTATION_TONE: Record<QuotationStatus, StatusTone> = {
  DRAFT: 'pending',
  SENT: 'pending',
  ACCEPTED: 'active',
  REJECTED: 'inactive',
  EXPIRED: 'inactive',
  SUPERSEDED: 'inactive',
  CANCELLED: 'overdue',
};

export function QuotationTab() {
  const { can } = useSession();
  const { rows, isPending, error } = usePortalList<PortalQuotationRow>(
    '/api/tenant/portal/quotations',
    'Could not load your quotations.',
  );
  const { print, printing, error: printError } = usePrint();

  const columns: DataTableColumn<PortalQuotationRow>[] = [
    {
      id: 'revision',
      header: 'Revision',
      numeric: true,
      align: 'right',
      cell: (r) => r.revisionNo,
    },
    { id: 'date', header: 'Quotation date', numeric: true, cell: (r) => plainDay(r.quotationDate) },
    { id: 'inquiry', header: 'Inquiry no', numeric: true, cell: (r) => <Dash value={r.inquiryCode} /> },
    { id: 'type', header: 'Type', cell: (r) => typeLabel(r.shipmentType) },
    { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
    { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
    { id: 'valid', header: 'Valid until', numeric: true, cell: (r) => plainDay(r.validityDate) },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <Status tone={QUOTATION_TONE[r.status]}>{PORTAL_QUOTATION_STATUS_LABEL[r.status]}</Status>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error ?? printError} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.code}
        codeHeader="Quotation no"
        actions={(r) =>
          can('CUSTOMER.QUOTATION.EXPORT_PDF') ? (
            <PrintButton
              busy={printing === r.id}
              onClick={() =>
                void print(r.id, `/api/tenant/portal/quotations/${r.id}/pdf`, 'quotation')
              }
            />
          ) : null
        }
        empty={{
          title: 'No quotations yet',
          description: 'Quotations your forwarder sends you will appear here, every revision.',
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ Booking

/** Where a booking has got to, as a pill: finished, stopped, or still moving. */
function bookingTone(status: ShipmentStatus): StatusTone {
  if (status === 'CANCELLED' || status === 'REJECTED') return 'overdue';
  if (status === 'SHORT_CLOSED') return 'inactive';
  if (status === 'BL_ISSUED') return 'active';
  return 'pending';
}

export function BookingTab() {
  const { rows, isPending, error } = usePortalList<PortalShipmentRow>(
    '/api/tenant/portal/shipments',
    'Could not load your bookings.',
  );

  const columns: DataTableColumn<PortalShipmentRow>[] = [
    { id: 'type', header: 'Type', cell: (r) => typeLabel(r.shipmentType) },
    { id: 'exporter', header: 'Exporter', cell: (r) => <Dash value={r.exporterName} /> },
    { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
    { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
    { id: 'etd', header: 'ETD', numeric: true, cell: (r) => plainDay(r.etd) },
    { id: 'eta', header: 'ETA', numeric: true, cell: (r) => plainDay(r.eta) },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => <Status tone={bookingTone(r.status)}>{SHIPMENT_STATUS_LABEL[r.status]}</Status>,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.code}
        codeHeader="Booking no"
        empty={{
          title: 'No bookings yet',
          description: 'Bookings your forwarder raises for you will appear here.',
        }}
      />
    </div>
  );
}

// -------------------------------------------------------- Awaiting approval

export function ApprovalTab() {
  const { rows, isPending, error } = usePortalList<PortalApprovalRow>(
    '/api/tenant/portal/approvals',
    'Could not load the sailings awaiting your approval.',
  );

  const columns: DataTableColumn<PortalApprovalRow>[] = [
    { id: 'type', header: 'Type', cell: (r) => typeLabel(r.shipmentType) },
    { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
    { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
    {
      id: 'leg',
      header: 'Voyage / flight',
      numeric: true,
      cell: (r) => <Dash value={r.voyageOrFlight} />,
    },
    { id: 'cutoff', header: 'Cut-off', numeric: true, cell: (r) => dhakaStamp(r.cutOff) },
    {
      id: 'etd',
      header: 'ETD',
      numeric: true,
      cell: (r) => (r.shipmentType === 'AIR' ? dhakaStamp(r.etd) : dhakaDay(r.etd)),
    },
    {
      id: 'eta',
      header: 'ETA',
      numeric: true,
      cell: (r) => (r.shipmentType === 'AIR' ? dhakaStamp(r.eta) : dhakaDay(r.eta)),
    },
    {
      id: 'pos',
      header: 'POs',
      cell: (r) =>
        r.poCount === 0
          ? '—'
          : r.rejectedCount > 0
            ? `${r.approvedCount} of ${r.poCount} approved, ${r.rejectedCount} rejected`
            : `${r.approvedCount} of ${r.poCount} approved`,
    },
    {
      id: 'status',
      header: 'Status',
      cell: () => <Status tone="pending">Awaiting approval</Status>,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-steel">
        Sailings your forwarder has proposed for these bookings. To approve or reject one, reply
        to your forwarder&apos;s customer service team.
      </p>
      <ErrorLine message={error} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.code}
        codeHeader="Booking no"
        empty={{
          title: 'Nothing awaiting your approval',
          description: 'When your forwarder proposes a vessel or flight for a booking, it appears here.',
        }}
      />
    </div>
  );
}

// ----------------------------------------------------------- Shipping Order

export function ShippingOrderTab() {
  const { can } = useSession();
  const { rows, isPending, error } = usePortalList<PortalShippingOrderRow>(
    '/api/tenant/portal/shipping-orders',
    'Could not load your shipping orders.',
  );
  const { print, printing, error: printError } = usePrint();

  const columns: DataTableColumn<PortalShippingOrderRow>[] = [
    { id: 'booking', header: 'Booking no', numeric: true, cell: (r) => r.bookingCode },
    { id: 'issued', header: 'Issue date', numeric: true, cell: (r) => plainDay(r.issueDate) },
    { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
    { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
    { id: 'vessel', header: 'Vessel / flight', cell: (r) => <Dash value={r.vesselOrFlight} /> },
    { id: 'cutoff', header: 'Cut-off', numeric: true, cell: (r) => dhakaStamp(r.cutOff) },
    {
      id: 'etd',
      header: 'ETD',
      numeric: true,
      cell: (r) => (r.shipmentType === 'AIR' ? dhakaStamp(r.etd) : dhakaDay(r.etd)),
    },
    {
      id: 'eta',
      header: 'ETA',
      numeric: true,
      cell: (r) => (r.shipmentType === 'AIR' ? dhakaStamp(r.eta) : dhakaDay(r.eta)),
    },
    { id: 'cfs', header: 'Warehouse / CFS', cell: (r) => <Dash value={r.warehouseCfs} /> },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <Status tone={r.status === 'ISSUED' ? 'active' : 'overdue'}>
          {SHIPPING_ORDER_STATUS_LABEL[r.status]}
        </Status>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error ?? printError} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.code}
        codeHeader="S/O no"
        actions={(r) =>
          r.status === 'ISSUED' && can('CUSTOMER.SHIPPING_ORDER.EXPORT_PDF') ? (
            <PrintButton
              busy={printing === r.id}
              onClick={() =>
                void print(r.id, `/api/tenant/portal/shipping-orders/${r.id}/pdf`, 'shipping order')
              }
            />
          ) : null
        }
        empty={{
          title: 'No shipping orders yet',
          description: 'Once a sailing is approved, your forwarder issues the shipping order here.',
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------ Cargo Receipt

export function CargoReceiptTab() {
  const { rows, isPending, error } = usePortalList<PortalCargoReceiptRow>(
    '/api/tenant/portal/cargo-receipts',
    'Could not load your cargo receipts.',
  );

  const columns: DataTableColumn<PortalCargoReceiptRow>[] = [
    { id: 'booking', header: 'Booking no', numeric: true, cell: (r) => r.bookingCode },
    { id: 'seq', header: 'Receipt', cell: (r) => ordinal(r.receiptSeq) },
    { id: 'date', header: 'Received on', numeric: true, cell: (r) => plainDay(r.receiveDate) },
    {
      id: 'ctn',
      header: 'CTN',
      numeric: true,
      align: 'right',
      cell: (r) => r.ctnQty.toLocaleString('en-US'),
    },
    {
      id: 'pcs',
      header: 'PCS',
      numeric: true,
      align: 'right',
      cell: (r) => (r.pcsQty === null ? '—' : r.pcsQty.toLocaleString('en-US')),
    },
    {
      id: 'gwt',
      header: 'G.WT (kg)',
      numeric: true,
      align: 'right',
      cell: (r) => figure(r.grossWeightKg, 3),
    },
    {
      id: 'cbm',
      header: 'CBM',
      numeric: true,
      align: 'right',
      cell: (r) => figure(r.volumeCbm, 3),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.code}
        codeHeader="Receipt no"
        empty={{
          title: 'No cargo received yet',
          description: 'Each delivery the warehouse confirms for your bookings appears here.',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------- Shipment Advise

export function AdviseTab() {
  const { can } = useSession();
  const { rows, isPending, error } = usePortalList<PortalAdviseRow>(
    '/api/tenant/portal/advises',
    'Could not load your shipment advises.',
  );
  const { print, printing, error: printError } = usePrint();

  const columns: DataTableColumn<PortalAdviseRow>[] = [
    { id: 'bookings', header: 'Booking no', numeric: true, cell: (r) => r.bookingCodes },
    {
      id: 'hbl',
      header: 'HBL / HAWB',
      numeric: true,
      cell: (r) => r.houseBlNo,
    },
    { id: 'mbl', header: 'MBL / MAWB', numeric: true, cell: (r) => <Dash value={r.mblNo} /> },
    { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
    { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
    {
      id: 'etd',
      header: 'ETD',
      numeric: true,
      cell: (r) => (r.shipmentType === 'AIR' ? dhakaStamp(r.etd) : dhakaDay(r.etd)),
    },
    {
      id: 'eta',
      header: 'ETA',
      numeric: true,
      cell: (r) => (r.shipmentType === 'AIR' ? dhakaStamp(r.eta) : dhakaDay(r.eta)),
    },
    { id: 'sent', header: 'Sent on', numeric: true, cell: (r) => dhakaDay(r.sentAt) },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <Status tone={r.status === 'SENT' ? 'active' : 'overdue'}>
          {ADVISE_STATUS_LABEL[r.status]}
        </Status>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error ?? printError} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.code}
        codeHeader="Advise no"
        actions={(r) =>
          r.status === 'SENT' && can('CUSTOMER.ADVISE.EXPORT_PDF') ? (
            <PrintButton
              busy={printing === r.id}
              onClick={() =>
                void print(r.id, `/api/tenant/portal/advises/${r.id}/pdf`, 'shipment advise')
              }
            />
          ) : null
        }
        empty={{
          title: 'No shipment advises yet',
          description: 'When your cargo ships, your forwarder sends the shipment advise here.',
        }}
      />
    </div>
  );
}

// ----------------------------------------------------------------------- BL

const DRAFT_TONE: Record<BlDraftStatus, StatusTone> = {
  DRAFT: 'pending',
  SUBMITTED: 'pending',
  APPROVED: 'active',
  SENT: 'active',
  CANCELLED: 'overdue',
};

export function BillTab({
  onOpenDraft,
}: {
  /** Opens the draft screen for the advise's own booking. */
  onOpenDraft: (row: PortalBillRow) => void;
}) {
  const { can } = useSession();
  const { rows, isPending, error } = usePortalList<PortalBillRow>(
    '/api/tenant/portal/bills',
    'Could not load your bills of lading.',
  );
  const { print, printing, error: printError } = usePrint();

  const columns: DataTableColumn<PortalBillRow>[] = [
    {
      id: 'kind',
      header: 'Document',
      cell: (r) => billTerms(r.shipmentType === 'AIR' ? 'AIR' : 'SEA').short,
    },
    { id: 'bookings', header: 'Booking no', numeric: true, cell: (r) => r.bookingCodes },
    { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
    { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
    {
      id: 'draft',
      header: 'Draft status',
      cell: (r) =>
        r.draftStatus === null ? (
          <span className="text-steel">Not started</span>
        ) : (
          <Status tone={DRAFT_TONE[r.draftStatus]}>{BL_DRAFT_STATUS_LABEL[r.draftStatus]}</Status>
        ),
    },
    {
      id: 'issued',
      header: 'Issued on',
      numeric: true,
      cell: (r) => (r.issuedAt === null ? <span className="text-steel">Not issued</span> : dhakaDay(r.issuedAt)),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error ?? printError} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.blNo}
        codeHeader="BL / HAWB no"
        actions={(r) => {
          const terms = billTerms(r.shipmentType === 'AIR' ? 'AIR' : 'SEA');
          return (
            <>
              <button
                type="button"
                className="text-body text-harbour hover:underline"
                onClick={() => onOpenDraft(r)}
              >
                {`${r.draftStatus === null ? 'Make' : 'Open'} ${terms.draft}`}
              </button>
              {r.issuedAt !== null && can('CUSTOMER.BL_DRAFT.EXPORT_PDF') && (
                <PrintButton
                  busy={printing === r.id}
                  label="Print copy"
                  onClick={() =>
                    void print(r.id, `/api/tenant/portal/bills/${r.id}/pdf`, terms.document)
                  }
                />
              )}
            </>
          );
        }}
        empty={{
          title: 'No bills of lading yet',
          description:
            'Once your shipment advise is sent, its BL or HAWB number appears here and you can fill in the draft.',
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ Invoice

export function InvoiceTab() {
  const { can } = useSession();
  const { rows, isPending, error } = usePortalList<PortalInvoiceRow>(
    '/api/tenant/portal/invoices',
    'Could not load your invoices.',
  );
  const { print, printing, error: printError } = usePrint();

  const columns: DataTableColumn<PortalInvoiceRow>[] = [
    { id: 'date', header: 'Invoice date', numeric: true, cell: (r) => plainDay(r.invoiceDate) },
    { id: 'booking', header: 'Booking no', numeric: true, cell: (r) => <Dash value={r.bookingCode} /> },
    { id: 'currency', header: 'Currency', numeric: true, cell: (r) => r.currencyCode },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      align: 'right',
      cell: (r) => figure(r.totalAmount, 2),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (
        <Status tone={r.status === 'ISSUED' ? 'active' : 'overdue'}>
          {r.status === 'ISSUED' ? 'Issued' : 'Cancelled'}
        </Status>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={error ?? printError} />
      <PortalTable
        rows={rows}
        isPending={isPending}
        columns={columns}
        getCode={(r) => r.code}
        codeHeader="Invoice no"
        actions={(r) =>
          r.status === 'ISSUED' && can('CUSTOMER.INVOICE.EXPORT_PDF') ? (
            <PrintButton
              busy={printing === r.id}
              onClick={() => void print(r.id, `/api/tenant/portal/invoices/${r.id}/pdf`, 'invoice')}
            />
          ) : null
        }
        empty={{
          title: 'No invoices yet',
          description: 'Invoices your forwarder issues to you will appear here.',
        }}
      />
    </div>
  );
}
