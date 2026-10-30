'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type LoginInput, loginSchema } from '@ff/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/** Sign-in. Uses the same Zod schema the API validates with (CLAUDE.md §2). */
export default function LoginPage() {
  const { signIn, status, tenantSlug } = useSession();
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  useEffect(() => {
    if (status === 'authenticated') router.replace('/');
  }, [status, router]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signIn(values.username, values.password);
    } catch (error) {
      if (error instanceof ApiError) {
        // Map the API's field errors onto the form (§9 envelope).
        if (error.fields !== undefined) {
          for (const [field, messages] of Object.entries(error.fields)) {
            if (field === 'username' || field === 'password') {
              setError(field, { message: messages[0] ?? 'Invalid value.' });
            }
          }
        }
        setFormError(error.fields === undefined ? error.message : null);
        return;
      }
      setFormError('Could not reach the server. Check your connection and try again.');
    }
  });

  return (
    <div className="flex min-h-dvh bg-paper">
      {/*
        The brand panel, from lg up: the module colours as a stack of
        containers — the same marks the sidebar uses for each module.
      */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-hull p-10 text-white lg:flex">
        <span className="font-mono text-cell font-medium tracking-wider">FF·ERP</span>
        <div aria-hidden="true" className="grid w-fit grid-cols-4 gap-2">
          {[
            'purchase',
            'sales',
            'customer-service',
            'operation',
            'documentation',
            'accounts',
            'crm',
            'report',
          ].map((slug) => (
            <span key={slug} data-module={slug} className="h-10 w-16 rounded-manifest bg-module" />
          ))}
        </div>
        <div className="max-w-md">
          <p className="text-[28px] font-semibold leading-9">
            Rates, bookings, documents and accounts in one place.
          </p>
          <p className="mt-3 text-body text-white/70">
            Every module has its own colour, so you always know where you are.
          </p>
        </div>
      </div>

      <div className="flex w-full items-center justify-center p-4 sm:p-8 lg:w-[30rem] lg:shrink-0">
        <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 shadow-raised sm:p-8">
          <div className="mb-6">
            <span aria-hidden="true" className="mb-4 grid w-fit grid-cols-2 gap-1">
              <span data-module="purchase" className="size-3.5 rounded-[4px] bg-module" />
              <span data-module="customer-service" className="size-3.5 rounded-[4px] bg-module" />
              <span data-module="operation" className="size-3.5 rounded-[4px] bg-module" />
              <span data-module="accounts" className="size-3.5 rounded-[4px] bg-module" />
            </span>
            <h1 className="text-page-title text-hull">Sign in</h1>
            <p className="mt-1 text-body text-steel">
              Workspace{' '}
              <span className="rounded-full bg-module-soft px-2 py-0.5 font-mono text-harbour" data-numeric="">
                {tenantSlug}
              </span>
            </p>
          </div>

          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
            {formError !== null && (
              <p
                role="alert"
                className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
              >
                {formError}
              </p>
            )}

            <Field id="username" label="Username" required error={errors.username?.message}>
              <Input
                id="username"
                autoComplete="username"
                autoFocus
                aria-invalid={errors.username !== undefined}
                {...register('username')}
              />
            </Field>

            <Field id="password" label="Password" required error={errors.password?.message}>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                aria-invalid={errors.password !== undefined}
                {...register('password')}
              />
            </Field>

            <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
