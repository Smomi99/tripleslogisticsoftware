'use client';

import type { CarrierPositionDto, CarrierPositionSort, InquiryDto } from '@ff/shared';
import { useCallback, useEffect, useState } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Who serves this lane, and how well (§6.2).
 *
 * The rankings in carrier_port_pair were built in CR-001 and have had nowhere
 * to be read since. This is the screen they were built for: a salesman looking
 * at an inquiry, deciding who to ask.
 *
 * Both orderings are offered because they routinely disagree. The cheapest
 * carrier on a lane is rarely the one you would put urgent cargo on, and a
 * screen that showed only one of the two would quietly make that decision for
 * the operator.
 */
export function CarrierPositionDrawer({
  inquiry,
  onClose,
}: {
  inquiry: InquiryDto | null;
  onClose: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [rows, setRows] = useState<CarrierPositionDto[] | null>(null);
  const [sort, setSort] = useState<CarrierPositionSort>('price');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (inquiry === null) return;
    setRows(null);
    setError(null);
    try {
      setRows(
        await authorizedRequest<CarrierPositionDto[]>(
          `/api/tenant/sales/inquiries/${inquiry.id}/carrier-position?sort=${sort}`,
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not load the lane ranking.',
      );
    }
  }, [authorizedRequest, inquiry, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  if (inquiry === null) return null;

  const lane = `${inquiry.polCode} → ${inquiry.podCode}`;

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Carrier position — ${lane}`}
      description="Who serves this lane, ranked. Cheapest is not always best served."
      size="wide"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="label-manifest">Rank by</span>
          {(
            [
              ['price', 'Cheapest first'],
              ['service', 'Best service first'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setSort(value)}
              className={
                sort === value
                  ? 'rounded-manifest border border-harbour bg-harbour px-2.5 py-1 text-cell text-white'
                  : 'rounded-manifest border border-line bg-surface px-2.5 py-1 text-cell text-hull hover:bg-row-hover'
              }
            >
              {label}
            </button>
          ))}
        </div>

        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}
        {rows === null && error === null && <p className="text-cell text-steel">Loading…</p>}

        {rows !== null && rows.length === 0 && (
          <EmptyState
            title="No carriers ranked on this lane"
            description="Add a service port pair on the carrier record to rank who is cheapest and who serves it best. Until then this lane has no standing to show."
          />
        )}

        {rows !== null && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-line bg-paper">
                  <th className="label-manifest px-3 py-2 text-left">Carrier</th>
                  <th className="label-manifest px-3 py-2 text-left">Type</th>
                  <th className="label-manifest px-3 py-2 text-right">Price rank</th>
                  <th className="label-manifest px-3 py-2 text-right">Service rank</th>
                  <th className="label-manifest px-3 py-2 text-left">Rates we hold</th>
                  <th className="label-manifest px-3 py-2 text-left">Remarks</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.carrierId}
                    className="border-b border-line last:border-0 hover:bg-row-hover"
                  >
                    <td className="bg-paper/40 px-3 py-2 text-cell text-hull">{row.carrierName}</td>
                    <td className="px-3 py-2 text-cell text-steel">
                      {row.carrierTypeName ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-hull">
                      {row.lowPricePosition ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-hull">
                      {row.servicePosition ?? '—'}
                    </td>
                    {/* A carrier ranked first on price that we hold no rate with
                        is a different conversation from one we already buy. */}
                    <td className="px-3 py-2 text-cell">
                      {row.liveRates === 0 ? (
                        <Status tone="inactive">None live</Status>
                      ) : (
                        <Status tone="active">
                          {row.liveRates} live
                        </Status>
                      )}
                    </td>
                    <td className="px-3 py-2 text-cell text-steel">{row.remarks ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-cell text-steel">
          An unranked carrier sorts last rather than first — nobody has judged them on this lane
          yet, and putting them at the top would be a recommendation we never made.
        </p>
      </div>
    </Modal>
  );
}
