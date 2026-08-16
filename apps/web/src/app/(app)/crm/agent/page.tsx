'use client';

import { AGENT_TYPE_LABEL, AGENT_TYPES, type AgentDto, type AgentSortField } from '@ff/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/** CRM → Agent (CLAUDE.md §6, §8). */
const ENDPOINT = '/api/tenant/crm/agents';

export default function AgentPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<AgentDto, AgentSortField>(ENDPOINT, 'name');

  const [toToggle, setToToggle] = useState<AgentDto | null>(null);
  const [isToggling, setToggling] = useState(false);

  const columns: DataTableColumn<AgentDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Agent', sortable: true, cell: (r) => r.name },
      { id: 'country', header: 'Country', sortable: true, cell: (r) => r.country },
      { id: 'agentType', header: 'Type', cell: (r) => AGENT_TYPE_LABEL[r.agentType] },
      {
        id: 'expertAreas',
        header: 'Expert areas',
        cell: (r) =>
          r.expertAreas.length === 0 ? (
            <span className="text-steel">—</span>
          ) : (
            r.expertAreas.map((e) => e.name).join(', ')
          ),
      },
      {
        id: 'ports',
        header: 'Ports',
        align: 'right',
        numeric: true,
        cell: (r) => String(r.portCoverage.length),
      },
      {
        id: 'networks',
        header: 'Networks',
        cell: (r) =>
          r.networks.length === 0 ? (
            <span className="text-steel">—</span>
          ) : (
            r.networks.map((n) => n.name).join(', ')
          ),
      },
      {
        id: 'agreement',
        header: 'Agreement',
        cell: (r) =>
          r.agreementFile === null ? (
            <span className="text-steel">—</span>
          ) : (
            <span className="text-verified">Uploaded</span>
          ),
      },
      {
        id: 'isActive',
        header: 'Status',
        cell: (r) => (
          <Status tone={r.isActive ? 'active' : 'inactive'}>
            {r.isActive ? 'Active' : 'Inactive'}
          </Status>
        ),
      },
    ],
    [],
  );

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`${ENDPOINT}/${toToggle.id}/toggle-status`, { method: 'POST' });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await list.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Agent"
        description="Overseas partners, what they handle, where they cover, and which networks they belong to."
        action={
          can('CRM.AGENT.CREATE') ? (
            <Button asChild>
              <Link href="/crm/agent/new">+ Add agent</Link>
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search name, code or country"
          aria-label="Search agents"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Filter by type"
          value={list.filters['agentType'] ?? ''}
          onChange={(event) => list.setFilter('agentType', event.target.value)}
          className="w-44"
        >
          <option value="">All types</option>
          {AGENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {AGENT_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
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
        onSortChange={(by, order) => list.setSort(by as AgentSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('CRM.AGENT.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/crm/agent/${row.id}/pic`}>PIC</Link>
              </Button>
            )}
            {can('CRM.AGENT.EDIT') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/crm/agent/${row.id}/edit`}>Edit</Link>
              </Button>
            )}
            {can('CRM.AGENT.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No agents match those filters"
              description="Try a different name, country or type, or clear the filters."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No agents yet"
              description="Add your first overseas partner so shipments have someone to hand off to."
              action={
                can('CRM.AGENT.CREATE') ? (
                  <Button asChild>
                    <Link href="/crm/agent/new">+ Add agent</Link>
                  </Button>
                ) : null
              }
            />
          )
        }
      />

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this agent?' : 'Activate this agent?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing on new shipments. Existing shipments are unaffected.`
              : `${toToggle.name} will be available again on new shipments.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </div>
  );
}
