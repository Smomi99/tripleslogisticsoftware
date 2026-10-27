'use client';

import type { Route } from 'next';
import Link from 'next/link';

import { LeadForm } from '@/components/sales/lead-form';
import { PageHeader } from '@/components/ui/form-layout';

/** Sales → Sales Lead-FOB → new. Full page: §8 puts a form this size off-modal. */
export default function NewSalesLeadPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href={'/sales/sales-lead' as Route}
          className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
        >
          ← Back to list
        </Link>
        <PageHeader
          title="New FOB export lead"
          description="Capture the exporter, the buyer, the lane and what the business is worth."
        />
      </div>

      <div className="max-w-5xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <LeadForm lead={null} />
      </div>
    </div>
  );
}
