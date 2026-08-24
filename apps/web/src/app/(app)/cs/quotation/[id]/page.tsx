'use client';

import type { QuotationDto } from '@ff/shared';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { QuotationForm, type QuotationOptions } from '../quotation-form';

/**
 * One quotation (§6.5).
 *
 * A full page rather than a modal: the client's layout is a header block, two
 * line grids and a totals row, which is well past §8's eight-field threshold
 * and needs every pixel of a dense table.
 */
export default function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authorizedRequest } = useSession();
  const [quotation, setQuotation] = useState<QuotationDto | null>(null);
  const [options, setOptions] = useState<QuotationOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [row, opts] = await Promise.all([
          authorizedRequest<QuotationDto>(`/api/tenant/cs/quotations/${id}`),
          authorizedRequest<QuotationOptions>('/api/tenant/cs/quotation-options'),
        ]);
        if (cancelled) return;
        setQuotation(row);
        setOptions(opts);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiError ? caught.message : 'Could not load that quotation.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, id]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Link href={{ pathname: '/cs/quotation' }} className="text-cell text-harbour hover:underline">
          ← Back to list
        </Link>
        <EmptyState title="Not available" description={error} />
      </div>
    );
  }

  if (quotation === null || options === null) {
    return <p className="text-body text-steel">Loading…</p>;
  }

  return (
    <QuotationForm
      quotation={quotation}
      options={options}
      onSaved={(next) => setQuotation(next)}
    />
  );
}
