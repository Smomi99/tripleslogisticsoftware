'use client';

import type { Route } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/ui/form-layout';

import { CustomerForm } from '../customer-form';

/** CRM → Customer → new. Full page, because §8 puts a 10-field form off-modal. */
export default function NewCustomerPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href={'/crm/customer' as Route}
          className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
        >
          ← Back to list
        </Link>
        <PageHeader title="Add customer" description="Volumes are optional and can be filled in later." />
      </div>

      <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <CustomerForm customer={null} />
      </div>
    </div>
  );
}
