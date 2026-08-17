'use client';

import {
  CONTACT_MODES,
  CONTACT_MODE_LABEL,
  type ContactMode,
  type SalesLeadFollowupDto,
} from '@ff/shared';
import { use, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { ChildScreenHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Sales → Sales Lead Follow-up (CLAUDE.md §3, §8's child-screen pattern).
 *
 * Scoped to the parent by URL, headed by the parent's name, and with the Back
 * to list link §8 calls required rather than optional.
 */
interface FollowupPayload {
  lead: { id: string; code: string; name: string };
  followups: SalesLeadFollowupDto[];
}

const today = (): string => new Date().toISOString().slice(0, 10);

export default function LeadFollowupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authorizedList, authorizedRequest, can } = useSession();

  const [data, setData] = useState<FollowupPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, setPending] = useState(true);

  const [followupDate, setFollowupDate] = useState(today);
  const [contactMode, setContactMode] = useState<ContactMode>('CALL');
  const [contactPerson, setContactPerson] = useState('');
  const [notes, setNotes] = useState('');
  const [nextFollowupDate, setNextFollowupDate] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setPending(true);
    try {
      const response = await authorizedList<FollowupPayload>(
        `/api/tenant/sales/leads/${id}/followups`,
      );
      setData(response.data);
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof ApiError ? error.message : 'Could not load the follow-up history.',
      );
    } finally {
      setPending(false);
    }
  }, [authorizedList, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(): Promise<void> {
    setFormError(null);
    setSaving(true);
    try {
      await authorizedRequest(`/api/tenant/sales/leads/${id}/followups`, {
        method: 'POST',
        body: { followupDate, contactMode, contactPerson, notes, nextFollowupDate },
      });
      toast.success('Follow-up recorded');
      setContactPerson('');
      setNotes('');
      setNextFollowupDate('');
      await load();
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not record the follow-up. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ChildScreenHeader
        parentLabel="Sales lead"
        parentName={data?.lead.name ?? 'Loading…'}
        title="Follow-up history"
        backHref="/sales/sales-lead"
      />

      {loadError !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {loadError}
        </p>
      )}

      {can('SALES.SALES_LEAD_FOLLOWUP.CREATE') && (
        <section
          aria-label="Record a follow-up"
          className="rounded-manifest border border-line bg-surface p-3 shadow-manifest"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isSaving) {
              event.preventDefault();
              void add();
            }
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <Field id="followupDate" label="Date" required>
                <Input
                  id="followupDate"
                  type="date"
                  numeric
                  value={followupDate}
                  onChange={(e) => setFollowupDate(e.target.value)}
                />
              </Field>
            </div>
            <div className="w-36">
              <Field id="contactMode" label="How" required>
                <Select
                  id="contactMode"
                  value={contactMode}
                  onChange={(e) => setContactMode(e.target.value as ContactMode)}
                >
                  {CONTACT_MODES.map((value) => (
                    <option key={value} value={value}>
                      {CONTACT_MODE_LABEL[value]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="w-48">
              <Field id="contactPerson" label="Who you spoke to">
                <Input
                  id="contactPerson"
                  value={contactPerson}
                  onChange={(e) => setContactPerson(e.target.value)}
                />
              </Field>
            </div>
            <div className="min-w-64 flex-1">
              <Field id="notes" label="Notes">
                <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
            <div className="w-40">
              <Field id="nextFollowupDate" label="Next follow-up">
                <Input
                  id="nextFollowupDate"
                  type="date"
                  numeric
                  value={nextFollowupDate}
                  onChange={(e) => setNextFollowupDate(e.target.value)}
                />
              </Field>
            </div>
            <Button type="button" onClick={() => void add()} disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Record'}
            </Button>
          </div>
          {formError !== null && (
            <p role="alert" className="mt-2 text-cell text-alert">
              {formError}
            </p>
          )}
        </section>
      )}

      {data !== null && data.followups.length === 0 && !isPending ? (
        <EmptyState
          title="No follow-ups yet"
          description="Record what was said and when to call back, so the next conversation starts where this one ended."
        />
      ) : (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper text-left">
                <th className="label-manifest px-2.5 py-2">Date</th>
                <th className="label-manifest px-2.5 py-2">How</th>
                <th className="label-manifest px-2.5 py-2">Contact</th>
                <th className="label-manifest px-2.5 py-2">Notes</th>
                <th className="label-manifest px-2.5 py-2">Next</th>
                <th className="label-manifest px-2.5 py-2">Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {(data?.followups ?? []).map((followup) => (
                <tr
                  key={followup.id}
                  className="border-b border-line last:border-0 hover:bg-row-hover"
                >
                  <td className="px-2.5 py-2 font-mono text-cell tabular-nums text-hull">
                    {followup.followupDate}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-hull">
                    {CONTACT_MODE_LABEL[followup.contactMode]}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-hull">
                    {followup.contactPerson ?? '—'}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-hull">{followup.notes ?? '—'}</td>
                  <td className="px-2.5 py-2 font-mono text-cell tabular-nums text-steel">
                    {followup.nextFollowupDate ?? '—'}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-steel">
                    {followup.createdBy ?? '—'}
                  </td>
                </tr>
              ))}
              {isPending && (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-body text-steel">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
