'use client';

import {
  BL_DRAFT_STATUS_LABEL,
  type BlDraftDto,
  type BlDraftPrefillDto,
  type BlTemplateDto,
  type ShipmentDto,
} from '@ff/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { BlDraftForm, type BlDraftFormValues, bodyFrom, valuesFrom } from './bl-draft-form';
import { BlPrintActions } from './bl-print-actions';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * BL Draft — docs/MODULE_DOCUMENTATION.md §2.3, on the shipment file.
 *
 * The staff half of the document. The customer's half runs the same form
 * (bl-draft-form.tsx) from the portal, and the two meet here: a draft the
 * customer submitted arrives in this tab as SUBMITTED, waiting to be approved.
 */

/** Stored UTC, read in Dhaka (CLAUDE.md §9). */
const inDhaka = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

const TONE: Record<BlDraftDto['status'], 'active' | 'pending' | 'inactive' | 'overdue'> = {
  DRAFT: 'pending',
  SUBMITTED: 'pending',
  APPROVED: 'active',
  SENT: 'active',
  CANCELLED: 'overdue',
};

export function BlDraftTab({
  booking,
  onChanged,
}: {
  booking: ShipmentDto;
  onChanged: () => void;
}) {
  const { authorizedRequest, authorizedList, authorizedObjectUrl, can } = useSession();

  const [draft, setDraft] = useState<BlDraftDto | null>(null);
  const [prefill, setPrefill] = useState<BlDraftPrefillDto | null>(null);
  const [values, setValues] = useState<BlDraftFormValues | null>(null);
  const [modes, setModes] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<BlTemplateDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');

  const load = useCallback(async () => {
    setLoaded(false);
    try {
      const row = await authorizedRequest<BlDraftDto | null>(
        `/api/tenant/documentation/bookings/${booking.id}/bl-draft`,
      );
      setDraft(row);
      if (row !== null) {
        setValues(valuesFrom(row));
        setSendTo(row.recipients.map((r) => r.email).join(', '));
        setPrefill(null);
      } else if (can('DOCUMENTATION.BL_DRAFT.CREATE')) {
        const fresh = await authorizedRequest<BlDraftPrefillDto>(
          `/api/tenant/documentation/bookings/${booking.id}/bl-draft/prefill`,
        );
        setPrefill(fresh);
        setValues(valuesFrom(fresh));
        setSendTo(fresh.recipients.map((r) => r.email).join(', '));
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the BL draft.');
    } finally {
      setLoaded(true);
    }
  }, [authorizedRequest, booking.id, can]);

  useEffect(() => {
    void load();
  }, [load]);

  // The two pickers the form needs, and the templates behind `Use Templet`.
  useEffect(() => {
    void authorizedList<{ id: string; name: string }[]>('/api/tenant/setting/modes?limit=100')
      .then((r) => setModes(r.data))
      .catch(() => setModes([]));
    void authorizedList<{ id: string; name: string }[]>('/api/tenant/crm/agents?limit=100')
      .then((r) => setAgents(r.data))
      .catch(() => setAgents([]));
    if (can('DOCUMENTATION.BL_TEMPLATE.VIEW')) {
      void authorizedRequest<BlTemplateDto[]>('/api/tenant/documentation/bl-templates')
        .then(setTemplates)
        .catch(() => setTemplates([]));
    }
  }, [authorizedList, authorizedRequest, can]);

  async function run(fn: () => Promise<void>, done: string): Promise<void> {
    setError(null);
    setPending(true);
    try {
      await fn();
      toast.success(done);
      setSendOpen(false);
      setCancelOpen(false);
      setTemplateOpen(false);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setPending(false);
    }
  }

  if (!loaded || values === null) return <p className="text-body text-steel">Loading…</p>;

  if (draft === null && prefill === null) {
    return (
      <EmptyState
        title="No BL draft yet"
        description="You do not have permission to draft one on this booking."
      />
    );
  }

  if (draft === null && prefill?.blockedReason != null) {
    return <EmptyState title="Not ready to draft" description={prefill.blockedReason} />;
  }

  const editable = draft === null || draft.status === 'DRAFT' || draft.status === 'SUBMITTED';
  /*
   * Approved once. A draft sent to the customer to check is still waiting on
   * that approval — it is frozen against edits, not against being accepted.
   */
  const approvable = draft !== null && draft.status !== 'CANCELLED' && draft.approvedAt === null;
  const blNo = draft?.blNo ?? prefill?.blNo ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-section text-hull">
            {draft === null ? 'New BL draft' : draft.code}
          </h2>
          {draft !== null && (
            <Status tone={TONE[draft.status]}>{BL_DRAFT_STATUS_LABEL[draft.status]}</Status>
          )}
          {draft?.origin === 'CUSTOMER' && (
            <span className="text-cell text-steel">Drafted by the customer</span>
          )}
          {/* §13: issued on BL Print — the originals exist from here. */}
          {draft?.issuedAt != null && (
            <Status tone="active">BL issued {inDhaka(draft.issuedAt)}</Status>
          )}
        </div>
        <p className="font-mono text-cell tabular-nums text-steel">
          BL {blNo}
          {draft?.mblNo != null && ` · MBL ${draft.mblNo}`}
        </p>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {error}
        </p>
      )}

      <BlDraftForm
        values={values}
        setValues={setValues}
        disabled={!editable || isPending}
        isCustomerView={false}
        modes={modes}
        agents={agents}
        containers={draft?.containers ?? prefill?.containers ?? []}
        templates={templates}
        onUseTemplate={(t) =>
          setValues({
            ...values,
            shipperText: t.shipperText ?? values.shipperText,
            consigneeText: t.consigneeText ?? values.consigneeText,
            notifyText: t.notifyText ?? values.notifyText,
            alsoNotifyText: t.alsoNotifyText ?? values.alsoNotifyText,
            freightPayableAt: t.freightPayableAt ?? values.freightPayableAt,
            originalBlCount:
              t.originalBlCount === null ? values.originalBlCount : String(t.originalBlCount),
            deliveryAgentId: t.deliveryAgentId ?? values.deliveryAgentId,
          })
        }
        onPullParties={() => undefined}
      />

      <div className="flex flex-wrap gap-2">
        {draft === null && can('DOCUMENTATION.BL_DRAFT.CREATE') && (
          <Button
            disabled={isPending}
            onClick={() => {
              void run(
                () =>
                  authorizedRequest(
                    `/api/tenant/documentation/bookings/${booking.id}/bl-draft`,
                    { method: 'POST', body: bodyFrom(values) },
                  ),
                'BL draft saved',
              );
            }}
          >
            Draft
          </Button>
        )}
        {draft !== null && editable && can('DOCUMENTATION.BL_DRAFT.EDIT') && (
          <Button
            disabled={isPending}
            onClick={() => {
              void run(
                () =>
                  authorizedRequest(`/api/tenant/documentation/bl-drafts/${draft.id}`, {
                    method: 'PATCH',
                    body: bodyFrom(values),
                  }),
                'Saved',
              );
            }}
          >
            Save changes
          </Button>
        )}
        {can('DOCUMENTATION.BL_TEMPLATE.CREATE') && (
          <Button variant="secondary" disabled={isPending} onClick={() => setTemplateOpen(true)}>
            Make Templet
          </Button>
        )}
        {can('DOCUMENTATION.BL_TEMPLATE.VIEW') && (
          <Link
            href="/documentation/bl-template"
            className="self-center text-body text-steel hover:underline"
          >
            Manage templates
          </Link>
        )}
        {approvable && can('DOCUMENTATION.BL_DRAFT.APPROVE') && (
          <Button
            variant="secondary"
            disabled={isPending}
            onClick={() => {
              void run(
                () =>
                  authorizedRequest(
                    `/api/tenant/documentation/bl-drafts/${draft.id}/approve`,
                    { method: 'POST', body: {} },
                  ),
                'BL draft approved',
              );
            }}
          >
            Approve
          </Button>
        )}
        {draft !== null && draft.status !== 'CANCELLED' && can('DOCUMENTATION.BL_DRAFT.SEND') && (
          <Button variant="secondary" disabled={isPending} onClick={() => setSendOpen(true)}>
            Save &amp; Send
          </Button>
        )}
        {draft !== null && can('DOCUMENTATION.BL_DRAFT.EXPORT_PDF') && (
          <Button
            variant="secondary"
            disabled={isPending}
            onClick={() => {
              void (async () => {
                try {
                  const url = await authorizedObjectUrl(
                    `/api/tenant/documentation/bl-drafts/${draft.id}/pdf`,
                  );
                  window.open(url, '_blank', 'noopener');
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : 'Could not open the BL draft.');
                }
              })();
            }}
          >
            Print
          </Button>
        )}
        {/*
          BL Print's acts (§13), here as well as on its own list: this tab is
          where the bill lives, and an operator who just approved it should not
          have to go to another screen to issue it.
        */}
        {draft !== null && draft.approvedAt !== null && draft.status !== 'CANCELLED' && (
          <BlPrintActions
            shipmentId={booking.id}
            status={booking.status}
            variant="buttons"
            onChanged={() => {
              void load();
              onChanged();
            }}
          />
        )}
        {draft !== null && draft.status !== 'CANCELLED' && can('DOCUMENTATION.BL_DRAFT.CANCEL') && (
          <Button variant="destructive" disabled={isPending} onClick={() => setCancelOpen(true)}>
            Cancel draft
          </Button>
        )}
      </div>

      <Modal open={sendOpen} onOpenChange={setSendOpen} title="Send the BL draft">
        <div className="flex flex-col gap-4">
          <Field id="blSendTo" label="To" hint="Comma separated." required>
            <Input id="blSendTo" value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
          </Field>
          <p className="text-cell text-steel">
            The draft is attached to the letter as a PDF, watermarked until it is approved.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSendOpen(false)}>
              Back
            </Button>
            <Button
              disabled={isPending || sendTo.trim() === '' || draft === null}
              onClick={() => {
                if (draft === null) return;
                void run(
                  () =>
                    authorizedRequest(
                      `/api/tenant/documentation/bl-drafts/${draft.id}/send`,
                      {
                        method: 'POST',
                        body: {
                          to: sendTo
                            .split(',')
                            .map((e) => e.trim())
                            .filter((e) => e !== '')
                            .map((email) => ({ email })),
                        },
                      },
                    ),
                  'BL draft sent',
                );
              }}
            >
              {isPending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={templateOpen} onOpenChange={setTemplateOpen} title="Save as a template">
        <div className="flex flex-col gap-4">
          <p className="text-body text-steel">
            Saves the party blocks, freight payable at, the number of originals and the delivery
            agent, for {booking.customerName}.
          </p>
          <Field id="templateName" label="Template name" required>
            <Input
              id="templateName"
              autoFocus
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder={`${booking.customerName} — standard`}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTemplateOpen(false)}>
              Back
            </Button>
            <Button
              disabled={isPending || templateName.trim() === ''}
              onClick={() => {
                void run(
                  () =>
                    authorizedRequest('/api/tenant/documentation/bl-templates', {
                      method: 'POST',
                      body: {
                        name: templateName.trim(),
                        customerId: booking.customerId,
                        shipperText: values.shipperText,
                        consigneeText: values.consigneeText,
                        notifyText: values.notifyText,
                        alsoNotifyText:
                          values.alsoNotifyText === '' ? null : values.alsoNotifyText,
                        freightPayableAt:
                          values.freightPayableAt === '' ? null : values.freightPayableAt,
                        originalBlCount:
                          values.originalBlCount === '' ? null : Number(values.originalBlCount),
                        deliveryAgentId:
                          values.deliveryAgentId === '' ? null : values.deliveryAgentId,
                      },
                    }),
                  'Template saved',
                );
              }}
            >
              Save template
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={cancelOpen} onOpenChange={setCancelOpen} title="Cancel this BL draft?">
        <div className="flex flex-col gap-4">
          <p className="text-body text-steel">
            The booking goes back to its shipment advise, and a new draft can be started against
            the same BL number.
          </p>
          {draft?.issuedAt != null && (
            <p className="text-body text-alert">
              This bill was issued on {inDhaka(draft.issuedAt)}. Cancelling voids that issue — the
              originals already printed are no longer the bill for this booking.
            </p>
          )}
          <Field id="blCancelReason" label="Reason" required>
            <Input
              id="blCancelReason"
              autoFocus
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Consignee block wrong"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={isPending || cancelReason.trim() === '' || draft === null}
              onClick={() => {
                if (draft === null) return;
                void run(
                  () =>
                    authorizedRequest(
                      `/api/tenant/documentation/bl-drafts/${draft.id}/cancel`,
                      { method: 'POST', body: { reason: cancelReason.trim() } },
                    ),
                  'BL draft cancelled',
                );
              }}
            >
              {isPending ? 'Cancelling…' : 'Cancel it'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
