'use client';

import {
  TA_DA_MODE_SUGGESTIONS,
  TA_DA_STATUS_LABEL,
  type TaDaClaimDto,
  type TaDaClaimSaveInput,
  taDaClaimSaveSchema,
  type TaDaOptionsDto,
  type TaDaStatus,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Status, type StatusTone } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { amount, fmt } from './format';

/**
 * One TA/DA claim (packages/shared/src/ta-da.ts): who travelled and why, a
 * row per trip or day, and the totals. The buttons along the foot are the
 * claim's next step, offered only to someone who may take it — Save and
 * Submit to the claimant, Approve and Reject to an approver, Pay to Accounts.
 */

export const TA_DA_TONE: Record<TaDaStatus, StatusTone> = {
  DRAFT: 'inactive',
  SUBMITTED: 'pending',
  APPROVED: 'pending',
  REJECTED: 'overdue',
  PAID: 'active',
  CANCELLED: 'inactive',
};

const FEATURE = 'ACCOUNTS.TA_DA';
const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour disabled:cursor-not-allowed disabled:bg-paper disabled:text-steel';

interface LineDraft {
  key: number;
  travelDate: string;
  fromPlace: string;
  toPlace: string;
  mode: string;
  description: string;
  taAmount: string;
  daAmount: string;
}

let seq = 0;
const blank = (date: string): LineDraft => ({
  key: (seq += 1),
  travelDate: date,
  fromPlace: '',
  toPlace: '',
  mode: '',
  description: '',
  taAmount: '',
  daAmount: '',
});

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const num = (v: string): number => (v.trim() === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));

export function TaDaForm({
  claim,
  options,
  onSaved,
}: {
  claim: TaDaClaimDto | null;
  options: TaDaOptionsDto;
  onSaved: (next: TaDaClaimDto) => void;
}) {
  const { can, authorizedRequest } = useSession();
  const router = useRouter();
  const isNew = claim === null;

  const [employeeId, setEmployeeId] = useState(claim?.employeeId ?? options.myEmployeeId ?? '');
  const [claimDate, setClaimDate] = useState(claim?.claimDate ?? today());
  const [purpose, setPurpose] = useState(claim?.purpose ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    claim === null
      ? [blank(today())]
      : claim.lines.map((l) => ({
          key: (seq += 1),
          travelDate: l.travelDate,
          fromPlace: l.fromPlace,
          toPlace: l.toPlace,
          mode: l.mode ?? '',
          description: l.description ?? '',
          taAmount: l.taAmount,
          daAmount: l.daAmount,
        })),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'reject' | 'cancel' | 'pay' | null>(null);
  const [reason, setReason] = useState('');
  const [paymentDate, setPaymentDate] = useState(today());
  const [moneyAccountId, setMoneyAccountId] = useState(options.moneyAccounts[0]?.id ?? '');

  const writable = isNew ? can(`${FEATURE}.CREATE`) : claim.editable && can(`${FEATURE}.EDIT`);
  const totals = useMemo(() => {
    const ta = lines.reduce((s, l) => s + num(l.taAmount), 0);
    const da = lines.reduce((s, l) => s + num(l.daAmount), 0);
    return { ta, da, total: ta + da };
  }, [lines]);
  const currency = claim?.currencyCode ?? options.baseCurrencyCode ?? '';

  const patch = (key: number, next: Partial<LineDraft>) =>
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...next } : l)));

  function body(): TaDaClaimSaveInput {
    return {
      employeeId,
      claimDate,
      purpose,
      lines: lines
        .filter((l) => l.fromPlace.trim() !== '' || l.toPlace.trim() !== '' || num(l.taAmount) + num(l.daAmount) > 0)
        .map((l) => ({
          travelDate: l.travelDate,
          fromPlace: l.fromPlace,
          toPlace: l.toPlace,
          mode: l.mode,
          description: l.description,
          taAmount: l.taAmount.trim() === '' ? '0' : l.taAmount.trim(),
          daAmount: l.daAmount.trim() === '' ? '0' : l.daAmount.trim(),
        })),
    };
  }

  /** Saves the claim and returns what the server stored, or null with the reason toasted. */
  async function save(): Promise<TaDaClaimDto | null> {
    const payload = body();
    const parsed = taDaClaimSaveSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the claim and try again.');
      return null;
    }
    try {
      return await authorizedRequest<TaDaClaimDto>(
        isNew ? '/api/tenant/accounts/ta-da' : `/api/tenant/accounts/ta-da/${claim.id}`,
        { method: isNew ? 'POST' : 'PATCH', body: payload },
      );
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save the claim.');
      return null;
    }
  }

  function land(next: TaDaClaimDto): void {
    if (isNew) router.replace(`/accounts/ta-da/${next.id}` as Route);
    else onSaved(next);
  }

  async function onSave(): Promise<void> {
    setBusy('save');
    const saved = await save();
    setBusy(null);
    if (saved === null) return;
    toast.success(isNew ? `Saved as ${saved.code}` : 'Saved');
    land(saved);
  }

  /** A transition on a saved claim — submit, approve, reject, pay, cancel. */
  async function act(step: string, payload: object, done: string, saveFirst = false): Promise<void> {
    setBusy(step);
    try {
      const target = saveFirst ? await save() : claim;
      if (target === null) return;
      const next = await authorizedRequest<TaDaClaimDto>(`/api/tenant/accounts/ta-da/${target.id}/${step}`, {
        method: 'POST',
        body: payload,
      });
      toast.success(done.replace('{code}', next.code));
      setDialog(null);
      setReason('');
      land(next);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'That did not go through. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const status = claim?.status;
  const canSubmit = writable && (isNew || status === 'DRAFT' || status === 'REJECTED');
  const canDecide = status === 'SUBMITTED' && can(`${FEATURE}.APPROVE`);
  const canPay = status === 'APPROVED' && can('ACCOUNTS.EXPENSE.CREATE');
  const canCancel =
    claim !== null && status !== 'PAID' && status !== 'CANCELLED' && can(`${FEATURE}.TOGGLE_STATUS`);

  return (
    <div className="flex flex-col gap-5">
      {/* ------------------------------------------------------------ header */}
      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="font-mono text-page-title tabular-nums text-hull">{claim?.code ?? 'New TA/DA claim'}</h1>
            {claim !== null && <Status tone={TA_DA_TONE[claim.status]}>{TA_DA_STATUS_LABEL[claim.status]}</Status>}
          </div>
          <Link href={{ pathname: '/accounts/ta-da' }} className="text-cell text-harbour hover:underline">
            ← Back to list
          </Link>
        </div>

        {claim?.status === 'REJECTED' && (
          <p className="mb-4 rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
            Rejected by {claim.decidedByName ?? 'an approver'}: {claim.rejectReason}. Change it and submit again.
          </p>
        )}
        {claim?.status === 'CANCELLED' && (
          <p className="mb-4 rounded-manifest border border-line bg-paper px-3 py-2 text-body text-hull">
            Cancelled {claim.cancelledAt?.slice(0, 10)} — {claim.cancelReason}
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Field id="employeeId" label="Employee" required>
            <Select id="employeeId" value={employeeId} disabled={!writable} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Choose the employee</option>
              {options.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="claimDate" label="Claim date" required>
            <Input id="claimDate" type="date" numeric value={claimDate} disabled={!writable} onChange={(e) => setClaimDate(e.target.value)} />
          </Field>
          <Field id="purpose" label="Purpose" required wide hint="What the travel was for — the port, customs, a customer's factory.">
            <textarea id="purpose" rows={2} className={TEXTAREA} value={purpose} disabled={!writable} onChange={(e) => setPurpose(e.target.value)} />
          </Field>
        </div>
      </section>

      {/* ------------------------------------------------------------- lines */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-section text-hull">Trips and days</h2>
          <p className="text-cell text-steel">TA is the fare; DA is food and the day&apos;s stay. One row per trip or day.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-250 border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Date</th>
                <th className="label-manifest px-3 py-2 text-left">From</th>
                <th className="label-manifest px-3 py-2 text-left">To</th>
                <th className="label-manifest px-3 py-2 text-left">Mode</th>
                <th className="label-manifest px-3 py-2 text-left">Note</th>
                <th className="label-manifest px-3 py-2 text-right">TA ({currency})</th>
                <th className="label-manifest px-3 py-2 text-right">DA ({currency})</th>
                <th className="label-manifest px-3 py-2 text-right">Amount</th>
                {writable && <th className="label-manifest px-3 py-2 text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key} className="border-b border-line last:border-0">
                  <td className="px-3 py-1.5">
                    {writable ? (
                      <Input aria-label="Date" type="date" numeric className="w-36" value={l.travelDate} onChange={(e) => patch(l.key, { travelDate: e.target.value })} />
                    ) : (
                      <span className="font-mono text-cell tabular-nums">{l.travelDate}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {writable ? (
                      <Input aria-label="From" className="min-w-36" value={l.fromPlace} onChange={(e) => patch(l.key, { fromPlace: e.target.value })} />
                    ) : (
                      <span className="text-cell">{l.fromPlace}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {writable ? (
                      <Input aria-label="To" className="min-w-36" value={l.toPlace} onChange={(e) => patch(l.key, { toPlace: e.target.value })} />
                    ) : (
                      <span className="text-cell">{l.toPlace}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {writable ? (
                      <Input aria-label="Mode" list="ta-da-modes" className="w-32" value={l.mode} onChange={(e) => patch(l.key, { mode: e.target.value })} />
                    ) : (
                      <span className="text-cell text-steel">{l.mode || '—'}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {writable ? (
                      <Input aria-label="Note" className="min-w-40" value={l.description} onChange={(e) => patch(l.key, { description: e.target.value })} />
                    ) : (
                      <span className="text-cell text-steel">{l.description || '—'}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {writable ? (
                      <Input aria-label="TA" inputMode="decimal" className="w-28 text-right font-mono tabular-nums" value={l.taAmount} onChange={(e) => patch(l.key, { taAmount: e.target.value })} />
                    ) : (
                      <span className="font-mono text-cell tabular-nums">{amount(l.taAmount)}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {writable ? (
                      <Input aria-label="DA" inputMode="decimal" className="w-28 text-right font-mono tabular-nums" value={l.daAmount} onChange={(e) => patch(l.key, { daAmount: e.target.value })} />
                    ) : (
                      <span className="font-mono text-cell tabular-nums">{amount(l.daAmount)}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-hull">
                    {fmt(num(l.taAmount) + num(l.daAmount))}
                  </td>
                  {writable && (
                    <td className="px-3 py-1.5 text-right">
                      <Button variant="destructive" size="inline" onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}>
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="ta-da-modes">
            {TA_DA_MODE_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-paper px-4 py-2">
          {writable ? (
            <Button
              variant="text"
              size="inline"
              onClick={() => setLines((c) => [...c, blank(c[c.length - 1]?.travelDate ?? claimDate)])}
            >
              + Add trip or day
            </Button>
          ) : (
            <span />
          )}
          <p className="font-mono text-body tabular-nums text-hull">
            <span className="label-manifest mr-2">TA</span>
            {fmt(totals.ta)}
            <span className="label-manifest ml-5 mr-2">DA</span>
            {fmt(totals.da)}
            <span className="label-manifest ml-5 mr-2">Total</span>
            <span className="text-section">{fmt(totals.total)}</span> {currency}
          </p>
        </div>
      </section>

      {/* --------------------------------------------------- the record */}
      {claim !== null && (claim.submittedAt !== null || claim.voucher !== null) && (
        <section className="flex flex-wrap gap-x-8 gap-y-2 rounded-manifest border border-line bg-surface px-5 py-3 text-body shadow-manifest">
          {claim.submittedAt !== null && (
            <span>
              <span className="label-manifest mr-2">Submitted</span>
              {claim.submittedByName ?? '—'} · <span className="font-mono tabular-nums">{claim.submittedAt.slice(0, 10)}</span>
            </span>
          )}
          {claim.decidedAt !== null && claim.status !== 'REJECTED' && (
            <span>
              <span className="label-manifest mr-2">Approved</span>
              {claim.decidedByName ?? '—'} · <span className="font-mono tabular-nums">{claim.decidedAt.slice(0, 10)}</span>
            </span>
          )}
          {claim.voucher !== null && (
            <span>
              <span className="label-manifest mr-2">Paid by</span>
              {can('ACCOUNTS.EXPENSE.VIEW') ? (
                <Link href={`/accounts/expense/${claim.voucher.id}` as Route} className="font-mono tabular-nums text-harbour hover:underline">
                  {claim.voucher.code}
                </Link>
              ) : (
                <span className="font-mono tabular-nums">{claim.voucher.code}</span>
              )}
              {claim.paidByName !== null && <> · {claim.paidByName}</>}
            </span>
          )}
        </section>
      )}

      {/* --------------------------------------------------- the buttons */}
      <section className="flex flex-wrap items-center gap-3 rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        {writable && (
          <Button variant="secondary" disabled={busy !== null} onClick={() => void onSave()}>
            {busy === 'save' ? 'Saving…' : isNew ? 'Save draft' : 'Save changes'}
          </Button>
        )}
        {canSubmit && (
          <Button disabled={busy !== null} onClick={() => void act('submit', {}, '{code} submitted for approval', true)}>
            {busy === 'submit' ? 'Submitting…' : 'Submit for approval'}
          </Button>
        )}
        {canDecide && (
          <>
            <Button disabled={busy !== null} onClick={() => void act('approve', {}, '{code} approved')}>
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
            <Button variant="destructive" disabled={busy !== null} onClick={() => setDialog('reject')}>
              Reject
            </Button>
          </>
        )}
        {canPay && (
          <Button disabled={busy !== null} onClick={() => setDialog('pay')}>
            Pay
          </Button>
        )}
        {canCancel && (
          <Button variant="destructive" disabled={busy !== null} onClick={() => setDialog('cancel')}>
            Cancel claim
          </Button>
        )}
        {status === 'SUBMITTED' && !canDecide && <p className="text-cell text-steel">Waiting for an approver.</p>}
        {status === 'APPROVED' && !canPay && <p className="text-cell text-steel">Approved — waiting for Accounts to pay it.</p>}
      </section>

      {/* ------------------------------------------- reject / cancel reason */}
      <Modal
        open={dialog === 'reject' || dialog === 'cancel'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={dialog === 'reject' ? `Reject ${claim?.code ?? ''}?` : `Cancel ${claim?.code ?? ''}?`}
        description={
          dialog === 'reject'
            ? 'It goes back to the claimant to change and submit again.'
            : 'The number is kept on the record. A cancelled claim cannot be paid.'
        }
      >
        <div className="flex flex-col gap-4">
          <Field id="reason" label="Reason" required>
            <textarea id="reason" rows={3} className={TEXTAREA} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={busy !== null || reason.trim() === ''}
              onClick={() =>
                void (dialog === 'reject'
                  ? act('reject', { reason }, '{code} rejected')
                  : act('cancel', { reason }, '{code} cancelled'))
              }
            >
              {busy === 'reject' || busy === 'cancel' ? 'Working…' : dialog === 'reject' ? 'Reject claim' : 'Cancel claim'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* -------------------------------------------------------------- pay */}
      <Modal
        open={dialog === 'pay'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={`Pay ${claim?.code ?? ''}`}
        description={`An Expense voucher for ${currency} ${claim === null ? '' : amount(claim.totalAmount)} on the TA/DA account, paid from the account you choose.`}
      >
        <div className="flex flex-col gap-4">
          <Field id="paymentDate" label="Payment date" required>
            <Input id="paymentDate" type="date" numeric value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </Field>
          <Field id="moneyAccountId" label="Paid from" required>
            <Select id="moneyAccountId" value={moneyAccountId} onChange={(e) => setMoneyAccountId(e.target.value)}>
              {options.moneyAccounts.length === 0 && <option value="">No cash or bank account is set up</option>}
              {options.moneyAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.balance === null ? '' : ` — ${amount(a.balance)}`}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Not now
            </Button>
            <Button
              disabled={busy !== null || moneyAccountId === ''}
              onClick={() => void act('pay', { paymentDate, moneyAccountId }, '{code} paid')}
            >
              {busy === 'pay' ? 'Paying…' : 'Pay claim'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
