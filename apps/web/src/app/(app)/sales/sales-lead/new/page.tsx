'use client';

import { ArrowLeft } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';

import { LeadForm } from '@/components/sales/lead-form';
import { backLinkClasses, PageHeader } from '@/components/ui/form-layout';

/** Sales → Sales Lead-FOB → new. Full page: §8 puts a form this size off-modal. */
export default function NewSalesLeadPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link href={'/sales/sales-lead' as Route} className={backLinkClasses}>
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to list
        </Link>
        <PageHeader
          title="New FOB export lead"
          description="Capture the exporter, the buyer, the lane and what the business is worth."
        />
      </div>

      <div className="max-w-5xl rounded-card border border-line bg-surface p-4 shadow-manifest sm:p-5">
        <LeadForm lead={null} />
      </div>
    </div>
  );
}
