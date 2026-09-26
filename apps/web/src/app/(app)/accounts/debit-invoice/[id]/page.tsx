'use client';

import type { DebitInvoiceDto, DebitInvoiceOptionsDto } from '@ff/shared';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';

import { DebitInvoiceForm } from '@/components/accounts/debit-invoice-form';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * One debit invoice — a full page, like the quotation: two kinds of grid, three
 * cost blocks and a totals row are well past §8's eight-field threshold.
 */
export default function DebitInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authorizedRequest } = useSession();
  const [invoice, setInvoice] = useState<DebitInvoiceDto | null>(null);
  const [options, setOptions] = useState<DebitInvoiceOptionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped on every save, so the form is rebuilt from what the server stored. */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [row, opts] = await Promise.all([
          authorizedRequest<DebitInvoiceDto>(`/api/tenant/accounts/debit-invoices/${id}`),
          authorizedRequest<DebitInvoiceOptionsDto>('/api/tenant/accounts/debit-invoices/options'),
        ]);
        if (cancelled) return;
        setInvoice(row);
        setOptions(opts);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof ApiError ? caught.message : 'Could not load that invoice.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, id]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Link href={{ pathname: '/accounts/debit-invoice' }} className="text-cell text-harbour hover:underline">
          ← Back to list
        </Link>
        <EmptyState title="Not available" description={error} />
      </div>
    );
  }
  if (invoice === null || options === null) return <p className="text-body text-steel">Loading…</p>;

  return (
    <DebitInvoiceForm
      key={`${invoice.id}:${version}`}
      mode={{ kind: 'edit', invoice }}
      options={options}
      onSaved={(next) => {
        setInvoice(next);
        setVersion((v) => v + 1);
      }}
    />
  );
}
