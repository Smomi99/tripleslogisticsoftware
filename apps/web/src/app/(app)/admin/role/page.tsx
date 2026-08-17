'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type RoleDto, type RoleInput, roleInputSchema, type RoleSortField } from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { FormLayout, PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/** Admin → Roles (CLAUDE.md §7 superadmin screen 1). */
const ENDPOINT = '/api/tenant/admin/roles';

export default function RolePage() {
  const { authorizedRequest, can } = useSession();
  const list = useMasterList<RoleDto, RoleSortField>(ENDPOINT, 'name');

  const [editing, setEditing] = useState<RoleDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [toToggle, setToToggle] = useState<RoleDto | null>(null);
  const [isToggling, setToggling] = useState(false);

  const columns: DataTableColumn<RoleDto>[] = useMemo(
    () => [
      { id: 'name', header: 'Role', sortable: true, cell: (r) => r.name },
      { id: 'description', header: 'Description', cell: (r) => r.description ?? '—' },
      {
        id: 'permissionCount',
        header: 'Permissions',
        align: 'right',
        numeric: true,
        cell: (r) => String(r.permissionCount),
      },
      {
        id: 'userCount',
        header: 'Users',
        align: 'right',
        numeric: true,
        cell: (r) => String(r.userCount),
      },
      {
        id: 'isSystem',
        header: 'Source',
        cell: (r) => (
          <span className="text-cell text-steel">{r.isSystem ? 'System' : 'Workspace'}</span>
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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Roles"
        description="Templates that grant a set of permissions. Per-user overrides always win."
        action={
          can('ADMIN.ROLE.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add role
            </Button>
          ) : null
        }
      />

      <Input
        type="search"
        placeholder="Search roles"
        aria-label="Search roles"
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
        onSortChange={(by, order) => list.setSort(by as RoleSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('ADMIN.ROLE.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/admin/role/${row.id}/permissions`}>Permissions</Link>
              </Button>
            )}
            {/* A system role is seeded; renaming or disabling it breaks the seed. */}
            {can('ADMIN.ROLE.EDIT') && !row.isSystem && (
              <Button
                variant="text"
                size="inline"
                onClick={() => {
                  setEditing(row);
                  setFormOpen(true);
                }}
              >
                Edit
              </Button>
            )}
            {can('ADMIN.ROLE.TOGGLE_STATUS') && !row.isSystem && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
          </>
        )}
        empty={
          <EmptyState
            title="No roles yet"
            description="Add a role, then choose what it can reach on the permissions screen."
            action={
              can('ADMIN.ROLE.CREATE') ? (
                <Button
                  onClick={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                >
                  + Add role
                </Button>
              ) : null
            }
          />
        }
      />

      <Modal
        open={isFormOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing === null ? 'Add role' : `Edit ${editing.name}`}
      >
        <RoleForm
          role={editing}
          onSaved={async () => {
            setFormOpen(false);
            setEditing(null);
            await list.reload();
          }}
          onCancel={() => {
            setFormOpen(false);
            setEditing(null);
          }}
        />
      </Modal>

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this role?' : 'Activate this role?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.userCount} user(s) hold ${toToggle.name}. Deactivating it removes their access immediately and signs them out.`
              : `${toToggle.name} will grant its permissions again.`
        }
        confirmLabel={toToggle?.isActive === true ? 'Deactivate' : 'Activate'}
        destructive={toToggle?.isActive === true}
        isPending={isToggling}
        onConfirm={() => void confirmToggle()}
      />
    </div>
  );
}

function RoleForm({
  role,
  onSaved,
  onCancel,
}: {
  role: RoleDto | null;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<RoleInput>({
    resolver: zodResolver(roleInputSchema),
    defaultValues: { name: '', description: '' },
  });

  useEffect(() => {
    reset({ name: role?.name ?? '', description: role?.description ?? '' });
    setFormError(null);
  }, [role, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await authorizedRequest(role === null ? ENDPOINT : `${ENDPOINT}/${role.id}`, {
        method: role === null ? 'POST' : 'PATCH',
        body: values,
      });
      toast.success(role === null ? 'Role added' : 'Saved');
      await onSaved();
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  });

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={isSubmitting}
      submitLabel={role === null ? 'Add role' : 'Save changes'}
      error={formError ?? undefined}
    >
      <Field id="name" label="Role name" required error={errors.name?.message}>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>
      <Field id="description" label="Description" error={errors.description?.message}>
        <Input id="description" {...register('description')} />
      </Field>
    </FormLayout>
  );
}
