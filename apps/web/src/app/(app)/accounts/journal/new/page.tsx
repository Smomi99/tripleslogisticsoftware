'use client';

import { VoucherForm } from '@/components/accounts/voucher-form';

/** A new journal — the client's `Journal` sheet. */
export default function NewJournalPage() {
  return <VoucherForm kind="JOURNAL" />;
}
