'use client';

import {
  LEDGER_PARTY_LABEL,
  type LedgerDto,
  type LedgerEntryDto,
  PAYMENT_STATUS_LABEL,
  SUPPLIER_PAYMENT_STATUS_LABEL,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';

import { amount, PAYMENT_TONE } from '@/components/accounts/format';
import { EmptyState } from '@/components/ui/empty-state';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * One party's ledger — the client's `Ledger.` sheet, titled `Ledger - CMA`
 * (docs/MODULE_ACCOUNTS.md §2.5), with the payments the books now record
 * (§14.6).
 *
 * Every document that moved the balance, in date order, each in its own
 * currency with the rate it was booked at: sheet G8's `Amount x Conversion
 * Rate = Amount (Base cur)`. `Make Payment` opens Expense against a supplier's
 * invoice, `Receive` opens Income against a customer's, and each payment names
 * the voucher that moved the money.
 */
export default function LedgerPage({ params }: { params: Promise<{ partyType: string; partyId: string }> }) {
  const { partyType, partyId } = use(params);
  const { authorizedRequest, can } = useSession();
  const [ledger, setLedger] = useState<LedgerDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void authorizedRequest<LedgerDto>(`/api/tenant/accounts/receivable-payable/${partyType}/${partyId}`)
      .then((data) => {
        if (!cancelled) setLedger(data);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : 'Could not load this ledger.');
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, partyType, partyId]);

  const back = (
    <Link href={{ pathname: '/accounts/receivable-payable' }} className="text-cell text-harbour hover:underline">
      ← Back to list
    </Link>
  );

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState title="Not available" description={error} />
      </div>
    );
  }
  if (ledger === null) return <p className="text-body text-steel">Loading…</p>;

  const baseCode = ledger.baseCurrencyCode ?? 'Base';
  const canOpenInvoice = can('ACCOUNTS.DEBIT_INVOICE.VIEW');
  const canPay = can('ACCOUNTS.EXPENSE.CREATE');
  const canReceive = can('ACCOUNTS.INCOME.CREATE') && can('ACCOUNTS.DEBIT_INVOICE.RECEIVE');
  const canReceiveOpening = can('ACCOUNTS.INCOME.CREATE');
  const partyRef = `${ledger.partyType}:${ledger.partyId}`;

  /** Where a receipt, payment or settlement's voucher lives. */
  const voucherHref = (e: LedgerEntryDto): Route | null => {
    if (e.journalEntryId === null) return null;
    const incoming = e.kind === 'RECEIPT' || (e.kind === 'OPENING_SETTLEMENT' && e.side === 'RECEIVABLE');
    const feature = incoming ? 'ACCOUNTS.INCOME.VIEW' : 'ACCOUNTS.EXPENSE.VIEW';
    if (!can(feature)) return null;
    return `/accounts/${incoming ? 'income' : 'expense'}/${e.journalEntryId}` as Route;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-page-title text-hull">Ledger - {ledger.partyName}</h1>
          <p className="text-body text-steel">
            <span className="font-mono tabular-nums">{ledger.partyCode}</span> ·{' '}
            {LEDGER_PARTY_LABEL[ledger.partyType]}
          </p>
        </div>
        {back}
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-manifest border border-line bg-surface px-4 py-3 shadow-manifest sm:grid-cols-3 xl:grid-cols-6">
        {(
          [
            ['Receivable (USD)', ledger.totals.receivableUsd],
            [`Receivable (${baseCode})`, ledger.totals.receivableBase],
            ['Unbilled (USD)', ledger.totals.unbilledUsd],
            [`Unbilled (${baseCode})`, ledger.totals.unbilledBase],
            ['Payable (USD)', ledger.totals.payableUsd],
            [`Payable (${baseCode})`, ledger.totals.payableBase],
          ] as [string, string][]
        ).map(([label, value]) => (
          <div key={label} className="text-right">
            <span className="label-manifest">{label}</span>
            <p className="font-mono text-section tabular-nums text-hull">{amount(value)}</p>
          </div>
        ))}
      </div>

      {ledger.entries.length === 0 ? (
        <EmptyState
          title="Nothing on this ledger yet"
          description="Entries appear when a debit invoice naming this party is sent, when money is paid or received against one, or when an opening balance is entered in CRM."
        />
      ) : (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full min-w-250 border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-right">Date</th>
                <th className="label-manifest px-3 py-2 text-left">Invoice No</th>
                <th className="label-manifest px-3 py-2 text-left">Description</th>
                <th className="label-manifest px-3 py-2 text-left">Side</th>
                <th className="label-manifest px-3 py-2 text-right">Amount</th>
                <th className="label-manifest px-3 py-2 text-right">Conversion Rate</th>
                <th className="label-manifest px-3 py-2 text-right">Amount ({baseCode})</th>
                <th className="label-manifest px-3 py-2 text-left">Payment Status</th>
                <th className="label-manifest px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {ledger.entries.map((e, index) => {
                const voucher = voucherHref(e);
                return (
                  <tr key={`${e.kind}:${e.reference}:${index}`} className="border-b border-line last:border-0 hover:bg-[#F0F4F4]">
                    <td className="px-3 py-2 text-right font-mono text-cell tabular-nums">{e.date}</td>
                    <td className="px-3 py-2 font-mono text-cell tabular-nums text-hull">
                      {voucher === null ? (
                        e.reference
                      ) : (
                        <Link href={voucher} className="text-harbour hover:underline">
                          {e.reference}
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2 text-cell text-hull">{e.description}</td>
                    <td className="px-3 py-2 text-cell text-steel">{e.side === 'RECEIVABLE' ? 'Receivable' : 'Payable'}</td>
                    <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-hull">
                      {e.currencyCode} {amount(e.amount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-steel">
                      {e.conversionRate ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-hull">{amount(e.amountBase)}</td>
                    <td className="px-3 py-2">
                      {e.paymentStatus === null ? (
                        <span className="text-cell text-steel">—</span>
                      ) : (
                        <Status tone={PAYMENT_TONE[e.paymentStatus]}>
                          {e.side === 'PAYABLE'
                            ? SUPPLIER_PAYMENT_STATUS_LABEL[e.paymentStatus]
                            : PAYMENT_STATUS_LABEL[e.paymentStatus]}
                        </Status>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-3">
                        {e.kind === 'SUPPLIER_INVOICE' && e.paymentStatus !== 'PAID' && canPay && e.creditInvoiceId !== null && (
                          <Link
                            href={`/accounts/expense/new?creditInvoice=${e.creditInvoiceId}` as Route}
                            className="text-cell text-harbour hover:underline"
                          >
                            Make Payment
                          </Link>
                        )}
                        {e.kind === 'DEBIT_INVOICE' && e.paymentStatus !== 'PAID' && canReceive && e.debitInvoiceId !== null && (
                          <Link
                            href={`/accounts/income/new?debitInvoice=${e.debitInvoiceId}` as Route}
                            className="text-cell text-harbour hover:underline"
                          >
                            Receive
                          </Link>
                        )}
                        {e.kind === 'OPENING' && e.side === 'PAYABLE' && canPay && ledger.partyType !== 'CUSTOMER' && (
                          <Link
                            href={`/accounts/expense/new?opening=${partyRef}` as Route}
                            className="text-cell text-harbour hover:underline"
                          >
                            Make Payment
                          </Link>
                        )}
                        {e.kind === 'OPENING' && e.side === 'RECEIVABLE' && canReceiveOpening && ledger.partyType === 'CUSTOMER' && (
                          <Link
                            href={`/accounts/income/new?opening=${partyRef}` as Route}
                            className="text-cell text-harbour hover:underline"
                          >
                            Receive
                          </Link>
                        )}
                        {(e.kind === 'DEBIT_INVOICE' || e.kind === 'SUPPLIER_INVOICE') && e.debitInvoiceId !== null && canOpenInvoice && (
                          <Link
                            href={`/accounts/debit-invoice/${e.debitInvoiceId}` as Route}
                            className="text-cell text-harbour hover:underline"
                          >
                            Open invoice
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
