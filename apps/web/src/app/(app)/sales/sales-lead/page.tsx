'use client';

import {
  FREIGHT_CONTROL_LABEL,
  FREIGHT_CONTROLS,
  type FreightControl,
  LEAD_FOLLOWUP_DUE,
  LEAD_FOLLOWUP_DUE_LABEL,
  LEAD_SHIPMENT_MODE_LABEL,
  type LookupOption,
  SALES_LEAD_STATUS_LABEL,
  SALES_LEAD_STATUSES,
  type SalesLeadDto,
  type SalesLeadFormOptions,
  type SalesLeadKpiDto,
  type SalesLeadSortField,
  type SalesLeadStatus,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { type InquiryPrefill, InquiryForm } from '@/components/sales/inquiry-form';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status, type StatusTone } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Sales → Sales Lead-FOB (docs/SALES_LEAD_FOB.md).
 *
 * §7's register: the columns the client listed, so a lead can be judged
 * without opening it, and the management KPIs above them. The form is a full
 * page (§8: far more than eight fields); follow-ups and documents are child
 * screens; "Raise inquiry" is §5 step 03, the rate request.
 */

const STATUS_TONE: Record<SalesLeadStatus, StatusTone> = {
  NEW: 'pending',
  QUALIFIED: 'pending',
  RATE_REQUESTED: 'pending',
  QUOTED: 'pending',
  NEGOTIATION: 'pending',
  WON: 'active',
  LOST: 'inactive',
};

const linkClass = 'text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline';

/** Today in Dhaka, the day follow-ups fall due on (CLAUDE.md §9). */
const dhakaToday = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const money = (value: string | null): string =>
  value === null
    ? '—'
    : Number(value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const isOpen = (status: SalesLeadStatus): boolean => status !== 'WON' && status !== 'LOST';

/** What a lead hands the inquiry form — the lane, the customer, the owner. */
function prefillFrom(lead: SalesLeadDto): InquiryPrefill {
  return {
    ...(lead.sourceId === null ? {} : { sourceId: lead.sourceId }),
    ...(lead.customerId === null ? {} : { customerId: lead.customerId }),
    shipmentType: lead.shipmentMode === 'AIR' ? 'AIR' : 'SEA',
    loadingType: lead.shipmentMode === 'SEA_FCL' ? 'FCL' : lead.shipmentMode === 'SEA_LCL' ? 'LCL' : '',
    // An FOB export lead is cargo leaving the country.
    movementType: 'OUTBOUND',
    ...(lead.polId === null ? {} : { polId: lead.polId }),
    ...(lead.podId === null ? {} : { podId: lead.podId }),
    ...(lead.commodityItemId === null ? {} : { commodityItemIds: [lead.commodityItemId] }),
    ...(lead.firstShipmentDate === null ? {} : { expectedShipmentDate: lead.firstShipmentDate }),
    ...(lead.requirements === null ? {} : { remarks: lead.requirements }),
    ...(lead.ownerId === null ? {} : { salesmanId: lead.ownerId }),
    leadId: lead.id,
  };
}

export default function SalesLeadPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<SalesLeadDto, SalesLeadSortField>(
    '/api/tenant/sales/leads',
    'leadDate',
    undefined,
    'desc',
  );

  const [owners, setOwners] = useState<LookupOption[]>([]);
  const [kpis, setKpis] = useState<SalesLeadKpiDto | null>(null);
  const [toToggle, setToToggle] = useState<SalesLeadDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  const [raising, setRaising] = useState<SalesLeadDto | null>(null);
  const today = dhakaToday();
  const ownerFilter = list.filters['ownerId'] ?? '';

  useEffect(() => {
    void authorizedRequest<SalesLeadFormOptions>('/api/tenant/sales/lead-form-options')
      .then((options) => setOwners(options.owners))
      .catch(() => setOwners([]));
  }, [authorizedRequest]);

  const loadKpis = useCallback(async () => {
    try {
      const query = ownerFilter === '' ? '' : `?ownerId=${ownerFilter}`;
      setKpis(await authorizedRequest<SalesLeadKpiDto>(`/api/tenant/sales/leads/kpis${query}`));
    } catch {
      setKpis(null);
    }
  }, [authorizedRequest, ownerFilter]);

  useEffect(() => {
    void loadKpis();
  }, [loadKpis]);

  async function reloadAll(): Promise<void> {
    await Promise.all([list.reload(), loadKpis()]);
  }

  const columns: DataTableColumn<SalesLeadDto>[] = useMemo(
    () => [
      { id: 'leadDate', header: 'Lead date', numeric: true, sortable: true, cell: (r) => r.leadDate },
      {
        id: 'name',
        header: 'Exporter / Factory',
        sortable: true,
        cell: (r) => (
          <>
            <div className="text-hull">{r.name}</div>
            <div className="text-steel">{r.customerName === null ? 'Prospect' : 'Customer on file'}</div>
          </>
        ),
      },
      {
        id: 'buyer',
        header: 'Buyer country · Agent',
        cell: (r) => (
          <>
            <div>{r.buyerCountry ?? '—'}</div>
            <div className="text-steel">{r.agentName ?? '—'}</div>
          </>
        ),
      },
      {
        id: 'lane',
        header: 'POL → POD',
        cell: (r) =>
          r.polName === null ? (
            <span className="text-steel">—</span>
          ) : (
            <>
              <div>{r.polName}</div>
              <div className="text-steel">→ {r.podName}</div>
            </>
          ),
      },
      {
        id: 'commodity',
        header: 'Commodity · Equipment',
        cell: (r) => (
          <>
            <div>{r.commodityName ?? '—'}</div>
            <div className="text-steel">
              {r.shipmentMode === null
                ? '—'
                : r.containerSizeName === null
                  ? LEAD_SHIPMENT_MODE_LABEL[r.shipmentMode]
                  : `${LEAD_SHIPMENT_MODE_LABEL[r.shipmentMode]} · ${r.containerSizeName}`}
            </div>
          </>
        ),
      },
      {
        id: 'teu',
        header: 'TEU / month',
        numeric: true,
        cell: (r) => r.forecast.monthlyTeu ?? <span className="text-steel">—</span>,
      },
      {
        id: 'freightControl',
        header: 'Freight control',
        cell: (r) => (r.freightControl === null ? <span className="text-steel">—</span> : FREIGHT_CONTROL_LABEL[r.freightControl]),
      },
      {
        id: 'incumbent',
        header: 'Current forwarder',
        cell: (r) => r.incumbentForwarder ?? <span className="text-steel">—</span>,
      },
      {
        id: 'value',
        header: 'Revenue · Profit / month (USD)',
        numeric: true,
        cell: (r) => (
          <>
            <div>{money(r.forecast.monthlyRevenue)}</div>
            <div className="text-steel">{money(r.forecast.monthlyProfit)}</div>
          </>
        ),
      },
      {
        id: 'status',
        header: 'Status · Probability',
        cell: (r) => (
          <>
            <Status tone={STATUS_TONE[r.status]}>{SALES_LEAD_STATUS_LABEL[r.status]}</Status>
            <div className="font-mono tabular-nums text-steel">
              {r.winProbability === null ? '—' : `${r.winProbability}%`}
              {!r.isActive && <span className="ml-2 font-sans">· deactivated</span>}
            </div>
          </>
        ),
      },
      {
        id: 'nextFollowupDate',
        header: 'Salesperson · Next follow-up',
        sortable: true,
        cell: (r) => {
          const overdue = isOpen(r.status) && r.nextFollowupDate !== null && r.nextFollowupDate < today;
          return (
            <>
              <div>{r.ownerName ?? '—'}</div>
              <div className={overdue ? 'font-mono tabular-nums text-alert' : 'font-mono tabular-nums text-steel'}>
                {r.nextFollowupDate ?? '—'}
                {overdue && <span className="ml-1 font-sans">overdue</span>}
              </div>
            </>
          );
        },
      },
    ],
    [today],
  );

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`/api/tenant/sales/leads/${toToggle.id}/toggle-status`, {
        method: 'POST',
      });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await reloadAll();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Sales Lead-FOB"
        description="FOB export leads, from first contact to confirmed business."
        action={
          can('SALES.NEW_SALES_LEAD.CREATE') ? (
            <Button asChild>
              <Link href={'/sales/sales-lead/new' as Route}>+ New lead</Link>
            </Button>
          ) : null
        }
      />

      {kpis !== null && <KpiStrip kpis={kpis} />}

      {/* Two to a row on a phone, search on a row of its own. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <Input
          type="search"
          placeholder="Search lead ID, exporter, buyer, agent"
          aria-label="Search leads"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="col-span-2 sm:w-72"
        />
        <Select
          aria-label="Filter by status"
          className="sm:w-48"
          value={list.filters['status'] ?? ''}
          onChange={(e) => list.setFilter('status', e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="OPEN">Open leads</option>
          <option value="CLOSED">Won or lost</option>
          {SALES_LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SALES_LEAD_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by salesperson"
          className="sm:w-48"
          value={ownerFilter}
          onChange={(e) => list.setFilter('ownerId', e.target.value)}
        >
          <option value="">All salespeople</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by freight control"
          className="sm:w-56"
          value={list.filters['freightControl'] ?? ''}
          onChange={(e) => list.setFilter('freightControl', e.target.value as FreightControl | '')}
        >
          <option value="">Any freight control</option>
          {FREIGHT_CONTROLS.map((f) => (
            <option key={f} value={f}>
              {FREIGHT_CONTROL_LABEL[f]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by follow-up"
          className="sm:w-44"
          value={list.filters['due'] ?? ''}
          onChange={(e) => list.setFilter('due', e.target.value)}
        >
          <option value="">Any follow-up</option>
          {LEAD_FOLLOWUP_DUE.map((d) => (
            <option key={d} value={d}>
              {LEAD_FOLLOWUP_DUE_LABEL[d]}
            </option>
          ))}
        </Select>
      </div>

      {list.error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
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
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as SalesLeadSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('SALES.NEW_SALES_LEAD.EDIT') && (
              <Link href={`/sales/sales-lead/${row.id}/edit` as Route} className={linkClass}>
                Edit
              </Link>
            )}
            {can('SALES.SALES_LEAD_FOLLOWUP.VIEW') && (
              <Link href={`/sales/sales-lead/${row.id}/followup` as Route} className={linkClass}>
                Follow-up
              </Link>
            )}
            <Link href={`/sales/sales-lead/${row.id}/documents` as Route} className={linkClass}>
              Documents{row.documentCount > 0 ? ` (${row.documentCount})` : ''}
            </Link>
            {can('SALES.INQUIRY.CREATE') && row.isActive && isOpen(row.status) && (
              <Button variant="text" size="inline" onClick={() => setRaising(row)}>
                Raise inquiry
              </Button>
            )}
            {can('SALES.NEW_SALES_LEAD.TOGGLE_STATUS') && (
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
              title="No leads match these filters"
              description="Try a different search, or clear the filters to see every lead."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No FOB leads yet"
              description="Add the first exporter you are working on, with its buyer, lane and monthly volume, to start building the pipeline."
              action={
                can('SALES.NEW_SALES_LEAD.CREATE') ? (
                  <Button asChild>
                    <Link href={'/sales/sales-lead/new' as Route}>+ New lead</Link>
                  </Button>
                ) : undefined
              }
            />
          )
        }
      />

      <Modal
        open={raising !== null}
        onOpenChange={(open) => !open && setRaising(null)}
        size="wide"
        title={raising === null ? 'Raise inquiry' : `Raise inquiry from ${raising.code}`}
        description={
          raising !== null && raising.customerId === null
            ? 'This exporter is not a customer yet — choose or add the customer. The lead is linked to it on save.'
            : 'The lane, customer and salesperson come from the lead. The pricing team sees it once saved.'
        }
      >
        {raising !== null && (
          <InquiryForm
            key={raising.id}
            inquiry={null}
            prefill={prefillFrom(raising)}
            onSaved={() => {
              // The form announces the new inquiry's number itself.
              setRaising(null);
              void reloadAll();
            }}
            onCancel={() => setRaising(null)}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this lead?' : 'Activate this lead?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will leave the pipeline and the follow-up list. Its history is kept.`
              : `${toToggle.name} will be back in the pipeline.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </div>
  );
}

/** §7's management KPIs. Pipeline figures are the open leads now; conversions count this year. */
function KpiStrip({ kpis }: { kpis: SalesLeadKpiDto }) {
  const tiles: { label: string; value: string; sub?: string; tone?: 'alert' }[] = [
    { label: 'Active leads', value: String(kpis.activeLeads) },
    { label: 'Qualified leads', value: String(kpis.qualifiedLeads) },
    { label: 'TEU pipeline / month', value: Number(kpis.monthlyTeuPipeline).toLocaleString('en-US') },
    {
      label: `Est. gross profit / month (${kpis.currency})`,
      value: money(kpis.monthlyProfit),
      sub: `Revenue ${money(kpis.monthlyRevenue)} · weighted ${money(kpis.weightedProfit)}`,
    },
    { label: 'Conversion pending', value: String(kpis.conversionPending), sub: 'Quoted or negotiating' },
    {
      label: `Conversion rate ${kpis.year}`,
      value: kpis.conversionRate === null ? '—' : `${kpis.conversionRate}%`,
      sub: `${kpis.wonThisYear} won · ${kpis.lostThisYear} lost`,
    },
    {
      label: 'Overdue follow-ups',
      value: String(kpis.overdueFollowups),
      ...(kpis.overdueFollowups > 0 ? { tone: 'alert' as const } : {}),
    },
    { label: `New customers won ${kpis.year}`, value: String(kpis.newCustomersWon) },
  ];

  return (
    <section aria-label="Lead KPIs" className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line md:grid-cols-4 xl:grid-cols-8">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-0.5 bg-surface px-3 py-2.5">
          <span className="label-manifest">{tile.label}</span>
          <span className={`font-mono text-page-title tabular-nums ${tile.tone === 'alert' ? 'text-alert' : 'text-hull'}`}>
            {tile.value}
          </span>
          {tile.sub !== undefined && <span className="text-cell text-steel">{tile.sub}</span>}
        </div>
      ))}
    </section>
  );
}
