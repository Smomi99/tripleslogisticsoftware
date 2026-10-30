'use client';

import type { TaDaClaimDto, TaDaOptionsDto } from '@ff/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';

import { TaDaForm } from '@/components/accounts/ta-da-form';
import { EmptyState } from '@/components/ui/empty-state';
import { backLinkClasses } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/** One TA/DA claim, rebuilt from what the server stored after every step. */
export default function TaDaClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authorizedRequest } = useSession();
  const [claim, setClaim] = useState<TaDaClaimDto | null>(null);
  const [options, setOptions] = useState<TaDaOptionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      authorizedRequest<TaDaClaimDto>(`/api/tenant/accounts/ta-da/${id}`),
      authorizedRequest<TaDaOptionsDto>('/api/tenant/accounts/ta-da/options'),
    ]).then(
      ([row, opts]) => {
        if (!live) return;
        setClaim(row);
        setOptions(opts);
      },
      (caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load that claim.');
      },
    );
    return () => {
      live = false;
    };
  }, [authorizedRequest, id]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Link href={{ pathname: '/accounts/ta-da' }} className={backLinkClasses}>
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to list
        </Link>
        <EmptyState title="Not available" description={error} />
      </div>
    );
  }
  if (claim === null || options === null) return <p className="text-body text-steel">Loading…</p>;
  // Keyed on status and totals, so every step rebuilds the form from the record.
  return <TaDaForm key={`${claim.status}:${claim.totalAmount}:${claim.decidedAt ?? ''}`} claim={claim} options={options} onSaved={setClaim} />;
}
