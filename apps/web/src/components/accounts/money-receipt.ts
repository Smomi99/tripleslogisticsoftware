'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * `Money receipt` (client, 2026-10-28): an Income voucher's receipt, opened in
 * a new tab to print — from the voucher itself, and from each receipt on the
 * debit invoice it settled. Needs ACCOUNTS.INCOME.VIEW, as the voucher does.
 */
export function useMoneyReceipt(): { open: (incomeId: string) => Promise<void>; opening: string | null } {
  const { authorizedObjectUrl } = useSession();
  const [opening, setOpening] = useState<string | null>(null);

  const open = useCallback(
    async (incomeId: string) => {
      setOpening(incomeId);
      try {
        const url = await authorizedObjectUrl(`/api/tenant/accounts/income/${incomeId}/money-receipt`);
        window.open(url, '_blank', 'noopener');
      } catch (caught) {
        toast.error(caught instanceof ApiError ? caught.message : 'Could not open the money receipt.');
      } finally {
        setOpening(null);
      }
    },
    [authorizedObjectUrl],
  );

  return { open, opening };
}
