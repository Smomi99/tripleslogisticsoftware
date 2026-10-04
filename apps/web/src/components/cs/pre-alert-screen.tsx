'use client';

import {
  PRE_ALERT_DOCUMENT_LABEL,
  PRE_ALERT_VIEW_LABEL,
  PRE_ALERT_VIEWS,
  type MilestoneSortField,
  type PreAlertDetailDto,
  type PreAlertDocumentKind,
  type PreAlertRow,
  type PreAlertView,
  type ShipmentType,
} from '@ff/shared';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { bookingColumns } from '@/components/cs/milestone-screen';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Customer Service → Pre-Alert — the client's `Pre Alert-Sea` sheet
 * (docs/DESIGN-UPDATE-2026-10-04.md §3). The On board row for outbound
 * bookings, with the sheet's Status, and `Send`: Select Documents, Select
 * Agent, Email ID.
 */
export function PreAlertScreen() {
  const [mode, setMode] = useState<ShipmentType>('SEA');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Pre-Alert"
        description="Outbound shipments. Send the destination agent the shipment's documents. The letter goes from the Sales Team's address."
      />
      <PreAlertList key={mode} mode={mode} onMode={setMode} />
    </div>
  );
}

function PreAlertList({ mode, onMode }: { mode: ShipmentType; onMode: (m: ShipmentType) => void }) {
  const { can } = useSession();
  const isAir = mode === 'AIR';
  const list = useMasterList<PreAlertRow, MilestoneSortField>(`/api/tenant/cs/pre-alerts?shipmentType=${mode}`, 'date');
  const view = (list.filters.view ?? 'AWAITING') as PreAlertView;
  const maySend = can('CUSTOMER_SERVICE.PRE_ALERT.SEND');
  const [sending, setSending] = useState<PreAlertRow | null>(null);

  const columns: DataTableColumn<PreAlertRow>[] = useMemo(
    () => [
      ...bookingColumns<PreAlertRow>('DEPARTED', isAir),
      {
        id: 'status',
        header: 'Status',
        cell: (r) =>
          r.lastSent === null ? (
            <Status tone="pending">Awaiting</Status>
          ) : (
            <div className="flex flex-col">
              <Status tone="active">
                Sent <span className="font-mono tabular-nums">{r.lastSent.sentAt.slice(0, 10)}</span>
              </Status>
              <span className="text-cell text-steel">
                {r.lastSent.agentName}
                {r.sentCount > 1 ? ` · ${r.sentCount} times` : ''}
              </span>
            </div>
          ),
      },
    ],
    [isAir],
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
          options={PRE_ALERT_VIEWS.map((v) => [v, PRE_ALERT_VIEW_LABEL[v]] as const)}
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
          maySend ? (
            <button type="button" className="text-body text-harbour hover:underline" onClick={() => setSending(row)}>
              {row.lastSent === null ? 'Send' : 'Send again'}
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
              title="No pre-alerts waiting"
              description="An outbound booking appears here once its schedule is approved. Send its pre-alert to the destination agent once it has sailed."
            />
          )
        }
      />

      {sending !== null && (
        <SendModal
          row={sending}
          onClose={() => setSending(null)}
          onSent={() => {
            setSending(null);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function SendModal({ row, onClose, onSent }: { row: PreAlertRow; onClose: () => void; onSent: () => void }) {
  const { authorizedRequest, authorizedUpload, authorizedDownload, can } = useSession();
  const mayUpload = can('CUSTOMER_SERVICE.PRE_ALERT.EDIT');
  const base = `/api/tenant/cs/pre-alerts/${row.shipmentId}`;
  const [detail, setDetail] = useState<PreAlertDetailDto | null>(null);
  const [chosen, setChosen] = useState<Set<PreAlertDocumentKind>>(new Set());
  const [agentId, setAgentId] = useState('');
  const [emails, setEmails] = useState('');
  const [uploading, setUploading] = useState<PreAlertDocumentKind | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<PreAlertDetailDto>(base)
      .then((data) => {
        if (!live) return;
        setDetail(data);
        // Everything that can go, ticked: the usual pre-alert carries it all.
        setChosen(new Set(data.documents.filter((d) => d.source !== null).map((d) => d.kind)));
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not open the pre-alert.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, base]);

  function chooseAgent(id: string): void {
    setAgentId(id);
    const agent = detail?.agents.find((a) => a.id === id);
    if (agent !== undefined) setEmails(agent.emails.join(', '));
  }

  async function upload(kind: PreAlertDocumentKind, file: File): Promise<void> {
    setUploading(kind);
    setError(null);
    try {
      const data = await authorizedUpload<PreAlertDetailDto>(`${base}/documents`, file, { kind });
      setDetail(data);
      setChosen((prev) => new Set(prev).add(kind));
      toast.success(`${PRE_ALERT_DOCUMENT_LABEL[kind]} uploaded`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not upload that file.');
    } finally {
      setUploading(null);
    }
  }

  async function send(): Promise<void> {
    const to = emails
      .split(/[,;\s]+/)
      .map((a) => a.trim())
      .filter((a) => a !== '');
    if (agentId === '') return setError('Choose the agent.');
    if (to.length === 0) return setError('Give at least one email address.');
    if (chosen.size === 0) return setError('Choose at least one document.');
    setPending(true);
    setError(null);
    try {
      await authorizedRequest<PreAlertDetailDto>(`${base}/send`, {
        method: 'POST',
        body: { agentId, to, documents: [...chosen] },
      });
      toast.success(`Pre-alert sent for ${row.bookingCode}`);
      onSent();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send the pre-alert.');
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
      title={`Pre-alert — ${row.bookingCode}`}
      description={`${row.customerName} · ${row.polName} to ${row.podName}${row.legLabel === null ? '' : ` · ${row.legLabel}`}`}
    >
      {detail === null ? (
        <p className="text-body text-steel">{error ?? 'Loading…'}</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <fieldset className="flex flex-col gap-2">
            <legend className="label-manifest mb-1">Select documents</legend>
            {detail.documents.map((doc) => {
              const available = doc.source !== null;
              return (
                <div key={doc.kind} className="flex items-start justify-between gap-3 rounded-manifest border border-line px-3 py-2">
                  <label className="flex items-start gap-2 text-body text-hull">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-harbour"
                      disabled={!available}
                      checked={chosen.has(doc.kind)}
                      onChange={(e) =>
                        setChosen((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(doc.kind);
                          else next.delete(doc.kind);
                          return next;
                        })
                      }
                    />
                    <span>
                      {PRE_ALERT_DOCUMENT_LABEL[doc.kind]}
                      <span className="block text-cell text-steel">
                        {available ? (
                          <button
                            type="button"
                            className="text-harbour hover:underline"
                            onClick={() =>
                              void authorizedDownload(`${base}/documents/${doc.kind}`, doc.fileName ?? doc.kind).catch(() =>
                                toast.error('Could not open that document.'),
                              )
                            }
                          >
                            {doc.fileName}
                          </button>
                        ) : (
                          doc.note
                        )}
                        {available && doc.source === 'SYSTEM' && doc.note !== null ? ` — ${doc.note}` : ''}
                      </span>
                    </span>
                  </label>
                  {mayUpload && (
                    <label className="shrink-0 cursor-pointer text-cell text-harbour hover:underline">
                      {uploading === doc.kind ? 'Uploading…' : doc.source === 'UPLOAD' ? 'Replace' : 'Upload'}
                      <input
                        type="file"
                        className="sr-only"
                        accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                        disabled={uploading !== null}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file !== undefined) void upload(doc.kind, file);
                        }}
                      />
                    </label>
                  )}
                </div>
              );
            })}
          </fieldset>

          <div className="flex flex-col gap-4">
            <Field id="pre-alert-agent" label="Select agent" required>
              <Select id="pre-alert-agent" value={agentId} onChange={(e) => chooseAgent(e.target.value)}>
                <option value="">Choose the destination agent</option>
                {detail.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.country === null ? '' : ` — ${a.country}`}
                    {a.coversPod ? ` · covers ${row.podName}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="pre-alert-to" label="Email ID" required hint="Filled from the agent's contacts. Separate addresses with commas.">
              <textarea
                id="pre-alert-to"
                rows={3}
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
              />
            </Field>
            {detail.sends.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="label-manifest">Sent before</span>
                <ul className="flex flex-col gap-1 text-cell text-steel">
                  {detail.sends.map((s) => (
                    <li key={s.id}>
                      <span className="font-mono tabular-nums text-hull">{s.sentAt.slice(0, 10)}</span> to {s.agentName} —{' '}
                      {s.documents.map((k) => PRE_ALERT_DOCUMENT_LABEL[k]).join(', ')}
                      {s.emailed ? '' : ' (not emailed)'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
            <Button onClick={() => void send()} disabled={pending || uploading !== null}>
              {pending ? 'Sending…' : 'Send pre-alert'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
