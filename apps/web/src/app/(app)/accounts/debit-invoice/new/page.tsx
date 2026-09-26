'use client';

import type { DebitInvoiceOptionsDto, DebitInvoicePrefillDto } from '@ff/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { DebitInvoiceForm, type DebitInvoiceFormMode } from '@/components/accounts/debit-invoice-form';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * A new debit invoice (docs/MODULE_ACCOUNTS.md §3.2).
 *
 *   ?shipment=:id   `Make invoice` from Awaiting Freight Inv — a FREIGHT invoice,
 *                   prefilled from the booking's quotation (§3.5)
 *   (nothing)       `Create New` on Debit Invoice — an OTHER invoice
 *
 * Nothing is saved by opening this page; the invoice is born on the first
 * `Save draft` or `Save & Send`.
 */
function NewDebitInvoice() {
  const params = useSearchParams();
  const shipmentId = params.get('shipment');
  const { authorizedRequest } = useSession();

  const [mode, setMode] = useState<DebitInvoiceFormMode | null>(null);
  const [options, setOptions] = useState<DebitInvoiceOptionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [opts, prefill] = await Promise.all([
          authorizedRequest<DebitInvoiceOptionsDto>('/api/tenant/accounts/debit-invoices/options'),
          shipmentId === null
            ? Promise.resolve(null)
            : authorizedRequest<DebitInvoicePrefillDto>(
                `/api/tenant/accounts/shipments/${shipmentId}/debit-invoice/prefill`,
              ),
        ]);
        if (cancelled) return;
        setOptions(opts);
        setMode(prefill === null ? { kind: 'other' } : { kind: 'freight', shipmentId: shipmentId!, prefill });
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Could not open the invoice.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, shipmentId]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Link
          href={shipmentId === null ? { pathname: '/accounts/debit-invoice' } : { pathname: '/accounts/awaiting-freight-inv' }}
          className="text-cell text-harbour hover:underline"
        >
          ← Back to list
        </Link>
        <EmptyState title="Cannot make this invoice" description={error} />
      </div>
    );
  }
  if (mode === null || options === null) return <p className="text-body text-steel">Loading…</p>;

  // A new invoice lands on its own page after the first save, so there is
  // nothing to do with the stored copy here.
  return <DebitInvoiceForm mode={mode} options={options} onSaved={() => undefined} />;
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <NewDebitInvoice />
    </Suspense>
  );
}
