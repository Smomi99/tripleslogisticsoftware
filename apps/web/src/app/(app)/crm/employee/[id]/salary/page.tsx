'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type EmployeeSalaryDto,
  type EmployeeSalaryInput,
  employeeSalaryInputSchema,
  SALARY_COMPONENTS,
} from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';

import { Field, Input } from '@/components/ui/field';
import { ChildScreenHeader, FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * CRM → Employee → Salary (CLAUDE.md §6 employee_salary, 1:1).
 *
 * gross_salary is a Postgres GENERATED ALWAYS column — §6 calls it "auto sum,
 * never stored by hand". So it is displayed, never submitted: the shared schema
 * has no field for it, and the database would refuse the write regardless.
 * The figure below the form is a live preview; the authoritative value comes
 * back from the server after saving.
 */
export default function EmployeeSalaryPage() {
  const params = useParams<{ id: string }>();
  const employeeId = params.id;
  const { authorizedRequest, can } = useSession();

  const [employeeName, setEmployeeName] = useState('…');
  const [savedGross, setSavedGross] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isReady, setReady] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = useForm<EmployeeSalaryInput>({ resolver: zodResolver(employeeSalaryInputSchema) });

  const watched = useWatch({ control });

  useEffect(() => {
    void (async () => {
      try {
        const [summary, salary] = await Promise.all([
          authorizedRequest<{ name: string }>(`/api/tenant/crm/employees/${employeeId}/summary`),
          authorizedRequest<EmployeeSalaryDto>(`/api/tenant/crm/employees/${employeeId}/salary`),
        ]);
        setEmployeeName(summary.name);
        setSavedGross(salary.grossSalary);
        reset({
          basicSalary: salary.basicSalary,
          homeRent: salary.homeRent,
          medical: salary.medical,
          mobileBill: salary.mobileBill,
          insurance: salary.insurance,
          incentive: salary.incentive,
        });
        setReady(true);
      } catch (error) {
        setLoadError(error instanceof ApiError ? error.message : 'Could not load this salary.');
      }
    })();
  }, [authorizedRequest, employeeId, reset]);

  const preview = SALARY_COMPONENTS.reduce((total, component) => {
    const raw = watched[component.key];
    const value = Number(raw ?? 0);
    return total + (Number.isFinite(value) ? value : 0);
  }, 0);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const saved = await authorizedRequest<EmployeeSalaryDto>(
        `/api/tenant/crm/employees/${employeeId}/salary`,
        { method: 'PUT', body: values },
      );
      setSavedGross(saved.grossSalary);
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
        title="Salary"
        backHref={'/crm/employee' as Route}
      />

      {loadError !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
      )}

      <div className="max-w-2xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        {!isReady && loadError === null ? (
          <p className="text-body text-steel">Loading…</p>
        ) : isReady ? (
          <>
            <fieldset disabled={!can('CRM.EMPLOYEE.EDIT')} className="contents">
              <FormLayout
                onSubmit={submit}
                isPending={isSubmitting}
                submitLabel="Save changes"
                error={formError ?? undefined}
                columns={2}
              >
                {SALARY_COMPONENTS.map((component) => (
                  <Field
                    key={component.key}
                    id={component.key}
                    label={component.label}
                    error={errors[component.key]?.message}
                  >
                    <Input
                      id={component.key}
                      numeric
                      inputMode="decimal"
                      className="text-right"
                      {...register(component.key)}
                    />
                  </Field>
                ))}
              </FormLayout>
            </fieldset>

            <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
              <div>
                <p className="label-manifest">Gross salary</p>
                <p className="text-cell text-steel">
                  Computed by the database from the six components — it cannot be typed.
                </p>
              </div>
              <p className="font-mono text-page-title text-hull" data-numeric="">
                {savedGross ?? '0.0000'}
              </p>
            </div>

            {savedGross !== null && Math.abs(preview - Number(savedGross)) > 0.00005 && (
              <p className="mt-2 text-right text-cell text-signal">
                Unsaved changes — will become{' '}
                <span className="font-mono" data-numeric="">
                  {preview.toFixed(4)}
                </span>
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
