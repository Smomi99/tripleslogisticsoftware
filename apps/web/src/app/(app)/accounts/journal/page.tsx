'use client';

import { VoucherList } from '@/components/accounts/voucher-list';

/** Accounts → Transaction → Journal — the client's `Journal` sheet (docs/MODULE_ACCOUNTS.md §14.4). */
export default function JournalListPage() {
  return <VoucherList kind="JOURNAL" />;
}
