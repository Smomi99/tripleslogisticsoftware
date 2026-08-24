'use client';

import {
  type ApiMeta,
  DEFAULT_PAGE_SIZE,
  type FreightRateDto,
  type LookupOption,
  type RateMode,
} from '@ff/shared';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { MultiSelect } from '@/components/ui/multi-select';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Price List (MODULE_PURCHASE_SALES §5.3) — "the screen sales actually lives in".
 *
 * Sell price for everyone with VIEW; buy price and margin only when the server
 * chose to send them (§4 rule 5), which is why every buy-price cell reads from
 * the key's presence rather than from a permission check here.
 *
 * §5.3 asks for a sticky header and sticky POL/POD columns because these tables
 * scroll wide — an operator reading the fifth tier column must still be able to
 * see which lane they are on.
 */

interface ListOptions {
  ports: LookupOption[];
  carriers: LookupOption[];
  goodsTypes: LookupOption[];
  tiers: { id: string; code: string; label: string }[];
  canSeeBuyPrice: boolean;
}

const EMPTY: ListOptions = {
  ports: [],
  carriers: [],
  goodsTypes: [],
  tiers: [],
  canSeeBuyPrice: false,
};

export function PriceListScreen({
  mode,
  feature,
  title,
  description,
}: {
  mode: RateMode;
  feature: string;
  title: string;
  description: string;
}) {
  const { authorizedList, authorizedDownload, can } = useSession();

  const [options, setOptions] = useState<ListOptions>(EMPTY);
  const [rates, setRates] = useState<FreightRateDto[]>([]);
  /** Rates whose local charges are open, expanded in place under their row. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /**
   * A screen-share toggle, not a permission. Someone who can see buy prices may
   * still want them off the screen while a customer is looking at it — §4 rule 5
   * is what actually keeps the figures from anyone who should not have them, and
   * it strips them from the response before they reach the browser at all.
   */
  const [hideBuyPrice, setHideBuyPrice] = useState(false);

  function toggleCharges(id: string): void {
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [meta, setMeta] = useState<ApiMeta>({
    page: 1,
    limit: DEFAULT_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [page, setPage] = useState(1);
  const [isPending, setPending] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isExporting, setExporting] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [polId, setPolId] = useState('');
  const [podIds, setPodIds] = useState<string[]>([]);
  const [carrierId, setCarrierId] = useState('');
  const [goodsTypeId, setGoodsTypeId] = useState('');
  const [includeExpired, setIncludeExpired] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authorizedList<ListOptions>(
          `/api/tenant/purchase/rate-options?mode=${mode}`,
        );
        if (!cancelled) setOptions(response.data);
      } catch {
        // The filters degrade to text search; the list itself still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedList, mode]);

  /** The filter set, shared by the list request and the download. */
  const filterParams = useCallback((): URLSearchParams => {
    const params = new URLSearchParams({ mode });
    if (search !== '') params.set('search', search);
    if (polId !== '') params.set('polId', polId);
    if (podIds.length > 0) params.set('podIds', podIds.join(','));
    if (carrierId !== '') params.set('carrierId', carrierId);
    if (goodsTypeId !== '') params.set('goodsTypeId', goodsTypeId);
    if (includeExpired) params.set('includeExpired', 'true');
    return params;
  }, [carrierId, goodsTypeId, includeExpired, mode, podIds, search]);

  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setPending(true);
    const params = filterParams();
    params.set('page', String(page));
    params.set('limit', String(DEFAULT_PAGE_SIZE));

    try {
      const response = await authorizedList<FreightRateDto[]>(
        `/api/tenant/purchase/price-list?${params.toString()}`,
      );
      if (requestId !== requestIdRef.current) return;
      setRates(response.data);
      if (response.meta !== undefined) setMeta(response.meta);
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setLoadError(error instanceof ApiError ? error.message : 'Could not load the price list.');
    } finally {
      if (requestId === requestIdRef.current) setPending(false);
    }
  }, [authorizedList, filterParams, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(format: 'xlsx' | 'pdf'): Promise<void> {
    setExporting(true);
    try {
      const params = filterParams();
      params.set('format', format);
      // §4 rule 12: the file is built from the same filters, server-side, so
      // it can never contain a column the screen was not allowed to show.
      const stamp = new Date().toISOString().slice(0, 10);
      await authorizedDownload(
        `/api/tenant/purchase/price-list/export?${params.toString()}`,
        `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}.${format}`,
      );
      toast.success(`${format === 'pdf' ? 'PDF' : 'Excel'} downloaded`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not build the export.');
    } finally {
      setExporting(false);
    }
  }

  const hasFilters =
    search !== '' ||
    polId !== '' ||
    podIds.length > 0 ||
    carrierId !== '' ||
    goodsTypeId !== '' ||
    includeExpired;

  function clearFilters(): void {
    setSearchInput('');
    setPolId('');
    setPodIds([]);
    setCarrierId('');
    setGoodsTypeId('');
    setIncludeExpired(false);
    setPage(1);
  }

  const canExport = can(`${feature}.EXPORT`);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={title}
        description={description}
        action={
          canExport ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => void download('xlsx')}
                disabled={isExporting || rates.length === 0}
              >
                Download Excel
              </Button>
              <Button
                variant="secondary"
                onClick={() => void download('pdf')}
                disabled={isExporting || rates.length === 0}
              >
                Download PDF
              </Button>
            </div>
          ) : null
        }
      />

      {loadError !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {loadError}
        </p>
      )}

      <section
        aria-label="Filters"
        className="flex flex-wrap items-end gap-2 rounded-manifest border border-line bg-surface p-3 shadow-manifest"
      >
        <div className="flex w-56 flex-col gap-1">
          <span className="label-manifest">Search</span>
          <Input
            type="search"
            aria-label="Search rates"
            placeholder="Code, port or carrier"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">POL</span>
          <Select
            aria-label="Port of loading"
            value={polId}
            onChange={(e) => {
              setPolId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {options.ports.map((port) => (
              <option key={port.id} value={port.id}>
                {port.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-64 flex-col gap-1">
          <span className="label-manifest">POD</span>
          <MultiSelect
            id="price-list-pod"
            options={options.ports}
            value={podIds}
            onChange={(next) => {
              setPodIds(next);
              setPage(1);
            }}
            placeholder="All destinations"
            searchPlaceholder="Filter ports"
          />
        </div>
        <div className="flex w-40 flex-col gap-1">
          <span className="label-manifest">Carrier</span>
          <Select
            aria-label="Carrier"
            value={carrierId}
            onChange={(e) => {
              setCarrierId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {options.carriers.map((carrier) => (
              <option key={carrier.id} value={carrier.id}>
                {carrier.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-40 flex-col gap-1">
          <span className="label-manifest">Goods type</span>
          <Select
            aria-label="Goods type"
            value={goodsTypeId}
            onChange={(e) => {
              setGoodsTypeId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {options.goodsTypes.map((goods) => (
              <option key={goods.id} value={goods.id}>
                {goods.name}
              </option>
            ))}
          </Select>
        </div>
        {options.canSeeBuyPrice && (
          <label className="flex h-9 items-center gap-2 text-body text-steel">
            <input
              type="checkbox"
              checked={hideBuyPrice}
              onChange={(e) => setHideBuyPrice(e.target.checked)}
              className="size-4 accent-harbour"
            />
            Hide buying price
          </label>
        )}
        <label className="flex h-9 items-center gap-2 text-body text-steel">
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(e) => {
              setIncludeExpired(e.target.checked);
              setPage(1);
            }}
            className="size-4 accent-harbour"
          />
          Include expired
        </label>
        {hasFilters && (
          <Button variant="secondary" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </section>

      {rates.length === 0 && !isPending ? (
        <EmptyState
          title={hasFilters ? 'No rates match those filters' : 'No published rates yet'}
          description={
            hasFilters
              ? 'Widen the search, or tick Include expired to see rates that have lapsed.'
              : 'Rates appear here once the pricing team has published them.'
          }
          action={
            hasFilters ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full min-w-max border-collapse">
            <thead className="sticky top-0 z-20">
              <tr className="bg-paper text-left">
                <StickyTh left="0" width="w-24">
                  Code
                </StickyTh>
                <StickyTh left="6rem" width="w-20">
                  POL
                </StickyTh>
                <StickyTh left="11rem" width="w-20">
                  POD
                </StickyTh>
                <Th>Carrier</Th>
                <Th>Goods</Th>
                {options.tiers.map((tier) => (
                  <Th key={tier.id} numeric>
                    {tier.code}
                  </Th>
                ))}
                <Th numeric>Local charges</Th>
                <Th numeric>Transit</Th>
                <Th numeric>Free days</Th>
                <Th>Validity</Th>
                <Th>Currency</Th>
              </tr>
            </thead>
            <tbody>
              {rates.map((rate) => (
                <Fragment key={rate.id}>
                  <tr className="border-b border-line last:border-0 hover:bg-row-hover [&>td]:align-top">
                  <StickyTd left="0" mono>
                    {rate.code}
                  </StickyTd>
                  <StickyTd left="6rem" mono>
                    {rate.polCode}
                  </StickyTd>
                  <StickyTd left="11rem" mono>
                    {rate.podCode}
                  </StickyTd>
                  <td className="whitespace-nowrap px-2.5 py-2 text-cell text-hull">{rate.carrierName}</td>
                  <td className="whitespace-nowrap px-2.5 py-2 text-cell text-hull">{rate.goodsTypeName}</td>
                  {options.tiers.map((tier) => {
                    const line = rate.lines.find((l) => l.tierId === tier.id);
                    return (
                      <td
                        key={tier.id}
                        className="px-2.5 py-2 text-right font-mono text-cell tabular-nums"
                      >
                        {line === undefined ? (
                          <span className="text-steel">—</span>
                        ) : (
                          <>
                            <div>{line.sellPrice}</div>
                            {/* Absent unless the server sent it (§4 rule 5). */}
                            {line.buyPrice !== undefined && !hideBuyPrice && (
                              <div className="text-steel">buy {line.buyPrice}</div>
                            )}
                          </>
                        )}
                      </td>
                    );
                  })}
                  {/*
                    The client asked for the line count here, with the
                    breakdown a click away — the total alone does not say what
                    it is made of, and the charges are already on the row.
                  */}
                  <td className="px-2.5 py-2 text-right text-cell">
                    {rate.localCharges.length === 0 ? (
                      <span className="font-mono tabular-nums text-steel">—</span>
                    ) : (
                      <Button
                        variant="text"
                        size="inline"
                        aria-expanded={expanded.has(rate.id)}
                        onClick={() => toggleCharges(rate.id)}
                      >
                        {rate.localCharges.length === 1
                          ? '1 line'
                          : `${rate.localCharges.length} lines`}
                      </Button>
                    )}
                  </td>
                  <td className="px-2.5 py-2 text-right font-mono text-cell tabular-nums text-steel">
                    {rate.transitDays ?? '—'}
                  </td>
                  <td className="px-2.5 py-2 text-right font-mono text-cell tabular-nums text-steel">
                    {rate.freeDays ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2 font-mono text-cell tabular-nums">
                    <div className={rate.expiringSoon ? 'text-signal' : 'text-hull'}>
                      {rate.validTo}
                    </div>
                    <div className="text-steel">from {rate.validFrom}</div>
                  </td>
                  <td className="px-2.5 py-2 font-mono text-cell tabular-nums text-steel">
                    {rate.currencyCode}
                  </td>
                </tr>
                {expanded.has(rate.id) && (
                  /*
                    Shown in the table rather than in a dialog, at the client's
                    request: the breakdown stays beside the rate it belongs to,
                    and two rates can be compared side by side without closing
                    one to open the other.
                  */
                  <tr className="bg-paper">
                    <td colSpan={10 + options.tiers.length} className="px-2.5 py-3">
                      <table className="w-full text-cell">
                        <thead>
                          <tr className="border-b border-line text-left">
                            <th className="label-manifest py-1">Cost head</th>
                            <th className="label-manifest py-1">Side</th>
                            <th className="label-manifest py-1">Container</th>
                            <th className="label-manifest py-1 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rate.localCharges.map((charge) => (
                            <tr key={charge.id} className="border-b border-line">
                              <td className="py-1 text-hull">{charge.costHeadName}</td>
                              <td className="py-1 text-steel">{charge.side}</td>
                              <td className="py-1 font-mono text-steel">
                                {charge.containerSizeCode ?? 'All'}
                              </td>
                              <td className="py-1 text-right font-mono tabular-nums text-hull">
                                {charge.amount} {charge.currencyCode}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={3} className="py-1.5 label-manifest">
                              Total
                            </td>
                            <td className="py-1.5 text-right font-mono tabular-nums text-hull">
                              {rate.localChargeTotal} {rate.currencyCode}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-cell text-steel">
          {meta.total} rate{meta.total === 1 ? '' : 's'}
        </span>
        {meta.totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="inline"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-cell text-steel">
              Page {meta.page} of {meta.totalPages}
            </span>
            <Button
              variant="secondary"
              size="inline"
              disabled={page >= meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <th
      className={`label-manifest border-b border-line bg-paper px-2.5 py-2 ${
        numeric === true ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

/** §5.3: POL and POD stay put while the tier columns scroll away. */
function StickyTh({
  children,
  left,
  width,
}: {
  children: React.ReactNode;
  left: string;
  width: string;
}) {
  return (
    <th
      style={{ left }}
      className={`label-manifest sticky z-30 border-b border-r border-line bg-paper px-2.5 py-2 text-left ${width}`}
    >
      {children}
    </th>
  );
}

function StickyTd({
  children,
  left,
  mono,
}: {
  children: React.ReactNode;
  left: string;
  mono?: boolean;
}) {
  return (
    <td
      style={{ left }}
      className={`sticky z-10 whitespace-nowrap border-r border-line bg-surface px-2.5 py-2 text-cell text-hull ${
        mono === true ? 'font-mono tabular-nums' : ''
      }`}
    >
      {children}
    </td>
  );
}
