'use client';

import {
  BL_DRAFT_STATUS_LABEL,
  type BlDraftDto,
  type BlDraftPrefillDto,
  type BlDraftStatus,
  type BlTemplateDto,
  SHIPMENT_STATUS_LABEL,
  type ShipmentStatus,
} from '@ff/shared';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { BlDraftForm, type BlDraftFormValues, bodyFrom, valuesFrom } from './bl-draft-form';
import { Button } from '@/components/ui/button';
import { DataTable, type DataTableColumn } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/form-layout';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The customer's own screen — docs/MODULE_DOCUMENTATION.md §2.4, §7.
 *
 * Their shipments, and the BL draft on one of them. §2.5 does not put BL Draft
 * on the Customer menu, so it opens from a shipment row the way every other
 * child screen in the product does (CLAUDE.md §8), with a Back link.
 *
 * Everything this screen can reach is behind `authenticateCustomer` and
 * `withCustomer` on the server. The screen enforces nothing on its own.
 */

interface PortalShipmentRow {
  id: string;
  code: string;
  shipmentType: string;
  status: ShipmentStatus;
  exporterName: string | null;
  importerName: string | null;
  polName: string;
  podName: string;
  etd: string | null;
  eta: string | null;
  blDraftStatus: BlDraftStatus | null;
}

const TONE: Record<BlDraftStatus, 'active' | 'pending' | 'inactive' | 'overdue'> = {
  DRAFT: 'pending',
  SUBMITTED: 'pending',
  APPROVED: 'active',
  SENT: 'active',
  CANCELLED: 'overdue',
};

export function PortalShipmentScreen() {
  const { authorizedRequest, authorizedObjectUrl, can } = useSession();

  const [rows, setRows] = useState<PortalShipmentRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<BlDraftDto | null>(null);
  const [values, setValues] = useState<BlDraftFormValues | null>(null);
  const [prefill, setPrefill] = useState<BlDraftPrefillDto | null>(null);
  const [templates] = useState<BlTemplateDto[]>([]);
  const [modes, setModes] = useState<{ id: string; name: string }[]>([]);
  const [isPending, setPending] = useState(false);
  const [listPending, setListPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // B34 is starred on the client's sheet, so the form cannot be completed
  // without this list.
  useEffect(() => {
    void authorizedRequest<{ modes: { id: string; name: string }[] }>(
      '/api/tenant/portal/lookups',
    )
      .then((r) => setModes(r.modes))
      .catch(() => setModes([]));
  }, [authorizedRequest]);

  useEffect(() => {
    void authorizedRequest<PortalShipmentRow[]>('/api/tenant/portal/shipments')
      .then(setRows)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not load your shipments.'),
      )
      .finally(() => setListPending(false));
  }, [authorizedRequest]);

  const openDraft = useCallback(
    async (shipmentId: string) => {
      setError(null);
      setOpenId(shipmentId);
      setDraft(null);
      setValues(null);
      setPrefill(null);
      try {
        const row = await authorizedRequest<BlDraftDto | null>(
          `/api/tenant/portal/shipments/${shipmentId}/bl-draft`,
        );
        if (row !== null) {
          setDraft(row);
          setValues(valuesFrom(row));
          return;
        }
        const fresh = await authorizedRequest<BlDraftPrefillDto>(
          `/api/tenant/portal/shipments/${shipmentId}/bl-draft/prefill`,
        );
        setPrefill(fresh);
        setValues(valuesFrom(fresh));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Could not open the BL draft.');
      }
    },
    [authorizedRequest],
  );

  async function run(fn: () => Promise<void>, done: string): Promise<void> {
    setError(null);
    setPending(true);
    try {
      await fn();
      toast.success(done);
      if (openId !== null) await openDraft(openId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<PortalShipmentRow>[] = [
    { id: 'type', header: 'Type', cell: (r) => (r.shipmentType === 'AIR' ? 'Air' : 'Sea') },
    { id: 'pol', header: 'POL / AOL', cell: (r) => r.polName },
    { id: 'pod', header: 'POD / AOD', cell: (r) => r.podName },
    { id: 'etd', header: 'ETD', numeric: true, cell: (r) => r.etd?.slice(0, 10) ?? '—' },
    { id: 'eta', header: 'ETA', numeric: true, cell: (r) => r.eta?.slice(0, 10) ?? '—' },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => <Status tone="active">{SHIPMENT_STATUS_LABEL[r.status]}</Status>,
    },
    {
      id: 'bl',
      header: 'BL draft',
      cell: (r) =>
        r.blDraftStatus === null ? (
          <span className="text-steel">—</span>
        ) : (
          <Status tone={TONE[r.blDraftStatus]}>{BL_DRAFT_STATUS_LABEL[r.blDraftStatus]}</Status>
        ),
    },
  ];

  if (openId !== null) {
    const editable = draft === null || draft.status === 'DRAFT';
    const booking = rows.find((r) => r.id === openId);

    return (
      <div className="flex flex-col gap-4">
        {/* §8: every child screen has a Back link. Required, not optional. */}
        <button
          type="button"
          className="self-start text-body text-harbour hover:underline"
          onClick={() => {
            setOpenId(null);
            setDraft(null);
            setValues(null);
          }}
        >
          ← Back to my shipments
        </button>

        <PageHeader
          title={`BL draft — ${booking?.code ?? ''}`}
          description="Fill in the bill of lading and submit it to your forwarder."
        />

        {error !== null && (
          <p
            role="alert"
            className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
          >
            {error}
          </p>
        )}

        {draft === null && prefill?.blockedReason != null && (
          <EmptyState title="Not ready yet" description={prefill.blockedReason} />
        )}

        {values !== null && (draft !== null || prefill?.blockedReason == null) && (
          <>
            {draft !== null && draft.status !== 'DRAFT' && (
              <p className="text-body text-steel">
                Submitted to your forwarder. They will come back to you if anything needs
                changing.
              </p>
            )}

            <BlDraftForm
              values={values}
              setValues={setValues}
              disabled={!editable || isPending}
              isCustomerView
              modes={modes}
              agents={[]}
              containers={draft?.containers ?? prefill?.containers ?? []}
              templates={templates}
              onUseTemplate={() => undefined}
              onPullParties={() => {
                if (prefill === null) return;
                setValues({
                  ...values,
                  shipperText: prefill.shipperText,
                  consigneeText: prefill.consigneeText,
                  notifyText: prefill.notifyText,
                });
              }}
            />

            <div className="flex flex-wrap gap-2">
              {draft === null && can('CUSTOMER.BL_DRAFT.CREATE') && (
                <Button
                  disabled={isPending}
                  onClick={() => {
                    void run(
                      () =>
                        authorizedRequest(
                          `/api/tenant/portal/shipments/${openId}/bl-draft`,
                          { method: 'POST', body: bodyFrom(values) },
                        ),
                      'Draft saved',
                    );
                  }}
                >
                  Draft
                </Button>
              )}
              {draft !== null && editable && can('CUSTOMER.BL_DRAFT.EDIT') && (
                <Button
                  disabled={isPending}
                  onClick={() => {
                    void run(
                      () =>
                        authorizedRequest(`/api/tenant/portal/bl-drafts/${draft.id}`, {
                          method: 'PATCH',
                          body: bodyFrom(values),
                        }),
                      'Saved',
                    );
                  }}
                >
                  Save changes
                </Button>
              )}
              {draft !== null && can('CUSTOMER.BL_DRAFT.EXPORT_PDF') && (
                <Button
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => {
                    void (async () => {
                      try {
                        const url = await authorizedObjectUrl(
                          `/api/tenant/portal/bl-drafts/${draft.id}/pdf`,
                        );
                        window.open(url, '_blank', 'noopener');
                      } catch (e) {
                        setError(e instanceof ApiError ? e.message : 'Could not open the draft.');
                      }
                    })();
                  }}
                >
                  Print
                </Button>
              )}
              {draft !== null && editable && can('CUSTOMER.BL_DRAFT.SUBMIT') && (
                <Button
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => {
                    void run(
                      () =>
                        authorizedRequest(
                          `/api/tenant/portal/bl-drafts/${draft.id}/submit`,
                          { method: 'POST', body: {} },
                        ),
                      'Submitted to your forwarder',
                    );
                  }}
                >
                  Save &amp; Submit
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="My shipments"
        description="Your bookings with this forwarder, and the bill of lading on each."
      />

      {error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {error}
        </p>
      )}

      <DataTable
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          getCode={(r) => r.code}
          total={rows.length}
          page={1}
          limit={rows.length === 0 ? 25 : rows.length}
          sortOrder="desc"
          onSortChange={() => undefined}
          onPageChange={() => undefined}
          isPending={listPending}
          empty={
            <EmptyState
              title="No shipments yet"
              description="Bookings your forwarder raises for you will appear here."
            />
          }
          actions={(row) =>
            can('CUSTOMER.BL_DRAFT.VIEW') ? (
              <button
                type="button"
                className="text-body text-harbour hover:underline"
                onClick={() => void openDraft(row.id)}
              >
                {row.blDraftStatus === null ? 'Make BL draft' : 'Open BL draft'}
              </button>
            ) : null
          }
        />
    </div>
  );
}
