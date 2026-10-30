'use client';

import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/*
 * Columns over time — stacked (parts of one whole, e.g. sea + air) or grouped
 * (two measures of the same unit side by side, e.g. revenue and cost). One
 * axis, always.
 *
 * Mark specs from the dataviz method: columns at most 24px wide (16px each
 * when grouped), 4px rounded data-end and square at the baseline, a 2px
 * surface gap between stacked parts, 1px solid recessive gridlines, the value
 * printed on the latest column's cap only. Every column's band is its hover
 * and keyboard target, and shows every series for that month in one tooltip;
 * the card's table view holds every value without hovering.
 */

export interface ColumnSeries {
  key: string;
  label: string;
  /** The mark colour as a fill utility, e.g. `fill-sea`. */
  fill: string;
  /** The same colour for HTML keys, e.g. `bg-sea`. */
  swatch: string;
}

export interface ColumnCategory {
  key: string;
  /** Under the column: "Oct". */
  label: string;
  /** In the tooltip: "October 2026". */
  title: string;
}

const PLOT = 180;
const TOP = 20; // room for the cap label
const AXIS = 24; // the month labels
const GUTTER = 44; // the tick labels

function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Clean tick steps — 1, 2 or 5 times a power of ten — and the axis top they reach. */
function scale(max: number, integer: boolean): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0] };
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const m = raw / power;
  let step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power;
  if (integer) step = Math.max(1, Math.round(step));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { top, ticks };
}

/** A column with rounded top corners and a square foot. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function ColumnChart({
  label,
  categories,
  series,
  value,
  layout = 'stacked',
  integer = false,
  format,
  formatTick,
}: {
  /** What the chart shows, for a screen reader. */
  label: string;
  categories: ColumnCategory[];
  series: ColumnSeries[];
  value: (category: string, series: string) => number;
  layout?: 'stacked' | 'grouped';
  /** Counts: ticks are whole numbers. */
  integer?: boolean;
  /** A value in full, for the tooltip. */
  format: (n: number) => string;
  /** A value in short, for ticks and the cap label. */
  formatTick: (n: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [active, setActive] = useState<number | null>(null);

  const totals = categories.map((c) => series.reduce((sum, s) => sum + value(c.key, s.key), 0));
  const max =
    layout === 'stacked'
      ? Math.max(0, ...totals)
      : Math.max(0, ...categories.flatMap((c) => series.map((s) => value(c.key, s.key))));
  const { top, ticks } = scale(max, integer);

  const plotWidth = Math.max(0, width - GUTTER);
  const band = categories.length === 0 ? 0 : plotWidth / categories.length;
  const yOf = (v: number) => TOP + PLOT - (v / top) * PLOT;
  const baseline = TOP + PLOT;
  // Thin the labels when the bands get narrow — a month of days is 31 of
  // them — keeping the latest. A label needs about 44px.
  const labelEvery = band === 0 ? 1 : Math.max(1, Math.ceil(44 / band));
  const last = categories.length - 1;

  const activeCategory = active === null ? undefined : categories[active];

  return (
    <div ref={ref} className="relative" style={{ height: TOP + PLOT + AXIS }}>
      {width > 0 && (
        <svg width={width} height={TOP + PLOT + AXIS} role="img" aria-label={label} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={GUTTER}
                x2={width}
                y1={yOf(t)}
                y2={yOf(t)}
                className="stroke-line"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={GUTTER - 8}
                y={yOf(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-steel text-[11px] tabular-nums"
              >
                {formatTick(t)}
              </text>
            </g>
          ))}

          {categories.map((c, i) => {
            const bandX = GUTTER + band * i;
            const centre = bandX + band / 2;
            const marks: ReactNode[] = [];
            let capX = centre;
            let capY = baseline;

            if (layout === 'stacked') {
              const w = Math.min(24, band * 0.56);
              const shown = series.filter((s) => value(c.key, s.key) > 0);
              let floor = baseline;
              shown.forEach((s, k) => {
                const h = (value(c.key, s.key) / top) * PLOT;
                // The 2px surface gap sits under every part but the first.
                const gap = k === 0 ? 0 : 2;
                const segment = Math.max(0, h - gap);
                const y = floor - h;
                marks.push(
                  k === shown.length - 1 ? (
                    <path key={s.key} d={columnPath(centre - w / 2, y, w, segment)} className={s.fill} />
                  ) : (
                    <rect key={s.key} x={centre - w / 2} y={y} width={w} height={segment} className={s.fill} />
                  ),
                );
                floor -= h;
              });
              capY = floor;
            } else {
              const w = Math.min(16, band * 0.3);
              const span = series.length * w + (series.length - 1) * 2;
              series.forEach((s, j) => {
                const v = value(c.key, s.key);
                if (v <= 0) return;
                const h = (v / top) * PLOT;
                marks.push(
                  <path
                    key={s.key}
                    d={columnPath(centre - span / 2 + j * (w + 2), baseline - h, w, h)}
                    className={s.fill}
                  />,
                );
              });
              // The first series is the accent; its column carries the cap label.
              const first = series[0];
              capX = centre - span / 2 + w / 2;
              capY = first === undefined ? baseline : yOf(value(c.key, first.key));
            }

            // The latest column carries its value; the axis and tooltip carry the rest.
            const capValue = layout === 'stacked' ? (totals[i] ?? 0) : value(c.key, series[0]?.key ?? '');
            const describe = `${c.title}: ${series.map((s) => `${s.label} ${format(value(c.key, s.key))}`).join(', ')}`;

            return (
              <g key={c.key}>
                {active === i && (
                  <rect x={bandX + 2} y={TOP} width={Math.max(0, band - 4)} height={PLOT} rx={4} className="fill-row-hover" />
                )}
                {marks}
                {i === last && capValue > 0 && (
                  <text
                    x={capX}
                    y={capY - 6}
                    textAnchor="middle"
                    className="fill-hull text-[11px] font-semibold tabular-nums"
                  >
                    {formatTick(capValue)}
                  </text>
                )}
                {(i % labelEvery === (last % labelEvery) || i === last) && (
                  <text
                    // The last label hangs left of its column's centre when
                    // centring it would run it off the edge ("31 Oct").
                    x={i === last && centre + 24 > width ? width : centre}
                    y={baseline + 16}
                    textAnchor={i === last && centre + 24 > width ? 'end' : 'middle'}
                    className={cn('text-[11px]', i === last ? 'fill-hull font-medium' : 'fill-steel')}
                  >
                    {c.label}
                  </text>
                )}
                <rect
                  x={bandX}
                  y={TOP}
                  width={band}
                  height={PLOT}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={describe}
                  className="cursor-default outline-none focus-visible:stroke-harbour focus-visible:[stroke-width:2]"
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((prev) => (prev === i ? null : prev))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((prev) => (prev === i ? null : prev))}
                />
              </g>
            );
          })}

          <line
            x1={GUTTER}
            x2={width}
            y1={baseline}
            y2={baseline}
            className="stroke-steel/40"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        </svg>
      )}

      {max === 0 && width > 0 && (
        <p className="pointer-events-none absolute inset-x-0 text-center text-cell text-steel" style={{ top: TOP + PLOT / 2 - 10, paddingLeft: GUTTER }}>
          Nothing in this period yet.
        </p>
      )}

      {active !== null && activeCategory !== undefined && (
        <div
          role="presentation"
          className="pointer-events-none absolute z-10 min-w-40 -translate-x-1/2 -translate-y-full rounded-manifest border border-line bg-surface px-3 py-2 shadow-raised"
          style={{
            left: Math.min(Math.max(GUTTER + band * active + band / 2, 90), width - 90),
            top: TOP + 4,
          }}
        >
          <p className="mb-1 text-cell text-steel">{activeCategory.title}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center gap-2 text-cell">
              <span aria-hidden="true" className={cn('h-0.5 w-3 shrink-0 rounded-full', s.swatch)} />
              <span className="font-semibold tabular-nums text-hull">{format(value(activeCategory.key, s.key))}</span>
              <span className="text-steel">{s.label}</span>
            </p>
          ))}
          {layout === 'stacked' && series.length > 1 && (
            <p className="mt-1 border-t border-line pt-1 text-cell text-steel">
              Total <span className="font-semibold tabular-nums text-hull">{format(totals[active] ?? 0)}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
