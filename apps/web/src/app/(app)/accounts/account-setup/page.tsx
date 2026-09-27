'use client';

import { type BankAccountDto, type BankDto, bankAccountInputSchema } from '@ff/shared';
import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { amount } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { FormLayout, PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { ActiveStatus } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * Accounts → Setting → Account Set up — the client's `Account setup` sheet
 * (docs/MODULE_ACCOUNTS.md §14.3).
 *
 * Account Name, Account Number, then Select Bank and Select Branch from Bank
 * Set up; Bank Address, Swift No, Routing number and IBAN No are that
 * branch's, shown rather than typed again. Each account is also a sub ledger
 * under Asset → Bank on the chart ("Bank Asia Ltd-878"), which is what the
 * Expense, Income and Transfer vouchers pay from and deposit to.
 */
const ENDPOINT = '/api/tenant/accounts/bank-accounts';

export default function AccountSetupPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<BankAccountDto, 'accountName'>(ENDPOINT, 'accountName');
  const [banks, setBanks] = useState<BankDto[]>([]);
  const [editing, setEditing] = useState<BankAccountDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<BankAccountDto | null>(null);
  const [isToggling, setToggling] = useState(false);

  useEffect(() => {
    void authorizedRequest<BankDto[]>(`${ENDPOINT}/banks`)
      .then(setBanks)
      .catch(() => setBanks([]));
  }, [authorizedRequest]);

  const columns: DataTableColumn<BankAccountDto>[] = useMemo(
    () => [
      { id: 'accountName', header: 'Account Name', sortable: true, cell: (r) => r.accountName },
      { id: 'accountNo', header: 'Account Number', numeric: true, align: 'left', cell: (r) => r.accountNo },
      {
        id: 'bank',
        header: 'Bank / Branch',
        cell: (r) => (
          <div className="flex flex-col">
            <span>{r.bankName}</span>
            <span className="text-cell text-steel">{r.branch}</span>
          </div>
        ),
      },
      { id: 'swiftNo', header: 'Swift No', numeric: true, align: 'left', cell: (r) => r.swiftNo ?? '—' },
      { id: 'routingNo', header: 'Routing number', numeric: true, align: 'left', cell: (r) => r.routingNo ?? '—' },
      { id: 'ledger', header: 'On the chart as', cell: (r) => r.ledgerName },
      {
        id: 'balance',
        header: 'Balance',
        numeric: true,
        cell: (r) => <span className="font-mono tabular-nums">{amount(r.balance)}</span>,
      },
      { id: 'isActive', header: 'Status', cell: (r) => <ActiveStatus isActive={r.isActive} /> },
    ],
    [],
  );

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`${ENDPOINT}/${toToggle.id}/toggle-status`, { method: 'POST' });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await list.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  const openAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Account Set up"
        description="The company's bank accounts. Each one is a ledger under Bank on the chart, which payments are made from and deposits made to."
        action={can('ACCOUNTS.ACCOUNT_SETUP.CREATE') ? <Button onClick={openAdd}>+ Add account</Button> : null}
      />

      <Input
        type="search"
        placeholder="Search accounts"
        aria-label="Search accounts"
        value={list.searchInput}
        onChange={(event) => list.setSearchInput(event.target.value)}
        className="w-72"
      />

      {list.error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {list.error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={list.rows}
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as 'accountName', order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('ACCOUNTS.ACCOUNT_SETUP.EDIT') && (
              <Button
                variant="text"
                size="inline"
                onClick={() => {
                  setEditing(row);
                  setFormOpen(true);
                }}
              >
                Edit
              </Button>
            )}
            {can('ACCOUNTS.ACCOUNT_SETUP.TOGGLE_STATUS') && (
              <Button variant={row.isActive ? 'destructive' : 'text'} size="inline" onClick={() => setToToggle(row)}>
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No accounts match that search"
              description="Try a different name, number or bank, or clear the search."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No bank accounts yet"
              description="Add the company's first bank account so payments and deposits can be recorded against it."
              action={can('ACCOUNTS.ACCOUNT_SETUP.CREATE') ? <Button onClick={openAdd}>+ Add account</Button> : null}
            />
          )
        }
      />

      <Modal
        open={isFormOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing === null ? 'Add account' : `Edit ${editing.accountName}`}
      >
        <AccountForm
          account={editing}
          banks={banks}
          canSetUpBanks={can('ACCOUNTS.BANK_SETUP.CREATE')}
          onSaved={async (isEdit) => {
            setFormOpen(false);
            setEditing(null);
            toast.success(isEdit ? 'Saved' : 'Account added');
            await list.reload();
          }}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
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
              ? `${toToggle.accountName} (${toToggle.accountNo}) will stop being offered for payments and deposits. Its history and balance stay on the chart.`
              : `${toToggle.accountName} (${toToggle.accountNo}) will be offered for payments and deposits again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </div>
  );
}

function AccountForm({
  account,
  banks,
  canSetUpBanks,
  onSaved,
  onCancel,
}: {
  account: BankAccountDto | null;
  banks: BankDto[];
  canSetUpBanks: boolean;
  onSaved: (isEdit: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [accountName, setAccountName] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankId, setBankId] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // An account being edited may sit at a branch since switched off; it stays
  // choosable for that account, and only for it.
  const choosable = useMemo(() => {
    if (account === null || banks.some((b) => b.id === account.bankId)) return banks;
    return [
      ...banks,
      {
        id: account.bankId,
        code: '',
        bankName: account.bankName,
        branch: account.branch,
        bankAddress: account.bankAddress,
        swiftNo: account.swiftNo,
        routingNo: account.routingNo,
        ibanNo: account.ibanNo,
        isActive: false,
      },
    ];
  }, [account, banks]);

  useEffect(() => {
    setAccountName(account?.accountName ?? '');
    setAccountNo(account?.accountNo ?? '');
    setBankName(account?.bankName ?? '');
    setBankId(account?.bankId ?? '');
    setErrors({});
    setFormError(null);
  }, [account]);

  const bankNames = [...new Set(choosable.map((b) => b.bankName))].sort((a, b) => a.localeCompare(b));
  const branches = choosable.filter((b) => b.bankName === bankName);
  const chosen = choosable.find((b) => b.id === bankId) ?? null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = bankAccountInputSchema.safeParse({ accountName, accountNo, bankId });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setFormError(null);
    setPending(true);
    try {
      await authorizedRequest<BankAccountDto>(account === null ? ENDPOINT : `${ENDPOINT}/${account.id}`, {
        method: account === null ? 'POST' : 'PATCH',
        body: parsed.data,
      });
      await onSaved(account !== null);
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  if (choosable.length === 0) {
    return (
      <EmptyState
        title="No bank set up yet"
        description="An account belongs to a bank branch. Add the branch on Bank Set up first."
        action={
          canSetUpBanks ? (
            <Link href={{ pathname: '/accounts/bank-setup' }} className="text-body text-harbour hover:underline">
              Go to Bank Set up
            </Link>
          ) : null
        }
      />
    );
  }

  const shown = (label: string, value: string | null | undefined) => (
    <div className="flex flex-col gap-1.5">
      <span className="label-manifest">{label}</span>
      <p className="flex h-9 items-center rounded-manifest border border-line bg-paper px-2.5 font-mono text-body tabular-nums text-steel">
        {value === null || value === undefined || value === '' ? '—' : value}
      </p>
    </div>
  );

  return (
    <FormLayout
      onSubmit={(e) => void submit(e)}
      onCancel={onCancel}
      isPending={pending}
      submitLabel={account === null ? 'Add account' : 'Save changes'}
      error={formError ?? undefined}
      columns={1}
    >
      <Field id="accountName" label="Account Name" required error={errors.accountName}>
        <Input id="accountName" autoFocus value={accountName} onChange={(e) => setAccountName(e.target.value)} />
      </Field>
      <Field id="accountNo" label="Account Number" required error={errors.accountNo}>
        <Input id="accountNo" numeric value={accountNo} onChange={(e) => setAccountNo(e.target.value)} />
      </Field>
      <Field id="bankName" label="Select Bank" required>
        <Select
          id="bankName"
          value={bankName}
          onChange={(e) => {
            setBankName(e.target.value);
            const only = choosable.filter((b) => b.bankName === e.target.value);
            setBankId(only.length === 1 ? only[0]!.id : '');
          }}
        >
          <option value="">Choose a bank</option>
          {bankNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="bankId" label="Select Branch" required error={errors.bankId}>
        <Select id="bankId" value={bankId} disabled={bankName === ''} onChange={(e) => setBankId(e.target.value)}>
          <option value="">Choose a branch</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.branch}
            </option>
          ))}
        </Select>
      </Field>
      {shown('Bank Address', chosen?.bankAddress)}
      <div className="grid grid-cols-3 gap-3">
        {shown('Swift No', chosen?.swiftNo)}
        {shown('Routing number', chosen?.routingNo)}
        {shown('IBAN No', chosen?.ibanNo)}
      </div>
    </FormLayout>
  );
}
