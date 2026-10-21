'use client';

import type { CostOptionsDto } from '@ff/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CreditInvoiceForm } from '@/components/accounts/credit-invoice-form';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/** Credit Invoice → Create New — a full page: an invoice to put it on, and the supplier's bill. */
export default function NewCreditInvoicePage() {
  const { authorizedRequest } = useSession();
  const [options, setOptions] = useState<CostOptionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<CostOptionsDto>('/api/tenant/accounts/credit-invoices/options').then(
      (data) => {
        if (live) setOptions(data);
      },
      (caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not open a new credit invoice.');
      },
    );
    return () => {
      live = false;
    };
  }, [authorizedRequest]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Link href={{ pathname: '/accounts/credit-invoice' }} className="text-cell text-harbour hover:underline">
          ← Back to list
        </Link>
        <EmptyState title="Not available" description={error} />
      </div>
    );
  }
  if (options === null) return <p className="text-body text-steel">Loading…</p>;
  return <CreditInvoiceForm options={options} />;
}
