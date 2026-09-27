'use client';

import {
  type ChartDto,
  type ChartLedgerDto,
  LEDGER_ACCOUNT_TYPE_LABEL,
  LEDGER_ACCOUNT_TYPES,
  type LedgerAccountDto,
  type LedgerAccountType,
} from '@ff/shared';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { amount } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { FormLayout, PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Segmented } from '@/components/ui/segmented';
import { ActiveStatus } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * Accounts → Chart of accounts — the client's `Chart of accounts` sheet
 * (docs/MODULE_ACCOUNTS.md §14.1).
 *
 * The five heads along the top (row 6), each a list of Ledgers with their Sub
 * Ledgers under them (B64–C68: "Ledger: Cost of Service · Sub Ledger: Sea
 * Freight-FCL"). "+ ADD new" beside a ledger adds a sub ledger; "++" beside a
 * head adds a ledger. The chart arrives predefined and is the workspace's own
 * to rename and extend. Balances are what the posted vouchers add up to.
 */

type Editing =
  | { mode: 'add-ledger'; accountType: LedgerAccountType }
  | { mode: 'add-sub'; ledger: ChartLedgerDto }
  | { mode: 'rename'; account: LedgerAccountDto };

export default function ChartOfAccountsPage() {
  const { authorizedRequest, can } = useSession();
  const [chart, setChart] = useState<ChartDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [head, setHead] = useState<LedgerAccountType>('EXPENSE');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [toToggle, setToToggle] = useState<LedgerAccountDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setChart(await authorizedRequest<ChartDto>('/api/tenant/accounts/chart'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the chart.');
    }
  }, [authorizedRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(): Promise<void> {
    if (toToggle === null) return;
    setBusy(true);
    try {
      await authorizedRequest(`/api/tenant/accounts/chart/${toToggle.id}/toggle-status`, { method: 'POST' });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not change the status.');
      setToToggle(null);
    } finally {
      setBusy(false);
    }
  }

  const current = chart?.heads.find((h) => h.accountType === head);
  const baseCode = chart?.baseCurrencyCode ?? 'Base';
  const canCreate = can('ACCOUNTS.CHART_OF_ACCOUNTS.CREATE');
  const canEdit = can('ACCOUNTS.CHART_OF_ACCOUNTS.EDIT');
  const canToggle = can('ACCOUNTS.CHART_OF_ACCOUNTS.TOGGLE_STATUS');
  const canSetUpAccounts = can('ACCOUNTS.ACCOUNT_SETUP.VIEW');

  const actions = (account: LedgerAccountDto) =>
    // A bank account's own ledger is named and switched from Account Set up.
    account.bankAccountId !== null ? (
      canSetUpAccounts ? (
        <Link href={{ pathname: '/accounts/account-setup' }} className="text-cell text-harbour hover:underline">
          Account Set up
        </Link>
      ) : null
    ) : (
      <>
        {canEdit && (
          <Button variant="text" size="inline" onClick={() => setEditing({ mode: 'rename', account })}>
            Edit
          </Button>
        )}
        {canToggle && (
          <Button variant={account.isActive ? 'destructive' : 'text'} size="inline" onClick={() => setToToggle(account)}>
            {account.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        )}
      </>
    );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Chart of accounts"
        description="Every ledger the books post to, under its head. Sub ledgers sit under their ledger; a ledger's balance adds them up."
        action={
          canCreate ? (
            <Button onClick={() => setEditing({ mode: 'add-ledger', accountType: head })}>
              + Add {LEDGER_ACCOUNT_TYPE_LABEL[head]} ledger
            </Button>
          ) : null
        }
      />

      <Segmented
        label="Head"
        value={head}
        options={LEDGER_ACCOUNT_TYPES.map((t) => [t, LEDGER_ACCOUNT_TYPE_LABEL[t]] as const)}
        onChange={setHead}
      />

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {chart === null && error === null && <p className="text-body text-steel">Loading…</p>}

      {current !== undefined &&
        (current.ledgers.length === 0 ? (
          <EmptyState
            title={`No ${current.label} ledgers yet`}
            description="Add the first ledger for this head, then add its sub ledgers under it."
          />
        ) : (
          <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
            <table className="w-full min-w-200 border-collapse">
              <thead>
                <tr className="border-b border-line bg-paper">
                  <th className="label-manifest w-28 px-3 py-2 text-left">Code</th>
                  <th className="label-manifest px-3 py-2 text-left">Ledger / Sub Ledger</th>
                  <th className="label-manifest px-3 py-2 text-right">Balance ({baseCode})</th>
                  <th className="label-manifest px-3 py-2 text-left">Status</th>
                  <th className="label-manifest px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {current.ledgers.map((ledger) => (
                  <LedgerRows
                    key={ledger.id}
                    ledger={ledger}
                    actions={actions}
                    onAddSub={
                      canCreate && ledger.systemKey !== 'ASSET.BANK'
                        ? () => setEditing({ mode: 'add-sub', ledger })
                        : null
                    }
                    bankHint={ledger.systemKey === 'ASSET.BANK' && canSetUpAccounts}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={
          editing === null
            ? ''
            : editing.mode === 'add-ledger'
              ? `Add ${LEDGER_ACCOUNT_TYPE_LABEL[editing.accountType]} ledger`
              : editing.mode === 'add-sub'
                ? `Add a sub ledger to ${editing.ledger.name}`
                : `Edit ${editing.account.name}`
        }
      >
        {editing !== null && (
          <AccountNameForm
            editing={editing}
            onDone={async (message) => {
              setEditing(null);
              toast.success(message);
              await load();
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this account?' : 'Activate this account?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing on new vouchers. What has already been posted to it stays, balance and all.`
              : `${toToggle.name} will be offered on new vouchers again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={busy}
        onConfirm={() => void toggle()}
      />
    </div>
  );
}

function LedgerRows({
  ledger,
  actions,
  onAddSub,
  bankHint,
}: {
  ledger: ChartLedgerDto;
  actions: (a: LedgerAccountDto) => ReactNode;
  onAddSub: (() => void) | null;
  bankHint: boolean;
}) {
  return (
    <>
      <tr className="border-b border-line bg-paper/60">
        <td className="px-3 py-2 font-mono text-cell tabular-nums text-steel">{ledger.code}</td>
        <td className="px-3 py-2">
          <span className={cn('text-body font-semibold', ledger.isActive ? 'text-hull' : 'text-steel')}>{ledger.name}</span>
          {onAddSub !== null && (
            <Button variant="text" size="inline" className="ml-3" onClick={onAddSub}>
              + ADD new
            </Button>
          )}
          {bankHint && (
            <Link href={{ pathname: '/accounts/account-setup' }} className="ml-3 text-cell text-harbour hover:underline">
              + ADD new on Account Set up
            </Link>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono text-body font-semibold tabular-nums text-hull">{amount(ledger.balance)}</td>
        <td className="px-3 py-2">
          <ActiveStatus isActive={ledger.isActive} />
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex justify-end gap-3">{actions(ledger)}</div>
        </td>
      </tr>
      {ledger.subLedgers.map((sub) => (
        <tr key={sub.id} className="border-b border-line last:border-0 hover:bg-[#F0F4F4]">
          <td className="px-3 py-1.5 font-mono text-cell tabular-nums text-steel">{sub.code}</td>
          <td className={cn('py-1.5 pl-8 pr-3 text-cell', sub.isActive ? 'text-hull' : 'text-steel')}>{sub.name}</td>
          <td className="px-3 py-1.5 text-right font-mono text-cell tabular-nums text-hull">{amount(sub.balance)}</td>
          <td className="px-3 py-1.5">
            <ActiveStatus isActive={sub.isActive} />
          </td>
          <td className="px-3 py-1.5 text-right">
            <div className="flex justify-end gap-3">{actions(sub)}</div>
          </td>
        </tr>
      ))}
    </>
  );
}

function AccountNameForm({
  editing,
  onDone,
  onCancel,
}: {
  editing: Editing;
  onDone: (message: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [name, setName] = useState(editing.mode === 'rename' ? editing.account.name : '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Enter the account name.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (editing.mode === 'rename') {
        await authorizedRequest(`/api/tenant/accounts/chart/${editing.account.id}`, {
          method: 'PATCH',
          body: { name: name.trim() },
        });
        await onDone('Saved');
      } else {
        await authorizedRequest('/api/tenant/accounts/chart', {
          method: 'POST',
          body:
            editing.mode === 'add-ledger'
              ? { accountType: editing.accountType, name: name.trim() }
              : { accountType: editing.ledger.accountType, parentId: editing.ledger.id, name: name.trim() },
        });
        await onDone(editing.mode === 'add-ledger' ? 'Ledger added' : 'Sub ledger added');
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <FormLayout
      onSubmit={(e) => void submit(e)}
      onCancel={onCancel}
      isPending={pending}
      submitLabel={editing.mode === 'rename' ? 'Save changes' : editing.mode === 'add-ledger' ? 'Add ledger' : 'Add sub ledger'}
    >
      <Field id="accountName" label={editing.mode === 'add-ledger' ? 'Ledger name' : 'Account name'} required error={error ?? undefined}>
        <Input id="accountName" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-invalid={error !== null} />
      </Field>
    </FormLayout>
  );
}
