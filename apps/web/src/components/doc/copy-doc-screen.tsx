'use client';

import {
  COPY_DOCUMENT_KINDS,
  type CopyDocDetailDto,
  type CopyDocRow,
  type CopyDocumentDto,
  type MilestoneSortField,
} from '@ff/shared';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { RowActions } from '@/components/ui/row-actions';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';
import { useIsPhone } from '@/lib/use-media-query';

const FEATURE = 'DOCUMENTATION.COPY_DOC_UPLOAD';
const BASE = '/api/tenant/documentation/copy-docs';

/**
 * Documentation → Copy Doc upload — the client's `Copy doc upload` sheet,
 * "Shipping Documens upload" (docs/DESIGN-UPDATE-2026-10-28.md §3). Sea and
 * air, inbound and outbound in one list, as the sheet's two sample rows are;
 * `Upload Doc` opens the papers: the sheet's nine, and the client's two additions.
 */
export function CopyDocScreen() {
  const { can } = useSession();
  const list = useMasterList<CopyDocRow, MilestoneSortField>(BASE, 'date');
  const [open, setOpen] = useState<CopyDocRow | null>(null);
  const mayUpload = can(`${FEATURE}.CREATE`) || can(`${FEATURE}.EDIT`);

  const columns: DataTableColumn<CopyDocRow>[] = useMemo(
    () => [
      { id: 'so', header: 'S/O No', cell: (r) => <span className="whitespace-nowrap font-mono tabular-nums">{r.soCode ?? '—'}</span> },
      { id: 'customer', header: 'Customer', sortable: true, cell: (r) => r.customerName },
      { id: 'exporter', header: 'Exporter', cell: (r) => r.exporterName ?? '—' },
      { id: 'importer', header: 'Importer', cell: (r) => r.importerName ?? '—' },
      { id: 'commodity', header: 'Commodity', cell: (r) => <span className="line-clamp-2 max-w-48">{r.commodity ?? '—'}</span> },
      { id: 'type', header: 'Shipment Type', cell: (r) => (r.shipmentType === 'AIR' ? 'Air' : 'Sea') },
      { id: 'pol', header: 'POL', cell: (r) => <span title={r.polCode}>{r.polName}</span> },
      { id: 'pod', header: 'POD', cell: (r) => <span title={r.podCode}>{r.podName}</span> },
      { id: 'carrier', header: 'Carrier', cell: (r) => r.carrierName },
      { id: 'hbl', header: 'House BL No', cell: (r) => <span className="whitespace-nowrap font-mono tabular-nums">{r.houseBlNo ?? '—'}</span> },
      { id: 'mbl', header: 'MBL No', cell: (r) => <span className="whitespace-nowrap font-mono tabular-nums">{r.mblNo ?? '—'}</span> },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Copy Doc Upload"
        description="Copies of each booking's shipping papers, sea and air, inbound and outbound. What the system already holds is shown until a copy is uploaded."
      />

      {/* On a phone the filters stack full width: side by side cut "Inbound and outbound" off. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="flex flex-col gap-1.5 sm:w-72">
          <span className="label-field">Search</span>
          <Input
            type="search"
            aria-label="Search bookings"
            placeholder="Booking, quotation, customer or exporter"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:w-40">
          <label htmlFor="copy-doc-mode" className="label-field">
            Mode
          </label>
          <Select id="copy-doc-mode" value={list.filters.shipmentType ?? ''} onChange={(e) => list.setFilter('shipmentType', e.target.value)}>
            <option value="">Sea and air</option>
            <option value="SEA">Sea</option>
            <option value="AIR">Air</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5 sm:w-48">
          <label htmlFor="copy-doc-direction" className="label-field">
            Direction
          </label>
          <Select
            id="copy-doc-direction"
            value={list.filters.movementType ?? ''}
            onChange={(e) => list.setFilter('movementType', e.target.value)}
          >
            <option value="">Inbound and outbound</option>
            <option value="OUTBOUND">Outbound</option>
            <option value="INBOUND">Inbound</option>
          </Select>
        </div>
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
        actions={(row) => (
          <span className="flex items-center gap-3">
            <Button variant="text" size="inline" onClick={() => setOpen(row)}>
              {mayUpload ? 'Upload Doc' : 'View docs'}
            </Button>
            <span className="whitespace-nowrap text-cell text-steel">
              <span className="font-mono tabular-nums">{row.onFile}</span> of{' '}
              <span className="font-mono tabular-nums">{COPY_DOCUMENT_KINDS.length}</span>
            </span>
          </span>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No bookings match"
              description="Try a different term, or clear the filters to see every booking."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No bookings to file papers for yet"
              description="A booking appears here once its schedule is approved. Upload its bills, invoice, packing list and certificates as they come in."
            />
          )
        }
      />

      {open !== null && (
        <CopyDocModal
          row={open}
          onClose={() => {
            setOpen(null);
            void list.reload();
          }}
        />
      )}
    </div>
  );
}

/** The upload form (C16–E24, plus two): a row per paper, each "browse and upload". */
function CopyDocModal({ row, onClose }: { row: CopyDocRow; onClose: () => void }) {
  const { can, authorizedRequest, authorizedUpload, authorizedDownload } = useSession();
  const isPhone = useIsPhone();
  const mayCreate = can(`${FEATURE}.CREATE`);
  const mayEdit = can(`${FEATURE}.EDIT`);
  const base = `${BASE}/${row.shipmentId}`;
  const [detail, setDetail] = useState<CopyDocDetailDto | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<CopyDocumentDto | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<CopyDocDetailDto>(base)
      .then((data) => {
        if (live) setDetail(data);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load the documents.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, base]);

  async function upload(doc: CopyDocumentDto, file: File): Promise<void> {
    setUploading(doc.kind);
    setError(null);
    try {
      setDetail(await authorizedUpload<CopyDocDetailDto>(`${base}/documents`, file, { kind: doc.kind }));
      toast.success(`${doc.label} uploaded`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not upload that file.');
    } finally {
      setUploading(null);
    }
  }

  async function remove(): Promise<void> {
    if (toRemove === null) return;
    setRemoving(true);
    try {
      setDetail(await authorizedRequest<CopyDocDetailDto>(`${base}/documents/${toRemove.kind}`, { method: 'DELETE' }));
      toast.success('Removed');
      setToRemove(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove that copy.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Modal
      open
      size="wide"
      onOpenChange={(open) => {
        if (!open && uploading === null) onClose();
      }}
      title={`Shipping documents — ${row.bookingCode}`}
      description={`${row.customerName} · ${row.polName} to ${row.podName}${row.houseBlNo === null ? '' : ` · HBL ${row.houseBlNo}`}`}
    >
      {detail === null ? (
        <p className="text-body text-steel">{error ?? 'Loading…'}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col divide-y divide-line rounded-manifest border border-line">
            {detail.documents.map((doc) => {
              // A first copy of a paper is CREATE; replacing or removing an upload is EDIT.
              const mayUploadThis = doc.source === 'UPLOAD' ? mayEdit : mayCreate;
              return (
                <li key={doc.kind} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-body text-hull">{doc.label}</span>
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-cell text-steel">
                      {doc.source === null ? (
                        <Status tone="inactive">Not on file</Status>
                      ) : (
                        <>
                          <Status tone="active">{doc.source === 'UPLOAD' ? 'Uploaded' : 'On file'}</Status>
                          <button
                            type="button"
                            className="max-w-full truncate text-harbour hover:underline sm:max-w-80"
                            title={doc.fileName ?? undefined}
                            onClick={() =>
                              void authorizedDownload(`${base}/documents/${doc.kind}`, doc.fileName ?? doc.kind).catch(() =>
                                toast.error('Could not open that document.'),
                              )
                            }
                          >
                            {doc.fileName}
                          </button>
                        </>
                      )}
                      {doc.note !== null && <span>{doc.note}</span>}
                      {doc.source === 'UPLOAD' && doc.uploadedAt !== null && (
                        <span>
                          <span className="font-mono tabular-nums">{doc.uploadedAt.slice(0, 10)}</span>
                          {doc.uploadedByName === null ? '' : ` · ${doc.uploadedByName}`}
                        </span>
                      )}
                    </span>
                  </div>
                  {/* The pills every table's row actions use; thumb-sized on a phone. */}
                  <RowActions layout={isPhone ? 'card' : 'table'}>
                    {mayUploadThis && (
                      <label className="cursor-pointer text-cell text-harbour hover:underline focus-within:outline-2 focus-within:outline-harbour">
                        {uploading === doc.kind
                          ? 'Uploading…'
                          : doc.source === 'UPLOAD'
                            ? 'Replace'
                            : doc.source === 'SYSTEM'
                              ? 'Upload a copy'
                              : 'Browse and upload'}
                        <input
                          type="file"
                          className="sr-only"
                          accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                          disabled={uploading !== null}
                          aria-label={`Upload ${doc.label}`}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (file !== undefined) void upload(doc, file);
                          }}
                        />
                      </label>
                    )}
                    {doc.source === 'UPLOAD' && mayEdit && (
                      <Button variant="destructive" size="inline" onClick={() => setToRemove(doc)} disabled={uploading !== null}>
                        Remove
                      </Button>
                    )}
                  </RowActions>
                </li>
              );
            })}
          </ul>
          {error !== null && (
            <p role="alert" className="text-cell text-alert">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose} disabled={uploading !== null} className="max-sm:w-full">
              Close
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) setToRemove(null);
        }}
        title="Remove this copy?"
        message={
          toRemove === null ? '' : `The uploaded ${toRemove.label.toLowerCase()} will be taken off. It stays on the record, and anything the system holds shows again.`
        }
        confirmLabel="Remove"
        destructive
        isPending={removing}
        onConfirm={() => void remove()}
      />
    </Modal>
  );
}
