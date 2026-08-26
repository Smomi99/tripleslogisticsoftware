'use client';

import {
  type InquiryDto,
  INQUIRY_STATUS_TONE,
  INQUIRY_STATUSES,
  type InquirySortField,
  type LookupOption,
  SHIPMENT_TYPES,
} from '@ff/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { InquiryForm } from '@/components/sales/inquiry-form';
import { PageHeader } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

import { AgentQuoteDrawer } from './agent-quote-drawer';
import { CarrierPositionDrawer } from './carrier-position-drawer';
import { FollowupDrawer } from './followup-drawer';
import { PriceDrawer } from './price-drawer';
import { ViewDrawer } from './view-drawer';

/**
 * Sales → Inquiry List (docs/MODULE_PURCHASE_SALES.md §5.5).
 *
 * The screen sales works the pipeline from. Its five row actions are five
 * separate permissions — seeing the list implies none of them.
 *
 * The OWN/ALL toggle only renders for someone the server would honour it for.
 * That is presentation, not enforcement: §4 rule 10 is decided in the API, and
 * asking for ALL without VIEW_ALL simply returns your own rows.
 */
interface InquiryOptions {
  seaPorts: LookupOption[];
  airPorts: LookupOption[];
  salesmen: LookupOption[];
  canViewAll: boolean;
  canSetOutcome: boolean;
}

const SHIPMENT_LABEL: Record<string, string> = { SEA: 'Sea', AIR: 'Air' };

/** §5.5's "Required Container" column, from the §5.4 volume grid. */
function requiredVolume(inquiry: InquiryDto): string {
  if (inquiry.volumes.length === 0) return '—';
  return inquiry.volumes
    .map((v) => {
      if (v.volumeKind === 'FCL') {
        return `${v.quantity ?? 0} × ${v.containerSizeCode ?? '?'}`;
      }
      if (v.volumeKind === 'LCL') return `${v.cbm ?? '0'} CBM`;
      return `${v.weightKg ?? '0'} KG`;
    })
    .join(', ');
}

export default function InquiryListPage() {
  const { authorizedRequest, can } = useSession();
  const router = useRouter();
  const list = useMasterList<InquiryDto, InquirySortField>(
    '/api/tenant/sales/inquiries',
    'inquiryDate',
  );
  const [options, setOptions] = useState<InquiryOptions | null>(null);
  const [viewing, setViewing] = useState<InquiryDto | null>(null);
  const [followingUp, setFollowingUp] = useState<InquiryDto | null>(null);
  const [carrierPosition, setCarrierPosition] = useState<InquiryDto | null>(null);
  const [agentQuotes, setAgentQuotes] = useState<InquiryDto | null>(null);
  const [pricing, setPricing] = useState<InquiryDto | null>(null);
  /** null closed · 'new' raising · an inquiry editing that one. */
  const [formFor, setFormFor] = useState<InquiryDto | 'new' | null>(null);

  useEffect(() => {
    void authorizedRequest<InquiryOptions>('/api/tenant/sales/inquiry-options')
      .then(setOptions)
      .catch(() => setOptions(null));
  }, [authorizedRequest]);

  const ports = [...(options?.seaPorts ?? []), ...(options?.airPorts ?? [])];

  /*
   * Quote opens the quotation this inquiry becomes.
   *
   * It used to POST /quote, which set the inquiry to QUOTED on its own. That
   * was right when there was nowhere for a quotation to live and is wrong now:
   * §5.3 rule 9 makes an inquiry QUOTED when its quotation is *sent*, and an
   * inquiry marked quoted with no document behind it is a lie the list tells
   * about itself. So this navigates, and the status follows the document.
   *
   * An inquiry that already has one goes to it rather than starting a second.
   */
  function quote(inquiry: InquiryDto): void {
    router.push(
      inquiry.quotation === null
        ? `/cs/quotation/new?inquiryId=${inquiry.id}`
        : `/cs/quotation/${inquiry.quotation.id}`,
    );
  }

  const columns: DataTableColumn<InquiryDto>[] = [
    { id: 'inquiryDate', header: 'Date', numeric: true, sortable: true, cell: (r) => r.inquiryDate },
    { id: 'customer', header: 'Customer', cell: (r) => r.customerName },
    {
      id: 'shipmentType',
      header: 'Shipment Type',
      cell: (r) => SHIPMENT_LABEL[r.shipmentType] ?? r.shipmentType,
    },
    // The name, not the code: an operator scanning a board knows Chittagong
    // and has to translate CGP. numeric is off because a place is not a figure.
    { id: 'pol', header: 'POL', cell: (r) => r.polName ?? r.polCode },
    { id: 'pod', header: 'POD', cell: (r) => r.podName ?? r.podCode },
    {
      id: 'commodity',
      header: 'Commodity',
      // Several per inquiry since §3; the column stays one line.
      cell: (r) => (r.commodities.length === 0 ? '—' : r.commodities.map((c) => c.name).join(', ')),
    },
    { id: 'volume', header: 'Required Container', numeric: true, cell: requiredVolume },
    {
      id: 'quotedPrice',
      header: 'Quoted Price',
      align: 'right',
      numeric: true,
      cell: (r) =>
        r.quotedPrice === null ? (
          <span className="text-steel">—</span>
        ) : (
          `${r.currencyCode ?? ''} ${r.quotedPrice}`.trim()
        ),
    },
    {
      /*
       * §6.2's Quotation column: View when this inquiry has one, a dash when it
       * does not. The pair of columns reads the way the desk works — Quoted
       * Price is the figure attached to the inquiry, this is the document that
       * went out carrying it.
       */
      id: 'quotation',
      header: 'Quotation',
      cell: (r) =>
        r.quotation === null ? (
          <span className="text-steel">—</span>
        ) : (
          <Link
            href={{ pathname: `/cs/quotation/${r.quotation.id}` }}
            className="text-harbour hover:underline"
            title={`${r.quotation.code}${r.quotation.revisionNo > 1 ? ` revision ${r.quotation.revisionNo}` : ''}`}
          >
            View
          </Link>
        ),
    },
    {
      id: 'validTo',
      header: 'Valid to Date',
      numeric: true,
      sortable: true,
      cell: (r) =>
        r.validTo === null ? (
          <span className="text-steel">—</span>
        ) : (
          // §4 rule 11: past its window but the job has not run yet.
          <span className={r.isLapsed ? 'text-alert' : undefined}>{r.validTo}</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      cell: (r) => (
        <Status tone={r.isLapsed ? 'overdue' : INQUIRY_STATUS_TONE[r.status]}>
          {r.isLapsed ? 'Lapsed' : r.status}
        </Status>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Live Inquiry"
        description="Every customer request on the board. Price it, follow it up, and turn it into a quotation."
        action={
          can('SALES.INQUIRY.CREATE') ? (
            <Button onClick={() => setFormFor('new')}>+ New inquiry</Button>
          ) : null
        }
      />

      {/* §5.5 filters, in the client's order. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search inquiry no or customer"
          aria-label="Search inquiries"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-64"
        />
        <Input
          type="date"
          aria-label="From date"
          numeric
          value={list.filters['fromDate'] ?? ''}
          onChange={(event) => list.setFilter('fromDate', event.target.value)}
          className="w-40"
        />
        <Input
          type="date"
          aria-label="To date"
          numeric
          value={list.filters['toDate'] ?? ''}
          onChange={(event) => list.setFilter('toDate', event.target.value)}
          className="w-40"
        />
        <Select
          aria-label="Shipment type"
          value={list.filters['shipmentType'] ?? ''}
          onChange={(event) => list.setFilter('shipmentType', event.target.value)}
          className="w-32"
        >
          <option value="">All modes</option>
          {SHIPMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {SHIPMENT_LABEL[t] ?? t}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Port of loading"
          value={list.filters['polId'] ?? ''}
          onChange={(event) => list.setFilter('polId', event.target.value)}
          className="w-44"
        >
          <option value="">All POL</option>
          {ports.map((p) => (
            <option key={`pol-${p.id}`} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Port of discharge"
          value={list.filters['podId'] ?? ''}
          onChange={(event) => list.setFilter('podId', event.target.value)}
          className="w-44"
        >
          <option value="">All POD</option>
          {ports.map((p) => (
            <option key={`pod-${p.id}`} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Salesman"
          value={list.filters['salesmanId'] ?? ''}
          onChange={(event) => list.setFilter('salesmanId', event.target.value)}
          className="w-40"
        >
          <option value="">All salesmen</option>
          {(options?.salesmen ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Status"
          value={list.filters['status'] ?? ''}
          onChange={(event) => list.setFilter('status', event.target.value)}
          className="w-36"
        >
          <option value="">All statuses</option>
          {INQUIRY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>

        {/* §4 rule 10's scope, shown only to someone it would change anything for. */}
        {options?.canViewAll === true && (
          <Select
            aria-label="Whose inquiries"
            value={list.filters['scope'] ?? 'OWN'}
            onChange={(event) => list.setFilter('scope', event.target.value)}
            className="w-36"
          >
            <option value="OWN">Mine</option>
            <option value="ALL">Whole team</option>
          </Select>
        )}

        {list.hasFilters && (
          <Button variant="secondary" onClick={list.clearFilters}>
            Clear filters
          </Button>
        )}
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
        codeHeader="Inquiry No"
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as InquirySortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('SALES.INQUIRY.VIEW') && (
              <Button variant="text" size="inline" onClick={() => setViewing(row)}>
                View
              </Button>
            )}
            {/* §5.5: Edit is blocked once WON. Hidden rather than disabled (§7). */}
            {can('SALES.INQUIRY.EDIT') && row.status !== 'WON' && (
              <Button variant="text" size="inline" onClick={() => setFormFor(row)}>
                Edit
              </Button>
            )}
            {/* §7 gives Price Check its own action: a salesman who may read
                an inquiry does not automatically get to read what the company
                paid for the lane. */}
            {can('SALES.INQUIRY.PRICE_CHECK') && (
              <Button variant="text" size="inline" onClick={() => setPricing(row)}>
                Price
              </Button>
            )}
            {/* §6.2's sixth action, and what CR-001's rankings were built for. */}
            {can('SALES.INQUIRY.CARRIER_POSITION') && (
              <Button variant="text" size="inline" onClick={() => setCarrierPosition(row)}>
                Carrier Position
              </Button>
            )}
            {/* What the agents came back with. Same permission as viewing the
                inquiry: whoever may read the lane may read what was quoted
                against it. */}
            {can('SALES.INQUIRY.VIEW') && (
              <Button variant="text" size="inline" onClick={() => setAgentQuotes(row)}>
                Agent quotes({row.agentQuoteCount})
              </Button>
            )}
            {can('SALES.INQUIRY.FOLLOWUP') && (
              <Button variant="text" size="inline" onClick={() => setFollowingUp(row)}>
                Follow Up({row.followupCount})
              </Button>
            )}
            {/* Both permissions, because the destination needs the second: a
                salesman who may convert an inquiry but not raise a quotation
                would otherwise land on a form that refuses them. */}
            {can('SALES.INQUIRY.CONVERT_QUOTE') &&
              (row.quotation !== null || can('CUSTOMER_SERVICE.QUOTATION.CREATE')) &&
              row.status !== 'WON' &&
              row.status !== 'LOST' && (
                <Button variant="text" size="inline" onClick={() => quote(row)}>
                  {row.quotation === null ? 'Quote' : 'Open quotation'}
                </Button>
              )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No inquiries match those filters"
              description="Try a wider date range or clear the filters to see them all."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No inquiries yet"
              description="Raise your first inquiry to start working the pipeline."
              action={
                can('SALES.INQUIRY.CREATE') ? (
                  <Button onClick={() => setFormFor('new')}>+ New inquiry</Button>
                ) : null
              }
            />
          )
        }
      />

      {/* The client asked for the form as a modal. §8 would send seventeen
          fields to a full page, so the modal is the wide variant rather than
          the 32rem default — a single scrolling column would be worse than the
          page it replaces. */}
      <Modal
        open={formFor !== null}
        onOpenChange={(open) => !open && setFormFor(null)}
        size="wide"
        title={formFor === 'new' || formFor === null ? 'New inquiry' : `Edit ${formFor.code}`}
        description={
          formFor === 'new' || formFor === null
            ? 'Capture what the customer asked for. The number is assigned on save.'
            : undefined
        }
      >
        {formFor !== null && (
          <InquiryForm
            // Remounts between rows, so an edit never opens on the last one's
            // values — the form seeds its state from props on mount.
            key={formFor === 'new' ? 'new' : formFor.id}
            inquiry={formFor === 'new' ? null : formFor}
            onSaved={() => {
              setFormFor(null);
              void list.reload();
            }}
            onCancel={() => setFormFor(null)}
          />
        )}
      </Modal>

      <ViewDrawer
        inquiry={viewing}
        canSetOutcome={options?.canSetOutcome === true}
        onClose={() => setViewing(null)}
        onChanged={() => void list.reload()}
      />
      <CarrierPositionDrawer
        inquiry={carrierPosition}
        onClose={() => setCarrierPosition(null)}
      />

      <FollowupDrawer
        inquiry={followingUp}
        onClose={() => setFollowingUp(null)}
        onChanged={() => void list.reload()}
      />
      <PriceDrawer
        inquiry={pricing}
        onClose={() => setPricing(null)}
        onChanged={() => void list.reload()}
      />
      <AgentQuoteDrawer inquiry={agentQuotes} onClose={() => setAgentQuotes(null)} />
    </div>
  );
}
