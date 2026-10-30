'use client';

import { ArrowLeft } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';

import { backLinkClasses, PageHeader } from '@/components/ui/form-layout';

import { CustomerForm } from '../customer-form';

/** CRM → Customer → new. Full page, because §8 puts a 10-field form off-modal. */
export default function NewCustomerPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link href={'/crm/customer' as Route} className={backLinkClasses}>
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to list
        </Link>
        <PageHeader title="Add customer" description="Volumes are optional and can be filled in later." />
      </div>

      <div className="max-w-3xl rounded-card border border-line bg-surface p-4 shadow-manifest sm:p-5">
        <CustomerForm customer={null} />
      </div>
    </div>
  );
}
