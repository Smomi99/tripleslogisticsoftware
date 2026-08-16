'use client';

import {
  createColumnHelper,
  type RowData,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';

/*
 * The list table every §8 master-data screen reuses.
 *
 * Sorting and pagination are SERVER-side (§9: every list endpoint takes page,
 * limit, search, sortBy, sortOrder, isActive), so no sorted or paginated row
 * model is registered here — the header click and the pager both just change
 * the query. TanStack owns the column and row model; this component owns the
 * §12 markup, stickiness and density.
 */

const features = tableFeatures({});

export interface DataTableColumn<T extends RowData> {
  /** Must match the API's sortBy value when sortable. */
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** §12: numbers right-aligned, and the header follows its column. */
  align?: 'left' | 'right';
  /** Renders mono with tabular figures — identifiers, codes, rates, dates. */
  numeric?: boolean;
  sortable?: boolean;
  className?: string;
}

export interface DataTableProps<T extends RowData> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** The business code for the stencilled gutter column (§12). */
  getCode: (row: T) => string;
  codeHeader?: string;
  total: number;
  page: number;
  limit: number;
  sortBy?: string | undefined;
  sortOrder: 'asc' | 'desc';
  onSortChange: (sortBy: string, sortOrder: 'asc' | 'desc') => void;
  onPageChange: (page: number) => void;
  /** Row actions — Edit, Active/Inactive, plus any contextual §8 buttons. */
  actions?: (row: T) => ReactNode;
  isPending?: boolean;
  empty: ReactNode;
}

type Density = 'comfortable' | 'compact';
const DENSITY_KEY = 'ff.table.density';

/** §12: ship a density toggle, persisted per user. */
function useDensity(): [Density, (d: Density) => void] {
  const [density, setDensity] = useState<Density>('comfortable');

  useEffect(() => {
    const stored = window.localStorage.getItem(DENSITY_KEY);
    if (stored === 'compact' || stored === 'comfortable') setDensity(stored);
  }, []);

  const update = useCallback((next: Density) => {
    setDensity(next);
    window.localStorage.setItem(DENSITY_KEY, next);
  }, []);

  return [density, update];
}

export function DataTable<T extends RowData>({
  columns,
  rows,
  getRowId,
  getCode,
  codeHeader = 'Code',
  total,
  page,
  limit,
  sortBy,
  sortOrder,
  onSortChange,
  onPageChange,
  actions,
  isPending = false,
  empty,
}: DataTableProps<T>) {
  const [density, setDensity] = useDensity();
  const rowHeight = density === 'compact' ? 'h-[30px]' : 'h-9';

  const helper = useMemo(() => createColumnHelper<typeof features, T>(), []);
  const tableColumns = useMemo(
    () =>
      helper.columns(
        columns.map((column) =>
          helper.display({ id: column.id, cell: ({ row }) => column.cell(row.original) }),
        ),
      ),
    [columns, helper],
  );

  const table = useTable({ features, columns: tableColumns, data: rows, getRowId });

  const firstRowNumber = (page - 1) * limit + 1;
  const lastRowNumber = Math.min(page * limit, total);
  const totalPages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;

  function toggleSort(column: DataTableColumn<T>): void {
    if (column.sortable !== true) return;
    const next = sortBy === column.id && sortOrder === 'asc' ? 'desc' : 'asc';
    onSortChange(column.id, next);
  }

  if (rows.length === 0 && !isPending) {
    return (
      <div className="rounded-manifest border border-line bg-surface shadow-manifest">
        {empty}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          'relative overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest',
          isPending && 'opacity-60',
        )}
      >
        <table className="w-full border-collapse text-cell">
          <thead className="sticky top-0 z-20">
            <tr className="bg-paper">
              {/* §8: SL No, then the client's exact columns, then Action. */}
              <th
                scope="col"
                className="label-manifest sticky left-0 z-30 w-14 border-b border-line bg-paper px-3 py-2 text-left"
              >
                SL
              </th>
              <th
                scope="col"
                className="label-manifest sticky left-14 z-30 border-b border-r border-line bg-paper px-3 py-2 text-left"
              >
                {codeHeader}
              </th>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={
                    sortBy === column.id
                      ? sortOrder === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={cn(
                    'label-manifest border-b border-line px-3 py-2',
                    column.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {column.sortable === true ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase hover:text-hull',
                        column.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {column.header}
                      {sortBy === column.id ? (
                        sortOrder === 'asc' ? (
                          <ArrowUp className="size-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3" aria-hidden="true" />
                        )
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
              {actions !== undefined && (
                <th
                  scope="col"
                  className="label-manifest sticky right-0 z-30 border-b border-l border-line bg-paper px-3 py-2 text-right"
                >
                  Action
                </th>
              )}
            </tr>
          </thead>

          <tbody>
            {table.getRowModel().rows.map((row, index) => (
              <tr
                key={row.id}
                className={cn('group border-b border-line last:border-b-0', rowHeight)}
              >
                <td className="sticky left-0 z-10 w-14 bg-surface px-3 text-steel transition-colors duration-[120ms] group-hover:bg-row-hover">
                  <span className="font-mono" data-numeric="">
                    {firstRowNumber + index}
                  </span>
                </td>
                {/*
                  §12: the business code sits in a faintly tinted gutter, in
                  mono — the stencilled container-marking reference, and the
                  anchor the eye returns to when scanning.
                */}
                <td className="sticky left-14 z-10 border-r border-line bg-paper/60 px-3 transition-colors duration-[120ms] group-hover:bg-row-hover">
                  <span className="font-mono text-hull" data-numeric="">
                    {getCode(row.original)}
                  </span>
                </td>
                {columns.map((column, columnIndex) => (
                  <td
                    key={column.id}
                    className={cn(
                      'bg-surface px-3 transition-colors duration-[120ms] group-hover:bg-row-hover',
                      column.align === 'right' ? 'text-right' : 'text-left',
                      column.numeric === true && 'font-mono',
                      column.className,
                    )}
                    {...(column.numeric === true ? { 'data-numeric': '' } : {})}
                  >
                    <table.FlexRender cell={row.getAllCells()[columnIndex]!} />
                  </td>
                ))}
                {actions !== undefined && (
                  <td className="sticky right-0 z-10 border-l border-line bg-surface px-3 text-right transition-colors duration-[120ms] group-hover:bg-row-hover">
                    <div className="flex items-center justify-end gap-3">
                      {actions(row.original)}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-cell text-steel">
          {total === 0 ? (
            'No records'
          ) : (
            <>
              <span className="font-mono text-hull" data-numeric="">
                {firstRowNumber}–{lastRowNumber}
              </span>{' '}
              of{' '}
              <span className="font-mono text-hull" data-numeric="">
                {total}
              </span>
            </>
          )}
        </p>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1">
            <span className="label-manifest">Density</span>
            <Button
              variant={density === 'comfortable' ? 'secondary' : 'text'}
              size="compact"
              aria-pressed={density === 'comfortable'}
              onClick={() => setDensity('comfortable')}
            >
              Default
            </Button>
            <Button
              variant={density === 'compact' ? 'secondary' : 'text'}
              size="compact"
              aria-pressed={density === 'compact'}
              onClick={() => setDensity('compact')}
            >
              Compact
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="compact"
              disabled={page <= 1 || isPending}
              onClick={() => onPageChange(page - 1)}
            >
              Previous
            </Button>
            <span className="text-cell text-steel">
              Page{' '}
              <span className="font-mono text-hull" data-numeric="">
                {page}
              </span>{' '}
              of{' '}
              <span className="font-mono text-hull" data-numeric="">
                {totalPages}
              </span>
            </span>
            <Button
              variant="secondary"
              size="compact"
              disabled={page >= totalPages || isPending}
              onClick={() => onPageChange(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
