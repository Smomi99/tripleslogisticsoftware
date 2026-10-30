'use client';

import type { SalesLeadDto } from '@ff/shared';
import { ArrowLeft } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { LeadForm } from '@/components/sales/lead-form';
import { backLinkClasses, PageHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/** Sales → Sales Lead-FOB → edit. Same form component as new, so the two cannot drift. */
export default function EditSalesLeadPage() {
  const params = useParams<{ id: string }>();
  const { authorizedRequest } = useSession();
  const [lead, setLead] = useState<SalesLeadDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void authorizedRequest<SalesLeadDto>(`/api/tenant/sales/leads/${params.id}`)
      .then(setLead)
      .catch((caught) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load this lead.'),
      );
  }, [authorizedRequest, params.id]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link href={'/sales/sales-lead' as Route} className={backLinkClasses}>
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to list
        </Link>
        <PageHeader
          title={lead === null ? 'Edit lead' : `Edit ${lead.name}`}
          description={lead === null ? undefined : `Lead ID ${lead.code}`}
        />
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      <div className="max-w-5xl rounded-card border border-line bg-surface p-4 shadow-manifest sm:p-5">
        {lead === null && error === null ? (
          <p className="text-body text-steel">Loading…</p>
        ) : lead !== null ? (
          // Keyed so a second lead opened from the same tab starts clean.
          <LeadForm key={lead.id} lead={lead} />
        ) : null}
      </div>
    </div>
  );
}
