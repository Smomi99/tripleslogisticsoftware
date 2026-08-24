'use client';

import { type AgentInquiryDto } from '@ff/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { StatusThread } from '@/components/agent-quote/status-thread';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { QuoteForm } from './quote-form';

/**
 * One inquiry, and the form that answers it (§5).
 *
 * What is NOT on this page is as deliberate as what is: no customer, no target
 * price, no other agent's quote, and no staff remarks. Those absences are
 * enforced twice over — the DTO has no such fields and agent_inquiry_v has no
 * such columns — but they are also a product decision, and this is the screen
 * where it shows.
 *
 * The remarks field further down is the agent's own, on their quote. It travels
 * the other way.
 */

/** A read-only fact about the shipment. */
function Detail({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label-manifest">{label}</span>
      <span className={mono === true ? 'font-mono text-body tabular-nums text-hull' : 'text-body text-hull'}>
        {value === null || value === '' ? '—' : value}
      </span>
    </div>
  );
}

export default function PortalInquiryDetailPage() {
  const params = useParams<{ id: string }>();
  const { authorizedRequest: request } = useSession();
  const [inquiry, setInquiry] = useState<AgentInquiryDto | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await request<AgentInquiryDto>(`/api/tenant/agent/inquiries/${params.id}`);
      setInquiry(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setNotFound(true);
        return;
      }
      setLoadError('Could not load this inquiry. Try again in a moment.');
    }
  }, [request, params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-page-title text-hull">Not available</h1>
        <p className="text-body text-steel">
          This inquiry is not one your forwarder has sent you, or it has been withdrawn.
        </p>
        <Button asChild variant="secondary">
          <Link href="/agent/inquiry">Back to inquiries</Link>
        </Button>
      </div>
    );
  }

  if (inquiry === null) {
    return (
      <p className={loadError === null ? 'text-body text-steel' : 'text-body text-alert'}>
        {loadError ?? 'Loading…'}
      </p>
    );
  }

  /*
   * Editable only while the inquiry is open AND the forwarder has not answered.
   *
   * The API already refuses a PATCH on a decided quote, so without this the
   * agent would meet an editable form and a 409 — a rejection with no
   * explanation, for a decision that had already been made.
   */
  const decision = inquiry.quote?.status ?? 'SUBMITTED';
  const answered = decision === 'WON' || decision === 'LOST';
  const quotable = inquiry.status === 'OPEN' && !answered;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        {/* Required on every child screen (§8), and doubly so here: this is the
            only way back for someone who arrived from an email link. */}
        <Link href="/agent/inquiry" className="text-cell text-harbour hover:underline">
          ← Back to inquiries
        </Link>
        <h1 className="font-mono text-page-title tabular-nums text-hull">{inquiry.code}</h1>
        <p className="text-body text-steel">
          {inquiry.polName ?? '—'} → {inquiry.podName ?? '—'}
        </p>
      </div>

      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <h2 className="mb-4 text-section text-hull">Shipment</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Detail label="Loading port" value={inquiry.polName} />
          <Detail label="Discharge port" value={inquiry.podName} />
          <Detail label="Place of receipt" value={inquiry.placeOfReceipt} />
          <Detail label="Shipment" value={inquiry.shipmentType} />
          <Detail label="Loading type" value={inquiry.loadingType} />
          <Detail label="Incoterm" value={inquiry.tosName} />
          <Detail label="Terms of shipment" value={inquiry.modeName} />
          <Detail
            label="Commodity"
            value={
              inquiry.commodities.length === 0
                ? null
                : inquiry.commodities
                    .map((c) => (c.hsCode === null || c.hsCode === '' ? c.name : `${c.name} (${c.hsCode})`))
                    .join(', ')
            }
          />
          <Detail label="Inquiry date" value={inquiry.inquiryDate} mono />
          <Detail label="Expected shipment" value={inquiry.expectedShipmentDate} mono />
          <Detail label="Quote wanted by" value={inquiry.validTo} mono />
        </div>
      </section>

      {inquiry.volumes.length > 0 && (
        <section className="rounded-manifest border border-line bg-surface shadow-manifest">
          <h2 className="border-b border-line px-5 py-3 text-section text-hull">Volume</h2>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-5 py-2 text-left">Type</th>
                <th className="label-manifest px-3 py-2 text-left">Container</th>
                <th className="label-manifest px-3 py-2 text-right">Quantity</th>
                <th className="label-manifest px-3 py-2 text-right">CBM</th>
                <th className="label-manifest px-5 py-2 text-right">Weight (kg)</th>
              </tr>
            </thead>
            <tbody>
              {inquiry.volumes.map((volume) => (
                <tr key={volume.id} className="border-b border-line last:border-0">
                  <td className="px-5 py-2 text-cell text-hull">{volume.volumeKind}</td>
                  <td className="px-3 py-2 text-cell text-hull">
                    {volume.containerSizeName ?? volume.containerSizeNote ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-hull">
                    {volume.quantity ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-cell tabular-nums text-hull">
                    {volume.cbm ?? '—'}
                  </td>
                  <td className="px-5 py-2 text-right font-mono text-cell tabular-nums text-hull">
                    {volume.weightKg ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section
        id="quotation"
        className="scroll-mt-20 rounded-manifest border border-line bg-surface p-5 shadow-manifest"
      >
        <h2 className="mb-1 text-section text-hull">Your quotation</h2>
        <p className="mb-4 text-cell text-steel">
          {quotable
            ? 'Price each charge on its own line. Send a second option if you can route this another way.'
            : answered
              ? decision === 'WON'
                ? 'You won this business. Your quotation can no longer be changed.'
                : 'This one went elsewhere. See the messages below.'
              : 'This inquiry is closed, so your quotation can no longer be changed.'}
        </p>

        <QuoteForm
          inquiryId={params.id}
          quote={inquiry.quote}
          quotable={quotable}
          onSaved={(saved) =>
            setInquiry((current) => (current === null ? current : { ...current, quote: saved }))
          }
        />
      </section>

      {/* The wireframe's Status column. Only ever present once a quotation
          exists — there is nothing to discuss before then. */}
      {inquiry.quote !== null && (
        <section
          id="status"
          className="scroll-mt-20 rounded-manifest border border-line bg-surface p-5 shadow-manifest"
        >
          <h2 className="mb-1 text-section text-hull">Status</h2>
          <p className="mb-4 text-cell text-steel">
            Messages between you and your forwarder about this quotation.
          </p>
          <StatusThread
            endpoint={`/api/tenant/agent/quotes/${inquiry.quote.id}/comments`}
            canPost
            emptyHint="No messages yet. Ask a question here if anything about this inquiry is unclear."
          />
        </section>
      )}
    </div>
  );
}
