'use client';

import {
  type EgmDto,
  type MilestoneSortField,
  type ShipmentType,
  VGM_EGM_STATUS_LABEL,
  VGM_EGM_VIEW_LABEL,
  VGM_EGM_VIEWS,
  type VgmContainerDto,
  type VgmDto,
  type VgmEgmRow,
  type VgmEgmStatus,
  type VgmEgmView,
  vgmSaveSchema,
} from '@ff/shared';
import { type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { amount } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

const FEATURE = 'OPERATION.VGM_EGM';
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.doc,.docx';
const FILE_INPUT =
  'text-body text-hull file:mr-3 file:rounded-manifest file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-body file:text-hull';

/**
 * Operation → Upload VGM & EGM — the client's `VGM` sheet, titled "VGM & EGM"
 * (docs/DESIGN-UPDATE-2026-10-28.md §2). Outbound only. A sea booking lists
 * each finalised container on its own line, each with its own VGM; the EGM
 * copies belong to the booking's bill.
 */
export function VgmEgmScreen() {
  const [mode, setMode] = useState<ShipmentType>('SEA');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Upload VGM & EGM"
        description="Outbound shipments only. Record each container's VGM with its declaration, and upload the EGM copies filed against the bill."
      />
      {/* Keyed by mode: each mode is its own list, with its own columns and page. */}
      <VgmEgmList key={mode} mode={mode} onMode={setMode} />
    </div>
  );
}

const TONE: Record<VgmEgmStatus, 'active' | 'pending'> = { PENDING: 'pending', UPLOADED: 'active' };

/** One line per container, the height of a status line, so the columns stay level. */
function ContainerLines({ row, render }: { row: VgmEgmRow; render: (c: VgmContainerDto) => ReactNode }) {
  if (row.vgmContainers.length === 0) return <span className="text-steel">—</span>;
  return (
    <div className="flex flex-col gap-1 py-1">
      {row.vgmContainers.map((c) => (
        <div key={c.clpId} className="flex h-6 items-center whitespace-nowrap">
          {render(c)}
        </div>
      ))}
    </div>
  );
}

function VgmEgmList({ mode, onMode }: { mode: ShipmentType; onMode: (m: ShipmentType) => void }) {
  const { can } = useSession();
  const isAir = mode === 'AIR';
  const list = useMasterList<VgmEgmRow, MilestoneSortField>(`/api/tenant/ops/vgm-egm?shipmentType=${mode}`, 'date');
  const view = (list.filters.view ?? 'PENDING') as VgmEgmView;
  const mayRecord = can(`${FEATURE}.CREATE`);
  const mayChange = can(`${FEATURE}.EDIT`);
  const [recording, setRecording] = useState<{ row: VgmEgmRow; container: VgmContainerDto } | null>(null);
  const [egmOf, setEgmOf] = useState<VgmEgmRow | null>(null);

  const columns: DataTableColumn<VgmEgmRow>[] = useMemo(() => {
    const cols: DataTableColumn<VgmEgmRow>[] = [
      { id: 'so', header: 'S/O No', cell: (r) => <span className="whitespace-nowrap font-mono tabular-nums">{r.soCode ?? '—'}</span> },
      { id: 'customer', header: 'Customer', sortable: true, cell: (r) => r.customerName },
      { id: 'exporter', header: 'Exporter', cell: (r) => r.exporterName ?? '—' },
      { id: 'commodity', header: 'Commodity', cell: (r) => <span className="line-clamp-2 max-w-48">{r.commodity ?? '—'}</span> },
      { id: 'type', header: 'Shipment Type', cell: (r) => (r.shipmentType === 'AIR' ? 'Air' : 'Sea') },
      { id: 'pol', header: isAir ? 'AOL' : 'POL', cell: (r) => <span title={r.polCode}>{r.polName}</span> },
      { id: 'pod', header: isAir ? 'AOD' : 'POD', cell: (r) => <span title={r.podCode}>{r.podName}</span> },
    ];
    if (!isAir) {
      cols.push({
        id: 'container',
        header: 'Container no',
        cell: (r) => <ContainerLines row={r} render={(c) => <span className="font-mono tabular-nums">{c.containerNo ?? '—'}</span>} />,
      });
    }
    cols.push({ id: 'carrier', header: isAir ? 'Airline' : 'Carrier', cell: (r) => r.carrierName });
    if (!isAir) {
      cols.push(
        {
          id: 'clp',
          header: 'CLP No',
          cell: (r) => <ContainerLines row={r} render={(c) => <span className="font-mono tabular-nums">{c.clpCode}</span>} />,
        },
        {
          id: 'vgm',
          header: 'VGM Status',
          cell: (r) =>
            r.vgmContainers.length === 0 ? (
              <span className="text-cell text-steel">No finalised CLP yet</span>
            ) : (
              <ContainerLines
                row={r}
                render={(c) => {
                  const done = c.vgm?.uploaded === true;
                  const allowed = c.vgm === null ? mayRecord : mayChange;
                  return (
                    <span className="flex items-center gap-3">
                      <Status tone={done ? 'active' : 'pending'}>{done ? 'Uploaded' : 'Pending'}</Status>
                      {allowed && (
                        <Button variant="text" size="inline" onClick={() => setRecording({ row: r, container: c })}>
                          {c.vgm === null ? 'Record VGM' : 'Change VGM'}
                        </Button>
                      )}
                    </span>
                  );
                }}
              />
            ),
        },
      );
    }
    cols.push({
      id: 'egm',
      header: 'EGM Status',
      cell: (r) =>
        r.egm === null ? (
          <span className="text-cell text-steel">No shipment advise yet</span>
        ) : (
          <div className="flex flex-col">
            <Status tone={TONE[r.egmStatus]}>{VGM_EGM_STATUS_LABEL[r.egmStatus]}</Status>
            {r.egm.files.length > 0 && (
              <span className="text-cell text-steel">
                <span className="font-mono tabular-nums">{r.egm.files.length}</span> {r.egm.files.length === 1 ? 'copy' : 'copies'}
              </span>
            )}
          </div>
        ),
    });
    return cols;
  }, [isAir, mayChange, mayRecord]);

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
          options={VGM_EGM_VIEWS.map((v) => [v, VGM_EGM_VIEW_LABEL[v]] as const)}
          onChange={(v) => list.setFilter('view', v === 'PENDING' ? '' : v)}
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
          row.egm === null ? null : (
            <Button variant="text" size="inline" onClick={() => setEgmOf(row)}>
              {row.egmStatus === 'UPLOADED' ? 'EGM copies' : 'Upload EGM'}
            </Button>
          )
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
              title={isAir ? 'No outbound air bookings waiting on an EGM' : 'No outbound sea bookings waiting on a VGM or EGM'}
              description={
                isAir
                  ? 'An outbound air booking appears here once its schedule is approved. Upload the EGM once the airline files it.'
                  : 'An outbound sea booking appears here once its schedule is approved. Record each container’s VGM when its CLP is finalised.'
              }
            />
          )
        }
      />

      {recording !== null && (
        <VgmModal
          row={recording.row}
          container={recording.container}
          onClose={() => setRecording(null)}
          onSaved={() => {
            setRecording(null);
            void list.reload();
          }}
        />
      )}
      {egmOf !== null && egmOf.egm !== null && (
        <EgmModal
          row={egmOf}
          egm={egmOf.egm}
          mayAdd={mayRecord}
          mayRemove={mayChange}
          onClose={() => {
            setEgmOf(null);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

type VgmErrors = Partial<Record<'carrierBookingNo' | 'vgmKg' | 'grossWeightKg' | 'signatoryName', string>>;

/** The VGM panel (B12–F24): Carrier Booking No · Container no · VGM · Gross Weight · Name · Upload VGM file. */
function VgmModal({
  row,
  container,
  onClose,
  onSaved,
}: {
  row: VgmEgmRow;
  container: VgmContainerDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authorizedRequest, authorizedUpload, authorizedDownload } = useSession();
  const existing = container.vgm;
  // A booking's containers usually travel on one carrier booking: open on the one already given.
  const sibling = row.vgmContainers.find((c) => c.vgm !== null)?.vgm?.carrierBookingNo ?? '';
  const [carrierBookingNo, setCarrierBookingNo] = useState(existing?.carrierBookingNo ?? sibling);
  const [vgmKg, setVgmKg] = useState(existing?.vgmKg ?? '');
  const [grossWeightKg, setGrossWeightKg] = useState(existing?.grossWeightKg ?? container.cargoGrossWeightKg ?? '');
  const [signatoryName, setSignatoryName] = useState(existing?.signatoryName ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<VgmErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(): Promise<void> {
    const parsed = vgmSaveSchema.safeParse({ carrierBookingNo, vgmKg, grossWeightKg, signatoryName });
    if (!parsed.success) {
      const next: VgmErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof VgmErrors | undefined;
        if (key !== undefined && next[key] === undefined) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setFormError(null);
    setPending(true);
    const fields: Record<string, string> = {
      carrierBookingNo: parsed.data.carrierBookingNo,
      vgmKg: parsed.data.vgmKg,
      signatoryName: parsed.data.signatoryName,
      ...(parsed.data.grossWeightKg === undefined ? {} : { grossWeightKg: parsed.data.grossWeightKg }),
    };
    try {
      const path = `/api/tenant/ops/vgm/${container.clpId}`;
      const saved =
        file === null
          ? await authorizedRequest<VgmDto>(path, { method: 'POST', body: fields })
          : await authorizedUpload<VgmDto>(path, file, fields);
      toast.success(
        `${container.containerNo ?? container.clpCode}: ${saved.uploaded ? 'VGM uploaded' : 'VGM saved — upload the file to mark it uploaded'}`,
      );
      onSaved();
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not save the VGM. Please try again.');
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
      title={`VGM — ${container.containerNo ?? container.clpCode}`}
      description={`${row.bookingCode} · ${container.clpCode} · ${container.size}${container.sealNo === null ? '' : ` · seal ${container.sealNo}`}`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="vgm-booking" label="Carrier Booking No" required error={errors.carrierBookingNo}>
          <Input id="vgm-booking" numeric value={carrierBookingNo} maxLength={64} onChange={(e) => setCarrierBookingNo(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field
            id="vgm-kg"
            label="VGM (kg)"
            required
            error={errors.vgmKg}
            hint="The packed container: cargo, packing and tare together."
          >
            <Input id="vgm-kg" numeric inputMode="decimal" className="text-right" value={vgmKg} onChange={(e) => setVgmKg(e.target.value)} />
          </Field>
          <Field
            id="vgm-gross"
            label="Gross Weight (kg)"
            error={errors.grossWeightKg}
            hint={container.cargoGrossWeightKg === null ? 'The cargo alone.' : `The CLP says ${amount(container.cargoGrossWeightKg, 3)} kg.`}
          >
            <Input
              id="vgm-gross"
              numeric
              inputMode="decimal"
              className="text-right"
              value={grossWeightKg}
              onChange={(e) => setGrossWeightKg(e.target.value)}
            />
          </Field>
        </div>
        <Field id="vgm-name" label="Name" required error={errors.signatoryName} hint="The person who signs the VGM declaration.">
          <Input id="vgm-name" value={signatoryName} maxLength={200} onChange={(e) => setSignatoryName(e.target.value)} />
        </Field>
        <Field
          id="vgm-file"
          label="VGM file"
          hint={
            existing?.fileName == null
              ? 'PDF, JPG, PNG or Word. Until it is uploaded the container stays Pending.'
              : `Uploaded: ${existing.fileName}. Choose another file to replace it.`
          }
        >
          <input id="vgm-file" type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className={FILE_INPUT} />
        </Field>
        {existing?.fileName != null && (
          <button
            type="button"
            className="self-start text-cell text-harbour hover:underline"
            onClick={() =>
              void authorizedDownload(`/api/tenant/ops/vgm/${container.clpId}/file`, existing.fileName ?? 'vgm').catch(() =>
                toast.error('Could not download the VGM file.'),
              )
            }
          >
            Download {existing.fileName}
          </button>
        )}
        {formError !== null && (
          <p role="alert" className="text-cell text-alert">
            {formError}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Close
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save VGM'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** The EGM panel (H12–M24): BL Number · MBL Number · carrier, and the copies — "Multiple file can be uploaded". */
function EgmModal({
  row,
  egm: initial,
  mayAdd,
  mayRemove,
  onClose,
}: {
  row: VgmEgmRow;
  egm: EgmDto;
  mayAdd: boolean;
  mayRemove: boolean;
  onClose: () => void;
}) {
  const { authorizedRequest, authorizedUpload, authorizedDownload } = useSession();
  const [egm, setEgm] = useState(initial);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [toRemove, setToRemove] = useState<EgmDto['files'][number] | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/tenant/ops/egm/${egm.adviseId}/files`;

  async function upload(files: File[]): Promise<void> {
    setError(null);
    let done = 0;
    setProgress({ done, of: files.length });
    try {
      for (const file of files) {
        setEgm(await authorizedUpload<EgmDto>(base, file));
        done += 1;
        setProgress({ done, of: files.length });
      }
      toast.success(files.length === 1 ? 'EGM copy uploaded' : `${files.length} EGM copies uploaded`);
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : 'Could not upload that file.';
      setError(done === 0 ? message : `${done} of ${files.length} uploaded. ${message}`);
    } finally {
      setProgress(null);
    }
  }

  async function remove(): Promise<void> {
    if (toRemove === null) return;
    setRemoving(true);
    try {
      setEgm(await authorizedRequest<EgmDto>(`${base}/${toRemove.id}`, { method: 'DELETE' }));
      toast.success('Removed');
      setToRemove(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not remove that copy.');
    } finally {
      setRemoving(false);
    }
  }

  const isAir = row.shipmentType === 'AIR';
  const facts: [string, string | null][] = [
    [isAir ? 'HAWB Number' : 'BL Number', egm.houseBlNo],
    [isAir ? 'MAWB Number' : 'MBL Number', egm.mblNo],
    [isAir ? 'Airline' : 'Carrier', egm.carrierName],
  ];

  return (
    <Modal
      open
      size="medium"
      onOpenChange={(open) => {
        if (!open && progress === null) onClose();
      }}
      title={`EGM — ${row.bookingCode}`}
      description={`Filed against ${egm.adviseCode}. Every booking on this advise shares these copies.`}
    >
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-3 gap-4">
          {facts.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1">
              <dt className="label-manifest">{label}</dt>
              <dd className="font-mono text-body tabular-nums text-hull">
                {value ?? <span className="font-sans text-cell text-steel">Not on the advise yet</span>}
              </dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-col gap-2">
          <span className="label-manifest">EGM copies</span>
          {egm.files.length === 0 ? (
            <p className="text-cell text-steel">No copies yet. Upload the EGM as the carrier filed it; several files are fine.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-manifest border border-line">
              {egm.files.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <button
                    type="button"
                    className="truncate text-left text-body text-harbour hover:underline"
                    title={f.fileName}
                    onClick={() => void authorizedDownload(`${base}/${f.id}`, f.fileName).catch(() => toast.error('Could not download that copy.'))}
                  >
                    {f.fileName}
                  </button>
                  <span className="flex shrink-0 items-center gap-3 text-cell text-steel">
                    <span className="font-mono tabular-nums">{f.uploadedAt.slice(0, 10)}</span>
                    {f.uploadedByName}
                    {mayRemove && (
                      <Button variant="destructive" size="inline" onClick={() => setToRemove(f)}>
                        Remove
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {mayAdd && (
          <Field id="egm-files" label="Upload EGM copy" hint="PDF, JPG, PNG or Word. Choose several files at once if the EGM came in parts.">
            <input
              id="egm-files"
              type="file"
              multiple
              accept={ACCEPT}
              disabled={progress !== null}
              className={FILE_INPUT}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length > 0) void upload(files);
              }}
            />
          </Field>
        )}
        {progress !== null && (
          <p className="text-cell text-steel" aria-live="polite">
            Uploading <span className="font-mono tabular-nums">{progress.done + 1}</span> of{' '}
            <span className="font-mono tabular-nums">{progress.of}</span>…
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose} disabled={progress !== null}>
            Close
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) setToRemove(null);
        }}
        title="Remove this EGM copy?"
        message={toRemove === null ? '' : `${toRemove.fileName} will be taken off the EGM. It stays on the record.`}
        confirmLabel="Remove"
        destructive
        isPending={removing}
        onConfirm={() => void remove()}
      />
    </Modal>
  );
}
