'use client';

import {
  type CostOptionsDto,
  type CreditInvoiceCreatedDto,
  type CreditInvoiceCreateInput,
  type CreditInvoiceTargetDto,
  SUPPLIER_PARTY_LABEL,
  SUPPLIER_PARTY_TYPES,
  type SupplierPartyType,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Segmented } from '@/components/ui/segmented';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { type BlockDraft, blankLine, CostBlocksEditor, emptyBlock, lineBody } from './cost-blocks';

/**
 * Accounts → Credit Invoice → Create New (docs/MODULE_ACCOUNTS.md §14.17).
 *
 * A supplier's bill, entered from the list. It is a cost block on the issued
 * debit invoice it is for, the same block the invoice's Buying section draws,
 * so the form is that block plus a picker for the invoice. The invoice's
 * other blocks are not touched.
 */

const TARGETS = '/api/tenant/accounts/credit-invoices/debit-invoices';

function targetLabel(t: CreditInvoiceTargetDto): string {
  return [t.code, t.invoiceDate, t.customerName, t.bookingCode].filter((part) => part !== null && part !== '').join(' · ');
}

export function CreditInvoiceForm({ options }: { options: CostOptionsDto }) {
  const router = useRouter();
  const { authorizedRequest, authorizedUpload } = useSession();

  const [search, setSearch] = useState('');
  const [targets, setTargets] = useState<CreditInvoiceTargetDto[] | null>(null);
  const [target, setTarget] = useState<CreditInvoiceTargetDto | null>(null);
  const [block, setBlock] = useState<BlockDraft>(() => emptyBlock('CARRIER', options));
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Debit Invoice No": the newest issued invoices, narrowed as the operator types.
  useEffect(() => {
    let live = true;
    const needle = search.trim();
    const timer = setTimeout(() => {
      authorizedRequest<CreditInvoiceTargetDto[]>(needle === '' ? TARGETS : `${TARGETS}?search=${encodeURIComponent(needle)}`)
        .then((rows) => {
          if (live) setTargets(rows);
        })
        .catch((caught: unknown) => {
          if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load the debit invoices.');
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [authorizedRequest, search]);

  // The chosen invoice stays in the list, even when a later search would leave it out.
  const choices =
    target === null || (targets ?? []).some((t) => t.id === target.id) ? (targets ?? []) : [target, ...(targets ?? [])];
  const lines = block.lines.filter((l) => !blankLine(l));
  const ready = target !== null && block.partyId !== '' && lines.length > 0;

  async function save(): Promise<void> {
    if (target === null) return;
    setPending(true);
    setError(null);
    try {
      const body: CreditInvoiceCreateInput = {
        debitInvoiceId: target.id,
        cost: {
          partyType: block.partyType,
          partyId: block.partyId,
          supplierInvoiceNo: block.supplierInvoiceNo.trim() === '' ? null : block.supplierInvoiceNo.trim(),
          currencyId: block.currencyId,
          conversionRate: block.conversionRate.trim(),
          lines: lines.map((l) => lineBody(l, 'MANUAL')),
        },
      };
      const made = await authorizedRequest<CreditInvoiceCreatedDto>('/api/tenant/accounts/credit-invoices', {
        method: 'POST',
        body,
      });
      if (file !== null) {
        try {
          await authorizedUpload(`/api/tenant/accounts/debit-invoices/${made.debitInvoiceId}/costs/${made.id}/file`, file);
        } catch (caught) {
          toast.error(
            `The credit invoice is saved, but the file did not upload: ${caught instanceof ApiError ? caught.message : 'try again from its debit invoice'}.`,
          );
        }
      }
      toast.success(`Credit invoice saved on ${made.debitInvoiceCode}`);
      router.push('/accounts/credit-invoice' as Route);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link href={{ pathname: '/accounts/credit-invoice' }} className="text-cell text-harbour hover:underline">
          ← Back to list
        </Link>
        <PageHeader
          title="New Credit Invoice"
          description="A carrier’s, agent’s or vendor’s bill for a job, added to the debit invoice it was billed on."
        />
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      {/* --------------------------------------------- which job it is for */}
      <section className="grid grid-cols-1 gap-4 rounded-manifest border border-line bg-surface p-5 shadow-manifest md:grid-cols-[16rem_1fr]">
        <Field id="targetSearch" label="Find the debit invoice" hint="Invoice no, customer or booking.">
          <Input
            id="targetSearch"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="DN-2026-…"
          />
        </Field>
        <Field
          id="target"
          label="Debit Invoice No"
          required
          hint={
            targets !== null && targets.length === 0
              ? search.trim() === ''
                ? 'No debit invoice has been sent yet. A bill goes on an invoice once it is sent.'
                : 'No sent debit invoice matches that.'
              : 'Sent debit invoices only. A draft’s costs are entered on the draft itself.'
          }
        >
          <Select
            id="target"
            value={target?.id ?? ''}
            disabled={targets === null}
            onChange={(e) => setTarget(choices.find((t) => t.id === e.target.value) ?? null)}
          >
            <option value="">{targets === null ? 'Loading…' : 'Choose the debit invoice'}</option>
            {choices.map((t) => (
              <option key={t.id} value={t.id}>
                {targetLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      {/* ------------------------------------------------- the supplier's bill */}
      <section className="flex flex-col gap-4 rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <div className="flex flex-col gap-1">
          <span className="label-manifest">Billed by</span>
          <Segmented<SupplierPartyType>
            label="Billed by"
            value={block.partyType}
            options={SUPPLIER_PARTY_TYPES.map((t) => [t, SUPPLIER_PARTY_LABEL[t]] as const)}
            onChange={(t) => setBlock((b) => ({ ...b, partyType: t, partyId: '' }))}
          />
        </div>

        <CostBlocksEditor
          blocks={[block]}
          onChange={(next) => setBlock(next[0] ?? block)}
          options={options}
          editable
          invoiceNo
          description="The bill as the supplier sent it: their invoice no, their currency, line by line."
        />

        <Field id="supplierInvoiceFile" label="Upload Invoice" hint="PDF or image of the supplier’s bill.">
          <input
            id="supplierInvoiceFile"
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-body text-hull file:mr-3 file:rounded-manifest file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-body file:text-hull"
          />
        </Field>
      </section>

      <div className="flex items-center justify-end gap-3">
        <Link href={{ pathname: '/accounts/credit-invoice' }} className="text-body text-harbour hover:underline">
          Cancel
        </Link>
        <Button disabled={pending || !ready} onClick={() => void save()}>
          {pending ? 'Saving…' : 'Save credit invoice'}
        </Button>
      </div>
    </div>
  );
}
