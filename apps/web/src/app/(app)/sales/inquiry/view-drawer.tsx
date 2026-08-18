'use client';

import {
  type InquiryDto,
  INQUIRY_STATUS_TONE,
  OUTCOME_STATUSES,
  SETTABLE_STATUSES,
} from '@ff/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * §5.5 View — "read-only detail drawer", plus the status control.
 *
 * The outcome control lives here rather than on the row because §9 Q10 makes
 * WON and LOST deliberate acts: they are the numbers the business is measured
 * on, and a one-click toggle in a dense table is how one gets set by accident.
 */
export function ViewDrawer({
  inquiry,
  canSetOutcome,
  onClose,
  onChanged,
}: {
  inquiry: InquiryDto | null;
  canSetOutcome: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { authorizedRequest, can } = useSession();
  const [status, setStatus] = useState<string>('');
  const [reason, setReason] = useState('');
  const [isSaving, setSaving] = useState(false);

  useEffect(() => {
    setStatus(inquiry?.status ?? '');
    setReason('');
  }, [inquiry]);

  if (inquiry === null) return null;

  const mayChange =
    can('SALES.INQUIRY.EDIT') || (canSetOutcome && can('SALES.INQUIRY.SET_OUTCOME'));

  async function save(): Promise<void> {
    if (inquiry === null) return;
    setSaving(true);
    try {
      await authorizedRequest(`/api/tenant/sales/inquiries/${inquiry.id}/status`, {
        method: 'POST',
        body: { status, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) },
      });
      toast.success(`${inquiry.code} is now ${status}`);
      onChanged();
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the status.');
    } finally {
      setSaving(false);
    }
  }

  const rows: [string, string][] = [
    ['Inquiry No', inquiry.code],
    ['Date', inquiry.inquiryDate],
    ['Source', inquiry.sourceName],
    ['Customer', inquiry.customerName],
    ['Shipment type', inquiry.shipmentType],
    ['Movement', inquiry.movementType],
    ['POL', `${inquiry.polCode} — ${inquiry.polName}`],
    ['POD', `${inquiry.podCode} — ${inquiry.podName}`],
    ['Place of receipt', inquiry.placeOfReceipt ?? '—'],
    ['Commodity', inquiry.commodityName ?? '—'],
    ['HS code', inquiry.hsCode ?? '—'],
    ['Terms of shipment', inquiry.tosName ?? '—'],
    [
      'Target price',
      inquiry.targetPrice === null ? '—' : `${inquiry.currencyCode ?? ''} ${inquiry.targetPrice}`,
    ],
    [
      'Quoted price',
      inquiry.quotedPrice === null ? '—' : `${inquiry.currencyCode ?? ''} ${inquiry.quotedPrice}`,
    ],
    ['Expected shipment', inquiry.expectedShipmentDate ?? '—'],
    ['Valid to', inquiry.validTo ?? '—'],
    ['Weight (kg)', inquiry.weightKg ?? '—'],
    ['Salesman', inquiry.salesmanName ?? '—'],
    ['Follow-ups', String(inquiry.followupCount)],
    ['Remarks', inquiry.remarks ?? '—'],
  ];

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={`Inquiry ${inquiry.code}`}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Status tone={inquiry.isLapsed ? 'overdue' : INQUIRY_STATUS_TONE[inquiry.status]}>
            {inquiry.isLapsed ? `${inquiry.status} — lapsed` : inquiry.status}
          </Status>
        </div>

        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1.5">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="label-manifest self-center">{label}</dt>
              <dd className="text-body text-hull">{value}</dd>
            </div>
          ))}
          {inquiry.volumes.length > 0 && (
            <div className="contents">
              <dt className="label-manifest self-center">Volume</dt>
              <dd className="font-mono text-cell text-hull">
                {inquiry.volumes
                  .map((v) =>
                    v.volumeKind === 'FCL'
                      ? `${v.quantity ?? 0} × ${v.containerTypeCode ?? '?'}`
                      : v.volumeKind === 'LCL'
                        ? `${v.cbm ?? '0'} CBM`
                        : `${v.weightKg ?? '0'} KG`,
                  )
                  .join(', ')}
              </dd>
            </div>
          )}
        </dl>

        {mayChange && (
          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <Field id="status" label="Status">
              <Select
                id="status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                {SETTABLE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            {OUTCOME_STATUSES.includes(status as (typeof OUTCOME_STATUSES)[number]) && (
              <Field
                id="reason"
                label="Reason"
                hint="Kept on the follow-up trail, where anyone reviewing this later will look."
              >
                <Input
                  id="reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button
                disabled={isSaving || status === inquiry.status}
                onClick={() => void save()}
              >
                {isSaving ? 'Saving…' : 'Save status'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
