'use client';

import { VoucherList } from '@/components/accounts/voucher-list';

/** Accounts → Transaction → Income — the client's `Income-Other` and `Income` sheets (docs/MODULE_ACCOUNTS.md §14.4). */
export default function IncomeListPage() {
  return <VoucherList kind="INCOME" />;
}
