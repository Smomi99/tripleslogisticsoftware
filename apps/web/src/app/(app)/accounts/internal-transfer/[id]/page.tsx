'use client';

import { use } from 'react';

import { VoucherView } from '@/components/accounts/voucher-view';

/** One internal transfer voucher (docs/MODULE_ACCOUNTS.md §14.4). */
export default function InternalTransferVoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <VoucherView kind="TRANSFER" id={id} />;
}
