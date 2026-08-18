'use client';

import type { InquiryDto, InquiryRateDto, InquiryRateMatchDto } from '@ff/shared';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * §5.5 Price — "opens matching rates for that lane/mode/validity, lets the user
 * attach one or more to the inquiry, and writes back Quoted Price".
 *
 * Buy price and margin appear only if the API sent them. It never sends them
 * without PURCHASE.RATE.VIEW_BUY_PRICE (§4 rule 5), so there is nothing to hide
 * here — the columns are simply absent from the data.
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
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [isLoading, setLoading] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const [m, a] = await Promise.all([
          authorizedList<InquiryRateMatchDto[]>(
            `/api/tenant/sales/inquiries/${id}/matching-rates`,
          ),
          authorizedList<InquiryRateDto[]>(`/api/tenant/sales/inquiries/${id}/rates`),
        ]);
        setMatches(m.data);
        setAttached(a.data);
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not load rates.');
      } finally {
        setLoading(false);
      }
    },
    [authorizedList],
  );

  useEffect(() => {
    if (inquiry === null) return;
    setPicked(new Set());
    void load(inquiry.id);
  }, [inquiry, load]);

  if (inquiry === null) return null;

  const attachedLineIds = new Set(attached.map((a) => a.rateLineId));

  async function attach(): Promise<void> {
    if (inquiry === null || picked.size === 0) return;
    setSaving(true);
    try {
      await authorizedRequest(`/api/tenant/sales/inquiries/${inquiry.id}/rates`, {
        method: 'POST',
        body: { rateLineIds: [...picked] },
      });
      toast.success(picked.size === 1 ? 'Rate attached' : `${picked.size} rates attached`);
      setPicked(new Set());
      await load(inquiry.id);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not attach the rate.');
    } finally {
      setSaving(false);
    }
  }

  async function select(inquiryRateId: string): Promise<void> {
    if (inquiry === null) return;
    setSaving(true);
    try {
      await authorizedRequest(`/api/tenant/sales/inquiries/${inquiry.id}/rates/select`, {
        method: 'POST',
        body: { inquiryRateId },
      });
      toast.success('Quoted price updated');
      await load(inquiry.id);
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
              {attached.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 border-b border-line pb-1.5"
                >
                  <span className="flex items-center gap-2">
                    <Status tone={row.isSelected ? 'active' : 'inactive'}>
                      {row.isSelected ? 'Quoted' : 'Attached'}
                    </Status>
                    <span className="text-body text-hull">{row.carrierName}</span>
                    <span className="text-cell text-steel">{row.tierLabel}</span>
                    {row.isStale && (
                      <span className="text-cell text-signal">rate has since changed</span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="font-mono text-cell text-hull">
                      {row.currencyCode} {row.quotedPrice}
                    </span>
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
                </li>
              ))}
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
                    <span className="text-body text-hull">{rate.carrierName}</span>
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
                      return (
                        <li key={line.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            id={`line-${line.id}`}
                            className="size-3.5 accent-harbour"
                            disabled={already}
                            checked={already || picked.has(line.id)}
                            onChange={(event) => {
                              const next = new Set(picked);
                              if (event.target.checked) next.add(line.id);
                              else next.delete(line.id);
                              setPicked(next);
                            }}
                          />
                          <label
                            htmlFor={`line-${line.id}`}
                            className="flex flex-1 items-center justify-between gap-3 text-cell"
                          >
                            <span className="text-hull">{line.tierLabel}</span>
                            <span className="flex items-center gap-3 font-mono">
                              {line.buyPrice !== undefined && (
                                <span className="text-steel">buy {line.buyPrice}</span>
                              )}
                              <span className="text-hull">
                                {rate.currencyCode} {line.sellPrice}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button disabled={isSaving || picked.size === 0} onClick={() => void attach()}>
            {isSaving ? 'Attaching…' : `Attach ${picked.size === 0 ? '' : picked.size} `.trim()}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
