'use client';

import {
  BUSINESS_MATRIX_SORT_FIELDS,
  type BusinessMatrixSortField,
  TRADE_LANE_DIRECTION_LABEL,
  TRADE_LANE_DIRECTIONS,
  TRADE_LANE_SIDES,
  type TradeLaneDirection,
  type TradeLaneDto,
} from '@ff/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { amount } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { ActiveStatus } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';
import { cn } from '@/lib/utils';

import { TradeLaneForm } from './trade-lane-form';

const FEATURE = 'SALES.BUSINESS_MATRIX';

const STATUS_OPTIONS = [
  ['', 'All'],
  ['true', 'Active'],
  ['false', 'Inactive'],
] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number][0];

const SORT_LABEL: Record<BusinessMatrixSortField, string> = { name: 'Name', code: 'Code' };

/**
 * Sales & Marketing → Business Matrix — the client's `Business Matrix` sheet
 * (docs/DESIGN-UPDATE-2026-10-28.md §1). Its two sections, OUTBOUND SHIPMENT
 * and INBOUND SHIPMENT, are the switch at the top; each trade lane is one
 * table of port pairs with the four counted columns.
 */
export default function Page() {
  const { can } = useSession();
  const [direction, setDirection] = useState<TradeLaneDirection>('OUTBOUND');
  const [adding, setAdding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Business Matrix"
        description="Inquiries, quotations, shipped TEUs and revenue for each trade lane, port pair by port pair."
        action={
          can(`${FEATURE}.CREATE`) ? <Button onClick={() => setAdding(true)}>+ Add trade lane</Button> : undefined
        }
      />
      {/* Keyed by direction: each section is its own list, with its own page. */}
      <LaneList key={`${direction}-${reloadKey}`} direction={direction} onDirection={setDirection} />
      {adding && (
        <TradeLaneForm
          lane={null}
          direction={direction}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            setDirection(saved.movementType);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function LaneList({ direction, onDirection }: { direction: TradeLaneDirection; onDirection: (d: TradeLaneDirection) => void }) {
  const { can, authorizedRequest } = useSession();
  const list = useMasterList<TradeLaneDto, BusinessMatrixSortField>(
    `/api/tenant/sales/business-matrix?movementType=${direction}`,
    'name',
  );
  const [editing, setEditing] = useState<TradeLaneDto | null>(null);
  const [toToggle, setToToggle] = useState<TradeLaneDto | null>(null);
  const [isToggling, setToggling] = useState(false);

  const { page, limit, total } = list.meta;
  const totalPages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`/api/tenant/sales/business-matrix/${toToggle.id}/toggle-status`, { method: 'POST' });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      void list.reload();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Segmented
          label="Which section"
          value={direction}
          options={TRADE_LANE_DIRECTIONS.map((d) => [d, TRADE_LANE_DIRECTION_LABEL[d]] as const)}
          onChange={onDirection}
        />
        <div className="flex w-64 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search trade lanes"
            placeholder="Lane name, code or port"
            value={list.searchInput}
            onChange={(e) => list.setSearchInput(e.target.value)}
          />
        </div>
        {/* §6 Q1: the sheet has no period. Empty is all time; each figure is dated by its own record. */}
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor="matrix-from" className="label-manifest">
            From
          </label>
          <Input
            id="matrix-from"
            type="date"
            numeric
            value={list.filters.from ?? ''}
            onChange={(e) => list.setFilter('from', e.target.value)}
          />
        </div>
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor="matrix-to" className="label-manifest">
            To
          </label>
          <Input id="matrix-to" type="date" numeric value={list.filters.to ?? ''} onChange={(e) => list.setFilter('to', e.target.value)} />
        </div>
        <Segmented
          label="Status"
          value={(list.filters.isActive ?? '') as StatusFilter}
          options={STATUS_OPTIONS}
          onChange={(v) => list.setFilter('isActive', v)}
        />
        <div className="flex w-36 flex-col gap-1">
          <label htmlFor="matrix-sort" className="label-manifest">
            Sort by
          </label>
          <Select
            id="matrix-sort"
            value={list.sortBy}
            onChange={(e) => list.setSort(e.target.value as BusinessMatrixSortField, list.sortOrder)}
          >
            {BUSINESS_MATRIX_SORT_FIELDS.map((f) => (
              <option key={f} value={f}>
                {SORT_LABEL[f]}
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

      {list.rows.length === 0 && !list.isPending ? (
        <div className="rounded-manifest border border-line bg-surface shadow-manifest">
          {list.hasFilters ? (
            <EmptyState
              title="No trade lanes match"
              description="Try a different term or period, or clear the filters to see every lane."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={`No ${direction === 'OUTBOUND' ? 'outbound' : 'inbound'} trade lanes yet`}
              description={
                direction === 'OUTBOUND'
                  ? 'Add a lane, one POL to the PODs it serves, to see its inquiries, quotations, TEUs and revenue port by port.'
                  : 'Add a lane, the POLs that feed one POD, to see its inquiries, quotations, TEUs and revenue port by port.'
              }
            />
          )}
        </div>
      ) : (
        <div className={cn('flex flex-col gap-4', list.isPending && 'opacity-60')} aria-busy={list.isPending}>
          {list.rows.map((lane) => (
            <LaneTable
              key={lane.id}
              lane={lane}
              onEdit={can(`${FEATURE}.EDIT`) ? () => setEditing(lane) : undefined}
              onToggle={can(`${FEATURE}.TOGGLE_STATUS`) ? () => setToToggle(lane) : undefined}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-cell text-steel">
          <span>
            Lanes <span className="font-mono tabular-nums">{(page - 1) * limit + 1}</span>–
            <span className="font-mono tabular-nums">{Math.min(page * limit, total)}</span> of{' '}
            <span className="font-mono tabular-nums">{total}</span>
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="compact" disabled={page <= 1} onClick={() => list.setPage(page - 1)}>
              Previous
            </Button>
            <Button variant="secondary" size="compact" disabled={page >= totalPages} onClick={() => list.setPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      {editing !== null && (
        <TradeLaneForm
          lane={editing}
          direction={direction}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this trade lane?' : 'Activate this trade lane?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will be kept but marked inactive, and its port pairs can go on another lane.`
              : `${toToggle.name} will be active again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </>
  );
}

/** One lane: C8 "Trade Lane Name : …" and its table (row 9). */
function LaneTable({ lane, onEdit, onToggle }: { lane: TradeLaneDto; onEdit?: (() => void) | undefined; onToggle?: (() => void) | undefined }) {
  const single = TRADE_LANE_SIDES[lane.movementType].single;
  const head = 'label-manifest border-b border-line px-3 py-2';
  const numberCell = 'px-3 text-right font-mono tabular-nums';

  return (
    <section className="rounded-manifest border border-line bg-surface shadow-manifest" aria-label={`Trade lane ${lane.name}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-section text-hull">
            <span className="text-steel">Trade lane:</span> {lane.name}
          </h2>
          <span className="font-mono text-cell tabular-nums text-steel">{lane.code}</span>
          <ActiveStatus isActive={lane.isActive} />
        </div>
        <div className="flex items-center gap-4">
          {onEdit !== undefined && (
            <Button variant="text" size="inline" onClick={onEdit}>
              Edit
            </Button>
          )}
          {onToggle !== undefined && (
            <Button variant={lane.isActive ? 'destructive' : 'text'} size="inline" onClick={onToggle}>
              {lane.isActive ? 'Deactivate' : 'Activate'}
            </Button>
          )}
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-cell">
          <thead>
            <tr className="bg-paper">
              <th scope="col" className={cn(head, 'text-left')}>
                POL
              </th>
              <th scope="col" className={cn(head, 'text-left')}>
                POD
              </th>
              <th scope="col" className={cn(head, 'text-right')}>
                Inquiry Received
              </th>
              <th scope="col" className={cn(head, 'text-right')}>
                No of Quotation
              </th>
              <th scope="col" className={cn(head, 'text-right')}>
                Shipment Volume (TEUs)
              </th>
              <th scope="col" className={cn(head, 'text-right')}>
                Total Revenue{lane.revenueCurrency === '' ? '' : ` (${lane.revenueCurrency})`}
              </th>
            </tr>
          </thead>
          <tbody>
            {lane.rows.map((row, index) => {
              // The single side is written once, on the first row, as the sheet does (C10, D30).
              const portCell = (port: typeof row.pol, isSingle: boolean) =>
                isSingle && index > 0 ? null : (
                  <span title={`${port.name} (${port.portCode}), ${port.country}`}>
                    {port.name} <span className="font-mono tabular-nums text-steel">{port.portCode}</span>
                  </span>
                );
              return (
                <tr key={`${row.pol.id}-${row.pod.id}`} className="h-9 border-b border-line last:border-b-0 hover:bg-row-hover">
                  <td className={cn('px-3', single === 'POL' && index === 0 && 'font-semibold')}>{portCell(row.pol, single === 'POL')}</td>
                  <td className={cn('px-3', single === 'POD' && index === 0 && 'font-semibold')}>{portCell(row.pod, single === 'POD')}</td>
                  <td className={numberCell}>{row.inquiries}</td>
                  <td className={numberCell}>{row.quotations}</td>
                  <td className={numberCell} title={row.teus === null ? 'An air lane has no containers.' : undefined}>
                    {row.teus === null ? '—' : amount(row.teus)}
                  </td>
                  <td className={numberCell}>{amount(row.revenue)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Spoken once, so a screen reader knows which port the blank cells repeat. */}
      <p className="sr-only">
        Every row runs {single === 'POL' ? 'from' : 'to'}{' '}
        {lane.port.name}.
      </p>
    </section>
  );
}
