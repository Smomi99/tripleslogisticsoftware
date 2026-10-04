'use client';

import { IGM_VIEW_LABEL, IGM_VIEWS, type IgmDto, type IgmRow, type IgmView, type MilestoneSortField, type ShipmentType } from '@ff/shared';
import { useMemo, useState } from 'react';
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
 * Operation → IGM Submission — the client's `IGM Update ( Inbound shipment
 * only)` sheet (docs/DESIGN-UPDATE-2026-10-04.md §4.1). The Arrival sheet's
 * booking row, then the sheet's own detail: HBL NO and the IGM file.
 */
export function IgmScreen() {
  const [mode, setMode] = useState<ShipmentType>('SEA');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="IGM Update"
        description="Inbound shipments only. Record the HBL No and upload the IGM (PDF or JPG). The DO can be issued once the IGM is in."
      />
      {/* Keyed by mode: each mode is its own list, with its own columns and page. */}
      <IgmList key={mode} mode={mode} onMode={setMode} />
    </div>
  );
}

function IgmList({ mode, onMode }: { mode: ShipmentType; onMode: (m: ShipmentType) => void }) {
  const { can, authorizedDownload } = useSession();
  const isAir = mode === 'AIR';
  const list = useMasterList<IgmRow, MilestoneSortField>(`/api/tenant/ops/igm?shipmentType=${mode}`, 'date');
  const view = (list.filters.view ?? 'AWAITING') as IgmView;
  const mayRecord = can('OPERATION.IGM_SUBMISSION.CREATE');
  const mayChange = can('OPERATION.IGM_SUBMISSION.EDIT');
  const [editing, setEditing] = useState<IgmRow | null>(null);

  const columns: DataTableColumn<IgmRow>[] = useMemo(
    () => [
      ...bookingColumns<IgmRow>('ARRIVED', isAir),
      { id: 'hbl', header: 'HBL No', cell: (r) => <span className="font-mono tabular-nums">{r.igm?.hblNo ?? '—'}</span> },
      {
        id: 'igm',
        header: 'IGM',
        cell: (r) =>
          r.igm?.updated === true ? (
            <div className="flex flex-col items-start">
              <Status tone="active">Updated</Status>
              <button
                type="button"
                className="max-w-48 truncate text-cell text-harbour hover:underline"
                title={r.igm.fileName ?? undefined}
                onClick={() =>
                  void authorizedDownload(`/api/tenant/ops/igm/${r.shipmentId}/file`, r.igm?.fileName ?? 'igm').catch(() =>
                    toast.error('Could not download the IGM file.'),
                  )
                }
              >
                {r.igm.fileName}
              </button>
            </div>
          ) : (
            <Status tone="pending">Awaiting</Status>
          ),
      },
    ],
    [authorizedDownload, isAir],
  );

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
          options={IGM_VIEWS.map((v) => [v, IGM_VIEW_LABEL[v]] as const)}
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
          (row.igm === null ? mayRecord : mayChange) ? (
            <button type="button" className="text-body text-harbour hover:underline" onClick={() => setEditing(row)}>
              {row.igm?.updated === true ? 'Change IGM' : 'Update IGM'}
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
            <EmptyState
              title="No inbound bookings waiting on an IGM"
              description="An inbound booking appears here once its schedule is approved. Upload its IGM when the carrier files it."
            />
          )
        }
      />

      {editing !== null && (
        <IgmModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function IgmModal({ row, onClose, onSaved }: { row: IgmRow; onClose: () => void; onSaved: () => void }) {
  const { authorizedRequest, authorizedUpload } = useSession();
  const [hblNo, setHblNo] = useState(row.igm?.hblNo ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (hblNo.trim() === '') {
      setError('Type the HBL No.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const path = `/api/tenant/ops/igm/${row.shipmentId}`;
      const saved =
        file === null
          ? await authorizedRequest<IgmDto>(path, { method: 'POST', body: { hblNo: hblNo.trim() } })
          : await authorizedUpload<IgmDto>(path, file, { hblNo: hblNo.trim() });
      toast.success(`${row.bookingCode}: IGM ${saved.updated ? 'updated' : 'saved — upload the file to mark it updated'}`);
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the IGM. Please try again.');
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
      title={`IGM — ${row.bookingCode}`}
      description={`${row.customerName} · ${row.polName} to ${row.podName}`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="igm-hbl" label="HBL No" required>
          <Input id="igm-hbl" numeric value={hblNo} maxLength={64} onChange={(e) => setHblNo(e.target.value)} />
        </Field>
        <Field
          id="igm-file"
          label="IGM file"
          hint={
            row.igm?.fileName == null
              ? 'PDF or JPG. Until it is uploaded the booking stays Awaiting.'
              : `Uploaded: ${row.igm.fileName}. Choose another file to replace it.`
          }
        >
          <input
            id="igm-file"
            type="file"
            accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-body text-hull file:mr-3 file:rounded-manifest file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-body file:text-hull"
          />
        </Field>
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
            {pending ? 'Saving…' : 'Save IGM'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
