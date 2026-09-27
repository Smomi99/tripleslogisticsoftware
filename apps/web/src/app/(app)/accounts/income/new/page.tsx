'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { VoucherForm } from '@/components/accounts/voucher-form';

/**
 * A new income voucher — the client's `Income-Other` and `Income` sheets.
 *
 *   ?debitInvoice=:id    `Receive` on Debit Invoice — the `Income` sheet
 *   ?opening=CUSTOMER:id  receive against a CRM opening balance
 *   (nothing)             the menu's own form
 */
function NewIncome() {
  const params = useSearchParams();
  return (
    <VoucherForm
      kind="INCOME"
      prefill={{
        debitInvoice: params.get('debitInvoice'),
        creditInvoice: params.get('creditInvoice'),
        opening: params.get('opening'),
      }}
    />
  );
}

export default function NewIncomePage() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <NewIncome />
    </Suspense>
  );
}
