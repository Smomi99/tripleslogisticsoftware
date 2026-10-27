'use client';

import {
  SALES_LEAD_DOCUMENT_KIND_LABEL,
  SALES_LEAD_DOCUMENT_KINDS,
  type SalesLeadDocumentDto,
  type SalesLeadDocumentKind,
} from '@ff/shared';
import { use, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { ChildScreenHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Sales → Sales Lead-FOB → one lead's documents (docs/SALES_LEAD_FOB.md §6):
 * the RFQ, the shipment forecast, the buyer's nomination, earlier quotations.
 *
 * A §8 child screen. Removing a document soft-deletes it (§4 rule 3).
 */
interface DocumentsPayload {
  lead: { id: string; code: string; name: string };
  documents: SalesLeadDocumentDto[];
}

export default function LeadDocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authorizedList, authorizedUpload, authorizedDownload, authorizedRequest, can } = useSession();
  const canEdit = can('SALES.NEW_SALES_LEAD.EDIT');

  const [data, setData] = useState<DocumentsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<SalesLeadDocumentKind>('RFQ');
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setUploading] = useState(false);
  const [toRemove, setToRemove] = useState<SalesLeadDocumentDto | null>(null);
  const [isRemoving, setRemoving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await authorizedList<DocumentsPayload>(`/api/tenant/sales/leads/${id}/documents`);
      setData(response.data);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : 'Could not load the documents.');
    }
  }, [authorizedList, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(): Promise<void> {
    if (file === null) {
      setUploadError('Choose a file to upload.');
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const next = await authorizedUpload<DocumentsPayload>(`/api/tenant/sales/leads/${id}/documents`, file, {
        kind,
      });
      setData(next);
      setFile(null);
      if (fileInput.current !== null) fileInput.current.value = '';
      toast.success('Document uploaded');
    } catch (error) {
      setUploadError(error instanceof ApiError ? error.message : 'Could not upload the file. Try again.');
    } finally {
      setUploading(false);
    }
  }

  async function remove(): Promise<void> {
    if (toRemove === null) return;
    setRemoving(true);
    try {
      const next = await authorizedRequest<DocumentsPayload>(
        `/api/tenant/sales/leads/${id}/documents/${toRemove.id}`,
        { method: 'DELETE' },
      );
      setData(next);
      setToRemove(null);
      toast.success('Document removed');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove the document.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ChildScreenHeader
        parentLabel={data === null ? 'Sales lead' : `Sales lead ${data.lead.code}`}
        parentName={data?.lead.name ?? 'Loading…'}
        title="Documents — RFQs, shipment forecasts, buyer nominations, previous quotations"
        backHref="/sales/sales-lead"
      />

      {loadError !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
      )}

      {canEdit && (
        <section
          aria-label="Upload a document"
          className="rounded-manifest border border-line bg-surface p-3 shadow-manifest"
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-52">
              <Field id="kind" label="Document" required>
                <Select id="kind" value={kind} onChange={(e) => setKind(e.target.value as SalesLeadDocumentKind)}>
                  {SALES_LEAD_DOCUMENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {SALES_LEAD_DOCUMENT_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="min-w-64 flex-1">
              <Field id="file" label="File" required hint="PDF, Word, JPG or PNG, up to 10 MB.">
                <Input
                  id="file"
                  ref={fileInput}
                  type="file"
                  accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                  className="py-1"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </Field>
            </div>
            <Button type="button" onClick={() => void upload()} disabled={isUploading}>
              {isUploading ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
          {uploadError !== null && (
            <p role="alert" className="mt-2 text-cell text-alert">
              {uploadError}
            </p>
          )}
        </section>
      )}

      {data !== null && data.documents.length === 0 ? (
        <EmptyState
          title="No documents yet"
          description="Attach the buyer's RFQ, a shipment forecast or a nomination letter so the whole team quotes from the same paper."
        />
      ) : (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper text-left">
                <th className="label-manifest px-2.5 py-2">Document</th>
                <th className="label-manifest px-2.5 py-2">File</th>
                <th className="label-manifest px-2.5 py-2">Uploaded</th>
                <th className="label-manifest px-2.5 py-2">By</th>
                <th className="label-manifest px-2.5 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {(data?.documents ?? []).map((doc) => (
                <tr key={doc.id} className="border-b border-line last:border-0 hover:bg-row-hover">
                  <td className="px-2.5 py-2 text-cell text-hull">{SALES_LEAD_DOCUMENT_KIND_LABEL[doc.kind]}</td>
                  <td className="px-2.5 py-2 text-cell text-hull">{doc.fileName}</td>
                  <td className="px-2.5 py-2 font-mono text-cell tabular-nums text-steel">
                    {doc.uploadedAt.slice(0, 10)}
                  </td>
                  <td className="px-2.5 py-2 text-cell text-steel">{doc.uploadedBy ?? '—'}</td>
                  <td className="px-2.5 py-2">
                    <div className="flex gap-3">
                      <Button
                        variant="text"
                        size="inline"
                        onClick={() =>
                          void authorizedDownload(
                            `/api/tenant/sales/leads/${id}/documents/${doc.id}`,
                            doc.fileName,
                          ).catch(() => toast.error('Could not download that file.'))
                        }
                      >
                        Download
                      </Button>
                      {canEdit && (
                        <Button variant="destructive" size="inline" onClick={() => setToRemove(doc)}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {data === null && loadError === null && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-body text-steel">
                    Loading…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => {
          if (!open) setToRemove(null);
        }}
        title="Remove this document?"
        message={toRemove === null ? '' : `${toRemove.fileName} will no longer be listed on this lead.`}
        confirmLabel="Remove"
        destructive
        isPending={isRemoving}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
