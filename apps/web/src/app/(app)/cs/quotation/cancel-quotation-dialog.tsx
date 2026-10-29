'use client';

import type { QuotationDto } from '@ff/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * `Cancel quotation` (client, 2026-10-29: "so that we can quote from the
 * inquiry again"), from the Quotation List and from the quotation itself. A
 * reason is required, as for a booking or an invoice; the server decides
 * whether this one may be cancelled and says why when it may not.
 */
export function CancelQuotationDialog({
  quotation,
  onClose,
  onCancelled,
}: {
  quotation: { id: string; code: string; revisionNo: number; inquiryCode: string } | null;
  onClose: () => void;
  onCancelled: (next: QuotationDto) => void;
}) {
  const { authorizedRequest } = useSession();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);

  const label =
    quotation === null ? 'this quotation' : quotation.revisionNo > 1 ? `${quotation.code} rev ${quotation.revisionNo}` : quotation.code;

  function close(): void {
    setReason('');
    onClose();
  }

  async function cancel(): Promise<void> {
    if (quotation === null) return;
    setPending(true);
    try {
      const next = await authorizedRequest<QuotationDto>(`/api/tenant/cs/quotations/${quotation.id}/cancel`, {
        method: 'POST',
        body: { reason },
      });
      toast.success(`${label} cancelled`);
      setReason('');
      onCancelled(next);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not cancel the quotation.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={quotation !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`Cancel ${label}?`}
      {...(quotation === null
        ? {}
        : { description: `The number is kept on the record, and ${quotation.inquiryCode} can be quoted again.` })}
    >
      <div className="flex flex-col gap-4">
        <Field id="quotationCancelReason" label="Reason" required>
          <textarea
            id="quotationCancelReason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
          />
        </Field>
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={close}>
            Keep it
          </Button>
          <Button variant="destructive" disabled={pending || reason.trim() === ''} onClick={() => void cancel()}>
            {pending ? 'Cancelling…' : 'Cancel quotation'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
