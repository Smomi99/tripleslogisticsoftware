'use client';

import {
  BUSINESS_AREA_LABEL,
  BUSINESS_AREAS,
  CUSTOMER_TYPE_LABEL,
  CUSTOMER_TYPES,
  type CustomerActivityLogDto,
  type LocalSalesRow,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { ActiveStatus } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Sales & Marketing → Local Sales — the client's `Local Sales` sheet
 * (docs/DESIGN-UPDATE-2026-10-04.md §6): every customer with its volumes and
 * opening balance, and the Activity Log the sales team keeps against each.
 */

const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour';

/** "12.5000" -> "12.5"; a column of volumes reads as numbers, not as storage. */
function volume(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : value;
}

function money(value: string | null): string | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value;
}

export default function LocalSalesPage() {
  const { can } = useSession();
  const list = useMasterList<LocalSalesRow, 'name' | 'country'>('/api/tenant/sales/local-sales', 'name');
  const [logFor, setLogFor] = useState<LocalSalesRow | null>(null);
  const mayEditCustomer = can('CRM.CUSTOMER.EDIT');
  const mayOpenPics = can('CRM.CUSTOMER.VIEW');

  const columns: DataTableColumn<LocalSalesRow>[] = useMemo(
    () => [
      { id: 'name', header: 'Customer Name', sortable: true, cell: (r) => r.name },
      { id: 'country', header: 'Country', sortable: true, cell: (r) => r.country },
      {
        id: 'address',
        header: 'Address',
        cell: (r) => (
          <span className="block max-w-56 truncate" title={r.address ?? undefined}>
            {r.address ?? '—'}
          </span>
        ),
      },
      { id: 'type', header: 'Customer Type', cell: (r) => CUSTOMER_TYPE_LABEL[r.customerType] },
      { id: 'category', header: 'Commodity Category', cell: (r) => r.commodityCategory },
      { id: 'area', header: 'Business Area', cell: (r) => BUSINESS_AREA_LABEL[r.businessArea] },
      { id: 'exSea', header: 'Ex-Sea TEU/Month', numeric: true, cell: (r) => volume(r.exSeaVolumeTeuMonth) },
      { id: 'exAir', header: 'Ex-Air KG/Month', numeric: true, cell: (r) => volume(r.exAirVolumeKgMonth) },
      { id: 'imSea', header: 'Im-Sea TEU/Month', numeric: true, cell: (r) => volume(r.imSeaVolumeTeuMonth) },
      { id: 'imAir', header: 'Im-Air KG/Month', numeric: true, cell: (r) => volume(r.imAirVolumeKgMonth) },
      {
        id: 'opening',
        header: 'Opening Balance',
        align: 'right',
        cell: (r) => {
          const owe = money(r.customerOwe);
          const we = money(r.weOwe);
          if (owe === null && we === null) return <span className="text-steel">—</span>;
          return (
            <div className="flex flex-col items-end font-mono tabular-nums">
              {owe !== null && (
                <span title="Customer owe (Cr)">
                  {r.openingCurrency} {owe} <span className="text-steel">owes us</span>
                </span>
              )}
              {we !== null && (
                <span title="We owe (Dr)">
                  {r.openingCurrency} {we} <span className="text-steel">we owe</span>
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: 'activity',
        header: 'Activity',
        cell: (r) =>
          r.activityCount === 0 ? (
            <span className="text-steel">None yet</span>
          ) : (
            <div className="flex flex-col">
              <span>
                {r.activityCount} · last <span className="font-mono tabular-nums">{r.lastActivityAt?.slice(0, 10)}</span>
              </span>
              {r.nextFollowupDate !== null && (
                <span className="text-cell text-signal">
                  Follow up <span className="font-mono tabular-nums">{r.nextFollowupDate}</span>
                </span>
              )}
            </div>
          ),
      },
      { id: 'status', header: 'Status', cell: (r) => <ActiveStatus isActive={r.isActive} /> },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Local Sales"
        description="Every customer, with their volumes and opening balance, and the meetings and calls the sales team records against them."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-72 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search customers"
            placeholder="Name, code, country or category"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-40 flex-col gap-1">
          <span className="label-manifest">Customer type</span>
          <Select aria-label="Customer type" value={list.filters.customerType ?? ''} onChange={(e) => list.setFilter('customerType', e.target.value)}>
            <option value="">Every type</option>
            {CUSTOMER_TYPES.map((t) => (
              <option key={t} value={t}>
                {CUSTOMER_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-40 flex-col gap-1">
          <span className="label-manifest">Business area</span>
          <Select aria-label="Business area" value={list.filters.businessArea ?? ''} onChange={(e) => list.setFilter('businessArea', e.target.value)}>
            <option value="">Every area</option>
            {BUSINESS_AREAS.map((a) => (
              <option key={a} value={a}>
                {BUSINESS_AREA_LABEL[a]}
              </option>
            ))}
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
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as 'name' | 'country', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            <Button variant="text" size="inline" onClick={() => setLogFor(row)}>
              Activity log
            </Button>
            {mayEditCustomer && (
              <Link href={`/crm/customer/${row.id}/edit` as Route} className="text-body text-harbour hover:underline">
                Edit
              </Link>
            )}
            {mayOpenPics && (
              <Link href={`/crm/customer/${row.id}/pic` as Route} className="text-body text-harbour hover:underline">
                PIC
              </Link>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No customers match those filters"
              description="Try a different term, or clear the filters."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState title="No customers yet" description="Customers are added under CRM → Customer, and appear here for the sales team." />
          )
        }
      />

      {logFor !== null && (
        <ActivityLog
          row={logFor}
          onClose={() => setLogFor(null)}
          onRecorded={() => void list.reload()}
        />
      )}
    </div>
  );
}

function nowLocal(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function ActivityLog({ row, onClose, onRecorded }: { row: LocalSalesRow; onClose: () => void; onRecorded: () => void }) {
  const { authorizedRequest, can } = useSession();
  const mayRecord = can('SALES.LOCAL_SALES.CREATE');
  const base = `/api/tenant/sales/local-sales/${row.id}/activities`;
  const [log, setLog] = useState<CustomerActivityLogDto | null>(null);
  const [activityAt, setActivityAt] = useState(nowLocal());
  const [picId, setPicId] = useState('');
  const [summary, setSummary] = useState('');
  const [nextDate, setNextDate] = useState('');
  const [competitors, setCompetitors] = useState('');
  const [possibility, setPossibility] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<CustomerActivityLogDto>(base)
      .then((data) => {
        if (live) setLog(data);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not open the log.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, base]);

  async function record(): Promise<void> {
    if (summary.trim() === '') return setError('Write what the meeting was about.');
    setPending(true);
    setError(null);
    try {
      const data = await authorizedRequest<CustomerActivityLogDto>(base, {
        method: 'POST',
        body: {
          // datetime-local has no zone; the browser's own is the operator's.
          activityAt: new Date(activityAt).toISOString(),
          customerPicId: picId,
          meetingSummary: summary,
          nextFollowupDate: nextDate,
          competitorAnalysis: competitors,
          businessPossibility: possibility,
        },
      });
      setLog(data);
      setSummary('');
      setNextDate('');
      setCompetitors('');
      setPossibility('');
      setActivityAt(nowLocal());
      toast.success('Recorded');
      onRecorded();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record it.');
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
      title={`Activity log — ${row.name}`}
      description="Meetings and calls with this customer, newest first."
    >
      <div className="flex flex-col gap-5">
        {mayRecord && (
          <form
            className="grid grid-cols-1 gap-3 rounded-manifest border border-line p-3 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void record();
            }}
          >
            <Field id="act-at" label="Date & time" required>
              <Input id="act-at" type="datetime-local" numeric value={activityAt} onChange={(e) => setActivityAt(e.target.value)} />
            </Field>
            <Field id="act-pic" label="PIC">
              <Select id="act-pic" value={picId} onChange={(e) => setPicId(e.target.value)}>
                <option value="">Not recorded</option>
                {log?.pics.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="act-summary" label="Meeting summary" required wide>
              <textarea id="act-summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} className={TEXTAREA} />
            </Field>
            <Field id="act-competitors" label="Competitors analysis">
              <textarea id="act-competitors" rows={2} value={competitors} onChange={(e) => setCompetitors(e.target.value)} className={TEXTAREA} />
            </Field>
            <Field id="act-possibility" label="Business possibility">
              <textarea id="act-possibility" rows={2} value={possibility} onChange={(e) => setPossibility(e.target.value)} className={TEXTAREA} />
            </Field>
            <Field id="act-next" label="Next follow-up date">
              <Input id="act-next" type="date" numeric value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
            </Field>
            <div className="flex items-end justify-end">
              <Button type="submit" disabled={pending || log === null}>
                {pending ? 'Recording…' : 'Record'}
              </Button>
            </div>
            {error !== null && (
              <p role="alert" className="text-cell text-alert md:col-span-2">
                {error}
              </p>
            )}
          </form>
        )}

        {log === null ? (
          <p className="text-body text-steel">{error ?? 'Loading…'}</p>
        ) : log.activities.length === 0 ? (
          <p className="text-body text-steel">Nothing recorded yet. Record the first meeting or call above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-cell">
              <thead>
                <tr className="border-b border-line bg-paper text-left">
                  {['Date & time', 'PIC', 'Meeting summary', 'Next follow-up', 'Competitors', 'Possibility', 'By'].map((h) => (
                    <th key={h} className="label-manifest px-2 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {log.activities.map((a) => (
                  <tr key={a.id} className="border-b border-line align-top">
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono tabular-nums">
                      {new Date(a.activityAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td className="px-2 py-1.5">{a.picName ?? '—'}</td>
                    <td className="whitespace-pre-line px-2 py-1.5">{a.meetingSummary}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono tabular-nums">{a.nextFollowupDate ?? '—'}</td>
                    <td className="whitespace-pre-line px-2 py-1.5">{a.competitorAnalysis ?? '—'}</td>
                    <td className="whitespace-pre-line px-2 py-1.5">{a.businessPossibility ?? '—'}</td>
                    <td className="px-2 py-1.5 text-steel">{a.recordedBy ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
