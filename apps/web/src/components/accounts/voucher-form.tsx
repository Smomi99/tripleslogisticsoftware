'use client';

import {
  type AccountOptionDto,
  type DocumentPartyDto,
  INCOME_FROM_PARTY_TYPES,
  type JournalEntryDto,
  type JournalEntryKind,
  JOURNAL_ENTRY_KIND_LABEL,
  type JournalEntryOptionsDto,
  LEDGER_PARTY_LABEL,
  type LedgerPartyType,
  type OpenDocumentDto,
  PAY_TO_PARTY_TYPES,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Segmented } from '@/components/ui/segmented';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { amount } from './format';
import { VOUCHER_SLUG } from './voucher-list';

/**
 * The four Transaction screens' form — docs/MODULE_ACCOUNTS.md §14.4–§14.6.
 *
 *   Journal            sheet `Journal`: Account / Debit / Credit rows, Save or
 *                      Save & agreed
 *   Expense            `Expense-regular`, and `Expense-Vendor` when paying a
 *                      supplier's invoice ("Pay to", "Select Invoice No")
 *   Income             `Income-Other`, and `Income` when banking a customer's
 *                      invoice ("Income From", "Select Invoice No")
 *   Internal Transfer  `Internal Transfer`: from one account, to others
 *
 * Every sheet ends in Debit Amount / Credit Amount / Difference, and so does
 * this: Save stays closed until the difference is nil. The server checks it
 * again, and so does the database.
 */

export interface VoucherPrefill {
  debitInvoice?: string | null;
  creditInvoice?: string | null;
  /** "VENDOR:12" — pay or receive against a CRM opening balance. */
  opening?: string | null;
}

interface Row {
  key: string;
  ledgerAccountId: string;
  amount: string;
}

interface JournalRow {
  key: string;
  ledgerAccountId: string;
  debit: string;
  credit: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);
let seq = 0;
const nextKey = (): string => `r${(seq += 1)}`;

/** Money typed on screen, as ten-thousandths — so 0.1 + 0.2 still balances. */
function units(value: string): number {
  const n = Number(value);
  return value.trim() === '' || !Number.isFinite(n) ? 0 : Math.round(n * 10_000);
}
const fromUnits = (u: number): string => (u / 10_000).toFixed(2);
/**
 * "800.0000" -> "800", "1234.5600" -> "1234.56". The exact figure, never
 * rounded: an outstanding of 1234.5678 rounded to 1234.57 would be refused as
 * more than is owed.
 */
const exact = (value: string): string => (value.includes('.') ? value.replace(/\.?0+$/, '') : value);

/** The sheet's "Select Expense Category": grouped by ledger, like the chart. */
function AccountSelect({
  id,
  value,
  onChange,
  accounts,
  placeholder,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  accounts: AccountOptionDto[];
  placeholder: string;
  label: string;
}) {
  const groups = useMemo(() => {
    const out = new Map<string, AccountOptionDto[]>();
    for (const a of accounts) {
      const [ledger] = a.label.split(' › ');
      const key = a.label.includes(' › ') ? (ledger ?? a.label) : '';
      out.set(key, [...(out.get(key) ?? []), a]);
    }
    return [...out.entries()];
  }, [accounts]);
  const text = (a: AccountOptionDto) => {
    const short = a.label.includes(' › ') ? a.label.split(' › ').slice(1).join(' › ') : a.label;
    return a.balance === null ? short : `${short} — ${amount(a.balance)}`;
  };
  return (
    <Select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {groups.map(([ledger, items]) =>
        ledger === '' ? (
          items.map((a) => (
            <option key={a.id} value={a.id}>
              {text(a)}
            </option>
          ))
        ) : (
          <optgroup key={ledger} label={ledger}>
            {items.map((a) => (
              <option key={a.id} value={a.id}>
                {text(a)}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </Select>
  );
}

export function VoucherForm({
  kind,
  prefill = {},
  existing = null,
}: {
  kind: Exclude<JournalEntryKind, never>;
  prefill?: VoucherPrefill;
  /** A draft journal, opened to carry on with it. */
  existing?: JournalEntryDto | null;
}) {
  const router = useRouter();
  const { authorizedRequest, authorizedUpload, can } = useSession();
  const slug = VOUCHER_SLUG[kind];
  const base = `/api/tenant/accounts/${slug}`;

  const [options, setOptions] = useState<JournalEntryOptionsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [entryDate, setEntryDate] = useState(existing?.entryDate ?? today());
  const [description, setDescription] = useState(existing?.description ?? '');
  const [file, setFile] = useState<File | null>(null);

  // Expense, Income, Transfer
  const [moneyAccountId, setMoneyAccountId] = useState('');
  const [moneyAmount, setMoneyAmount] = useState('');
  const [rows, setRows] = useState<Row[]>([{ key: nextKey(), ledgerAccountId: '', amount: '' }]);

  // Journal
  const [jrows, setJrows] = useState<JournalRow[]>(
    existing !== null
      ? existing.lines.map((l) => ({
          key: nextKey(),
          ledgerAccountId: l.ledgerAccountId,
          debit: Number(l.debit) > 0 ? l.debit : '',
          credit: Number(l.credit) > 0 ? l.credit : '',
        }))
      : [
          { key: nextKey(), ledgerAccountId: '', debit: '', credit: '' },
          { key: nextKey(), ledgerAccountId: '', debit: '', credit: '' },
        ],
  );

  // Expense-Vendor / Income: "Pay to" / "Income From" and "Select Invoice No"
  const settles = kind === 'EXPENSE' || kind === 'INCOME';
  const [withParty, setWithParty] = useState(false);
  const partyTypes: readonly LedgerPartyType[] = kind === 'EXPENSE' ? PAY_TO_PARTY_TYPES : INCOME_FROM_PARTY_TYPES;
  const [partyType, setPartyType] = useState<LedgerPartyType>(partyTypes[0]!);
  const [partyId, setPartyId] = useState('');
  const [documents, setDocuments] = useState<OpenDocumentDto[]>([]);
  const [docKey, setDocKey] = useState('');
  const [settleAmount, setSettleAmount] = useState('');

  const [pending, setPending] = useState<'save' | 'post' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const docKeyOf = (d: OpenDocumentDto): string => `${d.against}:${d.documentId ?? ''}`;
  const chosenDoc = documents.find((d) => docKeyOf(d) === docKey) ?? null;

  const categoryAccounts = useMemo(() => {
    if (options === null) return [];
    if (kind === 'EXPENSE') return options.accounts.filter((a) => a.accountType === 'EXPENSE');
    if (kind === 'INCOME') return options.accounts.filter((a) => a.accountType === 'INCOME');
    if (kind === 'TRANSFER') return options.moneyAccounts.filter((a) => a.id !== moneyAccountId);
    return options.accounts;
  }, [options, kind, moneyAccountId]);

  const partyChoices = (type: LedgerPartyType) => {
    if (options === null) return [];
    if (type === 'CUSTOMER') return options.customers;
    if (type === 'VENDOR') return options.vendors;
    if (type === 'CARRIER') return options.carriers;
    return options.agents;
  };

  // ------------------------------------------------------------ loading

  useEffect(() => {
    let cancelled = false;
    void authorizedRequest<JournalEntryOptionsDto>('/api/tenant/accounts/vouchers/options')
      .then((data) => {
        if (!cancelled) setOptions(data);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(caught instanceof ApiError ? caught.message : 'Could not open the form.');
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest]);

  /** Pre-selects a document and fills the figures from what is still owed. */
  function applyDocument(doc: OpenDocumentDto | null, opts: JournalEntryOptionsDto | null = options): void {
    setDocKey(doc === null ? '' : docKeyOf(doc));
    if (doc === null) return;
    setSettleAmount(exact(doc.outstanding));
    const banked =
      doc.isBaseCurrency || doc.conversionRate === null
        ? exact(doc.outstanding)
        : (Number(doc.outstanding) * Number(doc.conversionRate)).toFixed(2);
    setMoneyAmount(banked);
    // §14.5: the service the invoice was for picks its category, when there is one.
    const key =
      doc.serviceKey === null
        ? null
        : kind === 'EXPENSE'
          ? `EXPENSE.COST_OF_SERVICE.${doc.serviceKey}`
          : `INCOME.SERVICE.${doc.serviceKey}`;
    const account = key === null ? undefined : opts?.accounts.find((a) => a.systemKey === key);
    setRows([{ key: nextKey(), ledgerAccountId: account?.id ?? '', amount: banked }]);
  }

  async function loadDocuments(type: LedgerPartyType, id: string, select?: (d: OpenDocumentDto) => boolean) {
    if (id === '') {
      setDocuments([]);
      setDocKey('');
      return;
    }
    try {
      const docs = await authorizedRequest<OpenDocumentDto[]>(
        `/api/tenant/accounts/vouchers/open-documents?partyType=${type}&partyId=${id}`,
      );
      setDocuments(docs);
      const pick = select === undefined ? undefined : docs.find(select);
      if (pick !== undefined) applyDocument(pick);
      else setDocKey('');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not load their invoices.');
    }
  }

  // `Receive`, `Make Payment` and the ledger's opening links land here.
  useEffect(() => {
    if (options === null || !settles) return;
    const docId = prefill.debitInvoice ?? prefill.creditInvoice ?? null;
    if (docId !== null) {
      const query =
        prefill.debitInvoice !== undefined && prefill.debitInvoice !== null
          ? `debitInvoice=${docId}`
          : `creditInvoice=${docId}`;
      void authorizedRequest<DocumentPartyDto>(`/api/tenant/accounts/vouchers/document-party?${query}`)
        .then(async (party) => {
          setWithParty(true);
          setPartyType(party.partyType);
          setPartyId(party.partyId);
          await loadDocuments(party.partyType, party.partyId, (d) => d.documentId === docId);
        })
        .catch((caught: unknown) => {
          toast.error(caught instanceof ApiError ? caught.message : 'Could not find that invoice.');
        });
    } else if (prefill.opening !== undefined && prefill.opening !== null) {
      const [type, id] = prefill.opening.split(':');
      if (type !== undefined && id !== undefined && (partyTypes as readonly string[]).includes(type)) {
        setWithParty(true);
        setPartyType(type as LedgerPartyType);
        setPartyId(id);
        void loadDocuments(type as LedgerPartyType, id, (d) => d.against === 'OPENING');
      }
    }
    // Once, when the lookups arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  // ------------------------------------------------------ the arithmetic

  const moneyUnits = units(moneyAmount);
  const rowsUnits = rows.reduce((sum, r) => sum + units(r.amount), 0);
  const [debitUnits, creditUnits] =
    kind === 'JOURNAL'
      ? [jrows.reduce((s, r) => s + units(r.debit), 0), jrows.reduce((s, r) => s + units(r.credit), 0)]
      : kind === 'INCOME'
        ? [moneyUnits, rowsUnits]
        : [rowsUnits, moneyUnits];
  const difference = debitUnits - creditUnits;
  const balanced = difference === 0 && debitUnits > 0;
  const partyMissing = settles && withParty && (partyId === '' || chosenDoc === null || units(settleAmount) <= 0);
  const baseMismatch =
    settles && withParty && chosenDoc !== null && chosenDoc.isBaseCurrency && units(settleAmount) !== moneyUnits;

  /** A single category row follows the amount, until someone adds a second. */
  function setAmount(value: string): void {
    setMoneyAmount(value);
    setRows((current) => (current.length === 1 ? [{ ...current[0]!, amount: value }] : current));
  }

  // ------------------------------------------------------------ saving

  function body(post: boolean): Record<string, unknown> {
    const common = { entryDate, description: description.trim() === '' ? null : description.trim() };
    if (kind === 'JOURNAL') {
      return {
        ...common,
        post,
        lines: jrows
          .filter((r) => r.ledgerAccountId !== '' || r.debit.trim() !== '' || r.credit.trim() !== '')
          .map((r) => ({ ledgerAccountId: r.ledgerAccountId, debit: r.debit.trim(), credit: r.credit.trim() })),
      };
    }
    return {
      ...common,
      moneyAccountId,
      amount: moneyAmount.trim(),
      lines: rows
        .filter((r) => r.ledgerAccountId !== '' || r.amount.trim() !== '')
        .map((r) => ({ ledgerAccountId: r.ledgerAccountId, amount: r.amount.trim() })),
      ...(settles && withParty && chosenDoc !== null
        ? {
            settlement: {
              partyType,
              partyId,
              against: chosenDoc.against,
              documentId: chosenDoc.documentId,
              amount: settleAmount.trim(),
            },
          }
        : {}),
    };
  }

  async function save(post: boolean): Promise<void> {
    setPending(post ? 'post' : 'save');
    setError(null);
    try {
      const saved =
        existing !== null
          ? await authorizedRequest<JournalEntryDto>(`${base}/${existing.id}`, { method: 'PATCH', body: body(post) })
          : await authorizedRequest<JournalEntryDto>(base, { method: 'POST', body: body(post) });
      if (file !== null) {
        try {
          await authorizedUpload(`${base}/${saved.id}/file`, file);
        } catch (caught) {
          toast.error(
            `${saved.code} is saved, but the file did not upload: ${caught instanceof ApiError ? caught.message : 'try again from the voucher'}.`,
          );
        }
      }
      toast.success(saved.status === 'POSTED' ? `${saved.code} saved to the books` : `${saved.code} saved as a draft`);
      router.push(`/accounts/${slug}/${saved.id}` as Route);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Check your connection and try again.');
    } finally {
      setPending(null);
    }
  }

  // ------------------------------------------------------------ the page

  const back = (
    <Link href={`/accounts/${slug}` as Route} className="text-cell text-harbour hover:underline">
      ← Back to list
    </Link>
  );

  if (loadError !== null) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState title="Not available" description={loadError} />
      </div>
    );
  }
  if (options === null) return <p className="text-body text-steel">Loading…</p>;

  if (kind !== 'JOURNAL' && options.moneyAccounts.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState
          title="No bank or cash account to use"
          description="Money is paid from and deposited to an account under Bank or Cash on the chart. Set up a bank account first."
          action={
            can('ACCOUNTS.ACCOUNT_SETUP.VIEW') ? (
              <Link href={{ pathname: '/accounts/account-setup' }} className="text-body text-harbour hover:underline">
                Go to Account Set up
              </Link>
            ) : null
          }
        />
      </div>
    );
  }

  const baseCode = options.baseCurrencyCode ?? 'Base';
  const title =
    existing !== null
      ? `${existing.code} — draft`
      : kind === 'EXPENSE' && withParty
        ? 'Expense — pay a supplier'
        : kind === 'INCOME' && withParty
          ? 'Income — receive from a customer'
          : `New ${JOURNAL_ENTRY_KIND_LABEL[kind].toLowerCase()}`;

  const moneyLabel =
    kind === 'EXPENSE' ? 'Payment from' : kind === 'INCOME' ? 'Deposit to' : 'Transfer From';
  const moneyHint =
    kind === 'TRANSFER' ? 'The account the money left.' : '( Asset like Bank, Cash )';
  const rowsTitle =
    kind === 'EXPENSE' ? 'Expense Category' : kind === 'INCOME' ? 'Income Category' : 'Transfer To';
  const rowPlaceholder =
    kind === 'EXPENSE' ? 'Select Expense Category' : kind === 'INCOME' ? 'Select Income Category' : 'Select account';
  const foreignDoc = chosenDoc !== null && !chosenDoc.isBaseCurrency;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {back}
        <PageHeader title={title} />
      </div>

      {settles && existing === null && (
        <Segmented
          label="What this is"
          value={withParty ? 'PARTY' : 'REGULAR'}
          options={
            kind === 'EXPENSE'
              ? ([
                  ['REGULAR', 'Regular expense'],
                  ['PARTY', 'Pay a supplier'],
                ] as const)
              : ([
                  ['REGULAR', 'Other income'],
                  ['PARTY', 'Receive from a customer'],
                ] as const)
          }
          onChange={(v) => {
            setWithParty(v === 'PARTY');
            if (v === 'REGULAR') {
              setDocuments([]);
              setDocKey('');
              setPartyId('');
            }
          }}
        />
      )}

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {/* ------------------------------------------ date, party, description */}
      <section className="grid grid-cols-1 gap-4 rounded-manifest border border-line bg-surface p-5 shadow-manifest md:grid-cols-2">
        <Field id="entryDate" label="Date" required>
          <Input id="entryDate" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
        </Field>

        {settles && withParty && (
          <>
            <div className="grid grid-cols-[10rem_1fr] gap-3 md:col-span-2">
              <Field
                id="partyType"
                label={kind === 'EXPENSE' ? 'Pay to' : 'Income From'}
                required
                hint={kind === 'EXPENSE' ? '( Vendor / Carrier / Agent )' : '( Customer )'}
              >
                <Select
                  id="partyType"
                  value={partyType}
                  disabled={partyTypes.length === 1}
                  onChange={(e) => {
                    setPartyType(e.target.value as LedgerPartyType);
                    setPartyId('');
                    setDocuments([]);
                    setDocKey('');
                  }}
                >
                  {partyTypes.map((t) => (
                    <option key={t} value={t}>
                      {LEDGER_PARTY_LABEL[t]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="partyId" label={LEDGER_PARTY_LABEL[partyType]} required>
                <Select
                  id="partyId"
                  value={partyId}
                  onChange={(e) => {
                    setPartyId(e.target.value);
                    void loadDocuments(partyType, e.target.value);
                  }}
                >
                  <option value="">Choose one</option>
                  {partyChoices(partyType).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Field
                id="document"
                label="Select Invoice No"
                required
                hint={
                  partyId !== '' && documents.length === 0
                    ? kind === 'EXPENSE'
                      ? 'Nothing is owed to them: no unpaid credit invoice, and no opening balance.'
                      : 'They owe nothing: no unpaid debit invoice, and no opening balance.'
                    : undefined
                }
              >
                <Select
                  id="document"
                  value={docKey}
                  disabled={documents.length === 0}
                  onChange={(e) => applyDocument(documents.find((d) => docKeyOf(d) === e.target.value) ?? null)}
                >
                  <option value="">Choose the invoice</option>
                  {documents.map((d) => (
                    <option key={docKeyOf(d)} value={docKeyOf(d)}>
                      {d.reference}
                      {d.date === '' ? '' : ` · ${d.date}`} · {d.currencyCode} {amount(d.outstanding)} due
                    </option>
                  ))}
                </Select>
              </Field>
              {chosenDoc !== null && (
                <p className="flex flex-wrap gap-3 text-cell text-steel">
                  <span>{chosenDoc.description}</span>
                  {chosenDoc.debitInvoiceId !== null && can('ACCOUNTS.DEBIT_INVOICE.VIEW') && (
                    <Link
                      href={`/accounts/debit-invoice/${chosenDoc.debitInvoiceId}` as Route}
                      className="text-harbour hover:underline"
                      target="_blank"
                    >
                      ( View invoice )
                    </Link>
                  )}
                </p>
              )}
            </div>

            {chosenDoc !== null && (
              <Field
                id="settleAmount"
                label={`Amount ${kind === 'EXPENSE' ? 'paid' : 'received'} against it (${chosenDoc.currencyCode})`}
                required
                hint={`${chosenDoc.currencyCode} ${amount(chosenDoc.outstanding)} still due.`}
              >
                <Input
                  id="settleAmount"
                  numeric
                  inputMode="decimal"
                  value={settleAmount}
                  onChange={(e) => {
                    setSettleAmount(e.target.value);
                    if (chosenDoc.isBaseCurrency) setAmount(e.target.value);
                  }}
                />
              </Field>
            )}
          </>
        )}

        <Field id="description" label="Description" wide>
          <textarea
            id="description"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
          />
        </Field>

        <Field
          id="attachment"
          label={kind === 'EXPENSE' ? 'Upload Payment voucher' : 'Upload file'}
          hint={
            existing !== null && existing.attachmentFileName !== null
              ? `On file: ${existing.attachmentFileName}`
              : 'PDF or image.'
          }
          wide
        >
          <input
            id="attachment"
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-body text-hull file:mr-3 file:rounded-manifest file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-body file:text-hull"
          />
        </Field>
      </section>

      {/* ------------------------------------------------ the money account */}
      {kind !== 'JOURNAL' && (
        <section className="grid grid-cols-1 gap-4 rounded-manifest border border-line bg-surface p-5 shadow-manifest md:grid-cols-2">
          <Field id="moneyAccount" label={moneyLabel} required hint={moneyHint}>
            <AccountSelect
              id="moneyAccount"
              label={moneyLabel}
              value={moneyAccountId}
              onChange={setMoneyAccountId}
              accounts={options.moneyAccounts}
              placeholder={kind === 'TRANSFER' ? 'Choose the account' : 'Choose a bank or cash account'}
            />
          </Field>
          <Field
            id="moneyAmount"
            label={`Amount (${baseCode})`}
            required
            hint={
              foreignDoc && units(settleAmount) > 0 && moneyUnits > 0
                ? `What the bank ${kind === 'EXPENSE' ? 'paid out' : 'credited'}. That is ${(moneyUnits / units(settleAmount)).toFixed(4)} ${baseCode} per ${chosenDoc.currencyCode}.`
                : undefined
            }
            error={baseMismatch ? `The invoice is in ${baseCode}, so this must equal the amount against it.` : undefined}
          >
            <Input
              id="moneyAmount"
              numeric
              inputMode="decimal"
              value={moneyAmount}
              disabled={chosenDoc?.isBaseCurrency === true}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        </section>
      )}

      {/* ------------------------------------------------------ the rows */}
      <section className="rounded-manifest border border-line bg-surface shadow-manifest">
        <div className="border-b border-line px-5 py-3">
          <h2 className="text-section text-hull">{kind === 'JOURNAL' ? 'Account' : rowsTitle}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">{kind === 'JOURNAL' ? 'Account' : rowPlaceholder}</th>
                {kind === 'JOURNAL' ? (
                  <>
                    <th className="label-manifest w-44 px-3 py-2 text-right">Debit</th>
                    <th className="label-manifest w-44 px-3 py-2 text-right">Credit</th>
                  </>
                ) : (
                  <th className="label-manifest w-44 px-3 py-2 text-right">Amount</th>
                )}
                <th className="w-20 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {kind === 'JOURNAL'
                ? jrows.map((row, index) => (
                    <tr key={row.key} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">
                        <AccountSelect
                          id={`account-${row.key}`}
                          label={`Account, row ${index + 1}`}
                          value={row.ledgerAccountId}
                          onChange={(v) => setJrows((c) => c.map((r) => (r.key === row.key ? { ...r, ledgerAccountId: v } : r)))}
                          accounts={options.accounts}
                          placeholder="Select account"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          numeric
                          inputMode="decimal"
                          aria-label={`Debit, row ${index + 1}`}
                          className="text-right"
                          value={row.debit}
                          onChange={(e) =>
                            setJrows((c) => c.map((r) => (r.key === row.key ? { ...r, debit: e.target.value, credit: e.target.value === '' ? r.credit : '' } : r)))
                          }
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          numeric
                          inputMode="decimal"
                          aria-label={`Credit, row ${index + 1}`}
                          className="text-right"
                          value={row.credit}
                          onChange={(e) =>
                            setJrows((c) => c.map((r) => (r.key === row.key ? { ...r, credit: e.target.value, debit: e.target.value === '' ? r.debit : '' } : r)))
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {jrows.length > 2 && (
                          <Button variant="destructive" size="inline" onClick={() => setJrows((c) => c.filter((r) => r.key !== row.key))}>
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                : rows.map((row, index) => (
                    <tr key={row.key} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">
                        <AccountSelect
                          id={`account-${row.key}`}
                          label={`${rowsTitle}, row ${index + 1}`}
                          value={row.ledgerAccountId}
                          onChange={(v) => setRows((c) => c.map((r) => (r.key === row.key ? { ...r, ledgerAccountId: v } : r)))}
                          accounts={categoryAccounts}
                          placeholder={rowPlaceholder}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          numeric
                          inputMode="decimal"
                          aria-label={`Amount, row ${index + 1}`}
                          className="text-right"
                          value={row.amount}
                          onChange={(e) => setRows((c) => c.map((r) => (r.key === row.key ? { ...r, amount: e.target.value } : r)))}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {rows.length > 1 && (
                          <Button variant="destructive" size="inline" onClick={() => setRows((c) => c.filter((r) => r.key !== row.key))}>
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line px-5 py-3">
          <Button
            variant="text"
            size="inline"
            onClick={() =>
              kind === 'JOURNAL'
                ? setJrows((c) => [...c, { key: nextKey(), ledgerAccountId: '', debit: '', credit: '' }])
                : setRows((c) => [...c, { key: nextKey(), ledgerAccountId: '', amount: '' }])
            }
          >
            + add
          </Button>
        </div>
      </section>

      {/* ------------------------------ Debit Amount / Credit Amount / Difference */}
      <section className="flex flex-wrap items-end justify-between gap-4 rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <dl className="grid grid-cols-3 gap-8">
          {(
            [
              [kind === 'JOURNAL' ? 'Total Debit' : 'Debit Amount', debitUnits],
              [kind === 'JOURNAL' ? 'Total Credit' : 'Credit Amount', creditUnits],
              ['Difference', difference],
            ] as [string, number][]
          ).map(([label, value]) => (
            <div key={label} className="text-right">
              <dt className="label-manifest">{label}</dt>
              <dd
                className={
                  label === 'Difference' && value !== 0
                    ? 'font-mono text-section tabular-nums text-alert'
                    : 'font-mono text-section tabular-nums text-hull'
                }
              >
                {amount(fromUnits(value))} {baseCode}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center gap-3">
          {kind === 'JOURNAL' ? (
            <>
              <Button variant="secondary" disabled={pending !== null || !balanced} onClick={() => void save(false)}>
                {pending === 'save' ? 'Saving…' : 'Save'}
              </Button>
              {can('ACCOUNTS.JOURNAL.APPROVE') && (
                <Button disabled={pending !== null || !balanced} onClick={() => void save(true)}>
                  {pending === 'post' ? 'Saving…' : 'Save & agreed'}
                </Button>
              )}
            </>
          ) : (
            <Button
              disabled={pending !== null || !balanced || moneyAccountId === '' || partyMissing || baseMismatch}
              onClick={() => void save(true)}
            >
              {pending !== null ? 'Saving…' : 'Save'}
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
