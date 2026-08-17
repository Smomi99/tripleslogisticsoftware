'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type EmployeeDto, type EmployeeInput, employeeInputSchema } from '@ff/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Field, Input } from '@/components/ui/field';
import { CountrySelect } from '@/components/ui/country-select';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const ENDPOINT = '/api/tenant/crm/employees';

/** Employee form (CLAUDE.md §6). Nine fields, so §8 puts it on a full page. */
export function EmployeeForm({ employee }: { employee: EmployeeDto | null }) {
  const { authorizedRequest } = useSession();
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeInput>({
    resolver: zodResolver(employeeInputSchema),
    defaultValues: {
      name: '',
      country: '',
      department: '',
      designation: '',
      joiningDate: '',
      officeMobile: '',
      personalEmail: '',
      qualification: '',
    },
  });

  useEffect(() => {
    if (employee === null) return;
    reset({
      name: employee.name,
      country: employee.country,
      department: employee.department ?? '',
      designation: employee.designation ?? '',
      joiningDate: employee.joiningDate ?? '',
      officeMobile: employee.officeMobile ?? '',
      personalEmail: employee.personalEmail ?? '',
      qualification: employee.qualification ?? '',
    });
  }, [employee, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await authorizedRequest<EmployeeDto>(
        employee === null ? ENDPOINT : `${ENDPOINT}/${employee.id}`,
        { method: employee === null ? 'POST' : 'PATCH', body: values },
      );
      toast.success(employee === null ? 'Employee added' : 'Saved');
      router.push('/crm/employee');
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
      onCancel={() => router.push('/crm/employee')}
      isPending={isSubmitting}
      submitLabel={employee === null ? 'Add employee' : 'Save changes'}
      error={formError ?? undefined}
      columns={2}
    >
      <Field id="name" label="Employee name" required error={errors.name?.message} wide>
        <Input id="name" autoFocus aria-invalid={errors.name !== undefined} {...register('name')} />
      </Field>
      <Field id="country" label="Country" required error={errors.country?.message}>
        <CountrySelect id="country" aria-invalid={errors.country !== undefined} {...register('country')} />
      </Field>
      <Field id="joiningDate" label="Joining date" error={errors.joiningDate?.message}>
        <Input id="joiningDate" type="date" numeric {...register('joiningDate')} />
      </Field>
      <Field id="department" label="Department" error={errors.department?.message}>
        <Input id="department" {...register('department')} />
      </Field>
      <Field id="designation" label="Designation" error={errors.designation?.message}>
        <Input id="designation" {...register('designation')} />
      </Field>
      <Field id="officeMobile" label="Office mobile" error={errors.officeMobile?.message}>
        <Input id="officeMobile" numeric {...register('officeMobile')} />
      </Field>
      <Field id="personalEmail" label="Personal email" error={errors.personalEmail?.message}>
        <Input id="personalEmail" type="email" {...register('personalEmail')} />
      </Field>
      <Field id="qualification" label="Qualification" error={errors.qualification?.message} wide>
        <Input id="qualification" {...register('qualification')} />
      </Field>
    </FormLayout>
  );
}
