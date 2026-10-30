'use client';

import type {
  InquiryChargeOptionsDto,
  InquiryDto,
  InquiryRateDto,
  InquiryRateMatchDto,
  RatePriceChangeDto,
} from '@ff/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import {
  type ChargeDraft,
  ChargePicker,
  draftFromAttached,
  draftFromRate,
  draftToInput,
  validateDraft,
} from './charge-picker';
import { PriceHistoryHover } from './price-history-hover';

/** The attached box whose charges are open for correction. */
interface Editing {
  inquiryRateId: string;
  draft: ChargeDraft;
  errors: Record<string, string>;
}

/**
 * §5.5 Price — "opens matching rates for that lane/mode/validity, lets the user
 * attach one or more to the inquiry, and writes back Quoted Price".
 *
 * Buy price and margin appear only if the API sent them. It never sends them
 * without PURCHASE.RATE.VIEW_BUY_PRICE (§4 rule 5), so there is nothing to hide
 * here — the columns are simply absent from the data.
 *
 * Since 2026-10-26 a container carries charges: ticking one offers the
 * purchase rate's local charges for that box, all in to start with, plus any
 * extras — and the quoted price is freight plus all of them. Every freight
 * figure shows its lane's price history on hover.
 */
export function PriceDrawer({
  inquiry,
  onClose,
  onChanged,
}: {
  inquiry: InquiryDto | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { authorizedList, authorizedRequest } = useSession();
  const [matches, setMatches] = useState<InquiryRateMatchDto[]>([]);
  const [attached, setAttached] = useState<InquiryRateDto[]>([]);
  const [options, setOptions] = useState<InquiryChargeOptionsDto | null>(null);
  /** Each ticked box and what it will carry, by rate line id. */
  const [picked, setPicked] = useState<Map<string, ChargeDraft>>(new Map());
  const [pickErrors, setPickErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Editing | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** One request per rate line while the drawer is open, however often it is hovered. */
  const histories = useRef(new Map<string, Promise<RatePriceChangeDto[]>>());

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const [m, a, o] = await Promise.all([
          authorizedList<InquiryRateMatchDto[]>(
            `/api/tenant/sales/inquiries/${id}/matching-rates`,
          ),
          authorizedList<InquiryRateDto[]>(`/api/tenant/sales/inquiries/${id}/rates`),
          authorizedRequest<InquiryChargeOptionsDto>(
            `/api/tenant/sales/inquiries/${id}/charge-options`,
          ),
        ]);
        setMatches(m.data);
        setAttached(a.data);
        setOptions(o);
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not load rates.');
      } finally {
        setLoading(false);
      }
    },
    [authorizedList, authorizedRequest],
  );

  useEffect(() => {
    if (inquiry === null) return;
    setPicked(new Map());
    setPickErrors({});
    setEditing(null);
    histories.current = new Map();
    void load(inquiry.id);
  }, [inquiry, load]);

  const historyOf = useCallback(
    (rateLineId: string): Promise<RatePriceChangeDto[]> => {
      const cached = histories.current.get(rateLineId);
      if (cached !== undefined) return cached;
      const request = authorizedRequest<RatePriceChangeDto[]>(
        `/api/tenant/sales/inquiries/${inquiry?.id ?? ''}/rate-lines/${rateLineId}/price-history`,
      );
      histories.current.set(rateLineId, request);
      // A failed lookup is not remembered, so hovering again retries it.
      request.catch(() => histories.current.delete(rateLineId));
      return request;
    },
    [authorizedRequest, inquiry],
  );

  if (inquiry === null) return null;

  const attachedLineIds = new Set(attached.map((a) => a.rateLineId));
  const settled = inquiry.status === 'WON';

  function pick(lineId: string, on: boolean, draft: ChargeDraft): void {
    const next = new Map(picked);
    if (on) next.set(lineId, draft);
    else next.delete(lineId);
    setPicked(next);
  }

  async function attach(): Promise<void> {
    if (inquiry === null || picked.size === 0) return;
    const errors = Object.assign({}, ...[...picked.values()].map(validateDraft)) as Record<
      string,
      string
    >;
    setPickErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const next = await authorizedRequest<InquiryRateDto[]>(
        `/api/tenant/sales/inquiries/${inquiry.id}/rates`,
        {
          method: 'POST',
          body: {
            lines: [...picked].map(([rateLineId, draft]) => ({
              rateLineId,
              ...draftToInput(draft),
            })),
          },
        },
      );
      toast.success(picked.size === 1 ? 'Rate attached' : `${picked.size} rates attached`);
      setAttached(next);
      setPicked(new Map());
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not attach the rate.');
    } finally {
      setSaving(false);
    }
  }

  async function saveCharges(): Promise<void> {
    if (inquiry === null || editing === null) return;
    const errors = validateDraft(editing.draft);
    if (Object.keys(errors).length > 0) {
      setEditing({ ...editing, errors });
      return;
    }
    setSaving(true);
    try {
      const next = await authorizedRequest<InquiryRateDto[]>(
        `/api/tenant/sales/inquiries/${inquiry.id}/rates/${editing.inquiryRateId}/charges`,
        { method: 'PUT', body: draftToInput(editing.draft) },
      );
      toast.success('Charges saved');
      setAttached(next);
      setEditing(null);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save the charges.');
    } finally {
      setSaving(false);
    }
  }

  async function select(inquiryRateId: string): Promise<void> {
    if (inquiry === null) return;
    setSaving(true);
    try {
      const next = await authorizedRequest<InquiryRateDto[]>(
        `/api/tenant/sales/inquiries/${inquiry.id}/rates/select`,
        { method: 'POST', body: { inquiryRateId } },
      );
      toast.success('Quoted price updated');
      setAttached(next);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not change the quote.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Price — ${inquiry.code} · ${inquiry.polCode} → ${inquiry.podCode}`}
      size="medium"
    >
      <div className="flex flex-col gap-4">
        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}

        {attached.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="label-manifest">Attached</p>
            <ul className="flex flex-col gap-1">
              {attached.map((row) => {
                const isOpen = editing?.inquiryRateId === row.id;
                return (
                  <li key={row.id} className="flex flex-col gap-1 border-b border-line pb-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Status tone={row.isSelected ? 'active' : 'inactive'}>
                          {row.isSelected ? 'Quoted' : 'Attached'}
                        </Status>
                        <span className="text-cell text-hull">{row.carrierName}</span>
                        <span className="text-cell text-steel">{row.tierLabel}</span>
                        {row.isStale && (
                          <span className="text-cell text-signal">rate has since changed</span>
                        )}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="whitespace-nowrap font-mono text-cell text-hull">
                          {row.currencyCode} {row.quotedPrice}
                        </span>
                        {!settled && options !== null && (
                          <Button
                            variant="text"
                            size="inline"
                            disabled={isSaving}
                            aria-expanded={isOpen}
                            onClick={() =>
                              setEditing(
                                isOpen
                                  ? null
                                  : {
                                      inquiryRateId: row.id,
                                      draft: draftFromAttached(row.charges),
                                      errors: {},
                                    },
                              )
                            }
                          >
                            Charges
                          </Button>
                        )}
                        {!row.isSelected && (
                          <Button
                            variant="text"
                            size="inline"
                            disabled={isSaving}
                            onClick={() => void select(row.id)}
                          >
                            Quote this
                          </Button>
                        )}
                      </span>
                    </div>
                    {/* How the quoted figure is made up. */}
                    <p className="flex flex-wrap items-center gap-x-2 text-cell text-steel">
                      <span>
                        freight{' '}
                        <span className="font-mono">
                          <PriceHistoryHover
                            title={`${row.carrierName} · ${row.tierLabel}`}
                            load={() => historyOf(row.rateLineId)}
                          >
                            {row.currencyCode} {row.freightPrice}
                          </PriceHistoryHover>
                        </span>
                      </span>
                      {row.charges.map((charge) => (
                        <span key={charge.id}>
                          + {charge.costHeadName}{' '}
                          <span className="font-mono">
                            {charge.currencyCode} {charge.amount}
                          </span>
                        </span>
                      ))}
                    </p>
                    {isOpen && options !== null && (
                      <div className="flex flex-col gap-2">
                        <ChargePicker
                          idPrefix={`attached-${row.id}`}
                          available={row.availableCharges}
                          carried={row.charges}
                          value={editing.draft}
                          onChange={(draft) => setEditing({ ...editing, draft, errors: {} })}
                          options={options}
                          freight={{ currencyCode: row.currencyCode, price: row.freightPrice }}
                          errors={editing.errors}
                          disabled={isSaving}
                        />
                        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                          <Button
                            variant="secondary"
                            size="compact"
                            disabled={isSaving}
                            onClick={() => setEditing(null)}
                            className="max-sm:w-full"
                          >
                            Cancel
                          </Button>
                          <Button
                            size="compact"
                            disabled={isSaving}
                            onClick={() => void saveCharges()}
                            className="max-sm:w-full"
                          >
                            {isSaving ? 'Saving…' : 'Save charges'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <p className="label-manifest">Rates live today on this lane</p>
          {isLoading ? (
            <p className="text-cell text-steel">Loading…</p>
          ) : matches.length === 0 ? (
            <EmptyState
              title="No live rate for this lane"
              description="Nothing published covers this POL and POD today. Ask the pricing team to buy the lane, then price this inquiry."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {matches.map((rate) => (
                <li key={rate.rateId} className="flex flex-col gap-1 border-b border-line pb-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-cell text-steel">{rate.rateCode}</span>
                    <span className="text-cell text-hull">{rate.carrierName}</span>
                    <span className="text-cell text-steel">
                      valid to <span className="font-mono">{rate.validTo}</span>
                    </span>
                    {rate.transitDays !== null && (
                      <span className="text-cell text-steel">{rate.transitDays}d transit</span>
                    )}
                    {rate.freeDays !== null && (
                      <span className="text-cell text-steel">{rate.freeDays} free days</span>
                    )}
                  </span>
                  <ul className="flex flex-col gap-0.5 pl-1">
                    {rate.lines.map((line) => {
                      const already = attachedLineIds.has(line.id);
                      const draft = picked.get(line.id);
                      return (
                        <li key={line.id} className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2 text-cell">
                            <input
                              type="checkbox"
                              id={`line-${line.id}`}
                              className="size-4 accent-harbour sm:size-3.5"
                              disabled={already || settled}
                              checked={already || draft !== undefined}
                              onChange={(event) =>
                                pick(line.id, event.target.checked, draftFromRate(line.charges))
                              }
                            />
                            {/* The label covers the size only: the price beside it
                                opens its history, and must not tick the box. */}
                            <label htmlFor={`line-${line.id}`} className="flex-1 text-hull">
                              {line.tierLabel}
                              {line.charges.length > 0 && !already && draft === undefined && (
                                <span className="ml-2 text-steel">
                                  {line.charges.length === 1
                                    ? '1 local charge'
                                    : `${line.charges.length} local charges`}
                                </span>
                              )}
                            </label>
                            <span className="ml-auto flex items-center gap-3 font-mono">
                              {line.buyPrice !== undefined && (
                                <span className="text-steel">buy {line.buyPrice}</span>
                              )}
                              <span className="text-hull">
                                <PriceHistoryHover
                                  title={`${rate.carrierName} · ${line.tierLabel}`}
                                  load={() => historyOf(line.id)}
                                >
                                  {rate.currencyCode} {line.sellPrice}
                                </PriceHistoryHover>
                              </span>
                            </span>
                          </div>
                          {draft !== undefined && options !== null && (
                            <div className="sm:pl-5">
                              <ChargePicker
                                idPrefix={`line-${line.id}`}
                                available={line.charges}
                                value={draft}
                                onChange={(next) => {
                                  pick(line.id, true, next);
                                  setPickErrors({});
                                }}
                                options={options}
                                freight={{ currencyCode: rate.currencyCode, price: line.sellPrice }}
                                errors={pickErrors}
                                disabled={isSaving}
                              />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} className="max-sm:w-full">
            Close
          </Button>
          <Button
            disabled={isSaving || picked.size === 0}
            onClick={() => void attach()}
            className="max-sm:w-full"
          >
            {isSaving ? 'Attaching…' : `Attach ${picked.size === 0 ? '' : picked.size} `.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
