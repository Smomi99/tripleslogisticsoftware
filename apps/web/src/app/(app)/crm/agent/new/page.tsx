'use client';

import { ArrowLeft } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';

import { backLinkClasses, PageHeader } from '@/components/ui/form-layout';

import { AgentForm } from '../agent-form';

/** CRM → Agent → new. Full page: eight fields, three of them multi-selects. */
export default function NewAgentPage() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <Link href={'/crm/agent' as Route} className={backLinkClasses}>
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to list
        </Link>
        <PageHeader
          title="Add agent"
          description="The agreement file can be uploaded once the agent is saved."
        />
      </div>

      <div className="max-w-3xl rounded-card border border-line bg-surface p-4 shadow-manifest sm:p-5">
        <AgentForm agent={null} />
      </div>
    </div>
  );
}
