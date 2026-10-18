'use client';

import {
  type BalanceSheetDto,
  INCOME_STATEMENT_BASES,
  INCOME_STATEMENT_BASIS_LABEL,
  type IncomeStatementBasis,
} from '@ff/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { sheetDay, StatementTable } from '@/components/accounts/statement-table';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Segmented } from '@/components/ui/segmented';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Accounts → Balance Sheet (Menu M15). The position on a day — assets,
 * liabilities and owner's equity — beside the same day a year before, on the
 * Income Statement's two bases. Read-only; every figure is the server's
 * (lib/balance-sheet.ts).
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function BalanceSheetPage() {
  const { authorizedRequest, authorizedDownload, can } = useSession();
  const [asOf, setAsOf] = useState(today());
  const [yearStartMonth, setYearStartMonth] = useState(1);
  const [basis, setBasis] = useState<IncomeStatementBasis>('ACCRUAL');
  const [statement, setStatement] = useState<BalanceSheetDto | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = `asOf=${asOf}&yearStartMonth=${yearStartMonth}&basis=${basis}`;

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return;
    let live = true;
    setPending(true);
    authorizedRequest<BalanceSheetDto>(`/api/tenant/accounts/balance-sheet?${query}`)
      .then((data) => {
        if (!live) return;
        setStatement(data);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load the balance sheet.');
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, asOf, query]);

  async function exportIt(): Promise<void> {
    setExporting(true);
    try {
      await authorizedDownload(
        `/api/tenant/accounts/balance-sheet/export?${query}`,
        `balance-sheet-${asOf}-${basis.toLowerCase()}.xlsx`,
      );
    } catch {
      toast.error('Could not export the balance sheet.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Balance Sheet"
        description="What the business owns, what it owes, and the owner's equity — on a day, and a year before."
        action={
          can('ACCOUNTS.BALANCE_SHEET.EXPORT') ? (
            <Button variant="secondary" onClick={() => void exportIt()} disabled={exporting || statement === null}>
              {exporting ? 'Exporting…' : 'Export to Excel'}
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex w-48 flex-col gap-1">
          <label htmlFor="bs-as-of" className="label-manifest">
            As at
          </label>
          <Input id="bs-as-of" type="date" numeric value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <div className="flex w-48 flex-col gap-1">
          <label htmlFor="bs-year-start" className="label-manifest">
            Financial year starts
          </label>
          <Select id="bs-year-start" value={yearStartMonth} onChange={(e) => setYearStartMonth(Number(e.target.value))}>
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

      {statement !== null && (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-manifest border border-line bg-surface px-4 py-3 text-body shadow-manifest">
            <span>
              <span className="label-manifest mr-2">As at</span>
              <span className="font-mono tabular-nums">{sheetDay(statement.columns[0]?.asOf ?? asOf)}</span>
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
            {!statement.balanced && (
              <span className="text-alert">Assets and liabilities plus equity do not agree — see Difference.</span>
            )}
          </div>

          <StatementTable
            columns={statement.columns.map((c) => ({ label: c.label, sub: sheetDay(c.asOf) }))}
            rows={statement.rows}
            pending={pending}
          />

          <details className="rounded-manifest border border-line bg-surface px-4 py-3 text-body text-steel">
            <summary className="cursor-pointer text-hull">How these figures are made</summary>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              <li>
                Every asset, liability and equity account is its balance from posted vouchers up to the day, by chart of
                accounts. Draft and cancelled vouchers are left out.
              </li>
              {statement.basis === 'ACCRUAL' ? (
                <>
                  <li>
                    Accrual adds what the invoices leave owing: Accounts Receivable includes what customers owe on issued
                    debit invoices and on their opening balances; Accounts Payable includes what is owed to carriers, agents
                    and vendors on those invoices&apos; cost details and on theirs.
                  </li>
                  <li>
                    Profit for the Year is the Income Statement&apos;s accrual net profit from the start of the financial
                    year to the day. Retained Earnings Brought Forward is everything earned before it.
                  </li>
                </>
              ) : (
                <li>
                  Cash shows the books as they stand: an invoice appears only once money is received or paid against it.
                  Profit for the Year is the Income Statement&apos;s cash net profit for the financial year to the day.
                </li>
              )}
              <li>Opening balances carry no fixed rate, so a foreign-currency one is converted at today&apos;s rate.</li>
            </ul>
          </details>
        </>
      )}

      {statement === null && error === null && <p className="text-body text-steel">Loading…</p>}
    </div>
  );
}
