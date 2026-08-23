'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type AcceptInviteInput, acceptInviteSchema } from '@ff/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';

import { PortalDoor, PortalNotice } from '@/components/shell/portal-frame';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/lib/api-client';
import { usePortalSession } from '@/lib/portal-session';

/**
 * Setting a first password (§2.4).
 *
 * The forwarder never sees what is typed here. That is the whole reason this
 * screen exists rather than an admin field that sets a password for the agent —
 * a password your staff typed is a password your staff knows.
 */
function AcceptInviteForm() {
  const { tenantSlug } = usePortalSession();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AcceptInviteInput>({
    resolver: zodResolver(acceptInviteSchema),
    defaultValues: { token, password: '' },
    values: { token, password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await apiRequest('/api/portal/auth/accept-invite', {
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
      <PortalDoor title="Invitation link">
        <PortalNotice tone="error">
          This link is incomplete. Open the invitation from your email again, or ask your
          forwarder to send a new one.
        </PortalNotice>
      </PortalDoor>
    );
  }

  if (done) {
    return (
      <PortalDoor title="You are set up">
        <PortalNotice tone="done">Your password is saved.</PortalNotice>
        <Button asChild className="mt-4 w-full">
          <Link href="/portal/login">Sign in</Link>
        </Button>
      </PortalDoor>
    );
  }

  return (
    <PortalDoor
      title="Choose a password"
      lead="This is yours alone. Nobody at the forwarder can see it."
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field
          id="password"
          label="New password"
          required
          error={errors.password?.message}
          hint="At least 12 characters. Length beats punctuation."
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

export default function AcceptInvitePage() {
  // useSearchParams needs a Suspense boundary to keep the route static.
  return (
    <Suspense fallback={<PortalDoor title="Invitation">Loading…</PortalDoor>}>
      <AcceptInviteForm />
    </Suspense>
  );
}
