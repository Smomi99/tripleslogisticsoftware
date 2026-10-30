'use client';

import {
  CONTACT_MODE_LABEL,
  LEAD_FOLLOWUP_DUE,
  LEAD_FOLLOWUP_DUE_LABEL,
  type LeadFollowupDue,
  type LookupOption,
  SALES_LEAD_STATUS_LABEL,
  type SalesLeadActivityDto,
  type SalesLeadDueDto,
  type SalesLeadFormOptions,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { LeadFollowupForm } from '@/components/sales/lead-followup-form';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { Status } from '@/components/ui/status';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Sales → Sales Lead follow up (docs/SALES_LEAD_FOB.md §5 step 05, §6, §7).
 *
 * Two views over every lead's follow-ups:
 *   - Due: the open leads by when they next need a call — overdue first, so
 *     §7's "overdue follow-ups" KPI is a list someone can work through.
 *   - Activity log: every conversation recorded, newest first, for the
 *     management review §6 asks for.
 *
 * One lead's whole history stays on its own child screen, reached from both.
 */
type View = 'due' | 'activity';
const IDS = 'lead-followup';
const linkClass = 'text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline';

export default function SalesLeadFollowupPage() {
  const { authorizedRequest } = useSession();
  const [view, setView] = useState<View>('due');
  const [owners, setOwners] = useState<LookupOption[]>([]);

  useEffect(() => {
    void authorizedRequest<SalesLeadFormOptions>('/api/tenant/sales/lead-form-options')
      .then((options) => setOwners(options.owners))
      .catch(() => setOwners([]));
  }, [authorizedRequest]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Sales Lead Follow-up"
        description="Who needs a call, and every conversation already had."
      />
      <Tabs
        label="Follow-up views"
        idBase={IDS}
        value={view}
        onChange={setView}
        tabs={[
          { id: 'due', label: 'Due' },
          { id: 'activity', label: 'Activity log' },
        ]}
      />
      <TabPanel idBase={IDS} id="due" selected={view === 'due'}>
        <DueList owners={owners} />
      </TabPanel>
      <TabPanel idBase={IDS} id="activity" selected={view === 'activity'}>
        <ActivityLog owners={owners} />
      </TabPanel>
    </div>
  );
}

function OwnerFilter({
  owners,
  value,
  onChange,
}: {
  owners: LookupOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select aria-label="Filter by salesperson" className="col-span-2 sm:w-48" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All salespeople</option>
      {owners.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </Select>
  );
}

// ---------------------------------------------------------------------- due

function DueList({ owners }: { owners: LookupOption[] }) {
  const { can } = useSession();
  const list = useMasterList<SalesLeadDueDto, 'nextFollowupDate'>(
    '/api/tenant/sales/lead-followups/due',
    'nextFollowupDate',
  );
  const [recording, setRecording] = useState<SalesLeadDueDto | null>(null);
  const due = (list.filters['due'] ?? '') as LeadFollowupDue | '';
  const counts = list.meta.counts;

  const columns: DataTableColumn<SalesLeadDueDto>[] = useMemo(
    () => [
      {
        id: 'name',
        header: 'Exporter / Factory',
        cell: (r) => (
          <>
            <div className="text-hull">{r.name}</div>
            <div className="text-steel">{r.lane ?? '—'}</div>
          </>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (r) => <Status tone="pending">{SALES_LEAD_STATUS_LABEL[r.status]}</Status>,
      },
      { id: 'owner', header: 'Salesperson', cell: (r) => r.ownerName ?? <span className="text-steel">—</span> },
      {
        id: 'last',
        header: 'Last follow-up',
        cell: (r) =>
          r.last === null ? (
            <span className="text-steel">None yet</span>
          ) : (
            <>
              <div>
                <span className="font-mono tabular-nums">{r.last.followupDate}</span>
                <span className="text-steel"> · {CONTACT_MODE_LABEL[r.last.contactMode]}</span>
              </div>
              <div className="text-steel">{r.last.outcome ?? '—'}</div>
            </>
          ),
      },
      {
        id: 'nextAction',
        header: 'Next action',
        cell: (r) => r.last?.nextAction ?? <span className="text-steel">—</span>,
      },
      {
        id: 'nextFollowupDate',
        header: 'Next follow-up',
        numeric: true,
        cell: (r) =>
          r.nextFollowupDate === null ? (
            <span className="text-steel">Not set</span>
          ) : r.due === 'OVERDUE' ? (
            <Status tone="overdue">{r.nextFollowupDate}</Status>
          ) : r.due === 'TODAY' ? (
            <Status tone="pending">{r.nextFollowupDate}</Status>
          ) : (
            r.nextFollowupDate
          ),
      },
    ],
    [],
  );

  const bucketLabel = (d: LeadFollowupDue): string =>
    counts?.[d] === undefined ? LEAD_FOLLOWUP_DUE_LABEL[d] : `${LEAD_FOLLOWUP_DUE_LABEL[d]} (${counts[d]})`;

  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="When the follow-up is due"
          value={due}
          options={[['', 'All open'], ...LEAD_FOLLOWUP_DUE.map((d) => [d, bucketLabel(d)] as const)]}
          onChange={(value) => list.setFilter('due', value)}
        />
        <Input
          type="search"
          placeholder="Search lead ID or exporter"
          aria-label="Search leads"
          value={list.searchInput}
          onChange={(e) => list.setSearchInput(e.target.value)}
          className="sm:w-64"
        />
        <OwnerFilter owners={owners} value={list.filters['ownerId'] ?? ''} onChange={(v) => list.setFilter('ownerId', v)} />
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
        codeHeader="Lead ID"
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={undefined}
        sortOrder="asc"
        onSortChange={() => undefined}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('SALES.SALES_LEAD_FOLLOWUP.CREATE') && (
              <Button variant="text" size="inline" onClick={() => setRecording(row)}>
                Record follow-up
              </Button>
            )}
            <Link href={`/sales/sales-lead/${row.id}/followup` as Route} className={linkClass}>
              History
            </Link>
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="Nothing in this view"
              description="No open lead matches. Try another tab or clear the search."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Show all open leads
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No open leads to follow up"
              description="Leads appear here once they are added under Sales Lead-FOB, ordered by when they next need a call."
            />
          )
        }
      />

      <Modal
        open={recording !== null}
        onOpenChange={(open) => !open && setRecording(null)}
        size="medium"
        title={recording === null ? 'Record a follow-up' : `Follow-up — ${recording.name}`}
        description={recording === null ? undefined : `Lead ${recording.code}`}
      >
        {recording !== null && (
          <LeadFollowupForm
            key={recording.id}
            leadId={recording.id}
            onSaved={async () => {
              setRecording(null);
              await list.reload();
            }}
            onCancel={() => setRecording(null)}
          />
        )}
      </Modal>
    </div>
  );
}

// ----------------------------------------------------------------- activity

function ActivityLog({ owners }: { owners: LookupOption[] }) {
  const list = useMasterList<SalesLeadActivityDto, 'followupDate'>(
    '/api/tenant/sales/lead-followups/activity',
    'followupDate',
    undefined,
    'desc',
  );

  const columns: DataTableColumn<SalesLeadActivityDto>[] = useMemo(
    () => [
      {
        id: 'lead',
        header: 'Lead',
        cell: (r) => (
          <Link href={`/sales/sales-lead/${r.leadId}/followup` as Route} className={linkClass}>
            <span className="font-mono tabular-nums">{r.leadCode}</span> {r.leadName}
          </Link>
        ),
      },
      { id: 'how', header: 'How', cell: (r) => CONTACT_MODE_LABEL[r.contactMode] },
      { id: 'contact', header: 'Contact', cell: (r) => r.contactPerson ?? <span className="text-steel">—</span> },
      {
        id: 'notes',
        header: 'Discussion · Outcome',
        cell: (r) => (
          <>
            <div>{r.notes ?? '—'}</div>
            <div className="text-steel">{r.outcome ?? ''}</div>
          </>
        ),
      },
      {
        id: 'targetRate',
        header: 'Target rate',
        numeric: true,
        cell: (r) =>
          r.targetRate === null ? <span className="text-steel">—</span> : `${Number(r.targetRate).toFixed(2)} ${r.currency ?? ''}`,
      },
      { id: 'nextAction', header: 'Next action', cell: (r) => r.nextAction ?? <span className="text-steel">—</span> },
      { id: 'next', header: 'Next', numeric: true, cell: (r) => r.nextFollowupDate ?? '—' },
      { id: 'by', header: 'Recorded by', cell: (r) => r.createdBy ?? <span className="text-steel">—</span> },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-3 pt-3">
      {/* On a phone: search and salesperson full width, the two dates side by side. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Input
          type="search"
          placeholder="Search lead ID or exporter"
          aria-label="Search follow-ups"
          value={list.searchInput}
          onChange={(e) => list.setSearchInput(e.target.value)}
          className="col-span-2 sm:w-64"
        />
        <OwnerFilter owners={owners} value={list.filters['ownerId'] ?? ''} onChange={(v) => list.setFilter('ownerId', v)} />
        <label className="flex flex-col gap-1 text-cell text-steel sm:flex-row sm:items-center sm:gap-1.5">
          From
          <Input
            type="date"
            numeric
            className="sm:w-40"
            value={list.filters['from'] ?? ''}
            onChange={(e) => list.setFilter('from', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-cell text-steel sm:flex-row sm:items-center sm:gap-1.5">
          To
          <Input
            type="date"
            numeric
            className="sm:w-40"
            value={list.filters['to'] ?? ''}
            onChange={(e) => list.setFilter('to', e.target.value)}
          />
        </label>
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
        getCode={(r) => r.followupDate}
        codeHeader="Date"
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={undefined}
        sortOrder="desc"
        onSortChange={() => undefined}
        onPageChange={list.setPage}
        isPending={list.isPending}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No follow-ups match"
              description="Widen the dates or clear the filters to see every conversation."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No follow-ups recorded yet"
              description="Record a call, email or visit from the Due tab, and it appears here for the whole team."
            />
          )
        }
      />
    </div>
  );
}
