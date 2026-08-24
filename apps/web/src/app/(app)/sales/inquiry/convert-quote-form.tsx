'use client';

import type { InquiryDto, LookupOption, StaffAgentQuoteDto } from '@ff/shared';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Turning an accepted agent quote into a purchase rate.
 *
 * The agent's price becomes a real bought rate with `purchase source = AGENT`,
 * which is how this product already models buying from an agent — rather than a
 * parallel path bolted onto the inquiry. Once it exists it behaves like any
 * other rate: add margin on the Add-on screen, publish it, attach it with
 * Price, and it can be reused on the next inquiry for the same lane.
 *
 * Three fields cannot be derived and so are asked for. A quote is one all-in
 * figure (decision 3) and carries no carrier, no commodity and no equipment
 * size; guessing any of them would be inventing a business rule (§10 rule 2).
 * Everything else comes from the quote and the inquiry.
 *
 * Created as a DRAFT deliberately. Publishing at zero margin would put an
 * unpriced rate live on the lane, which is exactly what the purchase route
 * warns against: the buyer records the cost, pricing adds the margin.
 */

interface RateOptions {
  carriers: LookupOption[];
  goodsTypes: LookupOption[];
  tiers: { id: string; code: string; label: string }[];
}

export type ConvertMode = 'SEA_FCL' | 'SEA_LCL' | 'AIR';

/**
 * Which Purchase screen a converted rate would belong to.
 *
 * Exported so the caller can ask for the RIGHT permission. Hard-coding the FCL
 * feature would hide the action from someone who may price LCL, and offer it to
 * someone who may not.
 */
export const CONVERT_FEATURE: Record<ConvertMode, string> = {
  SEA_FCL: 'PURCHASE.SEA_FREIGHT_FCL',
  SEA_LCL: 'PURCHASE.SEA_FREIGHT_LCL',
  AIR: 'PURCHASE.AIR_FREIGHT_PURCHASE',
};

/** The rate mode this inquiry belongs to. Sea splits by loading type. */
export function modeOf(inquiry: InquiryDto): ConvertMode | null {
  if (inquiry.shipmentType === 'AIR') return 'AIR';
  if (inquiry.loadingType === 'FCL') return 'SEA_FCL';
  if (inquiry.loadingType === 'LCL') return 'SEA_LCL';
  return null;
}

/** "1450.5" -> "1,450.50", so the figure reads the same as it does everywhere. */
function money(amount: string): string {
  const value = Number(amount);
  return Number.isFinite(value)
    ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : amount;
}

const today = () => new Date().toISOString().slice(0, 10);

function plusDays(from: string, days: number): string {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function ConvertQuoteForm({
  inquiry,
  quote,
  onClose,
  onConverted,
}: {
  inquiry: InquiryDto;
  quote: StaffAgentQuoteDto | null;
  onClose: () => void;
  onConverted: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [options, setOptions] = useState<RateOptions | null>(null);
  const [carrierId, setCarrierId] = useState('');
  const [goodsTypeId, setGoodsTypeId] = useState('');
  const [tierId, setTierId] = useState('');
  const [validFrom, setValidFrom] = useState(today());
  const [validTo, setValidTo] = useState('');
  const [optionId, setOptionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mode = modeOf(inquiry);

  const load = useCallback(async () => {
    if (quote === null || mode === null) return;
    setError(null);
    try {
      setOptions(await authorizedRequest<RateOptions>(`/api/tenant/purchase/rate-options?mode=${mode}`));
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not load the carriers and tiers for this mode.',
      );
    }
  }, [authorizedRequest, quote, mode]);

  useEffect(() => {
    void load();
    if (quote !== null) {
      setOptionId(quote.options[0]?.id ?? '');
    }
  }, [load, quote]);

  /*
   * Which offer is being filed.
   *
   * A quotation can carry several alternatives now, and they are genuinely
   * different rates — a different carrier, a different transit, a different
   * price. Only one of them is the one you booked, so the buyer says which
   * rather than the screen guessing.
   */
  const chosen = quote?.options.find((o) => o.id === optionId) ?? quote?.options[0] ?? null;

  /*
   * The buy price.
   *
   * Every charge on the option, added up. A purchase rate holds one buy price
   * per tier, and splitting the breakdown into freight-plus-local-charges would
   * mean deciding which cost head counts as the freight — a rule nobody has
   * stated, and not one to invent inside a conversion. The all-in figure is
   * what the agent will actually invoice, so it is the honest cost to file.
   *
   * An option priced in two currencies has no single such figure, and is
   * refused below rather than silently converted at a rate nobody quoted.
   */
  const totals = chosen?.totals ?? [];
  const single = totals.length === 1 ? totals[0]! : null;
  const buyPrice = chosen === null ? (quote?.amount ?? '') : (single?.amount ?? '');
  const buyCurrencyId = chosen === null ? (quote?.currencyId ?? '') : (single?.currencyId ?? '');
  const buyCurrencyCode = chosen === null ? (quote?.currencyCode ?? '') : (single?.currencyCode ?? '');
  const mixedCurrency = chosen !== null && totals.length > 1;
  const transitDays = chosen?.transitDays ?? quote?.transitDays ?? null;

  useEffect(() => {
    // The agent said how long this offer stands; that is the rate's validity
    // unless someone changes it here.
    if (quote === null) return;
    setValidTo(chosen?.validUntil ?? quote.validUntil ?? plusDays(today(), 30));
  }, [quote, chosen]);

  if (quote === null) return null;

  if (mode === null) {
    return (
      <Modal open onOpenChange={onClose} title="Convert to a purchase rate">
        <p className="text-body text-alert">
          This inquiry has no loading type, so there is no rate mode to file the price under. Set
          FCL or LCL on the inquiry first.
        </p>
      </Modal>
    );
  }

  async function submit(): Promise<void> {
    if (quote === null || mode === null) return;
    setError(null);
    setSaving(true);
    try {
      // Straight to the existing purchase endpoint, so every rule that governs
      // a hand-entered rate governs this one — the lane checks, the code
      // series, the overlap constraint, all of it.
      const created = await authorizedRequest<{ code: string }>('/api/tenant/purchase/rates', {
        method: 'POST',
        body: {
          mode,
          polId: inquiry.polId,
          podId: inquiry.podId,
          carrierId,
          goodsTypeId,
          purchaseSourceType: 'AGENT',
          purchaseAgentId: quote.agentId,
          currencyId: buyCurrencyId,
          validFrom,
          validTo,
          transitDays: transitDays === null ? '' : String(transitDays),
          remarks: [
            `From ${quote.agentName}, quote ${quote.code} on ${inquiry.code}`,
            chosen === null ? null : `option ${chosen.position}`,
            chosen?.carrierName == null ? null : `via ${chosen.carrierName}`,
            chosen?.via == null || chosen.via === '' ? null : `routed ${chosen.via}`,
          ]
            .filter((part) => part !== null)
            .join(', ') +
            `.${quote.remarks === null || quote.remarks === '' ? '' : ` ${quote.remarks}`}`,
          status: 'DRAFT',
          // Zero margin on purpose: the buyer records the cost, the price team
          // adds the profit on the Add-on screen.
          lines: [{ tierId, buyPrice, profitType: 'FLAT', profitValue: '0' }],
          localCharges: [],
        },
      });
      toast.success(`Saved as ${created.code} — a draft rate you can price and publish.`);
      onConverted();
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not create the rate. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  const ready =
    carrierId !== '' &&
    goodsTypeId !== '' &&
    tierId !== '' &&
    validTo !== '' &&
    buyPrice !== '' &&
    buyCurrencyId !== '' &&
    !mixedCurrency;

  return (
    <Modal
      open
      onOpenChange={onClose}
      title="Convert to a purchase rate"
      description={`${quote.agentName}'s price on ${inquiry.code} becomes a rate you can quote from and reuse.`}
    >
      <div className="flex flex-col gap-4">
        {quote.options.length > 1 && (
          <Field id="optionId" label="Which offer did you book" required>
            <Select id="optionId" value={optionId} onChange={(e) => setOptionId(e.target.value)}>
              {quote.options.map((option) => (
                <option key={option.id} value={option.id}>
                  Option {option.position}
                  {option.carrierName === null ? '' : ` · ${option.carrierName}`}
                  {option.transitDays === null ? '' : ` · ${option.transitDays} days`}
                  {option.totals.length === 1
                    ? ` · ${option.totals[0]!.currencyCode ?? ''} ${money(option.totals[0]!.amount)}`
                    : ''}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {mixedCurrency && (
          <p role="alert" className="text-cell text-alert">
            This offer is priced in more than one currency, so it has no single buy price. A
            purchase rate holds one. Ask the agent to requote it in one currency, or file the rate
            by hand.
          </p>
        )}

        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 rounded-manifest border border-line bg-paper px-3 py-2">
          <dt className="label-manifest self-center">Buy price</dt>
          <dd className="font-mono text-cell tabular-nums text-hull">
            {buyPrice === '' ? '—' : `${buyCurrencyCode ?? ''} ${money(buyPrice)}`}
            {chosen !== null && chosen.lines.length > 1 && (
              <span className="ml-2 font-sans text-cell text-steel">
                all {chosen.lines.length} charges combined
              </span>
            )}
          </dd>
          <dt className="label-manifest self-center">Bought from</dt>
          <dd className="text-cell text-hull">{quote.agentName}</dd>
          <dt className="label-manifest self-center">Lane</dt>
          <dd className="text-cell text-hull">
            {inquiry.polCode ?? inquiry.polName} → {inquiry.podCode ?? inquiry.podName}
          </dd>
        </dl>

        <p className="text-cell text-steel">
          A quote is one all-in figure, so it does not say which carrier, commodity or equipment it
          covers. Those three are yours to set.
        </p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id="carrierId" label="Carrier" required>
            <Select id="carrierId" value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
              <option value="">Choose…</option>
              {(options?.carriers ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="goodsTypeId" label="Goods type" required>
            <Select
              id="goodsTypeId"
              value={goodsTypeId}
              onChange={(e) => setGoodsTypeId(e.target.value)}
            >
              <option value="">Choose…</option>
              {(options?.goodsTypes ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="tierId"
            label="Applies to"
            required
            hint="Which container size or unit this price covers."
          >
            <Select id="tierId" value={tierId} onChange={(e) => setTierId(e.target.value)}>
              <option value="">Choose…</option>
              {(options?.tiers ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="validFrom" label="Valid from" required>
            <Input
              id="validFrom"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </Field>

          <Field
            id="validTo"
            label="Valid to"
            required
            hint={quote.validUntil === null ? undefined : 'Taken from the agent’s own validity.'}
          >
            <Input
              id="validTo"
              type="date"
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
            />
          </Field>
        </div>

        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}

        <p className="text-cell text-steel">
          It is saved as a <strong className="text-hull">draft</strong> at zero margin. Add your
          profit on Price Add-on, publish it, then attach it here with Price.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || saving} onClick={() => void submit()}>
            {saving ? 'Creating…' : 'Create draft rate'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
