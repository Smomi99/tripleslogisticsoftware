'use client';

import { useState } from 'react';

import { PortalNotice } from '@/components/shell/portal-frame';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api-client';
import { usePortalSession } from '@/lib/portal-session';

/**
 * The agent's own account.
 *
 * Small on purpose. An agent cannot change their email — it is also their
 * username, and it came from the contact record the forwarder holds — so the
 * only action here is a password reset, which goes through the same emailed
 * link as a forgotten one. There is no "change password" form that takes the
 * old password: the reset flow already exists, already expires, and already
 * ends every other open session.
 */
export default function PortalAccountPage() {
  const { user, tenantSlug } = usePortalSession();
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');

  if (user === null) return null;

  const requestReset = async () => {
    setState('sending');
    try {
      await apiRequest('/api/portal/auth/request-reset', {
        method: 'POST',
        body: { email: user.email },
        tenantSlug,
      });
    } finally {
      setState('sent');
    }
  };

  return (
    <div className="flex max-w-xl flex-col gap-5">
      <h1 className="text-page-title text-hull">Account</h1>

      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <dl className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <dt className="label-manifest">Company</dt>
            <dd className="text-body text-hull">{user.agentName}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="label-manifest">Email address</dt>
            <dd className="text-body text-hull">{user.email}</dd>
          </div>
        </dl>
        <p className="mt-4 border-t border-line pt-4 text-cell text-steel">
          To change your company details or add another person from your team, ask your
          forwarder — those records are theirs to keep.
        </p>
      </section>

      <section className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <h2 className="text-section text-hull">Password</h2>
        <p className="mt-1 text-body text-steel">
          We will email you a link. It works once, and for one hour.
        </p>
        {state === 'sent' ? (
          <PortalNotice tone="done">
            Check your inbox. Using the link signs out anyone else who is signed in as you.
          </PortalNotice>
        ) : (
          <Button
            className="mt-4"
            disabled={state === 'sending'}
            onClick={() => void requestReset()}
          >
            {state === 'sending' ? 'Sending…' : 'Email me a reset link'}
          </Button>
        )}
      </section>
    </div>
  );
}
