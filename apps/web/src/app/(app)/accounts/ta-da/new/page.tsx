'use client';

import type { TaDaOptionsDto } from '@ff/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { TaDaForm } from '@/components/accounts/ta-da-form';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/** A new TA/DA claim — a full page: a header and a grid of trips. */
export default function NewTaDaPage() {
  const { authorizedRequest } = useSession();
  const [options, setOptions] = useState<TaDaOptionsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<TaDaOptionsDto>('/api/tenant/accounts/ta-da/options').then(
      (data) => {
        if (live) setOptions(data);
      },
      (caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not open a new claim.');
      },
    );
    return () => {
      live = false;
    };
  }, [authorizedRequest]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Link href={{ pathname: '/accounts/ta-da' }} className="text-cell text-harbour hover:underline">
          ← Back to list
        </Link>
        <EmptyState title="Not available" description={error} />
      </div>
    );
  }
  if (options === null) return <p className="text-body text-steel">Loading…</p>;
  return <TaDaForm claim={null} options={options} onSaved={() => undefined} />;
}
