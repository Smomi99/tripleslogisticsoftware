'use client';

import {
  createColumnHelper,
  type RowData,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Fragment, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';

import { useIsPhone } from '@/lib/use-media-query';
import { cn } from '@/lib/utils';

import { Button } from './button';
import { RowActions } from './row-actions';
import {
  ColumnScrollButtons,
  PINNED_END_EDGE,
  PINNED_START_EDGE,
  useHorizontalScroll,
} from './table-scroll';

/*
 * The list table every §8 master-data screen reuses.
 *
 * Sorting and pagination are SERVER-side (§9: every list endpoint takes page,
 * limit, search, sortBy, sortOrder, isActive), so no sorted or paginated row
 * model is registered here — the header click and the pager both just change
 * the query. TanStack owns the column and row model; this component owns the
 * markup, stickiness and density.
 *
 * On a phone (below md) the same rows render as cards — code on top, each
 * column as a label and value, actions as tappable chips — with a sort picker
 * in place of the clickable headers. Same columns, same cell renderers, so no
 * screen has to do anything to work on a phone.
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
  /** Makes the code a button — a screen whose number opens the record in a popup. */
  onCodeClick?: (row: T) => void;
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
  onCodeClick,
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
  const isPhone = useIsPhone();
  const sortSelectId = useId();
  const rowHeight = density === 'compact' ? 'h-8' : 'h-10';

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
  const scroller = useHorizontalScroll([rows, columns, isPhone, density]);

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
      <div className="rounded-card border border-line bg-surface shadow-manifest">{empty}</div>
    );
  }

  // Still fetching with nothing yet to show: say so, rather than flash
  // "No records" over a list that is about to fill.
  if (rows.length === 0) {
    return (
      <p className="rounded-card border border-line bg-surface px-4 py-10 text-center text-body text-steel shadow-manifest">
        Loading…
      </p>
    );
  }

  const sortableColumns = columns.filter((c) => c.sortable === true);

  const pager = (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="compact"
        disabled={page <= 1 || isPending}
        onClick={() => onPageChange(page - 1)}
      >
        Previous
      </Button>
      <span className="whitespace-nowrap text-cell text-steel">
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
  );

  const rangeLabel = (
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
  );

  if (isPhone) {
    return (
      <div className="flex flex-col gap-3">
        {sortableColumns.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor={sortSelectId} className="label-field shrink-0 text-steel">
              Sort by
            </label>
            <select
              id={sortSelectId}
              value={sortBy ?? ''}
              onChange={(event) => onSortChange(event.target.value, sortOrder)}
              className="h-10 min-w-0 flex-1 rounded-manifest border border-line bg-surface px-3 text-base text-hull focus:border-harbour focus:outline-none focus:ring-3 focus:ring-harbour/20"
            >
              {sortBy === undefined && <option value="">Default order</option>}
              {sortableColumns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.header}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              aria-label={sortOrder === 'asc' ? 'Sorted ascending — reverse' : 'Sorted descending — reverse'}
              disabled={sortBy === undefined}
              onClick={() => sortBy !== undefined && onSortChange(sortBy, sortOrder === 'asc' ? 'desc' : 'asc')}
              className="px-3"
            >
              {sortOrder === 'asc' ? (
                <ArrowUp className="size-4" aria-hidden="true" />
              ) : (
                <ArrowDown className="size-4" aria-hidden="true" />
              )}
            </Button>
          </div>
        )}

        <ul className={cn('flex flex-col gap-3', isPending && 'opacity-60')}>
          {rows.map((row, index) => (
            <li
              key={getRowId(row)}
              className="overflow-hidden rounded-card border border-line bg-surface shadow-manifest"
            >
              <div className="flex items-center justify-between gap-3 border-b border-line bg-module-soft px-4 py-2.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="label-manifest shrink-0">{codeHeader}</span>
                  {onCodeClick === undefined ? (
                    <span className="truncate font-mono font-medium text-harbour" data-numeric="">
                      {getCode(row)}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => onCodeClick(row)}
                      className="truncate font-mono font-medium text-harbour underline underline-offset-2"
                      data-numeric=""
                    >
                      {getCode(row)}
                    </button>
                  )}
                </span>
                <span className="shrink-0 font-mono text-cell text-steel" data-numeric="">
                  #{firstRowNumber + index}
                </span>
              </div>

              <dl className="grid grid-cols-[minmax(6.5rem,38%)_minmax(0,1fr)] gap-x-3 gap-y-2.5 px-4 py-3 text-cell">
                {columns.map((column) => (
                  <Fragment key={column.id}>
                    <dt className="label-manifest pt-px">{column.header}</dt>
                    <dd
                      className={cn(
                        'min-w-0 break-words text-hull',
                        column.numeric === true && 'font-mono',
                      )}
                      {...(column.numeric === true ? { 'data-numeric': '' } : {})}
                    >
                      {column.cell(row)}
                    </dd>
                  </Fragment>
                ))}
              </dl>

              {actions !== undefined && (
                // Tappable chips — inline text buttons are too small a target
                // for a thumb. Past two, the rest fold under More.
                <div className="border-t border-line px-4 py-3">
                  <RowActions layout="card">{actions(row)}</RowActions>
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="flex flex-col items-center gap-2">
          {pager}
          {rangeLabel}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        {...scroller.props}
        className={cn(
          'group/scroller relative overflow-x-auto rounded-card border border-line bg-surface shadow-manifest',
          isPending && 'opacity-60',
        )}
      >
        <table className="w-full border-collapse text-cell">
          <thead className="sticky top-0 z-20">
            <tr className="bg-module-soft">
              {/*
                §8: SL No, then the client's exact columns, then Action.

                SL is held at 56px from the inside (w-8 plus px-3 each side):
                a squeezed table shrinks a cell past its own width, and the
                code column, stuck at left-14, then slid over the column after it.
              */}
              <th
                scope="col"
                className="label-manifest sticky left-0 z-30 w-14 whitespace-nowrap border-b border-line bg-module-soft px-3 py-2.5 text-left"
              >
                <span className="inline-block w-8">SL</span>
              </th>
              <th
                scope="col"
                className={cn(
                  'label-manifest sticky left-14 z-30 whitespace-nowrap border-b border-r border-line bg-module-soft px-3 py-2.5 text-left',
                  PINNED_START_EDGE,
                )}
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
                    // A header never wraps: "VALID TO DATE" stacked three high
                    // made the header row taller than the rows under it.
                    'label-manifest whitespace-nowrap border-b border-line px-3 py-2.5',
                    column.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {column.sortable === true ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase transition-colors duration-[120ms] hover:text-harbour',
                        column.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {column.header}
                      {sortBy === column.id ? (
                        sortOrder === 'asc' ? (
                          <ArrowUp className="size-3 text-harbour" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3 text-harbour" aria-hidden="true" />
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
                  className={cn(
                    'label-manifest sticky right-0 z-30 whitespace-nowrap border-b border-l border-line bg-module-soft px-3 py-2.5 text-right',
                    PINNED_END_EDGE,
                  )}
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
                  <span className="inline-block w-8 font-mono" data-numeric="">
                    {firstRowNumber + index}
                  </span>
                </td>
                {/*
                  The business code sits in a gutter tinted with the module
                  colour, in mono — the stencilled container-marking reference,
                  and the anchor the eye returns to when scanning.
                */}
                <td
                  className={cn(
                    'sticky left-14 z-10 border-r border-line bg-module-soft px-3',
                    PINNED_START_EDGE,
                    'transition-colors duration-[120ms] group-hover:bg-row-hover',
                  )}
                >
                  {onCodeClick === undefined ? (
                    <span className="whitespace-nowrap font-mono font-medium text-harbour" data-numeric="">
                      {getCode(row.original)}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => onCodeClick(row.original)}
                      className="whitespace-nowrap rounded-manifest font-mono font-medium text-harbour underline decoration-harbour/30 underline-offset-2 transition-colors duration-[120ms] hover:text-harbour-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-harbour"
                      data-numeric=""
                    >
                      {getCode(row.original)}
                    </button>
                  )}
                </td>
                {columns.map((column, columnIndex) => (
                  <td
                    key={column.id}
                    className={cn(
                      'bg-surface px-3 transition-colors duration-[120ms] group-hover:bg-row-hover',
                      column.align === 'right' ? 'text-right' : 'text-left',
                      // Codes, dates and amounts stay whole: a wide table scrolls
                      // rather than breaking 2026-09-20 or QTN-0012 in two.
                      column.numeric === true && 'whitespace-nowrap font-mono',
                      column.className,
                    )}
                    {...(column.numeric === true ? { 'data-numeric': '' } : {})}
                  >
                    {column.numeric === true ? (
                      <table.FlexRender cell={row.getAllCells()[columnIndex]!} />
                    ) : (
                      /*
                       * Text keeps its own width up to 18rem and wraps only
                       * past it, so "Padma Pharmaceuticals" stays on one line
                       * instead of being squeezed into two. A table wider than
                       * the screen scrolls sideways under the sticky columns.
                       */
                      <div
                        className={cn(
                          'w-max max-w-[18rem] py-1.5',
                          column.align === 'right' && 'ml-auto',
                        )}
                      >
                        <table.FlexRender cell={row.getAllCells()[columnIndex]!} />
                      </div>
                    )}
                  </td>
                ))}
                {actions !== undefined && (
                  <td
                    className={cn(
                      'sticky right-0 z-10 border-l border-line bg-surface px-3 text-right',
                      PINNED_END_EDGE,
                      'transition-colors duration-[120ms] group-hover:bg-row-hover',
                    )}
                  >
                    <RowActions>{actions(row.original)}</RowActions>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {rangeLabel}

        <div className="flex flex-wrap items-center gap-4">
          <ColumnScrollButtons scroller={scroller} />

          <div className="flex items-center gap-1">
            <span className="label-manifest mr-1">Density</span>
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

          {pager}
        </div>
      </div>
    </div>
  );
}
