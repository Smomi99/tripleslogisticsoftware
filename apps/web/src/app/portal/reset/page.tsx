'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type CompleteResetInput, completeResetSchema } from '@ff/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';

import { PortalDoor, PortalNotice } from '@/components/shell/portal-frame';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/lib/api-client';
import { usePortalSession } from '@/lib/portal-session';

/** Choosing a new password from a reset link (§2.4). */
function ResetForm() {
  const { tenantSlug } = usePortalSession();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CompleteResetInput>({
    resolver: zodResolver(completeResetSchema),
    defaultValues: { token, password: '' },
    values: { token, password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await apiRequest('/api/portal/auth/complete-reset', {
        method: 'POST',
        body: values,
        tenantSlug,
      });
      setDone(true);
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  });

  if (token === '') {
    return (
      <PortalDoor title="Reset link">
        <PortalNotice tone="error">
          This link is incomplete. Ask for a new one and open it straight from your email.
        </PortalNotice>
        <Button asChild variant="secondary" className="mt-4 w-full">
          <Link href="/portal/forgot">Ask for a new link</Link>
        </Button>
      </PortalDoor>
    );
  }

  if (done) {
    return (
      <PortalDoor title="Password changed">
        {/*
          Worth saying out loud: completing a reset bumps token_version, so any
          session someone else had open is already dead. That is the reassurance
          the person resetting actually wants.
        */}
        <PortalNotice tone="done">
          Your new password is saved, and anyone signed in as you has been signed out.
        </PortalNotice>
        <Button asChild className="mt-4 w-full">
          <Link href="/portal/login">Sign in</Link>
        </Button>
      </PortalDoor>
    );
  }

  return (
    <PortalDoor title="Choose a new password">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field
          id="password"
          label="New password"
          required
          error={errors.password?.message}
          hint="At least 12 characters."
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            aria-invalid={errors.password !== undefined}
            {...register('password')}
          />
        </Field>

        {formError !== null && (
          <p role="alert" className="text-cell text-alert">
            {formError}
          </p>
        )}

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? 'Saving…' : 'Save password'}
        </Button>
      </form>
    </PortalDoor>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<PortalDoor title="Reset">Loading…</PortalDoor>}>
      <ResetForm />
    </Suspense>
  );
}
