'use client';

import {
  type BankAccountLedgerDto,
  JOURNAL_ENTRY_FEATURE,
  JOURNAL_ENTRY_KIND_LABEL,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { amount } from '@/components/accounts/format';
import { sheetDay } from '@/components/accounts/statement-table';
import { VOUCHER_SLUG } from '@/components/accounts/voucher-list';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * Account Set up → Ledger (client, 2026-10-28: "so that I can easily check my
 * amount's breakdown, filtered by date, month or year"). One bank account's
 * posted vouchers over a month, a year or a day range: the balance before,
 * each voucher with what it put in or took out and the balance after it, and
 * the balance at the end — and the same to Excel. Every figure is the server's.
 */

type PeriodKind = 'MONTH' | 'YEAR' | 'RANGE';

const PERIOD_OPTIONS = [
  ['MONTH', 'By month'],
  ['YEAR', 'By year'],
  ['RANGE', 'Date range'],
] as const;

const pad = (n: number) => String(n).padStart(2, '0');

function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "2026-02" → the 1st and the last day of February. */
function monthSpan(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad(last)}` };
}

/** Coloured --alert when below zero, as the statements read. */
function Money({ value, strong = false }: { value: string; strong?: boolean }) {
  return <span className={cn(Number(value) < 0 && 'text-alert', strong && 'font-semibold')}>{amount(value)}</span>;
}

export default function BankAccountLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authorizedRequest, authorizedDownload, can } = useSession();

  const [kind, setKind] = useState<PeriodKind>('MONTH');
  const [month, setMonth] = useState(thisMonth());
  const [year, setYear] = useState(new Date().getFullYear());
  const [from, setFrom] = useState(`${thisMonth()}-01`);
  const [to, setTo] = useState(today());

  const [ledger, setLedger] = useState<BankAccountLedgerDto | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const span =
    kind === 'MONTH'
      ? monthSpan(month)
      : kind === 'YEAR'
        ? { from: `${year}-01-01`, to: `${year}-12-31` }
        : /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)
          ? { from, to }
          : null;
  const backwards = span !== null && span.from > span.to;
  const query = span === null || backwards ? null : `from=${span.from}&to=${span.to}`;

  useEffect(() => {
    if (query === null) return;
    let live = true;
    setPending(true);
    authorizedRequest<BankAccountLedgerDto>(`/api/tenant/accounts/bank-accounts/${id}/ledger?${query}`)
      .then((data) => {
        if (!live) return;
        setLedger(data);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load the ledger.');
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, id, query]);

  const back = (
    <Link href={{ pathname: '/accounts/account-setup' }} className="text-cell text-harbour hover:underline">
      ← Back to list
    </Link>
  );

  if (error !== null && ledger === null) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState title="Not available" description={error} />
      </div>
    );
  }
  if (ledger === null) return <p className="text-body text-steel">Loading…</p>;

  async function exportIt(): Promise<void> {
    if (query === null || ledger === null) return;
    setExporting(true);
    try {
      await authorizedDownload(
        `/api/tenant/accounts/bank-accounts/${id}/ledger/export?${query}`,
        `ledger-${ledger.account.ledgerName}-${span?.from}-to-${span?.to}.xlsx`,
      );
    } catch {
      toast.error('Could not export the ledger.');
    } finally {
      setExporting(false);
    }
  }

  const code = ledger.currencyCode ?? 'Base';
  const years = Array.from({ length: 10 }, (_, i) => new Date().getFullYear() - i);
  const TH = 'label-manifest px-3 py-2';
  const TD = 'px-3 py-2 text-cell text-hull';
  const NUM = `${TD} text-right font-mono tabular-nums`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-page-title text-hull">Ledger - {ledger.account.ledgerName}</h1>
          <p className="text-body text-steel">
            {ledger.account.accountName} · <span className="font-mono tabular-nums">{ledger.account.accountNo}</span> ·{' '}
            {ledger.account.bankName}, {ledger.account.branch}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {can('ACCOUNTS.ACCOUNT_SETUP.EXPORT') && (
            <Button variant="secondary" onClick={() => void exportIt()} disabled={exporting || query === null}>
              {exporting ? 'Exporting…' : 'Export to Excel'}
            </Button>
          )}
          {back}
        </div>
      </div>

      {/* ---------------------------------------------------------- the period */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="label-manifest">Period</span>
          <Segmented label="Period" value={kind} options={PERIOD_OPTIONS} onChange={setKind} />
        </div>
        {kind === 'MONTH' && (
          <div className="flex w-48 flex-col gap-1">
            <label htmlFor="ledger-month" className="label-manifest">
              Month
            </label>
            <Input id="ledger-month" type="month" numeric value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
        )}
        {kind === 'YEAR' && (
          <div className="flex w-36 flex-col gap-1">
            <label htmlFor="ledger-year" className="label-manifest">
              Year
            </label>
            <Select id="ledger-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
        )}
        {kind === 'RANGE' && (
          <>
            <div className="flex w-48 flex-col gap-1">
              <label htmlFor="ledger-from" className="label-manifest">
                From
              </label>
              <Input id="ledger-from" type="date" numeric value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="flex w-48 flex-col gap-1">
              <label htmlFor="ledger-to" className="label-manifest">
                To
              </label>
              <Input id="ledger-to" type="date" numeric value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </>
        )}
      </div>
      {backwards && (
        <p role="alert" className="text-cell text-alert">
          The From date is after the To date. Choose a From date on or before the To date.
        </p>
      )}
      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {/* --------------------------------------------------------- the figures */}
      <div className="grid grid-cols-2 gap-4 rounded-manifest border border-line bg-surface px-4 py-3 shadow-manifest sm:grid-cols-4">
        {(
          [
            [`Opening balance (${code})`, ledger.opening, `As at ${sheetDay(ledger.from)}`],
            [`Money in (${code})`, ledger.totalDebit, null],
            [`Money out (${code})`, ledger.totalCredit, null],
            [`Closing balance (${code})`, ledger.closing, `As at ${sheetDay(ledger.to)}`],
          ] as [string, string, string | null][]
        ).map(([label, value, note]) => (
          <div key={label} className="text-right">
            <span className="label-manifest">{label}</span>
            <p className="font-mono text-section tabular-nums text-hull">
              <Money value={value} />
            </p>
            {note !== null && <p className="font-mono text-[11px] tabular-nums text-steel">{note}</p>}
          </div>
        ))}
      </div>

      <div className={cn('overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest', pending && 'opacity-60')}>
        <table className="w-full min-w-250 border-collapse">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className={`${TH} text-right`}>Date</th>
              <th className={`${TH} text-left`}>Voucher No</th>
              <th className={`${TH} text-left`}>Type</th>
              <th className={`${TH} text-left`}>Party</th>
              <th className={`${TH} text-left`}>Particulars</th>
              <th className={`${TH} text-left`}>Description</th>
              <th className={`${TH} text-right`}>Debit (in)</th>
              <th className={`${TH} text-right`}>Credit (out)</th>
              <th className={`${TH} text-right`}>Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line bg-paper/60">
              <td className={`${TD} text-right font-mono tabular-nums`}>{sheetDay(ledger.from)}</td>
              <td colSpan={7} className={`${TD} font-semibold`}>
                Opening balance
              </td>
              <td className={NUM}>
                <Money value={ledger.opening} strong />
              </td>
            </tr>
            {ledger.entries.length === 0 && (
              <tr className="border-b border-line">
                <td colSpan={9} className="px-3 py-6 text-center text-body text-steel">
                  No vouchers moved this account from {sheetDay(ledger.from)} to {sheetDay(ledger.to)}. Choose another
                  period above.
                </td>
              </tr>
            )}
            {ledger.entries.map((e) => (
              <tr key={e.journalEntryId} className="border-b border-line hover:bg-row-hover">
                <td className={`${TD} text-right font-mono tabular-nums`}>{sheetDay(e.date)}</td>
                <td className={`${TD} font-mono tabular-nums`}>
                  {can(`${JOURNAL_ENTRY_FEATURE[e.kind]}.VIEW`) ? (
                    // A new tab, so the ledger keeps its period.
                    <Link
                      href={`/accounts/${VOUCHER_SLUG[e.kind]}/${e.journalEntryId}` as Route}
                      target="_blank"
                      rel="noopener"
                      className="text-harbour hover:text-harbour-ink hover:underline"
                    >
                      {e.code}
                    </Link>
                  ) : (
                    e.code
                  )}
                </td>
                <td className={`${TD} text-steel`}>{JOURNAL_ENTRY_KIND_LABEL[e.kind]}</td>
                <td className={TD}>{e.partyName ?? '—'}</td>
                <td className={TD}>{e.particulars}</td>
                <td className={cn(TD, 'max-w-64 truncate')} title={e.description ?? undefined}>
                  {e.description ?? '—'}
                </td>
                <td className={NUM}>{Number(e.debit) === 0 ? '—' : amount(e.debit)}</td>
                <td className={NUM}>{Number(e.credit) === 0 ? '—' : amount(e.credit)}</td>
                <td className={NUM}>
                  <Money value={e.balance} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-paper">
              <td className={`${TD} text-right font-mono tabular-nums`}>{sheetDay(ledger.to)}</td>
              <td colSpan={5} className={`${TD} font-semibold uppercase`}>
                Closing balance
              </td>
              <td className={NUM}>
                <Money value={ledger.totalDebit} strong />
              </td>
              <td className={NUM}>
                <Money value={ledger.totalCredit} strong />
              </td>
              <td className={NUM}>
                <Money value={ledger.closing} strong />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
