'use client';

import type { Route } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/ui/form-layout';

import { AgentForm } from '../agent-form';

/** CRM → Agent → new. Full page: eight fields, three of them multi-selects. */
export default function NewAgentPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href={'/crm/agent' as Route}
          className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
        >
          ← Back to list
        </Link>
        <PageHeader
          title="Add agent"
          description="The agreement file can be uploaded once the agent is saved."
        />
      </div>

      <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        <AgentForm agent={null} />
      </div>
    </div>
  );
}
