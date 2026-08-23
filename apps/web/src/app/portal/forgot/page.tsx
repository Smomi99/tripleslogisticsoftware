'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type RequestResetInput, requestResetSchema } from '@ff/shared';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { PortalDoor, PortalNotice } from '@/components/shell/portal-frame';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/lib/api-client';
import { usePortalSession } from '@/lib/portal-session';

/**
 * Asking for a reset link (§2.4).
 *
 * Self-service, because an external user has no admin of yours to phone.
 */
export default function ForgotPasswordPage() {
  const { tenantSlug } = usePortalSession();
  const [sent, setSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RequestResetInput>({
    resolver: zodResolver(requestResetSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await apiRequest('/api/portal/auth/request-reset', {
        method: 'POST',
        body: values,
        tenantSlug,
      });
      setSent(true);
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    }
  });

  if (sent) {
    return (
      <PortalDoor title="Check your email">
        {/*
          Says "if we have an account" rather than "we have sent you an email".
          The API answers identically either way, and a screen that promised
          delivery would give away what the API deliberately does not: who this
          forwarder works with.
        */}
        <PortalNotice tone="done">
          If we have an account for that address, a link is on its way. It works for one hour.
        </PortalNotice>
        <Button asChild variant="secondary" className="mt-4 w-full">
          <Link href="/portal/login">Back to sign in</Link>
        </Button>
      </PortalDoor>
    );
  }

  return (
    <PortalDoor
      title="Reset your password"
      lead="We will email you a link. It works once, and for one hour."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field id="email" label="Email address" required error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            aria-invalid={errors.email !== undefined}
            {...register('email')}
          />
        </Field>

        {formError !== null && (
          <p role="alert" className="text-cell text-alert">
            {formError}
          </p>
        )}

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? 'Sending…' : 'Send the link'}
        </Button>
        <Button asChild variant="text" size="inline" className="mx-auto">
          <Link href="/portal/login">Back to sign in</Link>
        </Button>
      </form>
    </PortalDoor>
  );
}
