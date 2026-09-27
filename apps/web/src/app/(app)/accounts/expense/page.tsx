'use client';

import { VoucherList } from '@/components/accounts/voucher-list';

/** Accounts → Transaction → Expense — the client's `Expense-regular` and `Expense-Vendor` sheets (docs/MODULE_ACCOUNTS.md §14.4). */
export default function ExpenseListPage() {
  return <VoucherList kind="EXPENSE" />;
}
