'use client';

import type { QuotationDto } from '@ff/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import type { QuotationOptions } from '../quotation-form';

/**
 * Raising a quotation (§5.3 rules 1–3).
 *
 * Deliberately short. Everything the customer will read is copied down from the
 * inquiry and pulled from the price list, so the only things worth asking for
 * up front are the four the inquiry cannot answer: which carrier, what to bill
 * in, how long the offer stands, and what to call the freight.
 *
 * That last one is the odd one out and worth explaining. The price list prices
 * the box but does not name the charge — `freight_rate` carries no cost head,
 * only `rate_local_charge` does. What the freight is *called* on a
 * customer-facing document is a sales decision rather than a purchasing one, so
 * it is asked here rather than added as a column to the Purchase module. Leave
 * it blank and the local charges still pull; the freight lines are then yours
 * to add, which is §5.3 rule 5's instinct applied to a gap in the schema.
 */
export default function NewQuotationPage() {
  const { authorizedRequest } = useSession();
  const router = useRouter();

  const [options, setOptions] = useState<QuotationOptions | null>(null);
  const [inquiryId, setInquiryId] = useState('');
  const [carrierId, setCarrierId] = useState('');
  const [localCurrencyId, setLocalCurrencyId] = useState('');
  const [freightCostHeadId, setFreightCostHeadId] = useState('');
  const [quotationDate, setQuotationDate] = useState(new Date().toISOString().slice(0, 10));
  const [validityDate, setValidityDate] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const opts = await authorizedRequest<QuotationOptions>(
          '/api/tenant/cs/quotation-options',
        );
        if (cancelled) return;
        setOptions(opts);
        // Default to the workspace's own billing currency where there is one.
        setLocalCurrencyId((current) => current || (opts.currencies[0]?.id ?? ''));
      } catch (caught) {
        if (!cancelled) {
          toast.error(
            caught instanceof ApiError ? caught.message : 'Could not load the form.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest]);

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const created = await authorizedRequest<QuotationDto>('/api/tenant/cs/quotations', {
        method: 'POST',
        body: {
          inquiryId,
          carrierId,
          localCurrencyId,
          quotationDate,
          ...(validityDate === '' ? {} : { validityDate }),
          ...(freightCostHeadId === '' ? {} : { freightCostHeadId }),
        },
      });
      toast.success(
        created.lines.length === 0
          ? `${created.code} created. No price list covers this lane, so add the charges by hand.`
          : `${created.code} created with ${created.lines.length} charges from the price list`,
      );
      router.push(`/cs/quotation/${created.id}`);
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : 'Could not create the quotation.',
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = inquiryId !== '' && carrierId !== '' && localCurrencyId !== '';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="New quotation"
        description="Pick the inquiry and the carrier. The header copies down and the charges pull themselves from your price list."
      />

      <section className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <div className="grid gap-4">
          <Field
            id="inquiryId"
            label="Inquiry No"
            required
            hint="A quotation cannot exist without the request that prompted it."
          >
            <Select
              id="inquiryId"
              value={inquiryId}
              onChange={(event) => setInquiryId(event.target.value)}
            >
              <option value="">Choose an inquiry</option>
              {(options?.inquiries ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="carrierId" label="Carrier" required>
              <Select
                id="carrierId"
                value={carrierId}
                onChange={(event) => setCarrierId(event.target.value)}
              >
                <option value="">Choose a carrier</option>
                {(options?.carriers ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              id="localCurrencyId"
              label="Local Currency"
              required
              hint="Its conversion rate is frozen onto this quotation now, and never re-read."
            >
              <Select
                id="localCurrencyId"
                value={localCurrencyId}
                onChange={(event) => setLocalCurrencyId(event.target.value)}
              >
                <option value="">Choose a currency</option>
                {(options?.currencies ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.conversion})
                  </option>
                ))}
              </Select>
            </Field>

            <Field id="quotationDate" label="Quotation Date" required>
              <Input
                id="quotationDate"
                type="date"
                value={quotationDate}
                onChange={(event) => setQuotationDate(event.target.value)}
              />
            </Field>

            <Field id="validityDate" label="Validity Date">
              <Input
                id="validityDate"
                type="date"
                value={validityDate}
                onChange={(event) => setValidityDate(event.target.value)}
              />
            </Field>
          </div>

          <Field
            id="freightCostHeadId"
            label="Freight cost head"
            hint="What the freight is called on the customer's document. Leave blank and only the local charges pull."
          >
            <Select
              id="freightCostHeadId"
              value={freightCostHeadId}
              onChange={(event) => setFreightCostHeadId(event.target.value)}
            >
              <option value="">Don't pull the freight</option>
              {(options?.costHeads ?? []).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex items-center gap-3">
            <Button onClick={() => void create()} disabled={!ready || busy}>
              {busy ? 'Creating…' : 'Create quotation'}
            </Button>
            <Link
              href={{ pathname: '/cs/quotation' }}
              className="text-cell text-harbour hover:underline"
            >
              Back to list
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
