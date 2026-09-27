'use client';

import { VoucherList } from '@/components/accounts/voucher-list';

/** Accounts → Transaction → InternalTransfer — the client's `Internal Transfer` sheet (docs/MODULE_ACCOUNTS.md §14.4). */
export default function InternalTransferListPage() {
  return <VoucherList kind="TRANSFER" />;
}
