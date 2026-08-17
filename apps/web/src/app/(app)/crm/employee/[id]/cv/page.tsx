'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type EmployeeCvDto, type EmployeeCvInput, employeeCvInputSchema } from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Field, Input } from '@/components/ui/field';
import { ChildScreenHeader, FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * CRM → Employee → CV (CLAUDE.md §6 employee_cv, 1:1).
 *
 * Unlike every child screen so far this is a single record, not a list — so it
 * is a form that creates or replaces, with no table and no Add button.
 */
export default function EmployeeCvPage() {
  const params = useParams<{ id: string }>();
  const employeeId = params.id;
  const { authorizedRequest, can } = useSession();

  const [employeeName, setEmployeeName] = useState('…');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isReady, setReady] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeCvInput>({ resolver: zodResolver(employeeCvInputSchema) });

  useEffect(() => {
    void (async () => {
      try {
        const [summary, cv] = await Promise.all([
          authorizedRequest<{ name: string }>(`/api/tenant/crm/employees/${employeeId}/summary`),
          authorizedRequest<EmployeeCvDto>(`/api/tenant/crm/employees/${employeeId}/cv`),
        ]);
        setEmployeeName(summary.name);
        reset({
          presentAddress: cv.presentAddress ?? '',
          permanentAddress: cv.permanentAddress ?? '',
          qualification: cv.qualification ?? '',
          fatherName: cv.fatherName ?? '',
          motherName: cv.motherName ?? '',
          siblingName: cv.siblingName ?? '',
          siblingMobile: cv.siblingMobile ?? '',
          dateOfBirth: cv.dateOfBirth ?? '',
          reference1: cv.reference1 ?? '',
          reference2: cv.reference2 ?? '',
        });
        setReady(true);
      } catch (error) {
        setLoadError(error instanceof ApiError ? error.message : 'Could not load this CV.');
      }
    })();
  }, [authorizedRequest, employeeId, reset]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await authorizedRequest(`/api/tenant/crm/employees/${employeeId}/cv`, {
        method: 'PUT',
        body: values,
      });
      toast.success('Saved');
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <ChildScreenHeader
        parentLabel="Employee"
        parentName={employeeName}
        title="CV"
        backHref={'/crm/employee' as Route}
      />

      {loadError !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
      )}

      <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        {!isReady && loadError === null ? (
          <p className="text-body text-steel">Loading…</p>
        ) : isReady ? (
          <fieldset disabled={!can('CRM.EMPLOYEE.EDIT')} className="contents">
            <FormLayout
              onSubmit={submit}
              isPending={isSubmitting}
              submitLabel="Save changes"
              error={formError ?? undefined}
              columns={2}
            >
              <Field id="dateOfBirth" label="Date of birth" error={errors.dateOfBirth?.message}>
                <Input id="dateOfBirth" type="date" numeric {...register('dateOfBirth')} />
              </Field>
              <Field id="qualification" label="Qualification" error={errors.qualification?.message}>
                <Input id="qualification" {...register('qualification')} />
              </Field>
              <Field id="presentAddress" label="Present address" error={errors.presentAddress?.message} wide>
                <Input id="presentAddress" {...register('presentAddress')} />
              </Field>
              <Field id="permanentAddress" label="Permanent address" error={errors.permanentAddress?.message} wide>
                <Input id="permanentAddress" {...register('permanentAddress')} />
              </Field>
              <Field id="fatherName" label="Father's name" error={errors.fatherName?.message}>
                <Input id="fatherName" {...register('fatherName')} />
              </Field>
              <Field id="motherName" label="Mother's name" error={errors.motherName?.message}>
                <Input id="motherName" {...register('motherName')} />
              </Field>
              <Field id="siblingName" label="Sibling's name" error={errors.siblingName?.message}>
                <Input id="siblingName" {...register('siblingName')} />
              </Field>
              <Field id="siblingMobile" label="Sibling's mobile" error={errors.siblingMobile?.message}>
                <Input id="siblingMobile" numeric {...register('siblingMobile')} />
              </Field>
              <Field id="reference1" label="Reference 1" error={errors.reference1?.message} wide>
                <Input id="reference1" {...register('reference1')} />
              </Field>
              <Field id="reference2" label="Reference 2" error={errors.reference2?.message} wide>
                <Input id="reference2" {...register('reference2')} />
              </Field>
            </FormLayout>
          </fieldset>
        ) : null}
      </div>
    </div>
  );
}
