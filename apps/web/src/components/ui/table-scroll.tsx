'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';

/*
 * What a table wider than its box needs: to know whether columns are hidden to
 * either side, a shadow on its pinned columns while they are, and a way across
 * that is not a trackpad gesture. DataTable uses these, and so does every
 * hand-built wide table (rate grids, price lists), so they all scroll alike.
 */

/*
 * The edge of a sticky column, shown only while columns are hidden beneath it,
 * so they read as passing behind it rather than cut off. A gradient strip on a
 * pseudo-element, because a collapsed-border table draws no box-shadow on its
 * cells. START is the column pinned left, END the Action column pinned right;
 * the scroller sets data-hidden-left / data-hidden-right. The cell must be
 * sticky (or relative) for the strip to sit against it.
 */
export const PINNED_START_EDGE = cn(
  "after:pointer-events-none after:absolute after:inset-y-0 after:left-full after:w-3 after:content-['']",
  'after:bg-linear-to-r after:from-hull/12 after:to-transparent after:opacity-0',
  'after:transition-opacity after:duration-[120ms] group-data-[hidden-left]/scroller:after:opacity-100',
);
export const PINNED_END_EDGE = cn(
  "before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-3 before:content-['']",
  'before:bg-linear-to-l before:from-hull/12 before:to-transparent before:opacity-0',
  'before:transition-opacity before:duration-[120ms] group-data-[hidden-right]/scroller:before:opacity-100',
);

/**
 * Whether a wide table has columns hidden to its left or right.
 *
 * Drives the shadow on the pinned columns (shown only while something is
 * actually underneath them) and the Columns ‹ › buttons — an office mouse
 * wheel scrolls up and down, not sideways, so a table wider than the screen
 * needs a way across that is not a trackpad gesture.
 *
 * Spread `scroller.props` on the overflow box, which must also carry the
 * `group/scroller` class for the edges to show.
 */
export function useHorizontalScroll(deps: readonly unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const table = el.firstElementChild;
    if (table !== null) observer.observe(table);
    return () => observer.disconnect();
    // `deps` are the rows and layout: a new page of data can change the width.
  }, [measure, ...deps]);

  const scrollBy = useCallback((direction: -1 | 1) => {
    const el = ref.current;
    if (el === null) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.6, behavior: 'smooth' });
  }, []);

  const props = {
    ref,
    onScroll: measure,
    'data-hidden-left': edges.left ? '' : undefined,
    'data-hidden-right': edges.right ? '' : undefined,
  };

  return { ref, edges, measure, scrollBy, props };
}

export type HorizontalScroll = ReturnType<typeof useHorizontalScroll>;

/**
 * A column's header names it a status column — "Status", "Payment Status",
 * "VGM Status". Those pin beside Action (owner, 2026-11-01: "on every table
 * status will show sticky as action"), so whether a row is live, paid or
 * approved stays in view however far the table scrolls.
 */
export const isStatusHeader = (header: string): boolean => /\bstatus\b/i.test(header);

/** A cell pinned to the right of a wide table — Action, and Status beside it. */
export const PINNED_END_CELL = 'sticky z-10 border-l border-line';

/**
 * Where each right-pinned column sticks: the last (Action) at 0, each one
 * before it at the width of those after it. Measured from the header row,
 * whose pinned cells carry `data-pin-end` in order, and measured again when
 * one changes width — a page whose actions fold into More is narrower.
 * Measured before paint, so Status never draws on top of Action.
 */
export function usePinnedEnd(deps: readonly unknown[]) {
  const rowRef = useRef<HTMLTableRowElement>(null);
  const [offsets, setOffsets] = useState<number[]>([]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const cells = Array.from(row.querySelectorAll<HTMLElement>('[data-pin-end]'));
    const measure = () => {
      const widths = cells.map((cell) => cell.getBoundingClientRect().width);
      const next = widths.map((_, i) => widths.slice(i + 1).reduce((sum, w) => sum + w, 0));
      setOffsets((prev) =>
        prev.length === next.length && prev.every((v, i) => Math.abs(v - (next[i] ?? 0)) < 0.5) ? prev : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const cell of cells) observer.observe(cell);
    return () => observer.disconnect();
    // `deps` are what can add, remove or resize a pinned column.
  }, deps);

  /** The `right` for the pinned column at this position (0 = leftmost of them). */
  const right = useCallback((position: number): number => offsets[position] ?? 0, [offsets]);

  return { rowRef, right };
}

/**
 * Status and Action pinned on a hand-built table, as DataTable pins them.
 *
 *   const pin = useEndPins([rows]);
 *   <div {...pin.box} className="group/scroller overflow-x-auto …">
 *     <tr ref={pin.rowRef}> … <th {...pin.head(0, '…')}>Status</th><th {...pin.head(1, '…')}>Action</th>
 *     <tr className="group"> … <td {...pin.cell(0, '…')}> … <td {...pin.cell(1, '…')}>
 *
 * Positions count from the leftmost pinned column. A body cell is opaque so
 * columns pass behind it: the row's own background, given as `bg` when it is
 * not the plain surface, and the row needs `group` for the hover tint.
 */
export function useEndPins(deps: readonly unknown[]) {
  const scroller = useHorizontalScroll(deps);
  const pinned = usePinnedEnd(deps);

  const head = (position: number, className?: string) => ({
    'data-pin-end': '',
    style: { right: pinned.right(position) },
    className: cn(className, PINNED_END_CELL, 'z-30 bg-module-soft', position === 0 && PINNED_END_EDGE),
  });

  const cell = (position: number, className?: string, bg = 'bg-surface group-hover:bg-row-hover') => ({
    style: { right: pinned.right(position) },
    className: cn(
      className,
      PINNED_END_CELL,
      bg,
      'transition-colors duration-[120ms] ease-manifest',
      position === 0 && PINNED_END_EDGE,
    ),
  });

  return { box: scroller.props, rowRef: pinned.rowRef, head, cell };
}

/** The Columns ‹ › pair for a table's footer. Absent while every column fits. */
export function ColumnScrollButtons({ scroller, className }: { scroller: HorizontalScroll; className?: string }) {
  if (!scroller.edges.left && !scroller.edges.right) return null;
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <span className="label-manifest mr-1">Columns</span>
      <Button
        variant="secondary"
        size="compact"
        aria-label="Show columns to the left"
        disabled={!scroller.edges.left}
        onClick={() => scroller.scrollBy(-1)}
        className="px-2"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button
        variant="secondary"
        size="compact"
        aria-label="Show columns to the right"
        disabled={!scroller.edges.right}
        onClick={() => scroller.scrollBy(1)}
        className="px-2"
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
