'use client';

import {
  type CostOptionsDto,
  type QuotationCostsDto,
  type QuotationCostsSaveInput,
  type QuotationLineDto,
  quotationCostsSaveSchema,
} from '@ff/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  type BlockDraft,
  blankLine,
  CostBlocksEditor,
  costTotals,
  lineBody,
  lineFrom,
  nextKey,
  withEveryType,
} from '@/components/accounts/cost-blocks';
import { fmt } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The quotation's Cost Details (client, 2026-10-18) — the debit invoice's
 * "Buying from Carrier / Agent / Vendor" blocks, on the quotation, with the
 * gross profit the price leaves.
 *
 * Saved on its own, apart from `Save changes`: it is internal, so it never
 * issues the customer a new revision, and it is guarded by VIEW_BUY_PRICE. An
 * unsaved cost side starts from the price list's buying prices.
 */

function blocksFrom(view: QuotationCostsDto): BlockDraft[] {
  const drafts: BlockDraft[] =
    view.costs !== null
      ? view.costs.map((c) => ({
          key: nextKey(),
          id: c.id,
          partyType: c.partyType,
          partyId: c.partyId,
          supplierInvoiceNo: '',
          currencyId: c.currencyId,
          conversionRate: c.conversionRate,
          lines: c.lines.map(lineFrom),
          fileName: null,
        }))
      : view.prefill.map((c) => ({
          key: nextKey(),
          id: null,
          partyType: c.partyType,
          partyId: c.partyId ?? '',
          supplierInvoiceNo: '',
          currencyId: c.currencyId,
          conversionRate: c.conversionRate,
          lines: c.lines.map(lineFrom),
          fileName: null,
        }));
  return withEveryType(drafts, view.options);
}

type SellLine = Pick<QuotationLineDto, 'currencyId' | 'currencyCode' | 'totalAmount'>;
type SellPart = { currencyId: string; code: string; total: number; rate: number };

/*
  The selling side in base, at today's rate for each charge's currency — the
  rate each cost block starts on and the debit invoice converts at, so the gross
  profit subtracts base from base.

  Not the lines' bill amount: that is price x the quotation's frozen rate, and
  since Local Currency went (2026-09-11) the frozen rate is the base's own, 1 —
  so a USD 2,333 quotation read as "2,333.00 BDT".
*/
function sellInBase(
  lines: SellLine[],
  currencies: CostOptionsDto['currencies'],
): { base: number; parts: SellPart[] } | { unrated: string } {
  const parts = new Map<string, SellPart>();
  for (const line of lines) {
    let part = parts.get(line.currencyId);
    if (part === undefined) {
      const rate = Number(currencies.find((c) => c.id === line.currencyId)?.rate ?? '0');
      // A total missing a charge would look right and be wrong; say so instead.
      if (!(rate > 0)) return { unrated: line.currencyCode };
      part = { currencyId: line.currencyId, code: line.currencyCode, total: 0, rate };
      parts.set(line.currencyId, part);
    }
    part.total += Number(line.totalAmount);
  }
  const list = [...parts.values()];
  return { base: list.reduce((sum, p) => sum + p.total * p.rate, 0), parts: list };
}

export function QuotationCostDetails({
  quotationId,
  sellLines,
}: {
  quotationId: string;
  /** The charges as the quotation last saved them, in the currency each was priced in. */
  sellLines: SellLine[];
}) {
  const { authorizedRequest } = useSession();
  const endpoint = `/api/tenant/cs/quotations/${quotationId}/costs`;
  const [view, setView] = useState<QuotationCostsDto | null>(null);
  const [blocks, setBlocks] = useState<BlockDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = useCallback((next: QuotationCostsDto) => {
    setView(next);
    setBlocks(blocksFrom(next));
  }, []);

  useEffect(() => {
    let cancelled = false;
    authorizedRequest<QuotationCostsDto>(endpoint).then(
      (next) => {
        if (!cancelled) show(next);
      },
      (caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : 'Could not load the cost details.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, endpoint, show]);

  const grandCost = useMemo(() => costTotals(blocks).grandBase, [blocks]);

  if (error !== null) {
    return (
      <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
        {error}
      </p>
    );
  }
  if (view === null) return <p className="text-body text-steel">Loading cost details…</p>;

  const baseCode = view.options.baseCurrencyCode ?? '';
  const sell = sellInBase(sellLines, view.options.currencies);
  const sellTotalBase = 'base' in sell ? sell.base : null;
  const grossProfit = sellTotalBase === null ? null : sellTotalBase - grandCost;
  const gpPercent =
    sellTotalBase !== null && grossProfit !== null && sellTotalBase > 0 ? (grossProfit / sellTotalBase) * 100 : null;
  // Only charges priced outside the base were converted; those are worth showing the rate for.
  const converted = 'parts' in sell ? sell.parts.filter((p) => p.currencyId !== view.options.baseCurrencyId) : [];

  async function save(): Promise<void> {
    const payload: QuotationCostsSaveInput = {
      costs: blocks.map((b) => ({
        partyType: b.partyType,
        partyId: b.partyId === '' ? null : b.partyId,
        currencyId: b.currencyId,
        conversionRate: b.conversionRate.trim(),
        lines: b.lines.filter((l) => !blankLine(l)).map((l) => lineBody(l, l.source === 'AUTO' ? 'AUTO' : 'MANUAL')),
      })),
    };
    const parsed = quotationCostsSaveSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the cost details and try again.');
      return;
    }
    setBusy(true);
    try {
      show(await authorizedRequest<QuotationCostsDto>(endpoint, { method: 'PUT', body: payload }));
      toast.success('Cost details saved');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save the cost details.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {view.costs === null && (
        <div className="rounded-manifest border border-signal/30 bg-signal/5 px-3 py-2 text-cell text-hull">
          <p>Not saved yet. These start from the price list’s buying prices — check them, then save.</p>
          {view.notes.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {view.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <CostBlocksEditor
        blocks={blocks}
        onChange={setBlocks}
        options={view.options}
        editable={view.editable}
        description="What we expect to pay the carrier, agent and vendor. Never printed or sent to the customer; the debit invoice starts from it."
      />

      <section className="flex flex-wrap items-end justify-between gap-4 rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-4">
          <div>
            <dt className="label-manifest">Total Sell price</dt>
            <dd className="font-mono text-section tabular-nums text-hull">
              {fmt(sellTotalBase)} <span className="text-body text-steel">{baseCode}</span>
            </dd>
            {converted.length > 0 && (
              <dd className="mt-0.5 font-mono text-cell tabular-nums text-steel">
                {converted
                  .map((p) => `${fmt(p.total)} ${p.code} × ${p.rate.toLocaleString('en-US', { maximumFractionDigits: 4 })}`)
                  .join(' + ')}
              </dd>
            )}
          </div>
          <div>
            <dt className="label-manifest">Grand total cost</dt>
            <dd className="font-mono text-section tabular-nums text-hull">
              {fmt(grandCost)} <span className="text-body text-steel">{baseCode}</span>
            </dd>
          </div>
          <div>
            <dt className="label-manifest">Gross profit</dt>
            <dd
              className={`font-mono text-section tabular-nums ${grossProfit !== null && grossProfit < 0 ? 'text-alert' : 'text-hull'}`}
            >
              {fmt(grossProfit)} <span className="text-body text-steel">{baseCode}</span>
            </dd>
          </div>
          <div>
            <dt className="label-manifest">GP %</dt>
            <dd className="font-mono text-section tabular-nums text-hull">
              {gpPercent === null ? '—' : `${gpPercent.toFixed(2)}%`}
            </dd>
          </div>
          {'unrated' in sell && (
            <p role="alert" className="text-cell text-alert sm:col-span-4">
              No {sell.unrated} rate on file, so the sell price cannot be shown in {baseCode}. Set one on Settings →
              Currency.
            </p>
          )}
        </dl>
        {view.editable && (
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save cost details'}
          </Button>
        )}
      </section>
    </div>
  );
}
