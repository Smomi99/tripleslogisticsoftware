'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { VoucherForm } from '@/components/accounts/voucher-form';

/**
 * A new expense voucher — the client's `Expense-regular` and `Expense-Vendor` sheets.
 *
 *   ?creditInvoice=:id   `Make Payment` on Credit Invoice — `Expense-Vendor`
 *   ?opening=VENDOR:id    pay against a CRM opening balance
 *   (nothing)             the menu's own form
 */
function NewExpense() {
  const params = useSearchParams();
  return (
    <VoucherForm
      kind="EXPENSE"
      prefill={{
        debitInvoice: params.get('debitInvoice'),
        creditInvoice: params.get('creditInvoice'),
        opening: params.get('opening'),
      }}
    />
  );
}

export default function NewExpensePage() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <NewExpense />
    </Suspense>
  );
}
