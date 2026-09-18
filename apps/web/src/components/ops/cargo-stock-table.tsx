'use client';

import { type CargoStockRow, LOADING_TYPE_LABEL } from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Cargo Receipt → Available stock (client spec, 2026-09-18).
 *
 * "This available stock list is ready for make CLP. You can make category of
 * FCL, LCL and CONSOLE BOX. After made CLP it will not show in available
 * stock."
 *
 * So every row here is cargo physically in hand and free to load, and the row
 * leaves the moment a load plan claims its last carton. The figures come from
 * the same loader the CLP screen allocates against, so what this screen offers
 * and what that screen can actually take are one number.
 *
 * A sibling of the worklist table rather than a tab of it: the others count
 * bookings in a state, this one counts cartons.
 */

const FAMILIES = [
  { id: '', label: 'All categories' },
  { id: 'FCL', label: 'FCL' },
  { id: 'LCL', label: 'LCL' },
  { id: 'CONSOL_BOX', label: 'Consol box' },
];

interface Meta {
  page: number;
  limit: number;
  total: number;
}

export function CargoStockTable({
  search,
  shipmentType,
}: {
  search: string;
  shipmentType: string;
}) {
  const { authorizedList, can } = useSession();

  const [rows, setRows] = useState<CargoStockRow[]>([]);
  const [meta, setMeta] = useState<Meta>({ page: 1, limit: 25, total: 0 });
  const [page, setPage] = useState(1);
  const [family, setFamily] = useState('');
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The filters live on the screen above, so a change up there starts again
  // from page one down here.
  useEffect(() => {
    setPage(1);
  }, [search, shipmentType, family]);

  useEffect(() => {
    let cancelled = false;
    setPending(true);

    const params = new URLSearchParams({ page: String(page), limit: '25' });
    if (search !== '') params.set('search', search);
    if (shipmentType !== '') params.set('shipmentType', shipmentType);
    if (family !== '') params.set('family', family);

    void authorizedList<CargoStockRow[]>(`/api/tenant/ops/cargo-stock?${params.toString()}`)
      .then((result) => {
        if (cancelled) return;
        setRows(result.data);
        if (result.meta !== undefined) setMeta(result.meta);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load available stock.');
        }
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authorizedList, family, page, search, shipmentType]);

  const columns: DataTableColumn<CargoStockRow>[] = useMemo(
    () => [
      { id: 'customer', header: 'Customer', cell: (r) => r.customerName },
      {
        id: 'exporter',
        header: 'Exporter',
        cell: (r) => r.exporterName ?? '—',
      },
      {
        id: 'category',
        header: 'Category',
        // The client's three: FCL, LCL and Consol box.
        cell: (r) => (r.family === null ? '—' : LOADING_TYPE_LABEL[r.family]),
      },
      { id: 'so', header: 'S/O No', cell: (r) => r.shippingOrderCode ?? '—' },
      {
        // Where the goods physically are. A booking delivered in three drops
        // genuinely has three, so all of them show.
        id: 'cfs',
        header: 'Unload location',
        cell: (r) => (r.cfsLocations.length === 0 ? '—' : r.cfsLocations.join(', ')),
      },
      { id: 'pod', header: 'POD', cell: (r) => r.podName },
      {
        id: 'received',
        header: 'Received',
        numeric: true,
        cell: (r) => `${r.receivedCtnQty} CTN`,
      },
      {
        // The figure the whole tab turns on: what a CLP could take right now.
        id: 'available',
        header: 'Available',
        numeric: true,
        cell: (r) => `${r.availableCtnQty} CTN`,
      },
      { id: 'cbm', header: 'CBM', numeric: true, cell: (r) => r.availableCbm },
      {
        id: 'kg',
        header: 'Gross KG',
        numeric: true,
        cell: (r) => r.availableGrossKg,
      },
      {
        id: 'cutoff',
        header: 'Cut off',
        numeric: true,
        cell: (r) => r.cutOffDate?.slice(0, 10) ?? '—',
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-52 flex-col gap-1">
        <span className="label-manifest">Category</span>
        <Select
          aria-label="Loading category"
          value={family}
          onChange={(e) => setFamily(e.target.value)}
        >
          {FAMILIES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.shipmentId}
        getCode={(r) => r.code}
        total={meta.total}
        page={page}
        limit={meta.limit}
        /*
          Fixed order, so nothing here can be sorted: stock that has sat at the
          CFS longest is the stock costing storage, and that is the order it is
          worked in. No column is marked sortable, so this never fires.
        */
        sortOrder="asc"
        onSortChange={() => undefined}
        onPageChange={setPage}
        isPending={isPending}
        actions={(row) => (
          <>
            {can('OPERATION.CONTAINER_LOAD_PLAN.CREATE') && (
              <Link
                href={`/operation/container-load-plan?booking=${row.shipmentId}`}
                className="text-body text-harbour hover:underline"
              >
                Make CLP
              </Link>
            )}
            <Link
              href={`/cs/shipment-booking/${row.shipmentId}?tab=cargo-receipt`}
              className="text-body text-steel hover:underline"
            >
              Receipt
            </Link>
          </>
        )}
        empty={
          <EmptyState
            title="No stock waiting to be loaded"
            description="Cargo appears here once a receipt is confirmed, and leaves it once a load plan takes the last carton."
          />
        }
      />
    </div>
  );
}
