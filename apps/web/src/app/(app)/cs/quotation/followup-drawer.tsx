'use client';

import {
  CONTACT_MODES,
  type InquiryFollowupDto,
  type QuotationListItemDto,
} from '@ff/shared';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Chasing the customer for an answer (§6.7's Follow up action).
 *
 * The same conversation the inquiry drawer records, one step later: there the
 * question is "will they send us an inquiry", here it is "will they accept the
 * price we gave them". Same shape, deliberately — an operator should not have
 * to learn two ways to write down a phone call.
 */
export function FollowupDrawer({
  quotation,
  onClose,
}: {
  quotation: QuotationListItemDto | null;
  onClose: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [entries, setEntries] = useState<InquiryFollowupDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const [followupDate, setFollowupDate] = useState(today);
  const [contactMode, setContactMode] = useState<string>(CONTACT_MODES[0]);
  const [contactPerson, setContactPerson] = useState('');
  const [notes, setNotes] = useState('');
  const [nextFollowupDate, setNextFollowupDate] = useState('');

  const load = useCallback(async () => {
    if (quotation === null) return;
    setEntries(null);
    setError(null);
    try {
      setEntries(
        await authorizedRequest<InquiryFollowupDto[]>(
          `/api/tenant/cs/quotations/${quotation.id}/followups`,
        ),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the follow-ups.');
    }
  }, [authorizedRequest, quotation]);

  useEffect(() => {
    void load();
  }, [load]);

  if (quotation === null) return null;

  async function save(): Promise<void> {
    if (quotation === null) return;
    setBusy(true);
    try {
      await authorizedRequest(`/api/tenant/cs/quotations/${quotation.id}/followups`, {
        method: 'POST',
        body: {
          followupDate,
          contactMode,
          ...(contactPerson.trim() === '' ? {} : { contactPerson: contactPerson.trim() }),
          ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
          ...(nextFollowupDate === '' ? {} : { nextFollowupDate }),
        },
      });
      toast.success('Follow-up saved');
      setContactPerson('');
      setNotes('');
      setNextFollowupDate('');
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Follow up — ${quotation.code}`}
      description={`${quotation.customerName}. What was said, and when to ask again.`}
      size="wide"
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="followupDate" label="Date" required>
            <Input
              id="followupDate"
              type="date"
              value={followupDate}
              onChange={(event) => setFollowupDate(event.target.value)}
            />
          </Field>
          <Field id="contactMode" label="How" required>
            <Select
              id="contactMode"
              value={contactMode}
              onChange={(event) => setContactMode(event.target.value)}
            >
              {CONTACT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode.charAt(0) + mode.slice(1).toLowerCase().replace('_', ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="contactPerson" label="Who you spoke to">
            <Input
              id="contactPerson"
              value={contactPerson}
              onChange={(event) => setContactPerson(event.target.value)}
              placeholder="Name at the customer"
            />
          </Field>
          <Field id="nextFollowupDate" label="Chase again on">
            <Input
              id="nextFollowupDate"
              type="date"
              value={nextFollowupDate}
              onChange={(event) => setNextFollowupDate(event.target.value)}
            />
          </Field>
        </div>
        <Field id="notes" label="What was said">
          <textarea
            id="notes"
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
            placeholder="Their answer, and anything that changes the price."
          />
        </Field>
        <div>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save follow-up'}
          </Button>
        </div>

        <div className="border-t border-line pt-4">
          <h3 className="label-manifest mb-2">History</h3>
          {error !== null && (
            <p role="alert" className="text-cell text-alert">
              {error}
            </p>
          )}
          {entries === null && error === null && (
            <p className="text-cell text-steel">Loading…</p>
          )}
          {entries !== null && entries.length === 0 && (
            <EmptyState
              title="Nothing recorded yet"
              description="Write down the first call and the next one has something to build on."
            />
          )}
          {entries !== null && entries.length > 0 && (
            <ul className="flex flex-col gap-3">
              {entries.map((entry) => (
                <li key={entry.id} className="rounded-manifest border border-line px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-mono text-cell tabular-nums text-hull">
                      {entry.followupDate}
                    </span>
                    <span className="text-cell text-steel">{entry.contactMode}</span>
                    {entry.contactPerson !== null && (
                      <span className="text-cell text-hull">{entry.contactPerson}</span>
                    )}
                    {entry.nextFollowupDate !== null && (
                      <span className="text-cell text-signal">
                        chase again {entry.nextFollowupDate}
                      </span>
                    )}
                  </div>
                  {entry.notes !== null && (
                    <p className="mt-1 whitespace-pre-line text-cell text-hull">{entry.notes}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
