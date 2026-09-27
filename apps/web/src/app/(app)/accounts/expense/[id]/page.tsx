'use client';

import { use } from 'react';

import { VoucherView } from '@/components/accounts/voucher-view';

/** One expense voucher (docs/MODULE_ACCOUNTS.md §14.4). */
export default function ExpenseVoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <VoucherView kind="EXPENSE" id={id} />;
}
