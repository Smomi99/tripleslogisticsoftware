'use client';

import type { CashFlowDto } from '@ff/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { sheetDay, StatementTable } from '@/components/accounts/statement-table';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Accounts → Cash Flow Statement (Menu M16). Where the cash and bank money
 * came from and went to, by the direct method, for a month, the financial year
 * to date and the same span a year before — the Income Statement's columns.
 * Read-only; every figure is the server's (lib/cash-flow.ts).
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export default function CashFlowPage() {
  const { authorizedRequest, authorizedDownload, can } = useSession();
  const [month, setMonth] = useState(thisMonth());
  const [yearStartMonth, setYearStartMonth] = useState(1);
  const [statement, setStatement] = useState<CashFlowDto | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = `month=${month}&yearStartMonth=${yearStartMonth}`;

  useEffect(() => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    let live = true;
    setPending(true);
    authorizedRequest<CashFlowDto>(`/api/tenant/accounts/cash-flow?${query}`)
      .then((data) => {
        if (!live) return;
        setStatement(data);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load the cash flow statement.');
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
      await authorizedDownload(`/api/tenant/accounts/cash-flow/export?${query}`, `cash-flow-${month}.xlsx`);
    } catch {
      toast.error('Could not export the cash flow statement.');
    } finally {
      setExporting(false);
    }
  }

  const periods = statement?.periods;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cash Flow Statement"
        description="Where the cash and bank money came from and went to — for a month, the year to date, and the same span last year."
        action={
          can('ACCOUNTS.CASH_FLOW_STATEMENT.EXPORT') ? (
            <Button variant="secondary" onClick={() => void exportIt()} disabled={exporting || statement === null}>
              {exporting ? 'Exporting…' : 'Export to Excel'}
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-48 flex-col gap-1">
          <label htmlFor="cf-month" className="label-manifest">
            Month
          </label>
          <Input id="cf-month" type="month" numeric value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <div className="flex w-48 flex-col gap-1">
          <label htmlFor="cf-year-start" className="label-manifest">
            Financial year starts
          </label>
          <Select id="cf-year-start" value={yearStartMonth} onChange={(e) => setYearStartMonth(Number(e.target.value))}>
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {statement !== null && periods !== undefined && (
        <>
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
              <span className="label-manifest mr-2">Method</span>Direct
            </span>
          </div>

          <StatementTable
            columns={[
              { label: 'Current Month', sub: `${sheetDay(periods.currentMonth.from)} – ${sheetDay(periods.currentMonth.to)}` },
              { label: 'YTD', sub: `${sheetDay(periods.ytd.from)} – ${sheetDay(periods.ytd.to)}` },
              { label: 'Previous Year YTD', sub: `${sheetDay(periods.previousYtd.from)} – ${sheetDay(periods.previousYtd.to)}` },
            ]}
            rows={statement.rows}
            pending={pending}
          />

          <details className="rounded-manifest border border-line bg-surface px-4 py-3 text-body text-steel">
            <summary className="cursor-pointer text-hull">How these figures are made</summary>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              <li>Cash is every Cash and Bank account. Only posted vouchers count; drafts and cancellations are left out.</li>
              <li>
                Each voucher that moved cash is split by its other lines: money received against Income on Service is
                from customers, money paid to Cost of Service is to carriers, agents and vendors, and so on by chart of
                accounts.
              </li>
              <li>A transfer between two of your own cash or bank accounts moves nothing and does not appear.</li>
              <li>
                Opening cash plus the net change always equals closing cash. A Difference row would mean a voucher the
                classification missed.
              </li>
            </ul>
          </details>
        </>
      )}

      {statement === null && error === null && <p className="text-body text-steel">Loading…</p>}
    </div>
  );
}
