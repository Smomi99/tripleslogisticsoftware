'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { type PortalLoginInput, portalLoginSchema } from '@ff/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';

import { PortalDoor } from '@/components/shell/portal-frame';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { usePortalSession } from '@/lib/portal-session';

/** Agent sign-in. A different door from the staff one, by design (§2.2). */
export default function PortalLoginPage() {
  const { signIn, status } = usePortalSession();
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PortalLoginInput>({
    resolver: zodResolver(portalLoginSchema),
    defaultValues: { username: '', password: '' },
  });

  useEffect(() => {
    if (status === 'authenticated') router.replace('/portal');
  }, [status, router]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await signIn(values.username, values.password);
    } catch (error) {
      if (error instanceof ApiError) {
        // One message for every failure. Which of "no such account", "wrong
        // password" and "your access was withdrawn" it was is not something a
        // caller at a public door is told.
        setFormError(error.message);
        return;
      }
      setFormError('Could not reach the server. Check your connection and try again.');
    }
  });

  return (
    <PortalDoor
      title="Sign in"
      lead="Quote the inquiries your forwarder has sent you."
      footer={
        <Link href="/portal/forgot" className="text-harbour hover:underline">
          Forgotten your password?
        </Link>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Field id="username" label="Email address" required error={errors.username?.message}>
          <Input
            id="username"
            type="email"
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

        {formError !== null && (
          <p role="alert" className="text-cell text-alert">
            {formError}
          </p>
        )}

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </PortalDoor>
  );
}
