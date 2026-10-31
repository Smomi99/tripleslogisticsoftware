'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

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
