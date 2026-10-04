'use client';

import {
  MILESTONE_DATE_LABEL,
  MILESTONE_DONE_LABEL,
  MILESTONE_LEG_LABEL,
  MILESTONE_VIEW_LABEL,
  MILESTONE_VIEWS,
  type MilestoneConfirmResultDto,
  type MilestoneKind,
  type MilestoneRow,
  type MilestoneScreen as MilestoneScreenDef,
  type MilestoneSortField,
  type MilestoneView,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * One of the six lists behind Customer Service → Depart-Arrive Confirmation
 * (docs/DESIGN-UPDATE-2026-10-04.md §2): a kind (On board, Transshipment,
 * Arrival) and a mode. The columns are row 6 of the matching sheet; the
 * sheet's Action dropdown and Save become one button and a short form, so the
 * reason and the notice can be seen before anything is sent.
 */

const NOUN: Record<MilestoneKind, string> = {
  DEPARTED: 'departure',
  TRANSSHIPPED: 'transshipment',
  ARRIVED: 'arrival',
};

const DATE_FIELD: Record<MilestoneKind, string> = {
  DEPARTED: 'Departed on',
  TRANSSHIPPED: 'Left the transshipment port on',
  ARRIVED: 'Arrives on',
};

const EMPTY: Record<MilestoneKind, { title: string; description: string }> = {
  DEPARTED: {
    title: 'Nothing waiting to sail',
    description:
      'A booking appears here once its schedule is approved. Confirm the departure when it leaves, and the customer is told.',
  },
  TRANSSHIPPED: {
    title: 'No transshipments waiting',
    description: 'Indirect bookings appear here once their departure is confirmed. Direct sailings never do.',
  },
  ARRIVED: {
    title: 'Nothing waiting to arrive',
    description: 'A booking appears here once its departure is confirmed. Confirm the final arrival date and the customer is told.',
  },
};

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function Lines({ values }: { values: (string | null)[] }) {
  if (values.length === 0) return <span className="text-steel">—</span>;
  return (
    <div className="flex flex-col">
      {values.map((v, i) => (
        <span key={i} className="whitespace-nowrap font-mono tabular-nums">
          {v ?? '—'}
        </span>
      ))}
    </div>
  );
}

export function MilestoneScreen({ screen }: { screen: MilestoneScreenDef }) {
  const { can } = useSession();
  const { kind, shipmentType } = screen;
  const isAir = shipmentType === 'AIR';
  const list = useMasterList<MilestoneRow, MilestoneSortField>(
    `/api/tenant/cs/depart-arrive?kind=${kind}&shipmentType=${shipmentType}`,
    'date',
  );
  const view = (list.filters.view ?? 'AWAITING') as MilestoneView;
  const canEdit = can('CUSTOMER_SERVICE.DEPART_ARRIVE.EDIT');
  const [confirming, setConfirming] = useState<MilestoneRow | null>(null);

  const columns: DataTableColumn<MilestoneRow>[] = useMemo(() => {
    const cols: DataTableColumn<MilestoneRow>[] = [
      { id: 'quotation', header: 'Quotation No', cell: (r) => <span className="font-mono tabular-nums">{r.quotationCode}</span> },
      { id: 'so', header: 'S/O No', cell: (r) => <span className="font-mono tabular-nums">{r.soCode ?? '—'}</span> },
      { id: 'customer', header: 'Customer', sortable: true, cell: (r) => r.customerName },
      { id: 'exporter', header: 'Exporter', cell: (r) => r.exporterName ?? '—' },
      { id: 'type', header: 'Shipment Type', cell: (r) => (r.shipmentType === 'AIR' ? 'Air' : 'Sea') },
      { id: 'pol', header: isAir ? 'AOL' : 'POL', cell: (r) => <span title={r.polCode}>{r.polName}</span> },
      { id: 'pod', header: isAir ? 'AOD' : 'POD', cell: (r) => <span title={r.podCode}>{r.podName}</span> },
      { id: 'carrier', header: isAir ? 'Airline' : 'Carrier', cell: (r) => r.carrierName },
    ];
    if (!isAir) {
      cols.push(
        { id: 'container', header: 'Container no', cell: (r) => <Lines values={r.containers.map((c) => c.containerNo)} /> },
        { id: 'seal', header: 'Seal', cell: (r) => <Lines values={r.containers.map((c) => c.sealNo)} /> },
      );
    }
    cols.push(
      {
        id: 'leg',
        header: isAir ? MILESTONE_LEG_LABEL[kind].air : MILESTONE_LEG_LABEL[kind].sea,
        cell: (r) => <span className="font-mono tabular-nums">{r.legLabel ?? '—'}</span>,
      },
      {
        id: 'date',
        header: MILESTONE_DATE_LABEL[kind],
        numeric: true,
        sortable: true,
        cell: (r) => r.plannedOn ?? '—',
      },
      {
        id: 'status',
        header: 'Status',
        cell: (r) =>
          r.confirmation === null ? (
            <Status tone="pending">Awaiting</Status>
          ) : (
            <div className="flex flex-col">
              <Status tone="active">
                {MILESTONE_DONE_LABEL[kind]} <span className="font-mono tabular-nums">{r.confirmation.confirmedOn}</span>
              </Status>
              {r.confirmation.changeReason !== null && (
                <span className="max-w-56 text-cell text-steel" title={r.confirmation.changeReason}>
                  {r.confirmation.changeReason}
                </span>
              )}
              {!r.confirmation.notified && <span className="text-cell text-signal">Customer not emailed</span>}
            </div>
          ),
      },
    );
    return cols;
  }, [isAir, kind]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {/* The sheets' "back to landing" (B13). */}
        <Link
          href={'/cs/depart-arrive' as Route}
          className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
        >
          ← Back to Depart-Arrive Confirmation
        </Link>
        <div>
          <h1 className="text-page-title text-hull">{screen.title}</h1>
          <p className="mt-0.5 text-body text-steel">
            {kind === 'ARRIVED'
              ? `Confirm the final arrival date at least ${isAir ? 'one day' : 'three days'} before it lands. The customer is emailed the date${isAir ? '' : ', containers and seals'}.`
              : `The ${MILESTONE_DATE_LABEL[kind]} comes from the shipment advise. If it sailed early or late, change the date and say why — the customer is emailed.`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search bookings"
            placeholder="Booking, quotation, customer or exporter"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <Segmented
          label="Which bookings"
          value={view}
          options={MILESTONE_VIEWS.map((v) => [v, MILESTONE_VIEW_LABEL[v]] as const)}
          onChange={(v) => list.setFilter('view', v === 'AWAITING' ? '' : v)}
        />
      </div>

      {list.error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {list.error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={list.rows}
        getRowId={(r) => r.shipmentId}
        getCode={(r) => r.bookingCode}
        codeHeader="Booking No"
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as MilestoneSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) =>
          canEdit ? (
            <button type="button" className="text-body text-harbour hover:underline" onClick={() => setConfirming(row)}>
              {row.confirmation === null ? `Confirm ${NOUN[kind]}` : 'Change date'}
            </button>
          ) : null
        }
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No bookings match"
              description="Try a different term, or clear the filters to see the worklist."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState title={EMPTY[kind].title} description={EMPTY[kind].description} />
          )
        }
      />

      {confirming !== null && (
        <ConfirmModal
          kind={kind}
          row={confirming}
          onClose={() => setConfirming(null)}
          onSaved={() => {
            setConfirming(null);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

function ConfirmModal({
  kind,
  row,
  onClose,
  onSaved,
}: {
  kind: MilestoneKind;
  row: MilestoneRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authorizedRequest } = useSession();
  // A correction is measured against the date first pulled, not the last save.
  const pulled = row.confirmation?.pulledOn ?? row.plannedOn;
  const [date, setDate] = useState(row.confirmation?.confirmedOn ?? row.plannedOn ?? today());
  const [reason, setReason] = useState(row.confirmation?.changeReason ?? '');
  const [notify, setNotify] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [date, reason]);

  const moved = pulled !== null && date !== pulled;
  const reasonRequired = moved && kind !== 'ARRIVED';
  const action = row.confirmation === null ? `Confirm ${NOUN[kind]}` : 'Save new date';

  async function submit(): Promise<void> {
    if (date === '') {
      setError('Choose the date.');
      return;
    }
    if (reasonRequired && reason.trim() === '') {
      setError(`It was due on ${pulled}. Say why it moved — the customer is told.`);
      return;
    }
    setPending(true);
    try {
      const result = await authorizedRequest<MilestoneConfirmResultDto>(`/api/tenant/cs/depart-arrive/${row.shipmentId}`, {
        method: 'POST',
        body: { kind, date, reason: reason.trim() === '' ? undefined : reason.trim(), notify },
      });
      const extras = [
        result.notified ? 'customer emailed' : null,
        result.blDraftsUpdated > 0 ? 'BL on-board date set' : null,
      ].filter((v): v is string => v !== null);
      toast.success(
        `${row.bookingCode}: ${NOUN[kind]} ${row.confirmation === null ? 'confirmed' : 'date saved'}${extras.length === 0 ? '' : ` — ${extras.join(', ')}`}`,
      );
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : `Could not save the ${NOUN[kind]}. Please try again.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={`${action} — ${row.bookingCode}`}
      description={`${row.customerName} · ${row.polName} to ${row.podName}${row.legLabel === null ? '' : ` · ${row.legLabel}`}`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          id="milestone-date"
          label={DATE_FIELD[kind]}
          required
          hint={pulled === null ? undefined : `Due on ${pulled}${kind === 'DEPARTED' ? ', from the shipment advise' : ''}.`}
        >
          <Input id="milestone-date" type="date" numeric value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {(moved || reason !== '') && (
          <Field
            id="milestone-reason"
            label={kind === 'ARRIVED' ? 'Note for the customer' : 'Reason for the change'}
            required={reasonRequired}
            hint={reasonRequired ? 'Sailed early or late: this goes in the email.' : undefined}
          >
            <textarea
              id="milestone-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
            />
          </Field>
        )}
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-body text-hull">
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              className="h-4 w-4 accent-harbour"
            />
            Email the customer
          </label>
          {notify && (
            <p className="text-cell text-steel">
              {row.recipients.length === 0
                ? `No contact for ${row.customerName} has an email address, so nobody will be told. Add one under CRM → Customer.`
                : `To ${row.recipients.join(', ')}`}
            </p>
          )}
        </div>
        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Close
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
