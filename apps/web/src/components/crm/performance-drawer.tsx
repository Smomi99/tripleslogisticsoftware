'use client';

import {
  type EmployeePerformanceDto,
  type PerformanceDetailRow,
  type PerformanceMetricDto,
  REPORT_PERIODS,
  REPORT_PERIOD_LABEL,
  type ReportPeriod,
  resolvePeriod,
} from '@ff/shared';
import Link from 'next/link';
import type { Route } from 'next';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The Employee Performance Report — client wireframe, 2026-09-07.
 *
 * Opened by clicking an employee's name. Nine figures over a period, and every
 * countable one opens the rows behind it, because the client's note asks for
 * both: "Each report will show the details list".
 *
 * A drawer rather than a page. The question is asked from the employee list
 * and answered against it — sending somebody to a separate route and back
 * loses the list's scroll position and their place in it.
 */

export function PerformanceDrawer({
  employeeId,
  employeeName,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  onClose: () => void;
}) {
  const { authorizedRequest } = useSession();

  const [period, setPeriod] = useState<ReportPeriod>('THIS_MONTH');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<EmployeePerformanceDto | null>(null);
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Which figure is open, and its rows. */
  const [openMetric, setOpenMetric] = useState<PerformanceMetricDto | null>(null);
  const [detail, setDetail] = useState<PerformanceDetailRow[] | null>(null);
  const [isDetailPending, setDetailPending] = useState(false);

  /*
   * The dates a preset means, shown before the report is asked for. "Last 3
   * months" is a promise about a range, and somebody comparing two reports
   * needs to know which one they are looking at.
   */
  const preview =
    period === 'CUSTOM'
      ? from !== '' && to !== ''
        ? { from, to }
        : null
      : resolvePeriod(period, new Date());

  const query = useCallback((): string => {
    const params = new URLSearchParams({ period });
    if (period === 'CUSTOM') {
      params.set('from', from);
      params.set('to', to);
    }
    return params.toString();
  }, [period, from, to]);

  const ready = period !== 'CUSTOM' || (from !== '' && to !== '' && from <= to);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setPending(true);
    setOpenMetric(null);
    setDetail(null);

    void authorizedRequest<EmployeePerformanceDto>(
      `/api/tenant/crm/employees/${employeeId}/performance?${query()}`,
    )
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load the report.');
        }
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, employeeId, query, ready]);

  function openDetail(metric: PerformanceMetricDto): void {
    if (!metric.drillable) return;
    if (openMetric?.key === metric.key) {
      setOpenMetric(null);
      setDetail(null);
      return;
    }
    setOpenMetric(metric);
    setDetail(null);
    setDetailPending(true);
    void authorizedRequest<PerformanceDetailRow[]>(
      `/api/tenant/crm/employees/${employeeId}/performance/${metric.key}?${query()}`,
    )
      .then(setDetail)
      .catch(() => setDetail([]))
      .finally(() => setDetailPending(false));
  }

  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Performance — ${employeeName}`}
      size="wide"
    >
      <div className="flex flex-col gap-4">
        {/* ------------------------------------------------ report period */}
        <div className="flex flex-wrap items-end gap-3 border-b border-line pb-4">
          <div className="flex w-52 flex-col gap-1">
            <span className="label-manifest">Report period</span>
            <Select
              aria-label="Report period"
              value={period}
              onChange={(e) => setPeriod(e.target.value as ReportPeriod)}
            >
              {REPORT_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {REPORT_PERIOD_LABEL[p]}
                </option>
              ))}
            </Select>
          </div>

          {period === 'CUSTOM' && (
            <>
              <div className="flex w-40 flex-col gap-1">
                <span className="label-manifest">From</span>
                <Input
                  type="date"
                  aria-label="From date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="flex w-40 flex-col gap-1">
                <span className="label-manifest">To</span>
                <Input
                  type="date"
                  aria-label="To date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </>
          )}

          <p className="pb-2 font-mono text-cell tabular-nums text-steel">
            {preview === null
              ? 'Choose both dates.'
              : `${preview.from} → ${preview.to}`}
          </p>
        </div>

        {error !== null && (
          <p
            role="alert"
            className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
          >
            {error}
          </p>
        )}

        {isPending && report === null ? (
          <p className="text-body text-steel">Loading the report…</p>
        ) : report === null ? null : (
          <>
            {/* -------------------------------------------------- the grid */}
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {report.metrics.map((m) => (
                <MetricTile
                  key={m.key}
                  metric={m}
                  isOpen={openMetric?.key === m.key}
                  onOpen={() => openDetail(m)}
                />
              ))}
            </div>

            {report.incentivePercentage !== null && (
              <p className="text-cell text-steel">
                Incentive rate on file: {report.incentivePercentage}% of gross profit.
              </p>
            )}

            {/* ------------------------------------------------ the detail */}
            {openMetric !== null && (
              <div className="rounded-manifest border border-line bg-surface">
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <h3 className="text-section text-hull">
                    {openMetric.label}
                    {detail !== null && (
                      <span className="ml-2 font-mono text-cell text-steel">
                        {detail.length} {detail.length === 1 ? 'row' : 'rows'}
                      </span>
                    )}
                  </h3>
                  <Button variant="text" size="inline" onClick={() => openDetail(openMetric)}>
                    Close
                  </Button>
                </div>

                {isDetailPending ? (
                  <p className="px-4 py-3 text-body text-steel">Loading…</p>
                ) : detail === null || detail.length === 0 ? (
                  <p className="px-4 py-3 text-body text-steel">
                    Nothing in this period.
                  </p>
                ) : (
                  <div className="max-h-80 overflow-y-auto">
                    <table className="w-full border-collapse text-cell">
                      <tbody>
                        {detail.map((row) => (
                          <tr key={row.id} className="border-b border-line last:border-0">
                            <td className="w-40 bg-paper px-3 py-1.5 font-mono text-cell tabular-nums text-hull">
                              {row.code}
                            </td>
                            <td className="px-3 py-1.5 text-hull">
                              {row.href === null ? (
                                row.title
                              ) : (
                                <Link
                                  href={row.href as Route}
                                  className="text-harbour hover:underline"
                                >
                                  {row.title}
                                </Link>
                              )}
                              {row.subtitle !== null && (
                                <span className="block text-cell text-steel">{row.subtitle}</span>
                              )}
                            </td>
                            <td className="w-28 px-3 py-1.5 text-right font-mono text-cell tabular-nums text-steel">
                              {row.date ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * One figure.
 *
 * A countable one is a button, because the client asked for the rows behind it.
 * A money one is not — it has nothing to open until Accounts exists — and says
 * so on its face rather than showing a zero somebody might act on.
 */
function MetricTile({
  metric,
  isOpen,
  onOpen,
}: {
  metric: PerformanceMetricDto;
  isOpen: boolean;
  onOpen: () => void;
}) {
  const pending = metric.pendingReason !== null;

  if (pending) {
    return (
      <div
        className="rounded-manifest border border-dashed border-line bg-paper px-3.5 py-3"
        title={metric.pendingReason ?? undefined}
      >
        <div className="label-manifest">{metric.label}</div>
        <div className="mt-1 font-mono text-body text-steel">Awaiting Accounts</div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={isOpen}
      className={[
        'rounded-manifest border bg-surface px-3.5 py-3 text-left transition-colors duration-[120ms]',
        isOpen
          ? 'border-harbour bg-harbour/5'
          : 'border-line hover:border-harbour hover:bg-row-hover',
      ].join(' ')}
    >
      <div className="label-manifest">{metric.label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="font-mono text-section tabular-nums text-hull">{metric.value}</span>
        <span className="text-cell text-harbour">{isOpen ? 'Hide' : 'View'}</span>
      </div>
    </button>
  );
}
