'use client';

import {
  CONTACT_MODE_LABEL,
  CONTACT_MODES,
  type InquiryDto,
  type InquiryFollowupDto,
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
 * §5.5 Follow Up(n) — "drawer listing follow-ups + add form".
 *
 * The count on the row button comes from the same table, so recording one here
 * has to reload the list behind it, or the number lies until the next refresh.
 */
export function FollowupDrawer({
  inquiry,
  onClose,
  onChanged,
}: {
  inquiry: InquiryDto | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { authorizedList, authorizedRequest } = useSession();
  const [rows, setRows] = useState<InquiryFollowupDto[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().slice(0, 10);
  const [followupDate, setFollowupDate] = useState(today);
  const [contactMode, setContactMode] = useState<string>('CALL');
  const [contactPerson, setContactPerson] = useState('');
  const [notes, setNotes] = useState('');
  const [nextFollowupDate, setNextFollowupDate] = useState('');

  const load = useCallback(
    async (id: string) => {
      setLoading(true);
      try {
        const response = await authorizedList<InquiryFollowupDto[]>(
          `/api/tenant/sales/inquiries/${id}/followups`,
        );
        setRows(response.data);
        setError(null);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Could not load the follow-ups.');
      } finally {
        setLoading(false);
      }
    },
    [authorizedList],
  );

  useEffect(() => {
    if (inquiry === null) return;
    setFollowupDate(today);
    setContactMode('CALL');
    setContactPerson('');
    setNotes('');
    setNextFollowupDate('');
    void load(inquiry.id);
  }, [inquiry, load, today]);

  if (inquiry === null) return null;

  async function record(): Promise<void> {
    if (inquiry === null) return;
    setSaving(true);
    try {
      await authorizedRequest(`/api/tenant/sales/inquiries/${inquiry.id}/followups`, {
        method: 'POST',
        body: {
          followupDate,
          contactMode,
          ...(contactPerson.trim() === '' ? {} : { contactPerson: contactPerson.trim() }),
          ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
          ...(nextFollowupDate === '' ? {} : { nextFollowupDate }),
        },
      });
      toast.success('Follow-up recorded');
      setContactPerson('');
      setNotes('');
      setNextFollowupDate('');
      await load(inquiry.id);
      onChanged();
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : 'Could not record the follow-up.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Follow-ups — ${inquiry.code}`}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field id="followupDate" label="Date" required>
            <Input
              id="followupDate"
              type="date"
              numeric
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
              {CONTACT_MODES.map((m) => (
                <option key={m} value={m}>
                  {CONTACT_MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="contactPerson" label="Contact person">
            <Input
              id="contactPerson"
              value={contactPerson}
              onChange={(event) => setContactPerson(event.target.value)}
            />
          </Field>
          <Field id="nextFollowupDate" label="Next follow-up">
            <Input
              id="nextFollowupDate"
              type="date"
              numeric
              value={nextFollowupDate}
              onChange={(event) => setNextFollowupDate(event.target.value)}
            />
          </Field>
          <div className="col-span-2">
            <Field id="notes" label="Notes">
              <Input
                id="notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button disabled={isSaving} onClick={() => void record()}>
            {isSaving ? 'Recording…' : 'Record'}
          </Button>
        </div>

        <div className="border-t border-line pt-3">
          {error !== null && (
            <p role="alert" className="text-cell text-alert">
              {error}
            </p>
          )}
          {isLoading ? (
            <p className="text-cell text-steel">Loading…</p>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No follow-ups yet"
              description="Record the first call or email so the next person picking this up knows where it stands."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-col gap-0.5 border-b border-line pb-2">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-cell text-hull">{row.followupDate}</span>
                    <span className="label-manifest">{CONTACT_MODE_LABEL[row.contactMode]}</span>
                    {row.contactPerson !== null && (
                      <span className="text-cell text-steel">{row.contactPerson}</span>
                    )}
                  </span>
                  {row.notes !== null && <span className="text-body text-hull">{row.notes}</span>}
                  {row.nextFollowupDate !== null && (
                    <span className="text-cell text-steel">
                      Next: <span className="font-mono">{row.nextFollowupDate}</span>
                    </span>
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
