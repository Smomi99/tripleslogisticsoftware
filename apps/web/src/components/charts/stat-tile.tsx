import type { Module } from '@ff/shared';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';

import { MODULE_THEME } from '@/components/shell/module-theme';
import { cn } from '@/lib/utils';

/*
 * A headline figure: label, value, and optionally the change against the
 * comparison period and a sparkline of the range.
 *
 * The value uses proportional figures — tabular digits look loose at this
 * size. The change says its direction in words and an icon as well as colour,
 * and the colour follows whether that direction is good, not just up or down.
 * The sparkline is quiet gray with the latest column marked in the module's
 * colour.
 */

export interface StatChange {
  current: number;
  previous: number;
  upIsGood: boolean;
  /** What the figure is compared with: "yesterday", "the same days last month". */
  against: string;
}

function Change({ current, previous, upIsGood, against }: StatChange) {
  if (current === previous) {
    return (
      <span className="inline-flex items-center gap-1 text-cell text-steel">
        <Minus className="size-3.5" aria-hidden="true" />
        No change vs {against}
      </span>
    );
  }
  const up = current > previous;
  const good = up === upIsGood;
  const Icon = up ? TrendingUp : TrendingDown;
  const text =
    previous === 0
      ? `Up from none vs ${against}`
      : `${up ? 'Up' : 'Down'} ${Math.round((Math.abs(current - previous) / previous) * 100)}% vs ${against}`;
  return (
    <span
      className={cn(
        // A soft box rather than a full pill: the wording can run to two lines.
        'inline-flex w-fit items-start gap-1 rounded-manifest px-2 py-0.5 text-cell font-medium',
        good ? 'bg-verified/10 text-verified-ink' : 'bg-alert/10 text-alert',
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {text}
    </span>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 100;
  const h = 28;
  const max = Math.max(...values, 1);
  const x = (i: number) => (i / (values.length - 1)) * (w - 8) + 4;
  const y = (v: number) => h - 4 - (v / max) * (h - 8);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const lastIndex = values.length - 1;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" className="h-7 w-full">
      <polyline
        points={points}
        fill="none"
        className="stroke-deemphasis"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={x(lastIndex)} cy={y(values[lastIndex] ?? 0)} r={4} className="fill-harbour stroke-surface" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StatTile({
  module,
  label,
  value,
  note,
  change,
  trend,
  href,
}: {
  module: Module;
  label: string;
  value: string;
  note?: string | undefined;
  change?: StatChange | undefined;
  trend?: number[] | undefined;
  /** The screen the figure comes from. */
  href: Route;
}) {
  const { slug, icon: Icon } = MODULE_THEME[module];
  return (
    <Link
      href={href}
      data-module={slug}
      className="group flex min-w-0 flex-col gap-2 rounded-card border border-line bg-surface p-4 shadow-manifest transition-colors duration-[120ms] hover:border-harbour/40"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-cell font-medium text-steel">{label}</span>
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-manifest bg-module-soft text-harbour"
        >
          <Icon className="size-4" />
        </span>
      </span>
      <span className="text-[26px] font-semibold leading-8 text-hull">{value}</span>
      {change !== undefined && <Change {...change} />}
      {note !== undefined && <span className="text-cell text-steel">{note}</span>}
      {trend !== undefined && <Sparkline values={trend} />}
    </Link>
  );
}
