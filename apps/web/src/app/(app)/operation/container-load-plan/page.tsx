'use client';

import type { ClpBookingRow } from '@ff/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Cargo Load Plan - SEA, the booking selector — MODULE_CLP.md §5.1.
 *
 * Only bookings whose goods are in at CFS appear: §1 puts the CLP after cargo
 * receipt, so a booking with nothing received has nothing to plan and would
 * only be a row nobody can act on.
 *
 * The two figures on the right are what a planner actually chooses by — how
 * many containers are planned already, and how many cartons are still waiting
 * for one.
 */
export default function ContainerLoadPlanPage() {
  const { authorizedList, can } = useSession();
  const [rows, setRows] = useState<ClpBookingRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (term: string) => {
      setLoading(true);
      try {
        const query = term.trim() === '' ? '' : `?search=${encodeURIComponent(term.trim())}`;
        const result = await authorizedList<ClpBookingRow[]>(
          `/api/tenant/ops/clp-bookings${query}`,
        );
        setRows(result.data);
      } catch (error) {
        toast.error(
          error instanceof ApiError ? error.message : 'Could not load the bookings.',
        );
      } finally {
        setLoading(false);
      }
    },
    [authorizedList],
  );

  useEffect(() => {
    const id = setTimeout(() => void load(search), search === '' ? 0 : 300);
    return () => clearTimeout(id);
  }, [load, search]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cargo Load Plan"
        description="Bookings with cargo received at CFS, waiting to be planned into containers."
      />

      <Input
        type="search"
        placeholder="Booking number or customer"
        aria-label="Search bookings"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="max-w-80"
      />

      {loading ? (
        <p className="text-body text-steel">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing to plan yet"
          description="A booking appears here once its cargo has been received and accepted at the CFS."
        />
      ) : (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full min-w-[1100px] border-collapse text-cell">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Booking No</th>
                <th className="label-manifest px-3 py-2 text-left">S/O No</th>
                <th className="label-manifest px-3 py-2 text-left">Customer</th>
                <th className="label-manifest px-3 py-2 text-left">Exporter</th>
                <th className="label-manifest px-3 py-2 text-left">Commodity</th>
                <th className="label-manifest px-3 py-2 text-left">POL</th>
                <th className="label-manifest px-3 py-2 text-left">POD</th>
                <th className="label-manifest px-3 py-2 text-left">Required Container</th>
                <th className="label-manifest px-3 py-2 text-left">Carrier</th>
                <th className="label-manifest px-3 py-2 text-right">Planned</th>
                <th className="label-manifest px-3 py-2 text-right">Unassigned CTN</th>
                <th className="label-manifest px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.shipmentId} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-mono tabular-nums text-hull">{row.code}</td>
                  <td className="px-3 py-2 font-mono tabular-nums text-steel">
                    {row.shippingOrderCode ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-hull">{row.customerName}</td>
                  <td className="px-3 py-2 text-steel">{row.exporterName ?? '—'}</td>
                  <td className="px-3 py-2 text-steel">{row.commodity}</td>
                  <td className="px-3 py-2 text-hull">{row.polName}</td>
                  <td className="px-3 py-2 text-hull">{row.podName}</td>
                  <td className="px-3 py-2 font-mono tabular-nums text-hull">
                    {row.requiredContainer}
                  </td>
                  <td className="px-3 py-2 text-steel">{row.carrierName ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-hull">
                    {row.plannedCount}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {/*
                      The number that says whether this booking still needs
                      work. Zero left is the finish line, so it reads quietly
                      rather than as an alert.
                    */}
                    {row.unallocatedCtnQty === 0 ? (
                      <Status tone="active">All assigned</Status>
                    ) : (
                      <span className="text-hull">{row.unallocatedCtnQty}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {can('OPERATION.CONTAINER_LOAD_PLAN.VIEW') && (
                      <Button variant="text" size="inline" asChild>
                        <Link href={`/operation/container-load-plan/${row.shipmentId}`}>
                          {row.plannedCount === 0 ? 'Make CLP' : 'Open CLP'}
                        </Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
