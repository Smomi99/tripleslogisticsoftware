'use client';

import Link from 'next/link';

import { PageHeader } from '@/components/ui/form-layout';
import { useSession } from '@/lib/session';

export default function HomePage() {
  const { user, can } = useSession();

  // An outside company sees none of this. The panel below reports role and
  // permission counts, which mean nothing to them, and the description names a
  // build phase, which is our business and not theirs.
  if (user?.isExternal === true) {
    const isAgent = user.agentId !== null;
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          title={`Welcome, ${user.name ?? user.username}`}
          description={
            isAgent
              ? 'Rate requests sent to you appear under Agent Inquiry.'
              : 'Your account is ready. Nothing has been shared with you yet.'
          }
        />
        {isAgent && can('AGENT.INQUIRY.VIEW') && (
          <div className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
            <Link
              href="/agent/inquiry"
              className="text-body text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
            >
              Open Agent Inquiry →
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`Welcome, ${user?.name ?? user?.username ?? ''}`}
        description="Phase 4 shell. Business modules land from Phase 5 onward."
      />

      <div className="rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <p className="label-manifest mb-3">Your access</p>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-body sm:grid-cols-2">
          <div className="flex justify-between border-b border-line py-1.5">
            <dt className="text-steel">Role</dt>
            <dd className="text-hull">
              {user?.isSuperadmin === true ? 'Superadmin' : (user?.roleName ?? 'None')}
            </dd>
          </div>
          <div className="flex justify-between border-b border-line py-1.5">
            <dt className="text-steel">Permissions</dt>
            <dd className="font-mono text-hull" data-numeric="">
              {user?.isSuperadmin === true ? 'all' : (user?.permissions.length ?? 0)}
            </dd>
          </div>
        </dl>

        {can('SETTING.SEA_AIR_PORT.VIEW') && (
          <Link
            href="/setting/port"
            className="mt-4 inline-block text-body text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
          >
            Open Sea-Air Port →
          </Link>
        )}
      </div>
    </div>
  );
}
