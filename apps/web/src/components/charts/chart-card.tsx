'use client';

import type { Module } from '@ff/shared';
import { ArrowRight } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';

import { MODULE_THEME } from '@/components/shell/module-theme';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/*
 * The frame every chart sits in: the card, painted in the colour of the
 * module the figures come from, with its title, an optional legend, and a
 * "Show table" switch — the accessible twin of every chart, so no value is
 * ever reachable only by hovering.
 */
export function ChartCard({
  module,
  title,
  description,
  href,
  legend,
  table,
  children,
}: {
  module: Module;
  title: string;
  description?: ReactNode;
  /** The screen the figures come from. */
  href?: Route;
  legend?: ReactNode;
  /** The same figures as a table. Omit only where the chart already prints every value. */
  table?: ReactNode;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const { slug, icon: Icon } = MODULE_THEME[module];

  return (
    <figure
      data-module={slug}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-line bg-surface p-4 shadow-manifest sm:p-5"
    >
      <figcaption className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-manifest bg-module-soft text-harbour"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-section text-hull">{title}</h2>
          {description !== undefined && <p className="mt-0.5 text-cell text-steel">{description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-0.5">
          {table !== undefined && (
            <Button variant="text" size="inline" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              {asTable ? 'Show chart' : 'Show table'}
            </Button>
          )}
          {href !== undefined && (
            <Link
              href={href}
              aria-label={`Open ${title}`}
              className="rounded-full p-1 text-harbour transition-colors duration-[120ms] hover:bg-module-soft"
            >
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          )}
        </div>
      </figcaption>
      {legend !== undefined && !asTable && legend}
      {asTable ? table : children}
    </figure>
  );
}

/** A legend for two or more series: a swatch shaped like the mark, then the name, in text colours. */
export function Legend({ items }: { items: { label: string; swatch: string }[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-cell text-steel">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('size-2.5 rounded-[2px]', item.swatch)} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** The table view of a chart: first column the category, the rest figures, right-aligned in mono. */
export function FigureTable({
  head,
  rows,
}: {
  head: string[];
  rows: { key: string; cells: (string | number)[] }[];
}) {
  return (
    <div className="overflow-x-auto rounded-manifest border border-line">
      <table className="w-full border-collapse text-cell">
        <thead>
          <tr className="bg-module-soft">
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={cn(
                  'label-manifest whitespace-nowrap border-b border-line px-3 py-2',
                  i === 0 ? 'text-left' : 'text-right',
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-line last:border-b-0">
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={cn(
                    'whitespace-nowrap px-3 py-1.5',
                    i === 0 ? 'text-left text-hull' : 'text-right font-mono text-hull',
                  )}
                  {...(i === 0 ? {} : { 'data-numeric': '' })}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
