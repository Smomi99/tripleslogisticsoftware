'use client';

import { milestoneScreenOf } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { MilestoneScreen } from '@/components/cs/milestone-screen';

/** One tile of the Depart-Arrive landing page (docs/DESIGN-UPDATE-2026-10-04.md §2). */
export default function Page() {
  const params = useParams<{ screen: string }>();
  const screen = milestoneScreenOf(params.screen);

  if (screen === undefined) {
    return (
      <div className="flex flex-col items-start gap-2">
        <h1 className="text-page-title text-hull">No such list</h1>
        <p className="text-body text-steel">That confirmation list does not exist.</p>
        <Link href={'/cs/depart-arrive' as Route} className="text-body text-harbour hover:underline">
          Back to Depart-Arrive Confirmation
        </Link>
      </div>
    );
  }
  // Keyed by slug, so moving between lists starts each with its own filters.
  return <MilestoneScreen key={screen.slug} screen={screen} />;
}
