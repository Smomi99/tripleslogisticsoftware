'use client';

import {
  JOURNAL_ENTRY_FEATURE,
  JOURNAL_ENTRY_KIND_LABEL,
  JOURNAL_ENTRY_STATUS_LABEL,
  type JournalEntryDto,
  type JournalEntryKind,
  LEDGER_PARTY_LABEL,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { amount, money } from './format';
import { VoucherForm } from './voucher-form';
import { VOUCHER_SLUG, VOUCHER_STATUS_TONE } from './voucher-list';

/**
 * One voucher, as the books hold it (§14.4). A posted voucher is never edited:
 * it is cancelled with a reason, which also takes back whatever it paid or
 * banked against a party's invoice, and entered again. A draft journal opens
 * in its form, to finish and agree.
 */
export function VoucherView({ kind, id }: { kind: JournalEntryKind; id: string }) {
  const { authorizedRequest, authorizedDownload, can } = useSession();
  const slug = VOUCHER_SLUG[kind];
  const feature = JOURNAL_ENTRY_FEATURE[kind];
  const [entry, setEntry] = useState<JournalEntryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntry(await authorizedRequest<JournalEntryDto>(`/api/tenant/accounts/${slug}/${id}`));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this voucher.');
    }
  }, [authorizedRequest, slug, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <Link href={`/accounts/${slug}` as Route} className="text-cell text-harbour hover:underline">
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
  if (entry === null) return <p className="text-body text-steel">Loading…</p>;

  async function cancel(): Promise<void> {
    if (entry === null) return;
    setBusy(true);
    try {
      await authorizedRequest(`/api/tenant/accounts/${slug}/${entry.id}/cancel`, { method: 'POST', body: { reason } });
      toast.success(`${entry.code} cancelled`);
      setCancelling(false);
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not cancel it.');
    } finally {
      setBusy(false);
    }
  }

  async function agree(): Promise<void> {
    if (entry === null) return;
    setBusy(true);
    try {
      const done = await authorizedRequest<JournalEntryDto>(`/api/tenant/accounts/journal/${entry.id}/post`, { method: 'POST' });
      toast.success(`${done.code} saved to the books`);
      setEntry(done);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not agree it.');
    } finally {
      setBusy(false);
    }
  }

  const cancelModal = (
    <Modal
      open={cancelling}
      onOpenChange={setCancelling}
      title={`Cancel ${entry.code}?`}
      description={
        entry.settlement !== null
          ? `The number is kept on the record, and what it ${kind === 'EXPENSE' ? 'paid' : 'received'} against ${entry.settlement.reference} goes back on their ledger.`
          : 'The number is kept on the record, and it comes out of every balance.'
      }
    >
      <div className="flex flex-col gap-4">
        <Field id="reason" label="Reason" required>
          <textarea
            id="reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
          />
        </Field>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setCancelling(false)}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={busy || reason.trim() === ''} onClick={() => void cancel()}>
            {busy ? 'Cancelling…' : 'Cancel voucher'}
          </Button>
        </div>
      </div>
    </Modal>
  );

  if (entry.editable && can('ACCOUNTS.JOURNAL.EDIT')) {
    return (
      <div className="flex flex-col gap-4">
        <VoucherForm kind={kind} existing={entry} />
        {entry.cancellable && can(`${feature}.CANCEL`) && (
          <div>
            <Button variant="destructive" onClick={() => setCancelling(true)}>
              Cancel draft
            </Button>
          </div>
        )}
        {cancelModal}
      </div>
    );
  }

  const baseCode = entry.baseCurrencyCode ?? 'Base';
  const debit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
  const credit = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
  const settlementHref =
    entry.settlement !== null && entry.settlement.debitInvoiceId !== null && can('ACCOUNTS.DEBIT_INVOICE.VIEW')
      ? (`/accounts/debit-invoice/${entry.settlement.debitInvoiceId}` as Route)
      : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="label-manifest">{JOURNAL_ENTRY_KIND_LABEL[kind]}</p>
            <h1 className="font-mono text-page-title tabular-nums text-hull">{entry.code}</h1>
          </div>
          <div className="flex items-center gap-3">
            <Status tone={VOUCHER_STATUS_TONE[entry.status]}>{JOURNAL_ENTRY_STATUS_LABEL[entry.status]}</Status>
            {entry.status === 'DRAFT' && can('ACCOUNTS.JOURNAL.APPROVE') && (
              <Button disabled={busy} onClick={() => void agree()}>
                Save & agreed
              </Button>
            )}
            {entry.cancellable && can(`${feature}.CANCEL`) && (
              <Button variant="destructive" onClick={() => setCancelling(true)}>
                Cancel voucher
              </Button>
            )}
          </div>
        </div>
      </div>

      {entry.status === 'CANCELLED' && (
        <p className="rounded-manifest border border-line bg-paper px-3 py-2 text-body text-hull">
          Cancelled{entry.cancelledAt === null ? '' : ` on ${entry.cancelledAt.slice(0, 10)}`}: {entry.cancelReason}
        </p>
      )}

      <section className="grid grid-cols-1 gap-x-8 gap-y-3 rounded-manifest border border-line bg-surface p-5 shadow-manifest md:grid-cols-3">
        <div>
          <p className="label-manifest">Date</p>
          <p className="font-mono text-body tabular-nums text-hull">{entry.entryDate}</p>
        </div>
        {entry.party !== null && (
          <div>
            <p className="label-manifest">{kind === 'EXPENSE' ? 'Pay to' : 'Income From'}</p>
            <p className="text-body text-hull">
              {entry.party.name} <span className="text-steel">· {LEDGER_PARTY_LABEL[entry.party.type]}</span>
            </p>
          </div>
        )}
        {entry.settlement !== null && (
          <div>
            <p className="label-manifest">{entry.settlement.against === 'OPENING' ? 'Against' : 'Invoice No'}</p>
            <p className="text-body text-hull">
              {settlementHref === null ? (
                <span className="font-mono tabular-nums">{entry.settlement.reference}</span>
              ) : (
                <Link href={settlementHref} className="font-mono tabular-nums text-harbour hover:underline">
                  {entry.settlement.reference}
                </Link>
              )}{' '}
              <span className="font-mono tabular-nums text-steel">
                · {money(entry.settlement.currencyCode, entry.settlement.amount)}
              </span>
            </p>
          </div>
        )}
        <div className="md:col-span-3">
          <p className="label-manifest">Description</p>
          <p className="text-body text-hull">{entry.description ?? '—'}</p>
        </div>
        {entry.attachmentFileName !== null && (
          <div className="md:col-span-3">
            <p className="label-manifest">{kind === 'EXPENSE' ? 'Payment voucher' : 'File'}</p>
            <Button
              variant="text"
              size="inline"
              onClick={() =>
                void authorizedDownload(`/api/tenant/accounts/${slug}/${entry.id}/file`, entry.attachmentFileName ?? 'voucher').catch(
                  (caught: unknown) => toast.error(caught instanceof ApiError ? caught.message : 'Could not download the file.'),
                )
              }
            >
              {entry.attachmentFileName}
            </Button>
          </div>
        )}
      </section>

      <section className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
        <table className="w-full min-w-160 border-collapse">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className="label-manifest w-28 px-3 py-2 text-left">Code</th>
              <th className="label-manifest px-3 py-2 text-left">Account</th>
              <th className="label-manifest w-44 px-3 py-2 text-right">Debit ({baseCode})</th>
              <th className="label-manifest w-44 px-3 py-2 text-right">Credit ({baseCode})</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l) => (
              <tr key={l.id} className="border-b border-line">
                <td className="px-3 py-2 font-mono text-cell tabular-nums text-steel">{l.accountCode}</td>
                <td className="px-3 py-2 text-cell text-hull">{l.accountLabel}</td>
                <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-hull">
                  {Number(l.debit) > 0 ? amount(l.debit) : ''}
                </td>
                <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-hull">
                  {Number(l.credit) > 0 ? amount(l.credit) : ''}
                </td>
              </tr>
            ))}
            <tr className="bg-paper">
              <td />
              <td className="label-manifest px-3 py-2 text-right">Total</td>
              <td className="px-3 py-2 text-right font-mono text-body font-semibold tabular-nums text-hull">{amount(String(debit))}</td>
              <td className="px-3 py-2 text-right font-mono text-body font-semibold tabular-nums text-hull">{amount(String(credit))}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {cancelModal}
    </div>
  );
}
