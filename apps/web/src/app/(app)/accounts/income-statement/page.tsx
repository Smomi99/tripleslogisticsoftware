'use client';

import {
  INCOME_STATEMENT_BASES,
  INCOME_STATEMENT_BASIS_LABEL,
  type IncomeStatementBasis,
  type IncomeStatementDto,
  type IncomeStatementRowDto,
} from '@ff/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Segmented } from '@/components/ui/segmented';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useSession } from '@/lib/session';

/**
 * Accounts → Income Statement — the client's `Income statement` sheet
 * (docs/DESIGN-UPDATE-2026-10-04.md §9): sections A–E, Current Month, YTD
 * and Previous Year YTD, on an accrual basis. Read-only; every figure is the
 * server's, and this page only lays it out.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

/** "2026-10-01" → "01-Oct-2026", the sheet's own date style (C6). */
function sheetDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${SHORT[Number(m) - 1]}-${y}`;
}

function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** A loss reads with its minus sign, in --alert; a deduction in brackets; an empty line as a dash. */
function figure(value: string | null, row: IncomeStatementRowDto): { text: string; negative: boolean } {
  if (value === null) return { text: '—', negative: false };
  const n = Number(value);
  if (row.kind === 'PERCENT') return { text: `${n.toFixed(1)}%`, negative: n < 0 };
  if (n === 0 && row.kind === 'LINE') return { text: '—', negative: false };
  const shown = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (row.deduction === true) return { text: n === 0 ? '—' : `(${shown})`, negative: false };
  return { text: n < 0 ? `-${shown}` : shown, negative: n < 0 };
}

export default function IncomeStatementPage() {
  const { authorizedRequest, authorizedDownload, can } = useSession();
  const [month, setMonth] = useState(thisMonth());
  const [yearStartMonth, setYearStartMonth] = useState(1);
  const [basis, setBasis] = useState<IncomeStatementBasis>('ACCRUAL');
  const [statement, setStatement] = useState<IncomeStatementDto | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = `month=${month}&yearStartMonth=${yearStartMonth}&basis=${basis}`;

  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    let live = true;
    setPending(true);
    authorizedRequest<IncomeStatementDto>(`/api/tenant/accounts/income-statement?${query}`)
      .then((data) => {
        if (!live) return;
        setStatement(data);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load the statement.');
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, month, query]);

  async function exportIt(): Promise<void> {
    setExporting(true);
    try {
      await authorizedDownload(
        `/api/tenant/accounts/income-statement/export?${query}`,
        `income-statement-${month}-${basis.toLowerCase()}.xlsx`,
      );
    } catch {
      toast.error('Could not export the statement.');
    } finally {
      setExporting(false);
    }
  }

  const periods = statement?.periods;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Income Statement"
        description="Profit and loss for a month, the year to date, and the same span last year."
        action={
          can('ACCOUNTS.INCOME_STATEMENT.EXPORT') ? (
            <Button variant="secondary" onClick={() => void exportIt()} disabled={exporting || statement === null}>
              {exporting ? 'Exporting…' : 'Export to Excel'}
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-48 flex-col gap-1">
          <label htmlFor="is-month" className="label-manifest">
            Month
          </label>
          <Input id="is-month" type="month" numeric value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="flex w-48 flex-col gap-1">
          <label htmlFor="is-year-start" className="label-manifest">
            Financial year starts
          </label>
          <Select id="is-year-start" value={yearStartMonth} onChange={(e) => setYearStartMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="label-manifest">Basis</span>
          <Segmented
            label="Basis"
            value={basis}
            options={INCOME_STATEMENT_BASES.map((b) => [b, INCOME_STATEMENT_BASIS_LABEL[b]] as const)}
            onChange={setBasis}
          />
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {statement !== null && periods !== undefined && (
        <>
          {/* The sheet's header block (C6–C9). */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-manifest border border-line bg-surface px-4 py-3 text-body shadow-manifest">
            <span>
              <span className="label-manifest mr-2">Period</span>
              <span className="font-mono tabular-nums">
                {sheetDay(periods.currentMonth.from)} to {sheetDay(periods.currentMonth.to)}
              </span>
            </span>
            <span>
              <span className="label-manifest mr-2">Branch</span>All
            </span>
            <span>
              <span className="label-manifest mr-2">Currency</span>
              <span className="font-mono">{statement.currencyCode}</span>
            </span>
            <span>
              <span className="label-manifest mr-2">Basis</span>
              {INCOME_STATEMENT_BASIS_LABEL[statement.basis]}
            </span>
          </div>

          <div className={cn('overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest', pending && 'opacity-60')}>
            <table className="w-full min-w-[720px] border-collapse text-cell">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-line bg-paper">
                  <th className="label-manifest px-4 py-2 text-left">Particulars</th>
                  {[
                    ['Current Month', periods.currentMonth],
                    ['YTD', periods.ytd],
                    ['Previous Year YTD', periods.previousYtd],
                  ].map(([label, p]) => {
                    const span = p as { from: string; to: string };
                    return (
                      <th key={label as string} className="px-4 py-2 text-right">
                        <span className="label-manifest block">{label as string}</span>
                        <span className="block font-mono text-[11px] font-normal tabular-nums text-steel">
                          {sheetDay(span.from)} – {sheetDay(span.to)}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {statement.rows.map((row) =>
                  row.kind === 'SECTION' ? (
                    <tr key={row.key}>
                      <td colSpan={4} className="px-4 pb-1 pt-4 text-body font-semibold uppercase tracking-wide text-hull">
                        {row.label}
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={row.key}
                      className={cn(
                        'border-line',
                        row.kind === 'LINE' && 'hover:bg-row-hover',
                        row.kind === 'SUBTOTAL' && 'border-t font-semibold',
                        row.kind === 'TOTAL' && 'border-t bg-paper font-semibold uppercase',
                        row.kind === 'PERCENT' && 'text-steel',
                      )}
                    >
                      <td className={cn('px-4 py-1.5', row.kind === 'LINE' ? 'pl-8 text-hull' : 'text-hull')}>{row.label}</td>
                      {row.amounts.map((amount, i) => {
                        const shown = figure(amount, row);
                        return (
                          <td
                            key={i}
                            className={cn('px-4 py-1.5 text-right font-mono tabular-nums', shown.negative && 'text-alert')}
                          >
                            {shown.text}
                          </td>
                        );
                      })}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>

          <details className="rounded-manifest border border-line bg-surface px-4 py-3 text-body text-steel">
            <summary className="cursor-pointer text-hull">How these figures are made</summary>
            {statement.basis === 'ACCRUAL' ? (
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                <li>
                  Accrual: revenue and job costs come from issued debit invoices, on the invoice date, by service (FCL,
                  LCL, Air; anything else is Other). Agent cost blocks are Agent / Overseas Partner Cost.
                </li>
                <li>Everything else comes from posted vouchers, on the voucher date, by chart of accounts.</li>
                <li>
                  Money received or paid against an invoice (Transaction → Income / Expense) is not counted a second
                  time. What the bank moved beyond the invoice&apos;s booked amount is the exchange gain or loss.
                </li>
                <li>Draft and cancelled invoices and vouchers are left out. Branch is not tracked, so every figure is All.</li>
              </ul>
            ) : (
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                <li>
                  Cash: every figure comes from the Transaction screens — Income, Expense and Journal vouchers as posted,
                  on the voucher date, by chart of accounts.
                </li>
                <li>
                  Revenue is what Transaction → Income received; job cost is what Transaction → Expense paid. An invoice
                  not yet received or paid does not appear.
                </li>
                <li>Draft and cancelled vouchers are left out. Branch is not tracked, so every figure is All.</li>
              </ul>
            )}
          </details>
        </>
      )}

      {statement === null && error === null && <p className="text-body text-steel">Loading…</p>}
    </div>
  );
}
