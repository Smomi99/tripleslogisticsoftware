'use client';

import type { EmployeeDto } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { EmployeeForm } from '../../employee-form';

/** CRM → Employee → edit, plus the service contract upload (§6). */
export default function EditEmployeePage() {
  const params = useParams<{ id: string }>();
  const { authorizedRequest, can } = useSession();
  const [employee, setEmployee] = useState<EmployeeDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEmployee(await authorizedRequest<EmployeeDto>(`/api/tenant/crm/employees/${params.id}`));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load this employee.');
    }
  }, [authorizedRequest, params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          href={'/crm/employee' as Route}
          className="text-cell text-harbour underline-offset-2 hover:text-harbour-ink hover:underline"
        >
          ← Back to list
        </Link>
        <PageHeader
          title={employee === null ? 'Edit employee' : `Edit ${employee.name}`}
          description={employee === null ? undefined : `Code ${employee.code}`}
        />
      </div>

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
        {employee === null && error === null ? (
          <p className="text-body text-steel">Loading…</p>
        ) : employee !== null ? (
          <EmployeeForm employee={employee} />
        ) : null}
      </div>

      {employee !== null && can('CRM.EMPLOYEE.EDIT') && (
        <div className="max-w-3xl rounded-manifest border border-line bg-surface p-5 shadow-manifest">
          <ContractUpload employee={employee} onUploaded={load} />
        </div>
      )}
    </div>
  );
}

function ContractUpload({
  employee,
  onUploaded,
}: {
  employee: EmployeeDto;
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
      await authorizedUpload(`/api/tenant/crm/employees/${employee.id}/contract`, file);
      toast.success('Contract uploaded');
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
      <p className="label-manifest">Service contract</p>

      {employee.serviceContractFile === null ? (
        <p className="text-body text-steel">No contract uploaded yet.</p>
      ) : (
        <p className="text-body text-hull">
          <span className="font-mono" data-numeric="">
            {employee.serviceContractFileName}
          </span>{' '}
          <button
            type="button"
            onClick={() =>
              void authorizedDownload(
                `/api/tenant/crm/employees/${employee.id}/contract`,
                employee.serviceContractFileName ?? 'contract',
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

      <input
        ref={inputRef}
        type="file"
        id="contract"
        accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
        className="text-cell file:mr-2 file:rounded-manifest file:border file:border-line file:bg-surface file:px-2.5 file:py-1 file:text-body file:text-hull"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void upload(file);
        }}
        disabled={isUploading}
      />
      <p className="text-cell text-steel">
        PDF, Word, JPG or PNG, up to 10 MB. Uploading again replaces the current file.
      </p>
    </div>
  );
}
