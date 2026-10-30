'use client';

import {
  INCOME_STATEMENT_BASIS_LABEL,
  JOURNAL_ENTRY_FEATURE,
  JOURNAL_ENTRY_KIND_LABEL,
  type StatementBreakdownDto,
  type StatementEntryDto,
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
 * What one figure on the Balance Sheet or the Cash Flow Statement is made of
 * (client, 2026-10-28: "when I click on the amount it will pop up the
 * breakdown, so that I can track"). The Income Statement's breakdown is the
 * pattern: a column switch, one row per document, subtotals by source, and the
 * statement's own figure as the total. Every amount is the server's.
 */

export interface StatementBreakdownTarget<C extends string> {
  line: string;
  label: string;
  column: C;
}

const TH = 'label-manifest whitespace-nowrap px-3 py-2';
const TD = 'px-3 py-2 text-cell text-hull';
const TD_NUM = `${TD} text-right font-mono tabular-nums`;

function sourceLabel(entry: StatementEntryDto): string {
  switch (entry.source) {
    case 'VOUCHER':
      return entry.voucherKind === null ? 'Voucher' : `${JOURNAL_ENTRY_KIND_LABEL[entry.voucherKind]} voucher`;
    case 'DEBIT_INVOICE':
      return 'Debit invoice';
    case 'INVOICE_COST':
      return 'Cost on invoice';
    case 'OPENING':
      return 'Opening balance';
    case 'EARLIER':
      return 'Brought forward';
    case 'FIGURE':
      return 'Worked out';
  }
}

function Figure({ value, strong = false }: { value: string; strong?: boolean }) {
  return <span className={cn(Number(value) < 0 && 'text-alert', strong && 'font-semibold')}>{amount(value)}</span>;
}

export function StatementBreakdown<C extends string>({
  target,
  path,
  query,
  columns,
  onColumnChange,
  onClose,
}: {
  target: StatementBreakdownTarget<C> | null;
  /** The breakdown endpoint, e.g. /api/tenant/accounts/balance-sheet/breakdown. */
  path: string;
  /** The statement's own filters, as its query string. */
  query: string;
  /** The statement's columns, in order, for the switch. */
  columns: readonly (readonly [C, string])[];
  onColumnChange: (column: C) => void;
  onClose: () => void;
}) {
  const { data, error } = useRecord<StatementBreakdownDto>(
    target === null ? null : `${path}?${query}&line=${target.line}&column=${target.column}`,
  );
  const [invoiceId, setInvoiceId] = useState<string | null>(null);

  const description =
    data === null
      ? undefined
      : data.basis === null
        ? `Amounts in ${data.currencyCode}`
        : `${INCOME_STATEMENT_BASIS_LABEL[data.basis]} basis · amounts in ${data.currencyCode}`;

  return (
    <>
      <Modal
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={target?.label ?? 'Breakdown'}
        {...(description === undefined ? {} : { description })}
        size="wide"
      >
        {target !== null && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Segmented label="Column" value={target.column} options={columns} onChange={onColumnChange} />
            {data !== null && (
              <>
                <span className="font-mono text-cell tabular-nums text-steel">
                  {data.period.from === null
                    ? `As at ${sheetDay(data.period.to)}`
                    : `${sheetDay(data.period.from)} – ${sheetDay(data.period.to)}`}
                </span>
                {/* Up here as well as at the foot, which a long list scrolls far from. */}
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
          <Button variant="secondary" className="max-sm:w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      </Modal>

      {/* Opens over the breakdown; closing it returns there. */}
      <DebitInvoiceDetail id={invoiceId} onClose={() => setInvoiceId(null)} />
    </>
  );
}

function BreakdownBody({ data, onOpenInvoice }: { data: StatementBreakdownDto; onOpenInvoice: (id: string) => void }) {
  const { can } = useSession();

  if (data.entries.length === 0 && data.withheld === null) {
    return (
      <p className="rounded-manifest border border-line bg-paper/60 px-4 py-6 text-center text-body text-steel">
        {data.period.from === null
          ? `Nothing makes up this line as at ${sheetDay(data.period.to)}.`
          : `Nothing moved on this line from ${sheetDay(data.period.from)} to ${sheetDay(data.period.to)}.`}{' '}
        Switch the column above to look at another one.
      </p>
    );
  }

  const parts = data.groups.length + (data.withheld === null ? 0 : 1);
  // A column with nothing in any row is left out.
  const hasParty = data.entries.some((e) => e.partyName !== null);
  const hasDetails = data.entries.some((e) => e.details !== null);
  const leading = 4 + (hasParty ? 1 : 0) + (hasDetails ? 1 : 0);

  function documentCell(entry: StatementEntryDto) {
    if (entry.documentCode === null) return <span className="text-steel">—</span>;
    const code = <span className="font-mono tabular-nums">{entry.documentCode}</span>;
    // A new tab, so the statement and this breakdown stay where they are.
    const newTab = (href: string) => (
      <Link href={href as Route} target="_blank" rel="noopener" className="text-harbour hover:text-harbour-ink hover:underline">
        {code}
      </Link>
    );

    if (entry.source === 'VOUCHER' && entry.voucherKind !== null && entry.documentId !== null) {
      if (!can(`${JOURNAL_ENTRY_FEATURE[entry.voucherKind]}.VIEW`)) return code;
      return newTab(`/accounts/${VOUCHER_SLUG[entry.voucherKind]}/${entry.documentId}`);
    }
    if ((entry.source === 'DEBIT_INVOICE' || entry.source === 'INVOICE_COST') && entry.documentId !== null) {
      if (!can('ACCOUNTS.DEBIT_INVOICE.VIEW')) return code;
      const id = entry.documentId;
      return (
        <Button variant="text" size="inline" onClick={() => onOpenInvoice(id)} aria-haspopup="dialog">
          {code}
        </Button>
      );
    }
    if (entry.source === 'OPENING' && entry.partyType !== null && entry.partyId !== null) {
      if (!can('ACCOUNTS.RECEIVABLE_PAYABLE.VIEW')) return code;
      return newTab(`/accounts/receivable-payable/${entry.partyType.toLowerCase()}/${entry.partyId}`);
    }
    return code;
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
                Suppliers&apos; costs on debit invoices <span className="font-mono normal-case tracking-normal">· {data.withheld.count}</span>
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
            <tr className="border-b border-line bg-module-soft">
              <th className={`${TH} text-left`}>Date</th>
              <th className={`${TH} text-left`}>Document</th>
              <th className={`${TH} text-left`}>Source</th>
              {hasParty && <th className={`${TH} text-left`}>Party</th>}
              <th className={`${TH} text-left`}>Account / Booking</th>
              {hasDetails && <th className={`${TH} text-left`}>Details</th>}
              <th className={`${TH} text-right`}>Amount ({data.currencyCode})</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr
                key={`${e.source}-${e.documentId ?? e.partyId ?? e.reference}-${i}`}
                className={cn('border-b border-line hover:bg-row-hover', e.source === 'EARLIER' && 'bg-paper/60')}
              >
                <td className={`${TD} font-mono tabular-nums`}>{e.date === null ? '—' : sheetDay(e.date)}</td>
                <td className={TD}>{documentCell(e)}</td>
                <td className={`${TD} text-steel`}>{sourceLabel(e)}</td>
                {hasParty && <td className={TD}>{e.partyName ?? '—'}</td>}
                <td
                  className={cn(TD, (e.source === 'DEBIT_INVOICE' || e.source === 'INVOICE_COST') && 'font-mono tabular-nums')}
                >
                  {e.reference ?? '—'}
                </td>
                {hasDetails && (
                  <td className={cn(TD, 'max-w-72 truncate')} title={e.details ?? undefined}>
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
                  Suppliers&apos; costs on {data.withheld.count} debit invoice{data.withheld.count === 1 ? '' : 's'}, listed
                  only for users who can see buy prices
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

      {data.notes.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-cell text-steel">
          {data.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
