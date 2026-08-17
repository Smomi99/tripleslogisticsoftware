'use client';

import type { Route } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/ui/form-layout';

import { EmployeeForm } from '../employee-form';

/** CRM → Employee → new. Full page: nine fields (§8). */
export default function NewEmployeePage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href={'/crm/employee' as Route}
          className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
        >
          ← Back to list
        </Link>
        <PageHeader
          title="Add employee"
          description="CV, salary and the service contract can be added once the employee is saved."
        />
      </div>

      <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <EmployeeForm employee={null} />
      </div>
    </div>
  );
}
