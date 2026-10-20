'use client';

import {
  INCOME_STATEMENT_BASIS_LABEL,
  INCOME_STATEMENT_COLUMN_LABEL,
  INCOME_STATEMENT_COLUMNS,
  type IncomeStatementBreakdownDto,
  type IncomeStatementColumn,
  type IncomeStatementEntryDto,
  JOURNAL_ENTRY_FEATURE,
  JOURNAL_ENTRY_KIND_LABEL,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

import { amount } from './format';
import { DebitInvoiceDetail, Pending, useRecord } from './invoice-detail';
import { sheetDay } from './statement-table';
import { VOUCHER_SLUG } from './voucher-list';

/**
 * What one figure on the Income Statement is made of (client, 2026-10-20): a
 * line's name opens it, and the popup switches between the three columns.
 * Every amount and total is the server's; this only lays them out.
 */

export interface BreakdownTarget {
  line: string;
  label: string;
  column: IncomeStatementColumn;
}

const TH = 'label-manifest px-3 py-2';
const TD = 'px-3 py-2 text-cell text-hull';
const TD_NUM = `${TD} text-right font-mono tabular-nums`;

function sourceLabel(entry: IncomeStatementEntryDto): string {
  switch (entry.source) {
    case 'DEBIT_INVOICE':
      return 'Debit invoice';
    case 'INVOICE_COST':
      return 'Cost on invoice';
    case 'EXCHANGE':
      return 'Exchange difference';
    case 'VOUCHER':
      return entry.voucherKind === null ? 'Voucher' : `${JOURNAL_ENTRY_KIND_LABEL[entry.voucherKind]} voucher`;
  }
}

function Figure({ value, strong = false }: { value: string; strong?: boolean }) {
  return <span className={cn(Number(value) < 0 && 'text-alert', strong && 'font-semibold')}>{amount(value)}</span>;
}

export function IncomeStatementBreakdown({
  target,
  query,
  onColumnChange,
  onClose,
}: {
  target: BreakdownTarget | null;
  /** The statement's own month, yearStartMonth and basis, as its query string. */
  query: string;
  onColumnChange: (column: IncomeStatementColumn) => void;
  onClose: () => void;
}) {
  const { data, error } = useRecord<IncomeStatementBreakdownDto>(
    target === null
      ? null
      : `/api/tenant/accounts/income-statement/breakdown?${query}&line=${target.line}&column=${target.column}`,
  );
  const [invoiceId, setInvoiceId] = useState<string | null>(null);

  return (
    <>
      <Modal
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={target?.label ?? 'Breakdown'}
        {...(data === null ? {} : { description: `${INCOME_STATEMENT_BASIS_LABEL[data.basis]} basis · amounts in ${data.currencyCode}` })}
        size="wide"
      >
        {target !== null && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Segmented
              label="Column"
              value={target.column}
              options={INCOME_STATEMENT_COLUMNS.map((c) => [c, INCOME_STATEMENT_COLUMN_LABEL[c]] as const)}
              onChange={onColumnChange}
            />
            {data !== null && (
              <>
                <span className="font-mono text-cell tabular-nums text-steel">
                  {sheetDay(data.period.from)} – {sheetDay(data.period.to)}
                </span>
                {/* Up here as well as at the foot, which a year's list scrolls far from. */}
                <span className="ml-auto text-body text-hull">
                  <span className="label-manifest mr-2">Total</span>
                  <span className="font-mono tabular-nums">
                    <Figure value={data.total} strong />
                  </span>
                </span>
              </>
            )}
          </div>
        )}

        {data === null ? <Pending error={error} /> : <BreakdownBody data={data} onOpenInvoice={setInvoiceId} />}

        <div className="mt-5 flex items-center justify-end border-t border-line pt-4">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>

      {/* Opens over the breakdown; closing it returns there. */}
      <DebitInvoiceDetail id={invoiceId} onClose={() => setInvoiceId(null)} />
    </>
  );
}

function BreakdownBody({
  data,
  onOpenInvoice,
}: {
  data: IncomeStatementBreakdownDto;
  onOpenInvoice: (id: string) => void;
}) {
  const { can } = useSession();

  if (data.entries.length === 0 && data.withheld === null) {
    return (
      <p className="rounded-manifest border border-line bg-paper/60 px-4 py-6 text-center text-body text-steel">
        Nothing was booked to this line from {sheetDay(data.period.from)} to {sheetDay(data.period.to)}. Switch the
        column above to look at another period.
      </p>
    );
  }

  const parts = data.groups.length + (data.withheld === null ? 0 : 1);
  // A column with nothing in any row is left out: revenue has no details, rent no party.
  const hasParty = data.entries.some((e) => e.partyName !== null);
  const hasDetails = data.entries.some((e) => e.details !== null);
  const leading = 4 + (hasParty ? 1 : 0) + (hasDetails ? 1 : 0);

  function documentCell(entry: IncomeStatementEntryDto) {
    const code = <span className="font-mono tabular-nums">{entry.documentCode}</span>;
    if (entry.voucherKind === null) {
      if (!can('ACCOUNTS.DEBIT_INVOICE.VIEW')) return code;
      return (
        <Button variant="text" size="inline" onClick={() => onOpenInvoice(entry.documentId)} aria-haspopup="dialog">
          {code}
        </Button>
      );
    }
    if (!can(`${JOURNAL_ENTRY_FEATURE[entry.voucherKind]}.VIEW`)) return code;
    // A new tab, so the statement and this breakdown stay where they are.
    return (
      <Link
        href={`/accounts/${VOUCHER_SLUG[entry.voucherKind]}/${entry.documentId}` as Route}
        target="_blank"
        rel="noopener"
        className="text-harbour hover:text-harbour-ink hover:underline"
      >
        {code}
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Where the figure came from, when it came from more than one place. */}
      {parts > 1 && (
        <dl className="grid gap-x-6 gap-y-2 rounded-manifest border border-line bg-paper/60 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.groups.map((g) => (
            <div key={g.label}>
              <dt className="label-manifest">
                {g.label} <span className="font-mono normal-case tracking-normal">· {g.count}</span>
              </dt>
              <dd className="font-mono text-body tabular-nums text-hull">
                <Figure value={g.amount} />
              </dd>
            </div>
          ))}
          {data.withheld !== null && (
            <div>
              <dt className="label-manifest">
                Costs on debit invoices <span className="font-mono normal-case tracking-normal">· {data.withheld.count}</span>
              </dt>
              <dd className="font-mono text-body tabular-nums text-hull">
                <Figure value={data.withheld.amount} />
              </dd>
            </div>
          )}
        </dl>
      )}

      <div className="overflow-x-auto rounded-manifest border border-line">
        <table className="w-full min-w-4xl border-collapse">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className={`${TH} text-left`}>Date</th>
              <th className={`${TH} text-left`}>Document</th>
              <th className={`${TH} text-left`}>Source</th>
              {hasParty && <th className={`${TH} text-left`}>Party</th>}
              <th className={`${TH} text-left`}>Booking / Account</th>
              {hasDetails && <th className={`${TH} text-left`}>Details</th>}
              <th className={`${TH} text-right`}>Amount ({data.currencyCode})</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr key={`${e.source}-${e.documentId}-${i}`} className="border-b border-line hover:bg-row-hover">
                <td className={`${TD} font-mono tabular-nums`}>{sheetDay(e.date)}</td>
                <td className={TD}>{documentCell(e)}</td>
                <td className={`${TD} text-steel`}>{sourceLabel(e)}</td>
                {hasParty && <td className={TD}>{e.partyName ?? '—'}</td>}
                <td className={cn(TD, e.source !== 'VOUCHER' && 'font-mono tabular-nums')}>{e.reference ?? '—'}</td>
                {hasDetails && (
                  <td
                    className={cn(TD, 'max-w-64 truncate', e.source === 'INVOICE_COST' && 'font-mono tabular-nums')}
                    title={e.details ?? undefined}
                  >
                    {e.details ?? '—'}
                  </td>
                )}
                <td className={TD_NUM}>
                  <Figure value={e.amount} />
                </td>
              </tr>
            ))}
            {data.withheld !== null && (
              <tr className="border-b border-line">
                <td colSpan={leading} className={`${TD} text-steel`}>
                  Job costs on {data.withheld.count} debit invoice{data.withheld.count === 1 ? '' : 's'}, listed only for
                  users who can see buy prices
                </td>
                <td className={TD_NUM}>
                  <Figure value={data.withheld.amount} />
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="bg-paper">
              <td colSpan={leading} className={`${TD} font-semibold uppercase`}>
                Total · {data.label}
              </td>
              <td className={TD_NUM}>
                <Figure value={data.total} strong />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
