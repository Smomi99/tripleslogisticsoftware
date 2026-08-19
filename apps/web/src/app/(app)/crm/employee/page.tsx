'use client';

import type { EmployeeDto, EmployeeSortField } from '@ff/shared';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/** CRM → Employee (CLAUDE.md §6, §8). CV and Salary are contextual row buttons. */
const ENDPOINT = '/api/tenant/crm/employees';

export default function EmployeePage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<EmployeeDto, EmployeeSortField>(ENDPOINT, 'name');

  const [toToggle, setToToggle] = useState<EmployeeDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<EmployeeDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  const columns: DataTableColumn<EmployeeDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Employee', sortable: true, cell: (r) => r.name },
      { id: 'department', header: 'Department', sortable: true, cell: (r) => r.department ?? '—' },
      { id: 'designation', header: 'Designation', cell: (r) => r.designation ?? '—' },
      {
        id: 'joiningDate',
        header: 'Joined',
        numeric: true,
        cell: (r) => r.joiningDate ?? '—',
      },
      { id: 'officeMobile', header: 'Mobile', numeric: true, cell: (r) => r.officeMobile ?? '—' },
      {
        id: 'records',
        header: 'CV / Salary',
        cell: (r) => (
          <span className="text-cell text-steel">
            {r.hasCv ? 'Yes' : '—'} / {r.hasSalary ? 'Yes' : '—'}
          </span>
        ),
      },
      {
        id: 'isActive',
        header: 'Status',
        cell: (r) => (
          <Status tone={r.isActive ? 'active' : 'inactive'}>
            {r.isActive ? 'Active' : 'Inactive'}
          </Status>
        ),
      },
    ],
    [],
  );

  async function confirmToggle(): Promise<void> {
    if (toToggle === null) return;
    setToggling(true);
    try {
      await authorizedRequest(`${ENDPOINT}/${toToggle.id}/toggle-status`, { method: 'POST' });
      toast.success(toToggle.isActive ? 'Deactivated' : 'Activated');
      setToToggle(null);
      await list.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change the status.');
    } finally {
      setToggling(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (toDelete === null) return;
    setDeleting(true);
    try {
      await authorizedRequest(`/api/tenant/crm/employees/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Employee deleted');
      setToDelete(null);
      await list.reload();
    } catch (error) {
      // The refusal names what still uses it, which is the point.
      toast.error(error instanceof ApiError ? error.message : 'Could not delete it.');
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Employee"
        description="Your own staff. Each can have a CV, a salary breakdown and a service contract."
        action={
          can('CRM.EMPLOYEE.CREATE') ? (
            <Button asChild>
              <Link href="/crm/employee/new">+ Add employee</Link>
            </Button>
          ) : null
        }
      />

      <Input
        type="search"
        placeholder="Search name, code or department"
        aria-label="Search employees"
        value={list.searchInput}
        onChange={(event) => list.setSearchInput(event.target.value)}
        className="w-72"
      />

      {list.error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {list.error}
        </p>
      )}

      <DataTable
        columns={columns}
        rows={list.rows}
        getRowId={(r) => r.id}
        getCode={(r) => r.code}
        total={list.meta.total}
        page={list.page}
        limit={list.meta.limit}
        sortBy={list.sortBy}
        sortOrder={list.sortOrder}
        onSortChange={(by, order) => list.setSort(by as EmployeeSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {/* §8 lists CV and Salary as contextual buttons on the row. */}
            {can('CRM.EMPLOYEE.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/crm/employee/${row.id}/cv`}>CV</Link>
              </Button>
            )}
            {can('CRM.EMPLOYEE.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/crm/employee/${row.id}/salary`}>Salary</Link>
              </Button>
            )}
            {can('CRM.EMPLOYEE.EDIT') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/crm/employee/${row.id}/edit`}>Edit</Link>
              </Button>
            )}
            {can('CRM.EMPLOYEE.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('CRM.EMPLOYEE.DELETE') && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No employees match that search"
              description="Try a different name or department, or clear the search."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No employees yet"
              description="Add your staff so they can be given user accounts and assigned to shipments."
              action={
                can('CRM.EMPLOYEE.CREATE') ? (
                  <Button asChild>
                    <Link href="/crm/employee/new">+ Add employee</Link>
                  </Button>
                ) : null
              }
            />
          )
        }
      />

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this employee?' : 'Activate this employee?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing when assigning work. Their user account, if any, is unaffected.`
              : `${toToggle.name} will be available again when assigning work.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title="Delete this employee?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.name} will be removed from the list for good. This is for a employee added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
