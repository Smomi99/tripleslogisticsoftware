'use client';

import { VoucherForm } from '@/components/accounts/voucher-form';

/** A new internal transfer — the client's `Internal Transfer` sheet. */
export default function NewInternalTransferPage() {
  return <VoucherForm kind="TRANSFER" />;
}
