'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type UserType,
  USER_TYPE_ARTICLE,
  USER_TYPE_LABEL,
  type LookupOption,
  type UserFormInput,
  userFormSchema,
  type UserDto,
  type UserPasswordInput,
  userPasswordSchema,
  type UserSortField,
} from '@ff/shared';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { type FieldErrors, useForm, type UseFormRegister } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { FormLayout, PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { useMasterList } from '@/lib/use-master-list';

/**
 * CRM → User (CLAUDE.md §6 lists it under CRM; §7 gives its fields).
 *
 * Six fields, so §8 keeps the form in a modal. Password is set on create and
 * changed through its own action, never edited inline alongside the rest.
 */
const ENDPOINT = '/api/tenant/crm/users';

interface UserOptions {
  employees: LookupOption[];
  agents: LookupOption[];
  customers: LookupOption[];
  vendors: LookupOption[];
  roles: LookupOption[];
}

export default function UserPage() {
  const { authorizedRequest, can, user: currentUser } = useSession();
  const list = useMasterList<UserDto, UserSortField>(ENDPOINT, 'username');

  const [options, setOptions] = useState<UserOptions>({
    employees: [],
    agents: [],
    customers: [],
    vendors: [],
    roles: [],
  });
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [isFormOpen, setFormOpen] = useState(false);
  const [resetFor, setResetFor] = useState<UserDto | null>(null);
  const [toToggle, setToToggle] = useState<UserDto | null>(null);
  const [isToggling, setToggling] = useState(false);
  // CR-002. Deactivate retires a record that was real; Delete removes one
  // that never was. The server refuses if anything references it.
  const [toDelete, setToDelete] = useState<UserDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  useEffect(() => {
    void authorizedRequest<UserOptions>(`${ENDPOINT}/options`)
      .then(setOptions)
      .catch(() =>
        setOptions({ employees: [], agents: [], customers: [], vendors: [], roles: [] }),
      );
  }, [authorizedRequest]);

  const columns: DataTableColumn<UserDto>[] = useMemo(
    () => [
      { id: 'username', header: 'Username', sortable: true, numeric: true, cell: (r) => r.username },
      {
        // Whoever this login belongs to, whatever kind it is. An account named
        // "dhaka-apparels" tells you nothing on its own; the company does.
        id: 'belongsTo',
        header: 'Belongs to',
        cell: (r) => {
          const name = r.employeeName ?? r.agentName ?? r.customerName ?? r.vendorName;
          if (name === null || name === undefined) return <span className="text-steel">—</span>;
          return (
            <span className="flex flex-col">
              <span>{name}</span>
              {r.userType !== 'EMPLOYEE' ? (
                <span className="text-[11px] uppercase tracking-[0.06em] text-steel">
                  {USER_TYPE_LABEL[r.userType]}
                </span>
              ) : null}
            </span>
          );
        },
      },
      { id: 'email', header: 'Email', sortable: true, cell: (r) => r.email },
      {
        id: 'role',
        header: 'Role',
        cell: (r) =>
          r.isSuperadmin ? (
            <span className="text-hull">Superadmin</span>
          ) : (
            (r.roleName ?? <span className="text-steel">No role</span>)
          ),
      },
      {
        id: 'lastLoginAt',
        header: 'Last login',
        numeric: true,
        cell: (r) => (r.lastLoginAt === null ? '—' : r.lastLoginAt.slice(0, 10)),
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
      await authorizedRequest(`/api/tenant/crm/users/${toDelete.id}`, { method: 'DELETE' });
      toast.success('User deleted');
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
        title="User"
        description="Sign-in accounts for your staff and for the companies you work with."
        action={
          can('CRM.USER.CREATE') ? (
            <Button
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              + Add user
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search username or email"
          aria-label="Search users"
          value={list.searchInput}
          onChange={(event) => list.setSearchInput(event.target.value)}
          className="w-72"
        />
        <Select
          aria-label="Filter by role"
          value={list.filters['roleId'] ?? ''}
          onChange={(event) => list.setFilter('roleId', event.target.value)}
          className="w-48"
        >
          <option value="">All roles</option>
          {options.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
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
        onSortChange={(by, order) => list.setSort(by as UserSortField, order)}
        onPageChange={list.setPage}
        isPending={list.isPending}
        actions={(row) => (
          <>
            {can('CRM.USER.EDIT') && (
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
            {can('ADMIN.USER_PERMISSION.VIEW') && (
              <Button variant="text" size="inline" asChild>
                <Link href={`/admin/user-permission/${row.id}`}>Permissions</Link>
              </Button>
            )}
            {can('CRM.USER.EDIT') && (
              <Button variant="text" size="inline" onClick={() => setResetFor(row)}>
                Reset password
              </Button>
            )}
            {/* Deactivating yourself locks you out, so the control is not offered. */}
            {can('CRM.USER.TOGGLE_STATUS') && row.id !== currentUser?.id && (
              <Button
                variant={row.isActive ? 'destructive' : 'text'}
                size="inline"
                onClick={() => setToToggle(row)}
              >
                {row.isActive ? 'Deactivate' : 'Activate'}
              </Button>
            )}
            {can('CRM.USER.DELETE') && (
              <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                Delete
              </Button>
            )}
          </>
        )}
        empty={
          list.hasFilters ? (
            <EmptyState
              title="No users match those filters"
              description="Try a different username or role, or clear the filters."
              action={
                <Button variant="secondary" onClick={list.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No users yet"
              description="Add an account so your staff can sign in. Each one links to an employee record."
            />
          )
        }
      />

      <Modal
        open={isFormOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
        title={editing === null ? 'Add user' : `Edit ${editing.username}`}
        description={
          editing === null
            ? undefined
            : 'Changing the role signs this user out of any open session immediately.'
        }
      >
        <UserForm
          user={editing}
          options={options}
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

      <Modal
        open={resetFor !== null}
        onOpenChange={(open) => {
          if (!open) setResetFor(null);
        }}
        title={resetFor === null ? 'Reset password' : `Reset password for ${resetFor.username}`}
        description="This signs the user out of every open session."
      >
        <PasswordForm
          user={resetFor}
          onSaved={() => setResetFor(null)}
          onCancel={() => setResetFor(null)}
        />
      </Modal>

      <ConfirmDialog
        open={toToggle !== null}
        onOpenChange={(open) => {
          if (!open) setToToggle(null);
        }}
        title={toToggle?.isActive === true ? 'Deactivate this user?' : 'Activate this user?'}
        message={
          toToggle === null
            ? ''
            : toToggle.isActive
              ? `${toToggle.username} will be signed out immediately and will not be able to sign in again.`
              : `${toToggle.username} will be able to sign in again.`
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
        title="Delete this user?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.username} will be removed from the list for good. This is for a user added by mistake — if it has ever been used, deactivate it instead and nothing here will change.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function UserForm({
  user,
  options,
  onSaved,
  onCancel,
}: {
  user: UserDto | null;
  options: UserOptions;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const isEdit = user !== null;

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<UserFormInput>({
    // One schema for both modes; the API still requires a password on create.
    resolver: zodResolver(userFormSchema),
    defaultValues: {
      userType: 'EMPLOYEE',
      employeeId: '',
      agentId: '',
      customerId: '',
      vendorId: '',
      username: '',
      email: '',
      roleId: '',
      isSuperadmin: false,
      password: '',
    },
  });

  useEffect(() => {
    reset({
      userType: user?.userType ?? 'EMPLOYEE',
      employeeId: user?.employeeId ?? '',
      agentId: user?.agentId ?? '',
      customerId: user?.customerId ?? '',
      vendorId: user?.vendorId ?? '',
      username: user?.username ?? '',
      email: user?.email ?? '',
      roleId: user?.roleId ?? '',
      isSuperadmin: user?.isSuperadmin ?? false,
      password: '',
    });
    setFormError(null);
  }, [user, options, reset]);

  // Which link the form asks for, and which one is sent.
  const userType = watch('userType');

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    const body: Record<string, unknown> = {
      userType: values.userType,
      username: values.username,
      email: values.email,
      isSuperadmin: values.isSuperadmin,
    };
    // Only the link that applies is sent, so an account can never carry a stale
    // id from a type the operator changed their mind about.
    const type = values.userType ?? 'EMPLOYEE';
    const link: Record<UserType, { field: string; value: string | undefined }> = {
      EMPLOYEE: { field: 'employeeId', value: values.employeeId },
      AGENT: { field: 'agentId', value: values.agentId },
      CUSTOMER: { field: 'customerId', value: values.customerId },
      VENDOR: { field: 'vendorId', value: values.vendorId },
    };
    body[link[type].field] = link[type].value;
    if (values.roleId !== undefined && values.roleId !== '') body['roleId'] = values.roleId;
    if (!isEdit) body['password'] = values.password ?? '';

    try {
      await authorizedRequest(isEdit ? `${ENDPOINT}/${user.id}` : ENDPOINT, {
        method: isEdit ? 'PATCH' : 'POST',
        body,
      });
      toast.success(isEdit ? 'Saved' : 'User added');
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
      submitLabel={isEdit ? 'Save changes' : 'Add user'}
      error={formError ?? undefined}
    >
      {/*
        Who the login belongs to. The last three are outside companies: one
        login each, shared by all of that company's contacts. Only an agent has
        a screen to reach so far — the Agent Inquiry list.
      */}
      <Field id="userType" label="User type" required error={errors.userType?.message}>
        <Select id="userType" {...register('userType')}>
          <option value="EMPLOYEE">Employee — a member of your staff</option>
          <option value="AGENT">Agent — one shared login for an agent company</option>
          <option value="CUSTOMER">Customer — one shared login for a customer</option>
          <option value="VENDOR">Vendor — one shared login for a vendor</option>
        </Select>
      </Field>

      {userType === 'EMPLOYEE' ? (
        <Field id="employeeId" label="Employee" required error={errors.employeeId?.message}>
          <Select id="employeeId" {...register('employeeId')}>
            <option value="">Choose an employee</option>
            {options.employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <CompanyField
          userType={userType ?? 'AGENT'}
          options={options}
          register={register}
          errors={errors}
        />
      )}

      <Field
        id="username"
        label="Username"
        required
        hint="Stored in lower case; sign-in is not case-sensitive."
        error={errors.username?.message}
      >
        <Input id="username" numeric aria-invalid={errors.username !== undefined} {...register('username')} />
      </Field>

      <Field id="email" label="Email" required error={errors.email?.message}>
        <Input id="email" type="email" aria-invalid={errors.email !== undefined} {...register('email')} />
      </Field>

      <Field id="roleId" label="Role" hint="Leave blank to grant no role." error={errors.roleId?.message}>
        <Select id="roleId" {...register('roleId')}>
          <option value="">No role</option>
          {options.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>

      {!isEdit && (
        <Field
          id="password"
          label="Password"
          required
          hint="At least 12 characters. Length beats complexity rules."
          error={errors.password?.message}
        >
          <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
        </Field>
      )}

      <div className="flex items-center gap-2">
        <input
          id="isSuperadmin"
          type="checkbox"
          className="size-4 accent-harbour"
          {...register('isSuperadmin')}
        />
        <label htmlFor="isSuperadmin" className="text-body text-hull">
          Superadmin — bypasses every permission check
        </label>
      </div>
    </FormLayout>
  );
}

function PasswordForm({
  user,
  onSaved,
  onCancel,
}: {
  user: UserDto | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UserPasswordInput>({
    resolver: zodResolver(userPasswordSchema),
    defaultValues: { password: '' },
  });

  useEffect(() => {
    reset({ password: '' });
    setFormError(null);
  }, [user, reset]);

  const submit = handleSubmit(async (values) => {
    if (user === null) return;
    setFormError(null);
    try {
      await authorizedRequest(`${ENDPOINT}/${user.id}/password`, { method: 'POST', body: values });
      toast.success('Password reset');
      onSaved();
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
      submitLabel="Reset password"
      error={formError ?? undefined}
    >
      <Field
        id="newPassword"
        label="New password"
        required
        hint="At least 12 characters."
        error={errors.password?.message}
      >
        <Input id="newPassword" type="password" autoComplete="new-password" autoFocus {...register('password')} />
      </Field>
    </FormLayout>
  );
}

/**
 * The company an external login belongs to.
 *
 * One field for agent, customer and vendor: they differ only in which list they
 * read and what the label says, and three near-identical blocks is how the
 * fourth kind gets added slightly wrong.
 */
function CompanyField({
  userType,
  options,
  register,
  errors,
}: {
  userType: Exclude<UserType, 'EMPLOYEE'>;
  options: UserOptions;
  register: UseFormRegister<UserFormInput>;
  errors: FieldErrors<UserFormInput>;
}) {
  const spec = {
    AGENT: { id: 'agentId', list: options.agents },
    CUSTOMER: { id: 'customerId', list: options.customers },
    VENDOR: { id: 'vendorId', list: options.vendors },
  }[userType];
  const field = spec.id as 'agentId' | 'customerId' | 'vendorId';
  const label = USER_TYPE_LABEL[userType];
  const noun = label.toLowerCase();
  const article = USER_TYPE_ARTICLE[userType];

  return (
    <Field
      id={spec.id}
      label={label}
      required
      hint={`One login per ${noun}. All of their contacts sign in with it.`}
      error={errors[field]?.message}
    >
      <Select id={spec.id} {...register(field)}>
        <option value="">
          Choose {article} {noun}
        </option>
        {spec.list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
      {spec.list.length === 0 && (
        <p className="text-cell text-steel">Every active {noun} already has a login.</p>
      )}
    </Field>
  );
}
