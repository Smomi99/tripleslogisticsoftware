'use client';

import type { AgentDto } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { AgentForm } from '../../agent-form';

/** CRM → Agent → edit, plus the agreement upload (§6 agreement_file). */
export default function EditAgentPage() {
  const params = useParams<{ id: string }>();
  const { authorizedRequest, can } = useSession();
  const [agent, setAgent] = useState<AgentDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAgent(await authorizedRequest<AgentDto>(`/api/tenant/crm/agents/${params.id}`));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this agent.');
    }
  }, [authorizedRequest, params.id]);

  useEffect(() => {
    void load();
  }, [load]);

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
          title={agent === null ? 'Edit agent' : `Edit ${agent.name}`}
          description={agent === null ? undefined : `Code ${agent.code}`}
        />
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        {agent === null && error === null ? (
          <p className="text-body text-steel">Loading…</p>
        ) : agent !== null ? (
          <AgentForm agent={agent} />
        ) : null}
      </div>

      {agent !== null && can('CRM.AGENT.EDIT') && (
        <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
          <AgreementUpload agent={agent} onUploaded={load} />
        </div>
      )}
    </div>
  );
}

function AgreementUpload({
  agent,
  onUploaded,
}: {
  agent: AgentDto;
  onUploaded: () => Promise<void>;
}) {
  const { authorizedUpload, authorizedDownload } = useSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function upload(file: File): Promise<void> {
    setUploading(true);
    setUploadError(null);
    try {
      // Goes through the session so the bearer token and the refresh-and-retry
      // apply — the same reason every other call does.
      await authorizedUpload(`/api/tenant/crm/agents/${agent.id}/agreement`, file);
      toast.success('Agreement uploaded');
      await onUploaded();
    } catch (error) {
      setUploadError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setUploading(false);
      if (inputRef.current !== null) inputRef.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="label-manifest">Agreement</p>

      {agent.agreementFile === null ? (
        <p className="text-body text-steel">No agreement uploaded yet.</p>
      ) : (
        <p className="text-body text-hull">
          <span className="font-mono" data-numeric="">
            {agent.agreementFileName}
          </span>{' '}
          {/*
            Not a plain href: the download route is bearer-authenticated, and a
            browser navigation would not carry the token. Fetching it and
            handing the blob to a temporary link keeps the guard intact.
          */}
          <button
            type="button"
            onClick={() =>
              void authorizedDownload(
                `/api/tenant/crm/agents/${agent.id}/agreement`,
                agent.agreementFileName ?? 'agreement',
              ).catch(() => setUploadError('Could not download that file.'))
            }
            className="ml-2 text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
          >
            Download
          </button>
        </p>
      )}

      {uploadError !== null && (
        <p role="alert" className="text-cell text-alert">
          {uploadError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          id="agreement"
          accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
          className="text-cell file:mr-2 file:rounded-manifest file:border file:border-line file:bg-surface file:px-2.5 file:py-1 file:text-body file:text-hull"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void upload(file);
          }}
          disabled={isUploading}
        />
        {isUploading && <span className="text-cell text-steel">Uploading…</span>}
      </div>
      <p className="text-cell text-steel">
        PDF, Word, JPG or PNG, up to 10 MB. Uploading again replaces the current file.
      </p>
      <Button
        variant="secondary"
        size="compact"
        className="self-start"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
      >
        Choose file
      </Button>
    </div>
  );
}
