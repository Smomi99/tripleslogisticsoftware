'use client';

import {
  type FreightRateDto,
  type LookupOption,
  type MarginEdit,
  previewSellPrice,
  PROFIT_TYPES,
  PROFIT_TYPE_LABEL,
  type ProfitType,
  type RateMode,
} from '@ff/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { MultiSelect } from '@/components/ui/multi-select';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Price Add-on (MODULE_PURCHASE_SALES §5.2).
 *
 * "Results show two stacked rows per rate: buy price (read-only) above, profit
 * (editable) below, per tier — exactly as drawn." One component for all three
 * modes, same as the entry screen.
 *
 * The sell price under each input is a preview only. The authoritative figure
 * is the generated column, which is why nothing here ever posts a sell price —
 * §4 rule 4 puts that calculation in Postgres and nowhere else.
 */

interface AddonOptions {
  ports: LookupOption[];
  carriers: LookupOption[];
  goodsTypes: LookupOption[];
  tiers: { id: string; code: string; label: string }[];
  canSeeBuyPrice: boolean;
  canManageProfit: boolean;
}

const EMPTY: AddonOptions = {
  ports: [],
  carriers: [],
  goodsTypes: [],
  tiers: [],
  canSeeBuyPrice: false,
  canManageProfit: false,
};

/** Local edit state, keyed by rate line id. */
interface Draft {
  profitType: ProfitType;
  profitValue: string;
}

export function PriceAddonScreen({
  mode,
  title,
  description,
}: {
  mode: RateMode;
  title: string;
  description: string;
}) {
  const { authorizedRequest, authorizedList } = useSession();

  const [options, setOptions] = useState<AddonOptions>(EMPTY);
  const [rates, setRates] = useState<FreightRateDto[]>([]);
  const [isPending, setPending] = useState(false);
  const [hasSearched, setSearched] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [polId, setPolId] = useState('');
  const [podIds, setPodIds] = useState<string[]>([]);
  const [carrierId, setCarrierId] = useState('');
  const [goodsTypeId, setGoodsTypeId] = useState('');

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [reason, setReason] = useState('');
  const [isSaving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authorizedList<AddonOptions>(
          `/api/tenant/purchase/rate-options?mode=${mode}`,
        );
        if (!cancelled) setOptions(response.data);
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof ApiError ? error.message : 'Could not load the search filters.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedList, mode]);

  const requestIdRef = useRef(0);

  const search = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setPending(true);
    setSearched(true);

    const params = new URLSearchParams({ mode, limit: '100' });
    if (polId !== '') params.set('polId', polId);
    // §4 rule 7: many PODs at once.
    if (podIds.length > 0) params.set('podIds', podIds.join(','));
    if (carrierId !== '') params.set('carrierId', carrierId);
    if (goodsTypeId !== '') params.set('goodsTypeId', goodsTypeId);

    try {
      const response = await authorizedList<FreightRateDto[]>(
        `/api/tenant/purchase/addon/rates?${params.toString()}`,
      );
      if (requestId !== requestIdRef.current) return;
      setRates(response.data);
      // Edits belong to the results they were made against, so a new search
      // starts clean rather than carrying a stale margin onto another lane.
      setDrafts({});
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setLoadError(error instanceof ApiError ? error.message : 'Could not load rates.');
    } finally {
      if (requestId === requestIdRef.current) setPending(false);
    }
  }, [authorizedList, carrierId, goodsTypeId, mode, podIds, polId]);

  useEffect(() => {
    void search();
    // Runs once on mount so the screen opens with the full list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function draftFor(rate: FreightRateDto, lineId: string): Draft {
    const existing = drafts[lineId];
    if (existing !== undefined) return existing;
    const line = rate.lines.find((l) => l.id === lineId);
    return {
      profitType: line?.profitType ?? 'FLAT',
      profitValue: line?.profitValue ?? '0.0000',
    };
  }

  function setDraft(lineId: string, next: Partial<Draft>, current: Draft): void {
    setDrafts((prev) => ({ ...prev, [lineId]: { ...current, ...next } }));
  }

  /** Only rows whose margin actually differs from what the server holds. */
  function pendingEdits(): MarginEdit[] {
    const edits: MarginEdit[] = [];
    for (const rate of rates) {
      for (const line of rate.lines) {
        const draft = drafts[line.id];
        if (draft === undefined) continue;
        const sameType = (line.profitType ?? 'FLAT') === draft.profitType;
        const sameValue = Number(line.profitValue ?? '0') === Number(draft.profitValue || '0');
        if (sameType && sameValue) continue;
        edits.push({
          rateLineId: line.id,
          profitType: draft.profitType,
          profitValue: (draft.profitValue || '0').trim(),
        });
      }
    }
    return edits;
  }

  const edits = pendingEdits();

  async function save(): Promise<void> {
    if (edits.length === 0) return;
    setSaving(true);
    try {
      const result = await authorizedRequest<{ changed: number }>(
        '/api/tenant/purchase/addon/margins',
        { method: 'PATCH', body: { mode, edits, reason: reason.trim() } },
      );
      toast.success(`${result.changed} price${result.changed === 1 ? '' : 's'} updated`);
      setReason('');
      await search();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'Could not update the prices. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={description} />

      {loadError !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {loadError}
        </p>
      )}

      <section
        aria-label="Search rates"
        className="flex flex-wrap items-end gap-2 rounded-manifest border border-line bg-surface p-3 shadow-manifest"
      >
        <div className="flex w-48 flex-col gap-1">
          <span className="label-manifest">POL</span>
          <Select aria-label="Port of loading" value={polId} onChange={(e) => setPolId(e.target.value)}>
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
            id="pod-filter"
            options={options.ports}
            value={podIds}
            onChange={setPodIds}
            placeholder="All destinations"
            searchPlaceholder="Filter ports"
          />
        </div>

        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Carrier</span>
          <Select aria-label="Carrier" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
            <option value="">All</option>
            {options.carriers.map((carrier) => (
              <option key={carrier.id} value={carrier.id}>
                {carrier.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex w-44 flex-col gap-1">
          <span className="label-manifest">Goods type</span>
          <Select
            aria-label="Goods type"
            value={goodsTypeId}
            onChange={(e) => setGoodsTypeId(e.target.value)}
          >
            <option value="">All</option>
            {options.goodsTypes.map((goods) => (
              <option key={goods.id} value={goods.id}>
                {goods.name}
              </option>
            ))}
          </Select>
        </div>

        <Button type="button" onClick={() => void search()} disabled={isPending}>
          {isPending ? 'Searching…' : 'Search'}
        </Button>
      </section>

      {rates.length === 0 && hasSearched && !isPending ? (
        <EmptyState
          title="No rates match those filters"
          description="Widen the search, or buy the lane on the purchase screen first."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {rates.map((rate) => (
            <article
              key={rate.id}
              className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest"
            >
              <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line px-3 py-2">
                <span className="font-mono text-cell tabular-nums text-hull">{rate.code}</span>
                <span className="font-mono text-cell tabular-nums text-hull">
                  {rate.polCode} → {rate.podCode}
                </span>
                <span className="text-cell text-steel">{rate.carrierName}</span>
                <span className="text-cell text-steel">{rate.goodsTypeName}</span>
                <span className="ml-auto font-mono text-cell tabular-nums text-steel">
                  {rate.validFrom} – {rate.validTo} · {rate.currencyCode}
                </span>
              </header>

              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-line bg-paper">
                    <th className="label-manifest px-3 py-1.5 text-left">Tier</th>
                    {rate.lines.map((line) => (
                      <th key={line.id} className="label-manifest px-3 py-1.5 text-right">
                        {line.tierCode}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* Row 1: buy price, read-only — and absent entirely when the
                      server withheld it (§4 rule 5). */}
                  {options.canSeeBuyPrice && (
                    <tr className="border-b border-line">
                      <th className="label-manifest px-3 py-2 text-left">Buy</th>
                      {rate.lines.map((line) => (
                        <td
                          key={line.id}
                          className="px-3 py-2 text-right font-mono text-cell tabular-nums text-steel"
                        >
                          {line.buyPrice ?? '—'}
                        </td>
                      ))}
                    </tr>
                  )}

                  {/* Row 2: profit, editable. */}
                  <tr>
                    <th className="label-manifest px-3 py-2 text-left align-top">Profit</th>
                    {rate.lines.map((line) => {
                      const draft = draftFor(rate, line.id);
                      const preview = previewSellPrice(
                        line.buyPrice ?? line.sellPrice,
                        draft.profitType,
                        draft.profitValue || '0',
                      );
                      return (
                        <td key={line.id} className="px-3 py-2 align-top">
                          <div className="flex items-center justify-end gap-1">
                            <Select
                              aria-label={`Profit type for ${rate.code} ${line.tierCode}`}
                              value={draft.profitType}
                              onChange={(e) =>
                                setDraft(
                                  line.id,
                                  { profitType: e.target.value as ProfitType },
                                  draft,
                                )
                              }
                              className="w-24"
                            >
                              {PROFIT_TYPES.map((value) => (
                                <option key={value} value={value}>
                                  {PROFIT_TYPE_LABEL[value]}
                                </option>
                              ))}
                            </Select>
                            <Input
                              numeric
                              inputMode="decimal"
                              aria-label={`Profit for ${rate.code} ${line.tierCode}`}
                              value={draft.profitValue}
                              onChange={(e) =>
                                setDraft(line.id, { profitValue: e.target.value }, draft)
                              }
                              className="w-24 text-right"
                            />
                          </div>
                          {/* Quiet helper text: the outcome before saving. */}
                          <p className="mt-1 text-right font-mono text-cell tabular-nums text-steel">
                            {options.canSeeBuyPrice
                              ? `sell ${preview}`
                              : `now ${line.sellPrice}`}
                          </p>
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </article>
          ))}
        </div>
      )}

      {rates.length > 0 && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-manifest border border-line bg-surface p-3 shadow-manifest">
          <Input
            placeholder="Why this change? (optional, kept with the price history)"
            aria-label="Reason for the change"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-96"
          />
          <span className="text-body text-steel">
            {edits.length === 0
              ? 'No changes yet'
              : `${edits.length} price${edits.length === 1 ? '' : 's'} changed`}
          </span>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={isSaving || edits.length === 0}
            className="ml-auto"
          >
            {isSaving ? 'Updating…' : 'Update prices'}
          </Button>
        </div>
      )}
    </div>
  );
}
