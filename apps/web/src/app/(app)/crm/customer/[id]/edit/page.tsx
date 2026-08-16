'use client';

import type { CustomerDto } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { CustomerForm } from '../../customer-form';

/** CRM → Customer → edit. Same form component as new, so the two cannot drift. */
export default function EditCustomerPage() {
  const params = useParams<{ id: string }>();
  const { authorizedRequest } = useSession();
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void authorizedRequest<CustomerDto>(`/api/tenant/crm/customers/${params.id}`)
      .then(setCustomer)
      .catch((caught) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load this customer.'),
      );
  }, [authorizedRequest, params.id]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href={'/crm/customer' as Route}
          className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
        >
          ← Back to list
        </Link>
        <PageHeader
          title={customer === null ? 'Edit customer' : `Edit ${customer.name}`}
          description={customer === null ? undefined : `Code ${customer.code}`}
        />
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        {customer === null && error === null ? (
          <p className="text-body text-steel">Loading…</p>
        ) : customer !== null ? (
          <CustomerForm customer={customer} />
        ) : null}
      </div>
    </div>
  );
}
