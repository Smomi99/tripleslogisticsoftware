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
    <div className="flex min-h-screen items-center justify-center bg-paper p-5">
      <div className="w-full max-w-sm rounded-manifest border border-line bg-surface p-6 shadow-manifest">
        <div className="mb-5">
          <span className="font-mono text-cell tracking-wider text-steel">FF·ERP</span>
          <h1 className="mt-2 text-page-title text-hull">Sign in</h1>
          <p className="mt-1 text-body text-steel">
            Workspace{' '}
            <span className="font-mono text-hull" data-numeric="">
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
  );
}
