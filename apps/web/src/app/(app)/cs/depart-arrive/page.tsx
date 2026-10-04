'use client';

import { MILESTONE_SCREENS, type MilestoneSummaryDto } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Customer Service → Depart-Arrive Confirmation — the client's
 * `Depart-Arrival Landing page` (docs/DESIGN-UPDATE-2026-10-04.md §2): six
 * tiles, On board · Transshipment · Arrival, each for sea and air. Each tile
 * says how many bookings wait on it, so the day starts where the work is.
 */
export default function DepartArriveLandingPage() {
  const { authorizedRequest } = useSession();
  const [counts, setCounts] = useState<MilestoneSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    authorizedRequest<MilestoneSummaryDto>('/api/tenant/cs/depart-arrive/summary')
      .then((data) => {
        if (live) setCounts(data);
      })
      .catch((caught: unknown) => {
        if (live) setError(caught instanceof ApiError ? caught.message : 'Could not load the counts.');
      });
    return () => {
      live = false;
    };
  }, [authorizedRequest]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Depart-Arrive Confirmation"
        description="Departure, transshipment and arrival confirmation. Each confirmation emails the customer, and a departure date becomes the BL's on-board date."
      />

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {MILESTONE_SCREENS.map((screen) => {
          const waiting = counts?.[screen.slug];
          return (
            <Link
              key={screen.slug}
              href={`/cs/depart-arrive/${screen.slug}` as Route}
              className="flex flex-col gap-2 rounded-manifest border border-line bg-surface px-4 py-3 shadow-manifest transition-colors duration-[120ms] hover:border-harbour focus-visible:outline-2 focus-visible:outline-harbour"
            >
              <span className="text-section text-hull">{screen.title}</span>
              <span className="text-cell text-steel">
                {waiting === undefined ? (
                  'Counting…'
                ) : (
                  <>
                    <span className={waiting > 0 ? 'font-mono font-semibold tabular-nums text-signal' : 'font-mono tabular-nums'}>
                      {waiting}
                    </span>{' '}
                    awaiting
                  </>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
