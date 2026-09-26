'use client';

import { type BlPrintDto, type BlPrintKind, type ShipmentStatus } from '@ff/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * BL Print's three acts — docs/MODULE_DOCUMENTATION.md §13.
 *
 * `Issue BL`, `Print originals` and `Print copy`, drawn from the booking's
 * status the way every other Action button here is. Shared by the BL Print
 * list and the BL tab on the shipment file, so the two cannot disagree about
 * when a bill may be issued or printed.
 */

/** Stored UTC, read in Dhaka (CLAUDE.md §9). */
const inDhaka = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

export function BlPrintActions({
  shipmentId,
  status,
  onChanged,
  variant = 'links',
}: {
  shipmentId: string;
  status: ShipmentStatus;
  onChanged: () => void;
  /** Text actions in a table row; buttons on the BL tab. */
  variant?: 'links' | 'buttons';
}) {
  const { authorizedRequest, authorizedObjectUrl, can } = useSession();

  const [open, setOpen] = useState(false);
  const [bill, setBill] = useState<BlPrintDto | null>(null);
  const [originals, setOriginals] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [isPending, setPending] = useState(false);

  const canPrint = can('DOCUMENTATION.BL_PRINT.EXPORT_PDF');
  const issuable = status === 'BL_DRAFTED' && can('DOCUMENTATION.BL_PRINT.ISSUE');
  const printable = status === 'BL_DRAFTED' || status === 'BL_ISSUED';

  async function print(kind: BlPrintKind): Promise<void> {
    try {
      const url = await authorizedObjectUrl(
        `/api/tenant/documentation/bookings/${shipmentId}/bl/pdf?kind=${kind}`,
      );
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not open the bill of lading.');
    }
  }

  async function openIssue(): Promise<void> {
    setFieldError(undefined);
    setBill(null);
    setOpen(true);
    try {
      const row = await authorizedRequest<BlPrintDto>(
        `/api/tenant/documentation/bookings/${shipmentId}/bl`,
      );
      setBill(row);
      setOriginals(row.originalBlCount === null ? '' : String(row.originalBlCount));
    } catch (e) {
      setOpen(false);
      toast.error(e instanceof ApiError ? e.message : 'Could not load the bill of lading.');
    }
  }

  async function issue(): Promise<void> {
    if (bill === null) return;
    // Asked for only when the approved draft left it empty (§13.3 rule 3).
    const askCount = bill.originalBlCount === null;
    const n = Number(originals);
    if (askCount && (originals.trim() === '' || !Number.isInteger(n) || n < 0 || n > 99)) {
      setFieldError('Enter how many originals are being issued, from 0 to 99.');
      return;
    }

    setPending(true);
    setFieldError(undefined);
    try {
      const issued = await authorizedRequest<BlPrintDto>(
        `/api/tenant/documentation/bookings/${shipmentId}/bl/issue`,
        { method: 'POST', body: askCount ? { originalBlCount: n } : {} },
      );
      toast.success(`BL ${issued.blNo} issued`);
      setOpen(false);
      onChanged();
      // The point of issuing: the originals, straight to the printer.
      if (canPrint && (issued.originalBlCount ?? 0) > 0) await print('ORIGINAL');
    } catch (e) {
      if (e instanceof ApiError && e.fields?.['originalBlCount'] !== undefined) {
        setFieldError(e.fields['originalBlCount'][0]);
      } else {
        toast.error(e instanceof ApiError ? e.message : 'Could not issue the bill of lading.');
      }
    } finally {
      setPending(false);
    }
  }

  const action = (label: string, onClick: () => void) =>
    variant === 'links' ? (
      <button
        key={label}
        type="button"
        className="text-body text-harbour hover:underline"
        onClick={onClick}
      >
        {label}
      </button>
    ) : (
      <Button key={label} variant="secondary" disabled={isPending} onClick={onClick}>
        {label}
      </Button>
    );

  if (!printable) return null;

  return (
    <>
      {issuable && action('Issue BL', () => void openIssue())}
      {status === 'BL_ISSUED' && canPrint && action('Print originals', () => void print('ORIGINAL'))}
      {canPrint && action('Print copy', () => void print('COPY'))}

      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Issue this bill of lading?"
        description="Issuing is what makes the originals printable. A wrong bill is corrected by cancelling its draft and drafting it again."
      >
        {bill === null ? (
          <p className="text-body text-steel">Loading…</p>
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-body">
              <dt className="label-manifest self-center">Booking</dt>
              <dd className="font-mono tabular-nums text-hull">{bill.bookingNo}</dd>
              <dt className="label-manifest self-center">House BL</dt>
              <dd className="font-mono tabular-nums text-hull">{bill.blNo}</dd>
              <dt className="label-manifest self-center">MBL</dt>
              <dd className="font-mono tabular-nums text-hull">{bill.mblNo ?? '—'}</dd>
              <dt className="label-manifest self-center">Customer</dt>
              <dd className="text-hull">{bill.customerName}</dd>
              <dt className="label-manifest self-center">Route</dt>
              <dd className="text-hull">
                {bill.polName} → {bill.podName}
              </dd>
              <dt className="label-manifest self-center">Laden on board</dt>
              <dd className="font-mono tabular-nums text-hull">
                {bill.ladenOnBoardDate ?? '—'}
              </dd>
              <dt className="label-manifest self-center">Approved</dt>
              <dd className="font-mono tabular-nums text-hull">
                {bill.approvedAt === null ? '—' : inDhaka(bill.approvedAt)}
              </dd>
              {bill.originalBlCount !== null && (
                <>
                  <dt className="label-manifest self-center">Originals</dt>
                  <dd className="font-mono tabular-nums text-hull">{bill.originalBlCount}</dd>
                </>
              )}
            </dl>

            {bill.originalBlCount === null && (
              <Field
                id={`blOriginals-${shipmentId}`}
                label="No. of Original BL"
                required
                error={fieldError}
                hint="The approved draft left this empty. The bill prints one original per number."
              >
                <Input
                  id={`blOriginals-${shipmentId}`}
                  numeric
                  inputMode="numeric"
                  autoFocus
                  value={originals}
                  onChange={(e) => setOriginals(e.target.value)}
                  placeholder="3"
                />
              </Field>
            )}

            {bill.ladenOnBoardDate === null && (
              <p className="text-cell text-signal">
                Laden on Board Date is empty on this bill, and the originals will print without
                it.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Back
              </Button>
              <Button disabled={isPending} onClick={() => void issue()}>
                {isPending ? 'Issuing…' : 'Issue BL'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
