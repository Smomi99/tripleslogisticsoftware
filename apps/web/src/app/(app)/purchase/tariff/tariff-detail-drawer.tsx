'use client';

import { MOVEMENT_TYPE_LABEL, TARIFF_TYPE_LABEL, type TariffDto, type TariffListRow } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ActiveStatus } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * One tariff, read without leaving the list (client, 2026-10-07).
 *
 * The list carries the header and a count of charges; the charges themselves
 * are what somebody opening a tariff wants to read, and the edit form is the
 * wrong place to read them — it is how a figure gets changed by accident, and
 * a user with VIEW alone cannot open it at all. So the charges are fetched
 * here, with the same VIEW the list needs.
 */
export function TariffDetailDrawer({ row, onClose }: { row: TariffListRow | null; onClose: () => void }) {
  const { authorizedRequest, can } = useSession();
  const [tariff, setTariff] = useState<TariffDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTariff(null);
    setError(null);
    if (row === null) return;
    let live = true;
    authorizedRequest<TariffDto>(`/api/tenant/purchase/tariffs/${row.id}`)
      .then((data) => {
        if (live) setTariff(data);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not open the tariff.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, row]);

  if (row === null) return null;

  // The row is on screen already, so the header shows at once; the charges follow.
  const shown = tariff ?? row;
  const facts: [string, string][] = [
    ['Country', shown.country],
    ['POL', `${shown.polName} (${shown.polCode})`],
    ['Movement Type', MOVEMENT_TYPE_LABEL[shown.movementType]],
    ['Tariff Type', TARIFF_TYPE_LABEL[shown.tariffType]],
  ];

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Tariff ${shown.code}`}
      description={`${TARIFF_TYPE_LABEL[shown.tariffType]} at ${shown.polName}, ${MOVEMENT_TYPE_LABEL[shown.movementType].toLowerCase()}.`}
      size="wide"
    >
      <div className="flex flex-col gap-5">
        <ActiveStatus isActive={shown.isActive} />

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="label-manifest">{label}</dt>
              <dd className="text-body text-hull">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="text-section text-hull">Charges</h3>
          {error !== null ? (
            <p role="alert" className="text-body text-alert">
              {error}
            </p>
          ) : tariff === null ? (
            <p className="text-body text-steel">Loading the charges…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-cell">
                <thead>
                  <tr className="border-b border-line bg-paper text-left">
                    <th className="label-manifest px-2 py-2 text-right">SL No</th>
                    <th className="label-manifest px-2 py-2">Cost Head</th>
                    <th className="label-manifest px-2 py-2">Container Size</th>
                    <th className="label-manifest px-2 py-2">Unit</th>
                    <th className="label-manifest px-2 py-2 text-right">Unit Price</th>
                    <th className="label-manifest px-2 py-2">Currency</th>
                  </tr>
                </thead>
                <tbody>
                  {tariff.lines.map((line, index) => (
                    <tr key={line.id} className="border-b border-line">
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-steel">{index + 1}</td>
                      <td className="px-2 py-2 text-hull">{line.costHeadName}</td>
                      <td className="px-2 py-2 font-mono tabular-nums text-hull">{line.containerSizeName ?? '—'}</td>
                      <td className="px-2 py-2 text-hull">{line.unitName}</td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-hull">{price(line.unitPrice)}</td>
                      <td className="px-2 py-2 font-mono text-hull">{line.currencyCode}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {can('PURCHASE.TARIFF.EDIT') && (
          <div className="flex justify-end border-t border-line pt-4">
            <Button variant="secondary" asChild>
              <Link href={`/purchase/tariff/${row.id}` as Route}>Edit tariff</Link>
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** "1250.0000" → "1,250.00"; "0.0125" keeps its four places. The stored value is untouched. */
function price(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
