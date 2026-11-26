'use client';

import {
  billTerms,
  type BlDraftDto,
  type BlDraftPrefillDto,
  type BlTemplateDto,
  type PortalBillRow,
  PORTAL_TAB_LABEL,
  PORTAL_TAB_PERMISSION,
  PORTAL_TABS,
  type PortalTab,
} from '@ff/shared';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { BlDraftForm, type BlDraftFormValues, bodyFrom, valuesFrom } from './bl-draft-form';
import {
  AdviseTab,
  ApprovalTab,
  BillTab,
  BookingTab,
  CargoReceiptTab,
  InquiryTab,
  InvoiceTab,
  QuotationTab,
  ShippingOrderTab,
} from './portal-tabs';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { backLinkClasses, PageHeader } from '@/components/ui/form-layout';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The customer's own screen — docs/MODULE_DOCUMENTATION.md §2.4, §7, and the
 * tabs the owner asked for on 2026-11-26: Inquiry · Quotation · Booking ·
 * Awaiting approval · Shipping Order · Cargo Receipt · Shipment Advise · BL ·
 * Invoice, each the customer's own records of that kind (portal-tabs.tsx).
 *
 * A tab shows only with its own permission, so a forwarder can give a
 * customer's clerk the bookings without the invoices. The BL draft opens from
 * a row of the BL tab as a child screen (CLAUDE.md §8), with a Back link.
 *
 * Everything this screen can reach is behind `authenticateCustomer` and
 * `withCustomer` on the server. The screen enforces nothing on its own.
 */

/** The bill whose draft is open: which booking it hangs off, and what to call it. */
interface OpenBill {
  shipmentId: string;
  blNo: string;
  shipmentType: PortalBillRow['shipmentType'];
}

export function PortalShipmentScreen() {
  const { authorizedRequest, authorizedObjectUrl, can } = useSession();

  const visibleTabs = PORTAL_TABS.filter((t) => can(PORTAL_TAB_PERMISSION[t]));
  const [tab, setTab] = useState<PortalTab>('BOOKING');
  // A tab loads when first opened and stays mounted, so coming back is instant.
  const [visited, setVisited] = useState<ReadonlySet<PortalTab>>(new Set(['BOOKING']));
  const current = visibleTabs.includes(tab) ? tab : (visibleTabs[0] ?? 'BOOKING');

  const [openBill, setOpenBill] = useState<OpenBill | null>(null);
  const openId = openBill?.shipmentId ?? null;
  const [draft, setDraft] = useState<BlDraftDto | null>(null);
  const [values, setValues] = useState<BlDraftFormValues | null>(null);
  const [prefill, setPrefill] = useState<BlDraftPrefillDto | null>(null);
  const [templates] = useState<BlTemplateDto[]>([]);
  const [modes, setModes] = useState<{ id: string; name: string }[]>([]);
  const [isPending, setPending] = useState(false);
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

  const openDraft = useCallback(
    async (shipmentId: string) => {
      setError(null);
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

  if (openBill !== null && openId !== null) {
    const editable = draft === null || draft.status === 'DRAFT';
    // §14: an air booking's bill is a House Air Waybill.
    const isAir = (draft?.shipmentType ?? prefill?.shipmentType ?? openBill.shipmentType) === 'AIR';
    const terms = billTerms(isAir ? 'AIR' : 'SEA');

    return (
      <div className="flex flex-col gap-4">
        {/* §8: every child screen has a Back link. Required, not optional. */}
        <button
          type="button"
          className={backLinkClasses}
          onClick={() => {
            setOpenBill(null);
            setDraft(null);
            setValues(null);
            setError(null);
          }}
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          Back to my shipments
        </button>

        <PageHeader
          title={`${terms.draft} — ${openBill.blNo}`}
          description={`Fill in the ${terms.document} and submit it to your forwarder.`}
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

        {/* CR-005: bookings that share an EFR share one bill of lading. */}
        {(draft?.bookingNos ?? prefill?.bookingNos ?? []).length > 1 && (
          <p className="text-body text-steel">
            One {terms.document} for your bookings{' '}
            <span className="font-mono tabular-nums text-hull">
              {(draft?.bookingNos ?? prefill?.bookingNos ?? []).join(', ')}
            </span>
            . They were received under the same EFR, so they travel on one {terms.short}.
          </p>
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
              isAir={isAir}
              airRoute={draft?.airRoute ?? prefill?.airRoute ?? []}
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

            {/* On a phone the buttons run full width, like a FormLayout's. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
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

  function choose(next: PortalTab): void {
    setTab(next);
    setVisited((seen) => (seen.has(next) ? seen : new Set([...seen, next])));
  }

  function panel(id: PortalTab) {
    switch (id) {
      case 'INQUIRY':
        return <InquiryTab />;
      case 'QUOTATION':
        return <QuotationTab />;
      case 'BOOKING':
        return <BookingTab />;
      case 'APPROVAL':
        return <ApprovalTab />;
      case 'SHIPPING_ORDER':
        return <ShippingOrderTab />;
      case 'CARGO_RECEIPT':
        return <CargoReceiptTab />;
      case 'ADVISE':
        return <AdviseTab />;
      case 'BL':
        return (
          <BillTab
            onOpenDraft={(row) => {
              setOpenBill({ shipmentId: row.shipmentId, blNo: row.blNo, shipmentType: row.shipmentType });
              void openDraft(row.shipmentId);
            }}
          />
        );
      case 'INVOICE':
        return <InvoiceTab />;
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="My shipments"
        description="Your inquiries, quotations, bookings and their documents with this forwarder."
      />

      {visibleTabs.length > 1 && (
        <Tabs
          label="My shipments"
          idBase="portal"
          value={current}
          onChange={choose}
          tabs={visibleTabs.map((t) => ({ id: t, label: PORTAL_TAB_LABEL[t] }))}
        />
      )}

      {visibleTabs.map((t) =>
        // Mounted on first visit only: nine lists are nine requests, and
        // most visits look at one or two of them.
        t === current || visited.has(t) ? (
          <TabPanel key={t} idBase="portal" id={t} selected={t === current}>
            {panel(t)}
          </TabPanel>
        ) : null,
      )}
    </div>
  );
}
