'use client';

import {
  INQUIRY_STATUS_LABEL,
  OVERVIEW_PERIOD_LABEL,
  OVERVIEW_PRESETS,
  OVERVIEW_SECTION_PERMISSIONS,
  type OverviewDto,
  type OverviewInquiryStatus,
  type OverviewModeCounts,
  type OverviewPeriod,
  type OverviewPreset,
  overviewQuerySchema,
  overviewRangeDays,
  type OverviewRangeDto,
  SHIPMENT_STATUS_LABEL,
  SHIPMENT_TYPE_LABEL,
  SHIPMENT_TYPES,
} from '@ff/shared';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

import { BarList } from '@/components/charts/bar-list';
import { ChartCard, FigureTable, Legend } from '@/components/charts/chart-card';
import { type ColumnCategory, ColumnChart, type ColumnSeries } from '@/components/charts/column-chart';
import { bucketLabels, compact, count, rangeLabel, whole } from '@/components/charts/format';
import { StatTile } from '@/components/charts/stat-tile';
import { MODULE_THEME } from '@/components/shell/module-theme';
import { buildNav } from '@/components/shell/nav-config';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Segmented } from '@/components/ui/segmented';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * Overview — the first screen after sign-in.
 *
 * A period filter, headline figures and charts from the screens this user may
 * open, then a card per module to jump into. Every figure is one an existing
 * screen already defines (see packages/shared/src/overview.ts); the API
 * returns only the sections this user may see, and the page draws only those.
 */

/** Sea and air keep their colours on every chart, whichever module draws them. */
const MODE_SERIES: ColumnSeries[] = SHIPMENT_TYPES.map((type) => ({
  key: type,
  label: SHIPMENT_TYPE_LABEL[type],
  fill: type === 'SEA' ? 'fill-sea' : 'fill-air',
  swatch: type === 'SEA' ? 'bg-sea' : 'bg-air',
}));

const INQUIRY_LABEL: Record<OverviewInquiryStatus, string> = { ...INQUIRY_STATUS_LABEL, LAPSED: 'Lapsed' };

const PERIOD_OPTIONS = [...OVERVIEW_PRESETS, 'custom' as const].map(
  (p) => [p, OVERVIEW_PERIOD_LABEL[p]] as const,
);

/** What a range is compared with, said the way a person would. */
function against(range: OverviewRangeDto): string {
  switch (range.period) {
    case 'today':
      return 'yesterday';
    case 'month':
      return 'the same days last month';
    case '6months':
      return 'the 6 months before';
    case 'year':
      return 'the same dates last year';
    case 'custom': {
      const days = overviewRangeDays(range.from, range.to);
      return days === 1 ? 'the day before' : `the ${days} days before`;
    }
  }
}

type Applied = { period: OverviewPreset } | { period: 'custom'; from: string; to: string };

function queryOf(applied: Applied): string {
  return applied.period === 'custom'
    ? `period=custom&from=${applied.from}&to=${applied.to}`
    : `period=${applied.period}`;
}

const both = (r: OverviewModeCounts) => r.SEA + r.AIR;
const sumOf = (rows: OverviewModeCounts[], type: 'SEA' | 'AIR') => rows.reduce((n, r) => n + r[type], 0);

export default function OverviewPage() {
  const { user, can, authorizedRequest } = useSession();
  // What the filter shows, and what was last asked of the server: picking
  // "Custom range" opens the date fields without fetching until they are filled.
  const [selected, setSelected] = useState<OverviewPeriod>('6months');
  const [applied, setApplied] = useState<Applied>({ period: '6months' });
  const [data, setData] = useState<OverviewDto | null>(null);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isExternal = user?.isExternal === true;
  const mayAny = !isExternal && Object.values(OVERVIEW_SECTION_PERMISSIONS).some((p) => can(p));
  const query = queryOf(applied);

  useEffect(() => {
    if (!mayAny) return;
    let live = true;
    setPending(true);
    authorizedRequest<OverviewDto>(`/api/tenant/overview?${query}`)
      .then((next) => {
        if (!live) return;
        setData(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the overview. Please try again.');
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, mayAny, query]);

  const groups = useMemo(
    () =>
      buildNav()
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => item.href !== null && item.viewPermissions.every((p) => can(p))),
        }))
        .filter((group) => group.items.length > 0),
    [can],
  );

  const name = user?.name ?? user?.username ?? '';

  // An outside company sees none of the staff detail: role and figures mean
  // nothing to them, and are not theirs to see.
  const description = isExternal
    ? user?.agentId !== null
      ? 'Rate requests sent to you appear under Agent Inquiry.'
      : groups.length > 0
        ? 'Everything shared with you is below.'
        : 'Your account is ready. Nothing has been shared with you yet.'
    : mayAny
      ? `Welcome back, ${name}. Here is how the business is moving.`
      : `Welcome, ${name}. Choose a module to get started.`;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Overview" description={description} />

      {mayAny && (
        <PeriodFilter
          selected={selected}
          range={data?.range}
          onPreset={(period) => {
            setSelected(period);
            setApplied({ period });
          }}
          onCustom={() => setSelected('custom')}
          onApply={(from, to) => setApplied({ period: 'custom', from, to })}
        />
      )}

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {mayAny && data === null && error === null && (
        <p className="rounded-card border border-line bg-surface px-4 py-10 text-center text-body text-steel shadow-manifest">
          Loading the overview…
        </p>
      )}

      {/* A refetch keeps the frame: the charts stay and dim until the new range lands. */}
      {data !== null && (
        <div className={cn('flex flex-col gap-5 transition-opacity duration-[120ms]', isPending && 'opacity-60')}>
          <Headlines data={data} />
          <Charts data={data} />
        </div>
      )}

      <section aria-labelledby="modules-heading" className="flex flex-col gap-3">
        <h2 id="modules-heading" className={mayAny ? 'text-section text-hull' : 'sr-only'}>
          {mayAny ? 'Jump to a module' : 'Modules'}
        </h2>
        <ModuleCards groups={groups} />
      </section>
    </div>
  );
}

/**
 * The one filter row above everything it scopes: the period presets first,
 * then — for a custom range — the two days and the button that applies them.
 * The line under it names the range shown and what it is compared with.
 */
function PeriodFilter({
  selected,
  range,
  onPreset,
  onCustom,
  onApply,
}: {
  selected: OverviewPeriod;
  range: OverviewRangeDto | undefined;
  onPreset: (period: OverviewPreset) => void;
  onCustom: () => void;
  onApply: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [errors, setErrors] = useState<{ from?: string; to?: string }>({});

  function choose(period: OverviewPeriod): void {
    if (period !== 'custom') {
      onPreset(period);
      return;
    }
    // Start the fields on the range already on screen, so a small change is a small edit.
    if (from === '' && range !== undefined) setFrom(range.from);
    if (to === '' && range !== undefined) setTo(range.to);
    onCustom();
  }

  function apply(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // The same rules the server applies, so a mistake is named before it is sent.
    const parsed = overviewQuerySchema.safeParse({ period: 'custom', from: from || undefined, to: to || undefined });
    if (!parsed.success) {
      const next: { from?: string; to?: string } = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if ((key === 'from' || key === 'to') && next[key] === undefined) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    onApply(from, to);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-4">
        {/* Five choices do not fit across a phone; there they are a dropdown. */}
        <div className="sm:hidden">
          <Select
            aria-label="Period"
            value={selected}
            onChange={(e) => choose(e.target.value as OverviewPeriod)}
          >
            {PERIOD_OPTIONS.map(([key, text]) => (
              <option key={key} value={key}>
                {text}
              </option>
            ))}
          </Select>
        </div>
        <div className="hidden sm:block">
          <Segmented label="Period" value={selected} options={PERIOD_OPTIONS} onChange={choose} />
        </div>
        {selected === 'custom' && (
          <form onSubmit={apply} noValidate className="grid grid-cols-2 items-start gap-2 sm:flex sm:flex-wrap sm:items-end">
            <Field id="overview-from" label="From" error={errors.from}>
              <Input
                id="overview-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-invalid={errors.from !== undefined}
                className="sm:w-40"
              />
            </Field>
            <Field id="overview-to" label="To" error={errors.to}>
              <Input
                id="overview-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-invalid={errors.to !== undefined}
                className="sm:w-40"
              />
            </Field>
            <Button type="submit" variant="secondary" className="col-span-2 sm:col-span-1">
              Show this range
            </Button>
          </form>
        )}
      </div>
      {range !== undefined && (
        <p className="text-cell text-steel">
          Showing <span className="font-medium text-hull">{rangeLabel(range.from, range.to)}</span>, compared with{' '}
          {rangeLabel(range.previousFrom, range.previousTo)}.
        </p>
      )}
    </div>
  );
}

function Headlines({ data }: { data: OverviewDto }) {
  const { range, sales, bookings, invoicing, balances } = data;
  const vs = against(range);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {sales !== null && (
        <StatTile
          module="SALES"
          label="Inquiries"
          value={count(sales.total)}
          change={{ current: sales.total, previous: sales.previousTotal, upIsGood: true, against: vs }}
          note={`Sea ${count(sumOf(sales.byBucket, 'SEA'))} · Air ${count(sumOf(sales.byBucket, 'AIR'))}`}
          trend={sales.byBucket.map(both)}
          href="/sales/inquiry"
        />
      )}
      {bookings !== null && (
        <StatTile
          module="CUSTOMER_SERVICE"
          label="Bookings"
          value={count(bookings.total)}
          change={{ current: bookings.total, previous: bookings.previousTotal, upIsGood: true, against: vs }}
          note={`Sea ${count(sumOf(bookings.byBucket, 'SEA'))} · Air ${count(sumOf(bookings.byBucket, 'AIR'))}`}
          trend={bookings.byBucket.map(both)}
          href="/cs/shipment-booking-sea"
        />
      )}
      {invoicing !== null && (
        <StatTile
          module="ACCOUNTS"
          label="Invoiced"
          value={`${invoicing.currency} ${compact(Number(invoicing.total))}`}
          change={{
            current: Number(invoicing.total),
            previous: Number(invoicing.previousTotal),
            upIsGood: true,
            against: vs,
          }}
          note="Issued debit invoices"
          trend={invoicing.byBucket.map((m) => Number(m.revenue))}
          href="/accounts/debit-invoice"
        />
      )}
      {balances !== null && (
        <StatTile
          module="ACCOUNTS"
          label="Receivable outstanding"
          value={`${balances.currency} ${compact(Number(balances.receivable))}`}
          note={`As of today. Payable ${balances.currency} ${compact(Number(balances.payable))} · Unbilled ${balances.currency} ${compact(Number(balances.unbilled))}`}
          href="/accounts/receivable-payable"
        />
      )}
    </div>
  );
}

function Charts({ data }: { data: OverviewDto }) {
  const { range, sales, bookings, invoicing, balances } = data;
  const per = range.bucket === 'day' ? 'day' : 'month';
  // One column is not a trend: a single day shows in the headlines and lists only.
  const overTime = data.buckets.length > 1;
  const categories: ColumnCategory[] = data.buckets.map((b, i) => ({ key: b, ...bucketLabels(b, i === 0) }));
  const columnTitle = (b: string) => bucketLabels(b, false).title;

  const modeTable = (rows: OverviewModeCounts[]) => (
    <FigureTable
      head={[per === 'day' ? 'Day' : 'Month', 'Sea', 'Air', 'Total']}
      rows={rows.map((r) => ({ key: r.bucket, cells: [columnTitle(r.bucket), count(r.SEA), count(r.AIR), count(both(r))] }))}
    />
  );
  const modeValue = (rows: OverviewModeCounts[]) => (bucket: string, type: string) => {
    const row = rows.find((r) => r.bucket === bucket);
    return row === undefined ? 0 : type === 'SEA' ? row.SEA : row.AIR;
  };
  const modeLegend = <Legend items={MODE_SERIES.map((s) => ({ label: s.label, swatch: s.swatch }))} />;

  const showCost = invoicing !== null && invoicing.byBucket.some((m) => m.cost !== null);
  const money = (n: number) => (invoicing === null ? whole(n) : `${invoicing.currency} ${whole(n)}`);
  const moneySeries: ColumnSeries[] = [
    { key: 'revenue', label: 'Invoiced', fill: 'fill-harbour', swatch: 'bg-harbour' },
    ...(showCost ? [{ key: 'cost', label: 'Cost', fill: 'fill-deemphasis', swatch: 'bg-deemphasis' }] : []),
  ];

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {sales !== null && (
        <>
          {overTime && (
            <ChartCard
              module="SALES"
              title={`Inquiries by ${per}`}
              description="Every inquiry received, by the date it came in."
              href="/sales/inquiry"
              legend={modeLegend}
              table={modeTable(sales.byBucket)}
            >
              <ColumnChart
                label={`Inquiries received each ${per}, sea and air`}
                categories={categories}
                series={MODE_SERIES}
                value={modeValue(sales.byBucket)}
                integer
                format={count}
                formatTick={compact}
              />
            </ChartCard>
          )}
          <ChartCard
            module="SALES"
            title="Inquiry outcomes"
            description={
              sales.winRate === null
                ? 'Where the inquiries in this range stand now.'
                : `Where the inquiries in this range stand now. Win rate ${Math.round(sales.winRate * 100)}% of those decided.`
            }
            href="/sales/inquiry"
          >
            <BarList
              label="Inquiries by status"
              items={sales.byStatus.map((s) => ({ key: s.status, label: INQUIRY_LABEL[s.status], value: s.count }))}
              format={count}
              empty="No inquiries in this range."
            />
          </ChartCard>
        </>
      )}

      {bookings !== null && (
        <>
          {overTime && (
            <ChartCard
              module="CUSTOMER_SERVICE"
              title={`Bookings by ${per}`}
              description="Bookings opened, by the date they were opened. Cancelled ones are left out."
              href="/cs/shipment-booking-sea"
              legend={modeLegend}
              table={modeTable(bookings.byBucket)}
            >
              <ColumnChart
                label={`Bookings opened each ${per}, sea and air`}
                categories={categories}
                series={MODE_SERIES}
                value={modeValue(bookings.byBucket)}
                integer
                format={count}
                formatTick={compact}
              />
            </ChartCard>
          )}
          <ChartCard
            module="CUSTOMER_SERVICE"
            title="Bookings by status"
            description="Where the bookings opened in this range stand now."
            href="/cs/shipment-booking-sea"
          >
            <BarList
              label="Bookings by status"
              items={bookings.byStatus.map((s) => ({ key: s.status, label: SHIPMENT_STATUS_LABEL[s.status], value: s.count }))}
              format={count}
              empty="No bookings in this range."
            />
          </ChartCard>
          <ChartCard module="CUSTOMER_SERVICE" title="Top customers" description="Most bookings in this range.">
            <BarList
              label="Customers with the most bookings"
              items={bookings.topCustomers.map((c) => ({ key: c.id, label: c.name, value: c.count }))}
              format={count}
              empty="No bookings in this range."
            />
          </ChartCard>
          <ChartCard
            module="CUSTOMER_SERVICE"
            title="Top destinations"
            description="Ports of discharge with the most bookings in this range."
          >
            <BarList
              label="Ports of discharge with the most bookings"
              items={bookings.topDestinations.map((p) => ({ key: p.id, label: p.name, detail: p.detail, value: p.count }))}
              format={count}
              empty="No bookings in this range."
            />
          </ChartCard>
        </>
      )}

      {invoicing !== null && overTime && (
        <ChartCard
          module="ACCOUNTS"
          title={`Invoiced by ${per}`}
          description={`Issued debit invoices, in ${invoicing.currency}${showCost ? ', with what they cost' : ''}.`}
          href="/accounts/debit-invoice"
          {...(showCost ? { legend: <Legend items={moneySeries.map((s) => ({ label: s.label, swatch: s.swatch }))} /> } : {})}
          table={
            <FigureTable
              head={[
                per === 'day' ? 'Day' : 'Month',
                `Invoiced (${invoicing.currency})`,
                ...(showCost ? [`Cost (${invoicing.currency})`] : []),
              ]}
              rows={invoicing.byBucket.map((m) => ({
                key: m.bucket,
                cells: [columnTitle(m.bucket), whole(Number(m.revenue)), ...(showCost ? [whole(Number(m.cost ?? 0))] : [])],
              }))}
            />
          }
        >
          <ColumnChart
            label={`Invoiced each ${per} in ${invoicing.currency}${showCost ? ', beside cost' : ''}`}
            categories={categories}
            series={moneySeries}
            layout="grouped"
            value={(bucket, key) => {
              const row = invoicing.byBucket.find((m) => m.bucket === bucket);
              return Number((key === 'cost' ? row?.cost : row?.revenue) ?? 0);
            }}
            format={money}
            formatTick={compact}
          />
        </ChartCard>
      )}

      {balances !== null && (
        <ChartCard
          module="ACCOUNTS"
          title="Money owed"
          description="As of today, from the Receivable-Payable list — balances run on, whatever range is chosen."
          href="/accounts/receivable-payable"
        >
          <BarList
            label={`Receivable, unbilled and payable, in ${balances.currency}`}
            items={[
              { key: 'receivable', label: 'Receivable', detail: 'invoiced, not yet received', value: Number(balances.receivable) },
              { key: 'unbilled', label: 'Unbilled', detail: 'work not yet invoiced', value: Number(balances.unbilled) },
              { key: 'payable', label: 'Payable', detail: 'owed to carriers, agents and vendors', value: Number(balances.payable) },
            ]}
            format={(n) => `${balances.currency} ${whole(n)}`}
            empty="Nothing owed either way."
          />
        </ChartCard>
      )}
    </div>
  );
}

function ModuleCards({ groups }: { groups: ReturnType<typeof buildNav> }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
      {groups.map((group) => {
        const { slug, icon: Icon } = MODULE_THEME[group.module];
        const first = group.items[0];
        return (
          <li
            key={group.module}
            data-module={slug}
            className="flex flex-col overflow-hidden rounded-card border border-line bg-surface shadow-manifest"
          >
            <div className="flex items-center gap-3 bg-linear-to-r from-module-soft to-surface px-4 py-3">
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-card bg-linear-135 from-module to-harbour text-white shadow-manifest"
              >
                <Icon className="size-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-section text-hull">{group.label}</h3>
                <p className="text-cell text-steel">
                  <span className="font-mono" data-numeric="">
                    {group.items.length}
                  </span>{' '}
                  {group.items.length === 1 ? 'screen' : 'screens'}
                </p>
              </div>
              {first !== undefined && first.href !== null && (
                <Link
                  href={first.href}
                  aria-label={`Open ${group.label}`}
                  className="rounded-full p-2 text-harbour transition-colors duration-[120ms] hover:bg-module-soft"
                >
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              )}
            </div>
            <ul className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
              {group.items.map((item) =>
                item.href === null ? null : (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="inline-flex min-h-8 items-center rounded-full border border-line px-3 py-1 text-cell text-hull transition-colors duration-[120ms] hover:border-harbour/40 hover:bg-module-soft hover:text-harbour"
                    >
                      {item.label}
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
