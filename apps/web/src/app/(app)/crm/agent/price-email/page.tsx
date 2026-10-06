'use client';

import { AGENT_TYPE_LABEL, AGENT_TYPES } from '@ff/shared';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo } from 'react';

import { PriceEmailScreen } from '@/components/crm/price-email/price-email-screen';

/**
 * CRM → Agent → Email prices (2026-10-06) — the customer's Email prices, for
 * the agents on the Agent list.
 *
 * The screen is shared with the Customer list's; this page reads the Agent
 * list's filters from the URL, exactly as the button carried them, and says
 * them in words for the header.
 */
function AgentPriceEmail() {
  const params = useSearchParams();

  const filters = useMemo(() => {
    const picked: Record<string, string> = {};
    for (const name of ['search', 'agentType']) {
      const value = params.get(name);
      if (value !== null && value !== '') picked[name] = value;
    }
    return picked;
  }, [params]);

  const type = AGENT_TYPES.find((t) => t === filters['agentType']);
  const described =
    [
      filters['search'] === undefined ? null : `“${filters['search']}”`,
      type === undefined ? null : AGENT_TYPE_LABEL[type],
    ]
      .filter((part): part is string => part !== null)
      .join(' · ') || null;

  return <PriceEmailScreen party="agent" filters={filters} described={described} />;
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <AgentPriceEmail />
    </Suspense>
  );
}
