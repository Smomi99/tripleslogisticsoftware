'use client';

import type { ClpListRow, ClpStatus } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { type FamilyTab, familyInSentence, loadingLabel } from './clp-labels';

/**
 * Container Load Plan → Container plans: every plan made, and where it stands.
 *
 * The same table every list in the product uses, so the register reads like
 * the Customer or Carrier list rather than like a different application: row
 * numbers, the CLP number on the stencilled gutter, a sticky Action column, a
 * density toggle and a pager — this list used to stop silently at 25 rows.
 */

const LIMIT = 25;

const pct = (v: string | null): string =>
  v === null ? '—' : `${(Number(v) * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}%`;

export function ClpRegister({
  family,
  search,
  status,
}: {
  family: FamilyTab;
  search: string;
  status: '' | ClpStatus;
}) {
  const { authorizedList } = useSession();
  const [rows, setRows] = useState<ClpListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState(true);

  // A new question starts from the first page.
  useEffect(() => setPage(1), [family, search, status]);

  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      void (async () => {
        setPending(true);
        try {
          const query = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
          if (family !== '') query.set('family', family);
          if (status !== '') query.set('status', status);
          if (search.trim() !== '') query.set('search', search.trim());
          const result = await authorizedList<ClpListRow[]>(`/api/tenant/ops/clps?${query.toString()}`);
          if (!cancelled) {
            setRows(result.data);
            setTotal(result.meta?.total ?? result.data.length);
          }
        } catch (error) {
          if (!cancelled) {
            toast.error(error instanceof ApiError ? error.message : 'Could not load the container plans.');
          }
        } finally {
          if (!cancelled) setPending(false);
        }
      })();
    }, search === '' ? 0 : 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [authorizedList, family, page, search, status]);

  const columns: DataTableColumn<ClpListRow>[] = useMemo(
    () => [
      {
        id: 'booking',
        header: 'Booking No',
        numeric: true,
        cell: (r) => (
          <>
            <span className="block whitespace-nowrap">
              {r.bookingCode}
              {/* A shared container is the one row where "whose cargo" is more than this booking. */}
              {r.bookingCount > 1 && <span className="ml-1.5 text-steel">+{r.bookingCount - 1}</span>}
            </span>
            <span className="block font-sans text-cell text-steel">{loadingLabel(r.loadingType)}</span>
          </>
        ),
      },
      { id: 'customer', header: 'Customer', cell: (r) => r.customerName },
      {
        id: 'route',
        header: 'Route',
        cell: (r) => `${r.polName} → ${r.podName}`,
      },
      {
        id: 'container',
        header: 'Container',
        numeric: true,
        cell: (r) => (
          <>
            <span className="block whitespace-nowrap">{r.containerSizeCode}</span>
            {/* A draft has no container number by definition — say so in words, not a code. */}
            {r.containerNo === null ? (
              <span className="block whitespace-nowrap font-sans text-cell text-steel">no number yet</span>
            ) : (
              <span className="block whitespace-nowrap">{r.containerNo}</span>
            )}
          </>
        ),
      },
      { id: 'ctn', header: 'CTN', align: 'right', numeric: true, cell: (r) => r.totalCtnQty },
      { id: 'fill', header: 'Volume', align: 'right', numeric: true, cell: (r) => pct(r.volumeUtilisation) },
      {
        id: 'status',
        header: 'Status',
        cell: (r) => (
          <Status tone={r.status === 'FINAL' ? 'active' : r.status === 'CANCELLED' ? 'inactive' : 'pending'}>
            {r.status === 'FINAL' ? 'Final' : r.status === 'CANCELLED' ? 'Cancelled' : 'Draft'}
          </Status>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      getCode={(r) => r.code}
      codeHeader="CLP No"
      total={total}
      page={page}
      limit={LIMIT}
      sortOrder="desc"
      onSortChange={() => undefined}
      onPageChange={setPage}
      isPending={pending}
      actions={(r) => (
        <Button variant="text" size="inline" asChild>
          <Link href={`/operation/container-load-plan/${r.shipmentId}` as Route}>
            {r.status === 'DRAFT' ? 'Finalise' : 'Open'}
          </Link>
        </Button>
      )}
      empty={
        <EmptyState
          title={family === '' ? 'No container plans yet' : `No ${familyInSentence(family)} container plan`}
          description={
            search.trim() !== '' || status !== ''
              ? 'Nothing matches that search. Clear it to see every plan.'
              : 'Tick POs under To plan and create a container plan — it will be listed here.'
          }
        />
      }
    />
  );
}
