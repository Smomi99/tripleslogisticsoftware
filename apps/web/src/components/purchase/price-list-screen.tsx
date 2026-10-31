'use client';

import {
  type ApiMeta,
  PURCHASE_SOURCE_LABEL,
  DEFAULT_PAGE_SIZE,
  type FreightRateDto,
  type LookupOption,
  type RateMode,
  purchasePrice,
} from '@ff/shared';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { MultiSelect } from '@/components/ui/multi-select';
import { ColumnScrollButtons, PINNED_START_EDGE, useHorizontalScroll } from '@/components/ui/table-scroll';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useIsPhone } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

import { RateCard } from './rate-card';

/**
 * Price List (MODULE_PURCHASE_SALES §5.3) — "the screen sales actually lives in".
 *
 * Sell price for everyone with VIEW; buy price and margin only when the server
 * chose to send them (§4 rule 5), which is why every buy-price cell reads from
 * the key's presence rather than from a permission check here.
 *
 * §5.3 asks for a sticky header and sticky POL/POD columns because these tables
 * scroll wide — an operator reading the fifth tier column must still be able to
 * see which lane they are on. On a phone each rate is a card instead.
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

/**
 * What a price was bought against, for the hover (client, 2026-09-12).
 *
 * A sell price on its own says what to charge and nothing about where it came
 * from, which is the first question anybody asks of a number they are about to
 * quote. Everything here is already on the row; this only puts it within
 * reach of the price rather than three columns away.
 *
 * The buy figures follow the same rule the cell does: shown only when the
 * server actually sent them (§4 rule 5) and the buyer has not hidden them.
 * A tooltip is not a way around a permission.
 */
function boughtFrom(
  rate: FreightRateDto,
  line: FreightRateDto['lines'][number] | undefined,
  showBuy: boolean,
): string {
  const parts = [
    `Bought from ${PURCHASE_SOURCE_LABEL[rate.purchaseSourceType]}: ${rate.purchaseSourceName}`,
    `Rate ${rate.code} · ${rate.currencyCode}`,
    `Valid ${rate.validFrom} to ${rate.validTo}`,
  ];
  if (rate.route !== null && rate.route !== '') parts.push(`Routing: ${rate.route}`);
  if (line !== undefined && line.buyPrice !== undefined && showBuy) {
    // A percentage keeps its decimals — 12.5% is ordinary — but loses the
    // trailing zeros NUMERIC(18,4) hands back. A flat margin is a price and
    // reads like one.
    const margin =
      line.profitType === 'PERCENT'
        ? `${Number(line.profitValue ?? '0')}% margin`
        : `${purchasePrice(line.profitValue, rate.mode)} margin`;
    parts.push(
      `Buy ${purchasePrice(line.buyPrice, rate.mode)} · ${margin} · ` +
        `sell ${purchasePrice(line.sellPrice, rate.mode)}`,
    );
  }
  return parts.join(String.fromCharCode(10));
}

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
  /**
   * The rate whose local charges are open, expanded under its own row.
   *
   * One at a time: two breakdowns open at once push the second rate far enough
   * down the screen that the comparison they were opened for is impossible.
   */
  const [charges, setCharges] = useState<string | null>(null);
  /**
   * A screen-share toggle, not a permission. Someone who can see buy prices may
   * still want them off the screen while a customer is looking at it — §4 rule 5
   * is what actually keeps the figures from anyone who should not have them, and
   * it strips them from the response before they reach the browser at all.
   */
  const [hideBuyPrice, setHideBuyPrice] = useState(false);

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
  const [polIds, setPolIds] = useState<string[]>([]);
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
    if (polIds.length > 0) params.set('polIds', polIds.join(','));
    if (podIds.length > 0) params.set('podIds', podIds.join(','));
    if (carrierId !== '') params.set('carrierId', carrierId);
    if (goodsTypeId !== '') params.set('goodsTypeId', goodsTypeId);
    if (includeExpired) params.set('includeExpired', 'true');
    return params;
  }, [carrierId, goodsTypeId, includeExpired, mode, polIds, podIds, search]);

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
    polIds.length > 0 ||
    podIds.length > 0 ||
    carrierId !== '' ||
    goodsTypeId !== '' ||
    includeExpired;

  function clearFilters(): void {
    setSearchInput('');
    setPolIds([]);
    setPodIds([]);
    setCarrierId('');
    setGoodsTypeId('');
    setIncludeExpired(false);
    setPage(1);
  }

  const canExport = can(`${feature}.EXPORT`);
  const isPhone = useIsPhone();
  const scroller = useHorizontalScroll([rates, options.tiers, isPhone, hideBuyPrice, charges]);
  const pinned = usePinnedOffsets(3, [rates, isPhone]);

  function toggleCharges(rateId: string): void {
    setCharges((open) => (open === rateId ? null : rateId));
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={title}
        description={description}
        action={
          canExport ? (
            <div className="flex flex-wrap items-center gap-2 max-sm:*:flex-1">
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
        className="flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface p-3 shadow-manifest"
      >
        <div className="flex w-full flex-col gap-1 sm:w-56">
          <span className="label-field">Search</span>
          <Input
            type="search"
            aria-label="Search rates"
            placeholder="Code, port or carrier"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        {/*
          Either end may take several ports, but not both at once.
          A price list is read one-sidedly — these origins into one port, or
          one origin out to these — and a grid whose rows share neither end is
          a search result pretending to be a comparison. So picking a second
          port on one side collapses the other to the single port it already
          had, and the hint below says so before it happens rather than after.
        */}
        <div className="flex w-full flex-col gap-1 sm:w-64">
          <span className="label-field">POL</span>
          <MultiSelect
            id="price-list-pol"
            options={options.ports}
            value={polIds}
            onChange={(next) => {
              setPolIds(next);
              // Two origins means one destination. Keeping the first is the
              // least surprising choice: it is the one they picked first.
              if (next.length > 1 && podIds.length > 1) setPodIds(podIds.slice(0, 1));
              setPage(1);
            }}
            placeholder="All origins"
            searchPlaceholder="Filter ports"
          />
          {polIds.length > 1 && (
            <span className="text-cell text-steel">One discharge port at a time.</span>
          )}
        </div>
        <div className="flex w-full flex-col gap-1 sm:w-64">
          <span className="label-field">POD</span>
          <MultiSelect
            id="price-list-pod"
            options={options.ports}
            value={podIds}
            onChange={(next) => {
              setPodIds(next);
              if (next.length > 1 && polIds.length > 1) setPolIds(polIds.slice(0, 1));
              setPage(1);
            }}
            placeholder="All destinations"
            searchPlaceholder="Filter ports"
          />
          {podIds.length > 1 && (
            <span className="text-cell text-steel">One loading port at a time.</span>
          )}
        </div>
        <div className="flex min-w-0 grow basis-2/5 flex-col gap-1 sm:w-40 sm:flex-none">
          <span className="label-field">Carrier</span>
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
        <div className="flex min-w-0 grow basis-2/5 flex-col gap-1 sm:w-40 sm:flex-none">
          <span className="label-field">Goods type</span>
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

      {rates.length === 0 ? (
        <div className="rounded-card border border-line bg-surface shadow-manifest">
          {isPending ? (
            <p className="px-4 py-10 text-center text-body text-steel">Loading the price list…</p>
          ) : (
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
          )}
        </div>
      ) : isPhone ? (
        <ul className={cn('flex flex-col gap-3', isPending && 'opacity-60')}>
          {rates.map((rate) => (
            <li key={rate.id}>
              <RateCard
                rate={rate}
                tiers={options.tiers}
                showBuy={!hideBuyPrice}
                mutePrices={rate.isExpired}
                details={[
                  {
                    label: 'Local charges',
                    value:
                      rate.localCharges.length === 0 ? (
                        <span className="font-mono text-steel">—</span>
                      ) : (
                        // A 36px tap target (§12) without making the row taller.
                        <ChargesToggle
                          rate={rate}
                          open={charges === rate.id}
                          onToggle={toggleCharges}
                          className="-my-2 min-h-9"
                        />
                      ),
                  },
                  { label: 'Route', value: rate.route ?? '—' },
                  { label: 'Transit days', value: rate.transitDays ?? '—', numeric: true },
                  { label: 'Free days', value: rate.freeDays ?? '—', numeric: true },
                  { label: 'Validity', value: <Validity rate={rate} />, numeric: true },
                  // On a desktop this is the price's hover; a phone has no hover.
                  {
                    label: 'Bought from',
                    value: `${PURCHASE_SOURCE_LABEL[rate.purchaseSourceType]}: ${rate.purchaseSourceName}`,
                  },
                ]}
              >
                {charges === rate.id && <ChargeBreakdown rate={rate} stacked />}
              </RateCard>
            </li>
          ))}
        </ul>
      ) : (
        <div
          {...scroller.props}
          className={cn(
            'group/scroller relative max-h-[70vh] overflow-auto rounded-card border border-line bg-surface shadow-manifest',
            isPending && 'opacity-60',
          )}
        >
          <table className="w-full min-w-max border-collapse text-cell">
            <thead className="sticky top-0 z-20">
              <tr ref={pinned.headRef} className="bg-module-soft">
                <PinnedTh left={pinned.offsets[0]}>Code</PinnedTh>
                <PinnedTh left={pinned.offsets[1]}>POL</PinnedTh>
                <PinnedTh left={pinned.offsets[2]} last>
                  POD
                </PinnedTh>
                <Th>Carrier</Th>
                <Th>Goods</Th>
                {options.tiers.map((tier) => (
                  <Th key={tier.id} numeric title={tier.label}>
                    {tier.code}
                  </Th>
                ))}
                <Th numeric>Local charges</Th>
                {/* Beside Transit: how it travels, next to how long it takes. */}
                <Th>Route</Th>
                <Th numeric>Transit</Th>
                <Th numeric>Free days</Th>
                <Th>Validity</Th>
                <Th>Currency</Th>
              </tr>
            </thead>
            <tbody>
              {rates.map((rate) => (
                <Fragment key={rate.id}>
                  <tr className="group border-b border-line last:border-b-0 hover:bg-row-hover [&>td]:align-top">
                    <PinnedTd left={pinned.offsets[0]} code>
                      {rate.code}
                    </PinnedTd>
                    <PinnedTd left={pinned.offsets[1]}>{rate.polName ?? rate.polCode}</PinnedTd>
                    <PinnedTd left={pinned.offsets[2]} last>
                      {rate.podName ?? rate.podCode}
                    </PinnedTd>
                    <td className="px-3 py-2 text-hull">
                      <div className="w-max max-w-[18rem]">{rate.carrierName}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-hull">{rate.goodsTypeName}</td>
                    {options.tiers.map((tier) => {
                      const line = rate.lines.find((l) => l.tierId === tier.id);
                      return (
                        <td
                          key={tier.id}
                          className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums"
                          // Hover tells you where the price came from. A native
                          // title rather than a floating panel: this table scrolls
                          // sideways under sticky columns, and anything positioned
                          // inside a cell gets clipped by that.
                          title={line === undefined ? undefined : boughtFrom(rate, line, !hideBuyPrice)}
                        >
                          {line === undefined ? (
                            <span className="text-steel">—</span>
                          ) : (
                            <>
                              {/*
                                The currency beside the price (client,
                                2026-09-12). It belongs to the rate rather than
                                the tier, so it is the same down the row — but a
                                figure with no currency on it is not a price, and
                                the buyer reading across four tiers should not
                                have to remember which row they are on.
                              */}
                              {/* Dimmed when expired (§4 rule 2), so a lapsed
                                  price never reads as one sales can quote. */}
                              <div className={rate.isExpired ? 'cursor-help text-steel' : 'cursor-help text-hull'}>
                                {purchasePrice(line.sellPrice, mode)}{' '}
                                <span className="text-steel">{rate.currencyCode}</span>
                              </div>
                              {/* Absent unless the server sent it (§4 rule 5). */}
                              {line.buyPrice !== undefined && !hideBuyPrice && (
                                <div className="text-steel">buy {purchasePrice(line.buyPrice, mode)}</div>
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
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {rate.localCharges.length === 0 ? (
                        <span className="font-mono tabular-nums text-steel">—</span>
                      ) : (
                        <ChargesToggle rate={rate} open={charges === rate.id} onToggle={toggleCharges} />
                      )}
                    </td>
                    <td className="px-3 py-2 text-steel">
                      <div className="w-max max-w-[14rem]">{rate.route ?? '—'}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                      {rate.transitDays ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-steel">
                      {rate.freeDays ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums">
                      <Validity rate={rate} />
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums text-steel">{rate.currencyCode}</td>
                  </tr>

                  {/*
                    The breakdown, in the table, directly under the rate it
                    belongs to — the client's own layout: charge head, side,
                    unit, currency, amount. It stays in view while the table
                    scrolls sideways, since it belongs to the whole row rather
                    than to whichever columns are showing.
                  */}
                  {charges === rate.id && (
                    <tr className="border-b border-line bg-paper last:border-b-0">
                      <td colSpan={COLUMNS_AROUND_TIERS + options.tiers.length} className="py-3">
                        <div className="sticky left-3 w-fit max-w-2xl px-3">
                          <ChargeBreakdown rate={rate} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-cell text-steel">
          {meta.total} rate{meta.total === 1 ? '' : 's'}
        </span>
        <div className="flex flex-wrap items-center gap-4">
          {!isPhone && rates.length > 0 && <ColumnScrollButtons scroller={scroller} />}
          {meta.totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="compact"
                disabled={page <= 1 || isPending}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="whitespace-nowrap text-cell text-steel">
                Page {meta.page} of {meta.totalPages}
              </span>
              <Button
                variant="secondary"
                size="compact"
                disabled={page >= meta.totalPages || isPending}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Code, POL, POD; then Carrier, Goods; after the tiers, six more. For the breakdown row's span. */
const COLUMNS_AROUND_TIERS = 11;

/**
 * Where each pinned column starts: the widths of the pinned columns before it.
 *
 * Measured, because codes and port names set those widths. Fixed offsets (6rem
 * and 11rem) were narrower than "DEMO-RATE-1" and "Chattogram", so scrolling
 * slid POL under the code and POD under POL.
 */
function usePinnedOffsets(count: number, deps: readonly unknown[]) {
  const headRef = useRef<HTMLTableRowElement>(null);
  const [offsets, setOffsets] = useState<number[]>(() => Array.from({ length: count }, () => 0));

  useEffect(() => {
    const row = headRef.current;
    if (row === null) return;
    const cells = [...row.cells].slice(0, count);
    const measure = () => {
      let left = 0;
      const next = cells.map((cell) => {
        const at = left;
        left += cell.getBoundingClientRect().width;
        return at;
      });
      setOffsets((prev) => (prev.every((v, i) => v === next[i]) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const cell of cells) observer.observe(cell);
    return () => observer.disconnect();
    // `deps` are the rows: a new page can widen a pinned column, or remount the table.
  }, [count, ...deps]);

  return { headRef, offsets };
}

function Th({
  children,
  numeric,
  title,
}: {
  children: React.ReactNode;
  numeric?: boolean;
  title?: string;
}) {
  return (
    <th
      scope="col"
      title={title}
      className={cn(
        'label-manifest whitespace-nowrap border-b border-line bg-module-soft px-3 py-2.5',
        numeric === true ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

/**
 * §5.3: Code, POL and POD stay put while the tier columns scroll away. The
 * last of them carries the edge that shows columns passing behind.
 */
function PinnedTh({ children, left, last }: { children: React.ReactNode; left: number | undefined; last?: boolean }) {
  return (
    <th
      scope="col"
      style={{ left: left ?? 0 }}
      className={cn(
        'label-manifest sticky z-30 whitespace-nowrap border-b border-line bg-module-soft px-3 py-2.5 text-left',
        last === true && cn('border-r', PINNED_START_EDGE),
      )}
    >
      {children}
    </th>
  );
}

function PinnedTd({
  children,
  left,
  code,
  last,
}: {
  children: React.ReactNode;
  left: number | undefined;
  /** The business code: mono, in the module colour, on its tinted gutter (§12). */
  code?: boolean;
  last?: boolean;
}) {
  return (
    <td
      style={{ left: left ?? 0 }}
      className={cn(
        'sticky z-10 whitespace-nowrap px-3 py-2 transition-colors duration-[120ms] group-hover:bg-row-hover',
        code === true ? 'bg-module-soft font-mono font-medium tabular-nums text-harbour' : 'bg-surface text-hull',
        last === true && cn('border-r border-line', PINNED_START_EDGE),
      )}
    >
      {children}
    </td>
  );
}

function ChargesToggle({
  rate,
  open,
  onToggle,
  className,
}: {
  rate: FreightRateDto;
  open: boolean;
  onToggle: (rateId: string) => void;
  className?: string;
}) {
  return (
    <Button variant="text" size="inline" aria-expanded={open} onClick={() => onToggle(rate.id)} className={className}>
      {rate.localCharges.length === 1 ? '1 line' : `${rate.localCharges.length} lines`}
    </Button>
  );
}

/*
 * The container size rides in the head rather than taking a column of its own,
 * because that is how a forwarder writes it: "Stuffing Charge, 40HC" is the name
 * of the thing being billed, not a charge plus a separate fact about equipment.
 */
function chargeHead(charge: FreightRateDto['localCharges'][number]): string {
  return charge.containerSizeCode === null ? charge.costHeadName : `${charge.costHeadName}, ${charge.containerSizeCode}`;
}

/** A rate's local charges: a table under the row, or a list on a phone card. */
function ChargeBreakdown({ rate, stacked = false }: { rate: FreightRateDto; stacked?: boolean }) {
  if (stacked) {
    return (
      <ul aria-label={`Local charges for ${rate.code}`} className="flex flex-col divide-y divide-line rounded-manifest bg-paper px-3 text-cell">
        {rate.localCharges.map((charge) => (
          <li key={charge.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <div className="text-hull">{chargeHead(charge)}</div>
              <div className="text-steel">
                {charge.side}
                {charge.costUnitName !== null && ` · ${charge.costUnitName}`}
              </div>
            </div>
            <div className="shrink-0 text-right font-mono tabular-nums text-hull">
              {purchasePrice(charge.amount)} <span className="text-steel">{charge.currencyCode}</span>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <table className="w-full border-collapse text-cell">
      <thead>
        <tr className="border-b border-line text-left">
          <th className="label-manifest whitespace-nowrap py-1 pr-6">Charge head</th>
          <th className="label-manifest whitespace-nowrap py-1 pr-6">Side</th>
          <th className="label-manifest whitespace-nowrap py-1 pr-6">Unit</th>
          <th className="label-manifest whitespace-nowrap py-1 pr-6">Currency</th>
          <th className="label-manifest whitespace-nowrap py-1 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rate.localCharges.map((charge) => (
          <tr key={charge.id} className="border-b border-line last:border-0">
            <td className="whitespace-nowrap py-1.5 pr-6 text-hull">{chargeHead(charge)}</td>
            <td className="py-1.5 pr-6 text-steel">{charge.side}</td>
            <td className="whitespace-nowrap py-1.5 pr-6 text-steel">{charge.costUnitName ?? '—'}</td>
            <td className="py-1.5 pr-6 font-mono tabular-nums text-steel">{charge.currencyCode}</td>
            <td className="py-1.5 text-right font-mono tabular-nums text-hull">{purchasePrice(charge.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Validity({ rate }: { rate: FreightRateDto }) {
  return (
    <>
      <div className={rate.isExpired ? 'text-steel' : rate.expiringSoon ? 'text-signal' : 'text-hull'}>
        {rate.validTo}
        {rate.isExpired && ' • expired'}
      </div>
      <div className="text-steel">from {rate.validFrom}</div>
    </>
  );
}
