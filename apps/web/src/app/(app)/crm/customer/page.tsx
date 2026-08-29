'use client';

import {
  BUSINESS_AREA_LABEL,
  BUSINESS_AREAS,
  CUSTOMER_TYPE_LABEL,
  CUSTOMER_TYPES,
  type CustomerDto,
  type CustomerSortField,
  type LookupOption,
} from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/** CRM → Customer (CLAUDE.md §6, §8). */
const ENDPOINT = '/api/tenant/crm/customers';

export default function CustomerPage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<CustomerDto, CustomerSortField>(ENDPOINT, 'name');

  /* The commodity categories, for the filter beside the type. */
  const [sectors, setSectors] = useState<LookupOption[]>([]);
  useEffect(() => {
    void authorizedRequest<LookupOption[]>(`${ENDPOINT}/sectors`)
      .then(setSectors)
      .catch(() => setSectors([]));
  }, [authorizedRequest]);

  const [toToggle, setToToggle] = useState<CustomerDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<CustomerDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  const columns: DataTableColumn<CustomerDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Customer', sortable: true, cell: (r) => r.name },
      { id: 'country', header: 'Country', sortable: true, cell: (r) => r.country },
      {
        id: 'customerType',
        header: 'Type',
        cell: (r) => CUSTOMER_TYPE_LABEL[r.customerType],
      },
      {
        id: 'businessArea',
        header: 'Business',
        cell: (r) => BUSINESS_AREA_LABEL[r.businessArea],
      },
      { id: 'sector', header: 'Commodity', cell: (r) => r.industrySectorName },
      {
        id: 'picCount',
        header: 'Contacts',
        align: 'right',
        numeric: true,
        cell: (r) => String(r.picCount),
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
      await authorizedRequest(`/api/tenant/crm/customers/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Customer deleted');
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
        title="Customer"
        description="The shippers and consignees this workspace books for."
        action={
          can('CRM.CUSTOMER.CREATE') ? (
            <Button asChild>
              <Link href="/crm/customer/new">+ Add customer</Link>
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search name, code, country, type or commodity"
          aria-label="Search customers"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Filter by type"
          value={list.filters['customerType'] ?? ''}
          onChange={(event) => list.setFilter('customerType', event.target.value)}
          className="w-44"
        >
          <option value="">All types</option>
          {CUSTOMER_TYPES.map((t) => (
            <option key={t} value={t}>
              {CUSTOMER_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by business area"
          value={list.filters['businessArea'] ?? ''}
          onChange={(event) => list.setFilter('businessArea', event.target.value)}
          className="w-44"
        >
          <option value="">All business areas</option>
          {BUSINESS_AREAS.map((a) => (
            <option key={a} value={a}>
              {BUSINESS_AREA_LABEL[a]}
            </option>
          ))}
        </Select>
        {/*
          The commodity, which the client asked to filter by. It is the
          industry sector the form already calls Commodity category, so the
          label here follows the form rather than the column name.
        */}
        <Select
          aria-label="Filter by commodity"
          value={list.filters['industrySectorId'] ?? ''}
          onChange={(event) => list.setFilter('industrySectorId', event.target.value)}
          className="w-52"
        >
          <option value="">All commodities</option>
          {sectors.map((sector) => (
            <option key={sector.id} value={sector.id}>
              {sector.name}
            </option>
          ))}
        </Select>
      </div>

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
        onSortChange={(by, order) => list.setSort(by as CustomerSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('CRM.CUSTOMER.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/crm/customer/${row.id}/pic`}>PIC</Link>
              </Button>
            )}
            {can('CRM.CUSTOMER.EDIT') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/crm/customer/${row.id}/edit`}>Edit</Link>
              </Button>
            )}
            {can('CRM.CUSTOMER.TOGGLE_STATUS') && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('CRM.CUSTOMER.DELETE') && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No customers match those filters"
              description="Try a different name, country or type, or clear the filters."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No customers yet"
              description="Add your first customer so inquiries and quotations have someone to quote for."
              action={
                can('CRM.CUSTOMER.CREATE') ? (
                  <Button asChild>
                    <Link href="/crm/customer/new">+ Add customer</Link>
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
        title={toToggle?.isActive === true ? 'Deactivate this customer?' : 'Activate this customer?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.name} will stop appearing on new inquiries and quotations. Existing shipments are unaffected.`
              : `${toToggle.name} will be available again on new inquiries and quotations.`
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
        title="Delete this customer?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.name} will be removed from the list for good. This is for a customer added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
