'use client';

import type { TariffDto } from '@ff/shared';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { TariffForm } from '@/components/purchase/tariff-form';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/** Purchase → Tariff → Edit (docs/DESIGN-UPDATE-2026-10-04.md §5). */
export default function Page() {
  const params = useParams<{ id: string }>();
  const { authorizedRequest } = useSession();
  const [tariff, setTariff] = useState<TariffDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<TariffDto>(`/api/tenant/purchase/tariffs/${params.id}`)
      .then((data) => {
        if (live) setTariff(data);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not open the tariff.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest, params.id]);

  if (error !== null) return <p className="text-body text-alert">{error}</p>;
  if (tariff === null) return <p className="text-body text-steel">Loading…</p>;
  return <TariffForm key={tariff.id} tariff={tariff} />;
}
