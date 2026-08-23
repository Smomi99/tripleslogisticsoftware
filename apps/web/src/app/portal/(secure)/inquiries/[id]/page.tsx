'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type AgentInquiryDto,
  type AgentQuoteDto,
  type AgentQuoteInput,
  agentQuoteInputSchema,
  type PortalCurrencyOption,
} from '@ff/shared';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { usePortalSession } from '@/lib/portal-session';

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
  const { request, list } = usePortalSession();
  const [inquiry, setInquiry] = useState<AgentInquiryDto | null>(null);
  const [currencies, setCurrencies] = useState<PortalCurrencyOption[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AgentQuoteInput>({
    resolver: zodResolver(agentQuoteInputSchema),
    defaultValues: { amount: '', currencyId: '', validUntil: '', remarks: '' },
  });

  const load = useCallback(async () => {
    try {
      const data = await request<AgentInquiryDto>(`/api/portal/inquiries/${params.id}`);
      setInquiry(data);
      reset({
        amount: data.quote?.amount ?? '',
        currencyId: data.quote?.currencyId ?? '',
        validUntil: data.quote?.validUntil ?? '',
        remarks: data.quote?.remarks ?? '',
        ...(data.quote?.transitDays != null ? { transitDays: data.quote.transitDays } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setNotFound(true);
        return;
      }
      setFormError('Could not load this inquiry. Try again in a moment.');
    }
  }, [request, params.id, reset]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        // Currencies are one of the few reference tables an agent may read.
        const result = await list<PortalCurrencyOption[]>('/api/portal/currencies');
        setCurrencies(result.data);
      } catch {
        // A quote can still be typed; the select simply has fewer options.
      }
    })();
  }, [list]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const body = {
      amount: values.amount,
      currencyId: values.currencyId,
      ...(values.validUntil !== undefined && values.validUntil !== ''
        ? { validUntil: values.validUntil }
        : {}),
      ...(typeof values.transitDays === 'number' ? { transitDays: values.transitDays } : {}),
      ...(values.remarks !== undefined && values.remarks !== '' ? { remarks: values.remarks } : {}),
    };

    try {
      const existing = inquiry?.quote ?? null;
      const saved =
        existing === null
          ? await request<AgentQuoteDto>(`/api/portal/inquiries/${params.id}/quote`, {
              method: 'POST',
              body,
            })
          : await request<AgentQuoteDto>(`/api/portal/quotes/${existing.id}`, {
              method: 'PATCH',
              body,
            });
      // §9: the toast carries the same verb as the button.
      toast.success(existing === null ? 'Quote sent' : 'Quote updated');
      setInquiry((current) => (current === null ? current : { ...current, quote: saved }));
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not send your quote. Try again in a moment.',
      );
    }
  });

  if (notFound) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-page-title text-hull">Not available</h1>
        <p className="text-body text-steel">
          This inquiry is not one your forwarder has sent you, or it has been withdrawn.
        </p>
        <Button asChild variant="secondary">
          <Link href="/portal">Back to inquiries</Link>
        </Button>
      </div>
    );
  }

  if (inquiry === null) {
    return <p className="text-body text-steel">Loading…</p>;
  }

  /*
   * Editable only while the inquiry is open AND the forwarder has not answered.
   *
   * The API already refuses a PATCH on a decided quote, so without this the
   * agent would meet an editable form and a 409 — a rejection with no
   * explanation, for a decision that had already been made.
   */
  const decision = inquiry.quote?.status ?? 'SUBMITTED';
  const answered = decision === 'ACCEPTED' || decision === 'DECLINED';
  const quotable = inquiry.status === 'OPEN' && !answered;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        {/* Required on every child screen (§8), and doubly so here: this is the
            only way back for someone who arrived from an email link. */}
        <Link href="/portal" className="text-cell text-harbour hover:underline">
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
          <Detail label="Terms of service" value={inquiry.tosName} />
          <Detail label="Incoterm" value={inquiry.modeName} />
          <Detail label="Commodity" value={inquiry.commodityName} />
          <Detail label="HS code" value={inquiry.hsCode} mono />
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
                    {volume.containerTypeName ?? volume.containerTypeNote ?? '—'}
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

      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <h2 className="mb-1 text-section text-hull">Your quotation</h2>
        <p className="mb-4 text-cell text-steel">
          {quotable
            ? 'One all-in price for this lane. You can change it while the inquiry is open.'
            : answered
              ? decision === 'ACCEPTED'
                ? 'Your quotation has been accepted. It can no longer be changed.'
                : 'Your quotation was not taken forward on this inquiry.'
              : 'This inquiry is closed, so your quotation can no longer be changed.'}
        </p>

        <form onSubmit={onSubmit} noValidate className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id="amount" label="Price" required error={errors.amount?.message}>
            <Input
              id="amount"
              numeric
              inputMode="decimal"
              placeholder="1450.00"
              disabled={!quotable}
              aria-invalid={errors.amount !== undefined}
              {...register('amount')}
            />
          </Field>

          <Field id="currencyId" label="Currency" required error={errors.currencyId?.message}>
            <Select
              id="currencyId"
              disabled={!quotable}
              aria-invalid={errors.currencyId !== undefined}
              {...register('currencyId')}
            >
              <option value="">Choose…</option>
              {currencies.map((currency) => (
                <option key={currency.id} value={currency.id}>
                  {currency.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="validUntil" label="Valid until" error={errors.validUntil?.message}>
            <Input id="validUntil" type="date" disabled={!quotable} {...register('validUntil')} />
          </Field>

          <Field id="transitDays" label="Transit days" error={errors.transitDays?.message}>
            <Input
              id="transitDays"
              numeric
              inputMode="numeric"
              disabled={!quotable}
              {...register('transitDays', {
                setValueAs: (value: string) => (value === '' ? '' : Number(value)),
              })}
            />
          </Field>

          <Field id="remarks" label="Remarks" error={errors.remarks?.message} wide>
            <textarea
              id="remarks"
              rows={3}
              disabled={!quotable}
              className="w-full rounded-manifest border border-line bg-surface px-2.5 py-2 text-body text-hull focus:outline-2 focus:outline-harbour disabled:bg-paper disabled:text-steel"
              {...register('remarks')}
            />
          </Field>

          {formError !== null && (
            <p role="alert" className="text-cell text-alert md:col-span-2">
              {formError}
            </p>
          )}

          {quotable && (
            <div className="flex items-center gap-3 md:col-span-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? 'Sending…'
                  : inquiry.quote === null
                    ? 'Send quote'
                    : 'Update quote'}
              </Button>
              {inquiry.quote !== null && (
                <span className="text-cell text-steel">
                  Sent {new Date(inquiry.quote.submittedAt).toLocaleDateString()}
                </span>
              )}
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
