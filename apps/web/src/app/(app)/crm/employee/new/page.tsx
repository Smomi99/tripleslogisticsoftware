'use client';

import { ArrowLeft } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';

import { backLinkClasses, PageHeader } from '@/components/ui/form-layout';

import { EmployeeForm } from '../employee-form';

/** CRM → Employee → new. Full page: nine fields (§8). */
export default function NewEmployeePage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link href={'/crm/employee' as Route} className={backLinkClasses}>
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to list
        </Link>
        <PageHeader
          title="Add employee"
          description="CV, salary and the service contract can be added once the employee is saved."
        />
      </div>

      <div className="max-w-3xl rounded-card border border-line bg-surface p-4 shadow-manifest sm:p-5">
        <EmployeeForm employee={null} />
      </div>
    </div>
  );
}
