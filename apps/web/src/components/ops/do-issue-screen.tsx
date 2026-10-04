'use client';

import {
  DELIVERY_ORDER_VIEW_LABEL,
  DELIVERY_ORDER_VIEWS,
  type DeliveryOrderDto,
  type DeliveryOrderPrefillDto,
  type DeliveryOrderRow,
  type DeliveryOrderView,
  type MilestoneSortField,
  type ShipmentType,
} from '@ff/shared';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { bookingColumns } from '@/components/cs/milestone-screen';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Operation → DO Issue — the client's `DO ISSUE ( Inbound shipment only )`
 * sheet (docs/DESIGN-UPDATE-2026-10-04.md §4.2). The Arrival sheet's booking
 * row; `ISSUE DO` writes the letter the sheet frames — DATE, TO, SUBJECT and
 * CONTAINER NO — once the IGM is in.
 */

const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour';

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function DoIssueScreen() {
  const [mode, setMode] = useState<ShipmentType>('SEA');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="DO Issue"
        description="Inbound shipments only. Issue the delivery order once the IGM is in, then print it for the terminal."
      />
      <DoList key={mode} mode={mode} onMode={setMode} />
    </div>
  );
}

function DoList({ mode, onMode }: { mode: ShipmentType; onMode: (m: ShipmentType) => void }) {
  const { can, authorizedDownload } = useSession();
  const isAir = mode === 'AIR';
  const list = useMasterList<DeliveryOrderRow, MilestoneSortField>(
    `/api/tenant/ops/delivery-orders?shipmentType=${mode}`,
    'date',
  );
  const view = (list.filters.view ?? 'AWAITING') as DeliveryOrderView;
  const mayIssue = can('OPERATION.DO_ISSUE.CREATE');
  const mayPrint = can('OPERATION.DO_ISSUE.EXPORT');
  const mayCancel = can('OPERATION.DO_ISSUE.TOGGLE_STATUS');
  const [issuing, setIssuing] = useState<DeliveryOrderRow | null>(null);
  const [cancelling, setCancelling] = useState<DeliveryOrderDto | null>(null);

  const columns: DataTableColumn<DeliveryOrderRow>[] = useMemo(
    () => [
      ...bookingColumns<DeliveryOrderRow>('ARRIVED', isAir),
      { id: 'hbl', header: 'HBL No', cell: (r) => <span className="font-mono tabular-nums">{r.hblNo ?? '—'}</span> },
      {
        id: 'igm',
        header: 'IGM',
        cell: (r) => (r.igmUpdated ? <Status tone="active">Updated</Status> : <Status tone="pending">Awaiting</Status>),
      },
      {
        id: 'do',
        header: 'DO',
        cell: (r) => {
          const order = r.deliveryOrder;
          if (order === null) return <Status tone="pending">Not issued</Status>;
          return order.status === 'ISSUED' ? (
            <div className="flex flex-col">
              <span className="font-mono tabular-nums">{order.code}</span>
              <span className="text-cell text-steel">Issued {order.issueDate}</span>
            </div>
          ) : (
            <div className="flex flex-col">
              <Status tone="inactive">
                <span className="font-mono tabular-nums">{order.code}</span> cancelled
              </Status>
              {order.cancelReason !== null && (
                <span className="max-w-56 truncate text-cell text-steel" title={order.cancelReason}>
                  {order.cancelReason}
                </span>
              )}
            </div>
          );
        },
      },
    ],
    [isAir],
  );

  async function print(order: DeliveryOrderDto): Promise<void> {
    try {
      await authorizedDownload(`/api/tenant/ops/delivery-orders/${order.id}/pdf`, `${order.code}.pdf`);
    } catch {
      toast.error(`Could not download ${order.code}.`);
    }
  }

  return (
    <>
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
        <Segmented label="Sea or air" value={mode} options={[['SEA', 'Sea'], ['AIR', 'Air']] as const} onChange={onMode} />
        <Segmented
          label="Which bookings"
          value={view}
          options={DELIVERY_ORDER_VIEWS.map((v) => [v, DELIVERY_ORDER_VIEW_LABEL[v]] as const)}
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
        actions={(row) => {
          const order = row.deliveryOrder;
          if (order !== null && order.status === 'ISSUED') {
            return (
              <>
                {mayPrint && (
                  <button type="button" className="text-body text-harbour hover:underline" onClick={() => void print(order)}>
                    Print
                  </button>
                )}
                {mayCancel && (
                  <button type="button" className="text-body text-alert hover:underline" onClick={() => setCancelling(order)}>
                    Cancel
                  </button>
                )}
              </>
            );
          }
          if (!mayIssue) return null;
          return row.igmUpdated ? (
            <button type="button" className="text-body text-harbour hover:underline" onClick={() => setIssuing(row)}>
              Issue DO
            </button>
          ) : (
            <span className="text-cell text-steel" title="Upload the IGM on IGM Submission first.">
              Waiting on IGM
            </span>
          );
        }}
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
            <EmptyState
              title="No inbound bookings waiting on a DO"
              description="An inbound booking appears here once its schedule is approved. Issue its DO once the IGM is uploaded."
            />
          )
        }
      />

      {issuing !== null && (
        <IssueModal
          row={issuing}
          onClose={() => setIssuing(null)}
          onIssued={(order) => {
            setIssuing(null);
            void list.reload();
            if (mayPrint) void print(order);
          }}
        />
      )}
      {cancelling !== null && (
        <CancelModal
          order={cancelling}
          onClose={() => setCancelling(null)}
          onCancelled={() => {
            setCancelling(null);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function IssueModal({
  row,
  onClose,
  onIssued,
}: {
  row: DeliveryOrderRow;
  onClose: () => void;
  onIssued: (order: DeliveryOrderDto) => void;
}) {
  const { authorizedRequest } = useSession();
  const [prefill, setPrefill] = useState<DeliveryOrderPrefillDto | null>(null);
  const [issueDate, setIssueDate] = useState(today());
  const [addressee, setAddressee] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<DeliveryOrderPrefillDto>(`/api/tenant/ops/delivery-orders/prefill/${row.shipmentId}`)
      .then((data) => {
        if (!live) return;
        setPrefill(data);
        setAddressee(data.addressee);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not open the DO.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, row.shipmentId]);

  async function submit(): Promise<void> {
    if (addressee.trim() === '') return setError('Say who the order is addressed to.');
    if (subject.trim() === '') return setError('Write the subject.');
    setPending(true);
    setError(null);
    try {
      const order = await authorizedRequest<DeliveryOrderDto>('/api/tenant/ops/delivery-orders', {
        method: 'POST',
        body: { shipmentId: row.shipmentId, issueDate, addressee, subject, body },
      });
      toast.success(`${order.code} issued for ${row.bookingCode}`);
      onIssued(order);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not issue the DO. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open
      size="wide"
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={`Issue DO — ${row.bookingCode}`}
      description={`${row.customerName} · ${row.polName} to ${row.podName}${row.hblNo === null ? '' : ` · HBL ${row.hblNo}`}`}
    >
      <form
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-4">
          <Field id="do-date" label="Date" required>
            <Input id="do-date" type="date" numeric value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </Field>
          <Field id="do-to" label="To" required hint="Edit when the cargo is not at Chittagong.">
            <textarea id="do-to" rows={4} value={addressee} onChange={(e) => setAddressee(e.target.value)} className={TEXTAREA} />
          </Field>
          <Field id="do-subject" label="Subject" required>
            <Input id="do-subject" value={subject} maxLength={500} onChange={(e) => setSubject(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-col gap-4">
          <Field id="do-body" label="Letter">
            <textarea id="do-body" rows={7} value={body} onChange={(e) => setBody(e.target.value)} className={TEXTAREA} />
          </Field>
          <div className="flex flex-col gap-1">
            <span className="label-manifest">Container no</span>
            {prefill === null ? (
              <span className="text-cell text-steel">Loading…</span>
            ) : prefill.containers.length === 0 ? (
              <span className="text-cell text-steel">
                {row.shipmentType === 'AIR' ? 'Air: no containers.' : 'No containers on the load plan. Name them in the letter.'}
              </span>
            ) : (
              <ul className="flex flex-col text-cell">
                {prefill.containers.map((c, i) => (
                  <li key={i} className="font-mono tabular-nums">
                    {c.containerNo ?? '—'} <span className="text-steel">{[c.size, c.sealNo].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {error !== null && (
          <p role="alert" className="text-cell text-alert md:col-span-2">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3 md:col-span-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Close
          </Button>
          <Button type="submit" disabled={pending || prefill === null}>
            {pending ? 'Issuing…' : 'Issue DO'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CancelModal({
  order,
  onClose,
  onCancelled,
}: {
  order: DeliveryOrderDto;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (reason.trim() === '') return setError('Say why the order is cancelled.');
    setPending(true);
    try {
      await authorizedRequest(`/api/tenant/ops/delivery-orders/${order.id}/cancel`, { method: 'POST', body: { reason } });
      toast.success(`${order.code} cancelled`);
      onCancelled();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not cancel the DO.');
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
      title={`Cancel ${order.code}?`}
      description="The order is kept, numbered and marked cancelled. Issue a new one afterwards if the cargo is still to be released."
    >
      <div className="flex flex-col gap-4">
        <Field id="do-cancel-reason" label="Reason" required>
          <textarea id="do-cancel-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={TEXTAREA} />
        </Field>
        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Keep it
          </Button>
          <Button variant="danger" onClick={() => void submit()} disabled={pending}>
            {pending ? 'Cancelling…' : 'Cancel DO'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
