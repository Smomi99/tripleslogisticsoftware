'use client';

import {
  CONTACT_MODE_LABEL,
  FREIGHT_CONTROL_LABEL,
  INQUIRY_STATUS_LABEL,
  type InquiryStatus,
  SALES_LEAD_STATUS_LABEL,
  type SalesLeadFollowupPayload,
} from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { use, useCallback, useEffect, useState } from 'react';

import { LeadFollowupForm } from '@/components/sales/lead-followup-form';
import { LeadProgress } from '@/components/sales/lead-progress';
import { EmptyState } from '@/components/ui/empty-state';
import { ChildScreenHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Sales → Sales Lead-FOB → one lead's follow-up history (§8's child screen).
 *
 * Scoped to the parent by URL, headed by the parent's name, and with the Back
 * to list link §8 calls required. Above the history: where the lead stands on
 * §5's workflow, and the inquiries it has produced (§5 steps 03–06).
 */
const money = (value: string | null): string =>
  value === null
    ? '—'
    : Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function LeadFollowupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authorizedList, can } = useSession();

  const [data, setData] = useState<SalesLeadFollowupPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPending, setPending] = useState(true);

  const load = useCallback(async () => {
    setPending(true);
    try {
      const response = await authorizedList<SalesLeadFollowupPayload>(
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

  const lead = data?.lead ?? null;

  return (
    <div className="flex flex-col gap-4">
      <ChildScreenHeader
        parentLabel={lead === null ? 'Sales lead' : `Sales lead ${lead.code}`}
        parentName={lead?.name ?? 'Loading…'}
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

      {lead !== null && (
        <>
          <LeadProgress status={lead.status} />
          <section
            aria-label="Lead summary"
            className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-manifest border border-line bg-surface p-3 shadow-manifest md:grid-cols-4"
          >
            <Fact label="Status" value={SALES_LEAD_STATUS_LABEL[lead.status]} />
            <Fact label="Salesperson" value={lead.ownerName ?? '—'} />
            <Fact
              label="Lane"
              value={lead.polName === null ? '—' : `${lead.polName} → ${lead.podName ?? '—'}`}
            />
            <Fact
              label="Freight control"
              value={lead.freightControl === null ? '—' : FREIGHT_CONTROL_LABEL[lead.freightControl]}
            />
            <Fact label="Next follow-up" value={lead.nextFollowupDate ?? '—'} mono />
            <Fact label="Est. monthly profit (USD)" value={money(lead.forecast.monthlyProfit)} mono />
            <Fact label="Win probability" value={lead.winProbability === null ? '—' : `${lead.winProbability}%`} mono />
            <div className="flex items-end gap-3">
              {can('SALES.NEW_SALES_LEAD.EDIT') && (
                <Link
                  href={`/sales/sales-lead/${lead.id}/edit` as Route}
                  className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
                >
                  Edit lead
                </Link>
              )}
              <Link
                href={`/sales/sales-lead/${lead.id}/documents` as Route}
                className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
              >
                Documents ({lead.documentCount})
              </Link>
            </div>
          </section>

          {data !== null && data.inquiries.length > 0 && (
            <section
              aria-label="Inquiries raised from this lead"
              className="rounded-manifest border border-line bg-surface p-3 shadow-manifest"
            >
              <p className="label-manifest">Inquiries raised from this lead</p>
              <ul className="mt-2 flex flex-col gap-1">
                {data.inquiries.map((inquiry) => (
                  <li key={inquiry.id} className="flex flex-wrap gap-x-4 text-cell text-hull">
                    <span className="font-mono tabular-nums">{inquiry.code}</span>
                    <span className="font-mono tabular-nums text-steel">{inquiry.inquiryDate}</span>
                    <span>{inquiry.customerName}</span>
                    <span className="text-steel">
                      {INQUIRY_STATUS_LABEL[inquiry.status as InquiryStatus] ?? inquiry.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {can('SALES.SALES_LEAD_FOLLOWUP.CREATE') && (
        <section
          aria-label="Record a follow-up"
          className="rounded-manifest border border-line bg-surface p-4 shadow-manifest"
        >
          <h2 className="mb-3 text-section text-hull">Record a follow-up</h2>
          <LeadFollowupForm leadId={id} onSaved={load} />
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
                <th className="label-manifest px-2.5 py-2">Discussion</th>
                <th className="label-manifest px-2.5 py-2">Outcome</th>
                <th className="label-manifest px-2.5 py-2 text-right">Target rate</th>
                <th className="label-manifest px-2.5 py-2">Objections</th>
                <th className="label-manifest px-2.5 py-2">Next action</th>
                <th className="label-manifest px-2.5 py-2">Next</th>
                <th className="label-manifest px-2.5 py-2">Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {(data?.followups ?? []).map((followup) => (
                <tr key={followup.id} className="border-b border-line align-top last:border-0 hover:bg-row-hover">
                  <td className="px-2.5 py-2 font-mono text-cell tabular-nums text-hull">
                    {followup.followupDate}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-hull">
                    {CONTACT_MODE_LABEL[followup.contactMode]}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-hull">{followup.contactPerson ?? '—'}</td>
                  <td className="max-w-xs px-2.5 py-2 text-cell text-hull">{followup.notes ?? '—'}</td>
                  <td className="px-2.5 py-2 text-cell text-hull">{followup.outcome ?? '—'}</td>
                  <td className="px-2.5 py-2 text-right font-mono text-cell tabular-nums text-hull">
                    {followup.targetRate === null ? '—' : `${money(followup.targetRate)} ${followup.currency ?? ''}`}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-hull">{followup.objections ?? '—'}</td>
                  <td className="px-2.5 py-2 text-cell text-hull">{followup.nextAction ?? '—'}</td>
                  <td className="px-2.5 py-2 font-mono text-cell tabular-nums text-steel">
                    {followup.nextFollowupDate ?? '—'}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-steel">{followup.createdBy ?? '—'}</td>
                </tr>
              ))}
              {isPending && (
                <tr>
                  <td colSpan={10} className="p-6 text-center text-body text-steel">
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

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="label-manifest">{label}</p>
      <p className={mono === true ? 'font-mono text-body tabular-nums text-hull' : 'text-body text-hull'}>{value}</p>
    </div>
  );
}
