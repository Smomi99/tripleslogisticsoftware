'use client';

import {
  BUSINESS_AREA_LABEL,
  BUSINESS_AREAS,
  CUSTOMER_TYPE_LABEL,
  CUSTOMER_TYPES,
  type LookupOption,
} from '@ff/shared';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { PriceEmailScreen } from '@/components/crm/price-email/price-email-screen';
import { useSession } from '@/lib/session';

/**
 * CRM → Customer → Bulk email (2026-09-29; Email prices until 2026-10-07).
 *
 * The screen is shared with the Agent list's; this page reads the Customer
 * list's filters from the URL, exactly as the button carried them, and says
 * them in words for the header.
 */
function CustomerPriceEmail() {
  const params = useSearchParams();
  const { authorizedRequest } = useSession();

  const filters = useMemo(() => {
    const picked: Record<string, string> = {};
    for (const name of ['search', 'customerType', 'businessArea', 'industrySectorId']) {
      const value = params.get(name);
      if (value !== null && value !== '') picked[name] = value;
    }
    return picked;
  }, [params]);

  // The commodity filter arrives as an id; the header names it.
  const [sectorName, setSectorName] = useState<string | null>(null);
  const sectorId = filters['industrySectorId'];
  useEffect(() => {
    if (sectorId === undefined) return;
    void authorizedRequest<LookupOption[]>('/api/tenant/crm/customers/sectors')
      .then((sectors) => setSectorName(sectors.find((s) => s.id === sectorId)?.name ?? null))
      .catch(() => setSectorName(null));
  }, [authorizedRequest, sectorId]);

  const type = CUSTOMER_TYPES.find((t) => t === filters['customerType']);
  const area = BUSINESS_AREAS.find((a) => a === filters['businessArea']);
  const described =
    [
      filters['search'] === undefined ? null : `“${filters['search']}”`,
      type === undefined ? null : CUSTOMER_TYPE_LABEL[type],
      area === undefined ? null : BUSINESS_AREA_LABEL[area],
      sectorId === undefined ? null : (sectorName ?? 'one commodity'),
    ]
      .filter((part): part is string => part !== null)
      .join(' · ') || null;

  return <PriceEmailScreen party="customer" filters={filters} described={described} />;
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <CustomerPriceEmail />
    </Suspense>
  );
}
