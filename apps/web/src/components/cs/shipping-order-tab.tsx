'use client';

import {
  SHIPPING_ORDER_STATUS_LABEL,
  type ShipmentDto,
  type ShippingOrderDto,
} from '@ff/shared';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * Shipping Order — §6.6, on the shipment file.
 *
 * §5.4 rule 2 is why there is no edit here: issuing is one-way, and a mistake
 * is cancelled and reissued with a new number. §5.4 rule 3 is why there is a
 * SKIP: an inbound shipment needs no document at all, and saying so is a
 * decision the file records rather than an absence it infers.
 */

export function ShippingOrderTab({
  booking,
  onChanged,
}: {
  booking: ShipmentDto;
  onChanged: () => void;
}) {
  const { authorizedRequest, authorizedObjectUrl, can } = useSession();

  const [order, setOrder] = useState<ShippingOrderDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [warehouseCfs, setWarehouseCfs] = useState('');
  const [isPending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipOpen, setSkipOpen] = useState(false);
  const [skipReason, setSkipReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const load = useCallback(async () => {
    try {
      const row = await authorizedRequest<ShippingOrderDto | null>(
        `/api/tenant/cs/bookings/${booking.id}/shipping-order`,
      );
      setOrder(row);
      setWarehouseCfs(row?.warehouseCfs ?? booking.warehouseCfs ?? '');
    } catch {
      setOrder(null);
    } finally {
      setLoaded(true);
    }
  }, [authorizedRequest, booking.id, booking.warehouseCfs]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    path: string,
    body: Record<string, unknown>,
    done: string,
  ): Promise<void> {
    setError(null);
    setPending(true);
    try {
      await authorizedRequest(`/api/tenant/cs/bookings/${booking.id}/shipping-order${path}`, {
        method: 'POST',
        body,
      });
      toast.success(done);
      setSkipOpen(false);
      setCancelOpen(false);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not do that.');
    } finally {
      setPending(false);
    }
  }

  async function print(): Promise<void> {
    try {
      const url = await authorizedObjectUrl(
        `/api/tenant/cs/bookings/${booking.id}/shipping-order/pdf`,
      );
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not open the document.');
    }
  }

  if (!loaded) return <p className="text-body text-steel">Loading…</p>;

  const isInbound = booking.movementType === 'INBOUND';
  const readyToIssue = booking.status === 'APPROVED_FOR_SHIPMENT';

  // ------------------------------------------------------------ issued / skipped
  if (order !== null) {
    return (
      <div className="flex flex-col gap-4">
        <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-section text-hull">
              {order.status === 'SKIPPED' ? 'No shipping order needed' : 'Shipping order'}
            </h2>
            <div className="flex items-center gap-3">
              <Status tone={order.status === 'SKIPPED' ? 'inactive' : 'active'}>
                {SHIPPING_ORDER_STATUS_LABEL[order.status]}
              </Status>
              <span className="font-mono tabular-nums text-body text-hull">{order.code}</span>
            </div>
          </div>

          {order.status === 'SKIPPED' ? (
            <p className="text-body text-hull">
              <span className="font-medium">Skipped.</span> {order.skipReason}
            </p>
          ) : (
            <dl className="grid gap-4 md:grid-cols-4">
              {[
                ['Issued', order.issueDate],
                ['Issued by', order.issuedByName],
                [
                  booking.shipmentType === 'AIR' ? 'First flight' : 'First vessel',
                  booking.shipmentType === 'AIR' ? order.firstFlightNo : order.firstVesselName,
                ],
                ['Warehouse / CFS', order.warehouseCfs],
                ['Cut off', order.cutOff === null ? null : new Date(order.cutOff).toLocaleString()],
                ['ETD', order.etd === null ? null : new Date(order.etd).toLocaleString()],
                ['ETA', order.eta === null ? null : new Date(order.eta).toLocaleString()],
                ['POs on it', order.poNumbers.join(', ')],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="label-manifest">{label}</dt>
                  <dd className="text-body text-hull">
                    {value === null || value === '' ? '—' : value}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        {error !== null && (
          <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {order.status === 'ISSUED' && can('CUSTOMER_SERVICE.SHIPPING_ORDER.EXPORT_PDF') && (
            <Button onClick={() => void print()}>Print shipping order</Button>
          )}
          {can('CUSTOMER_SERVICE.SHIPPING_ORDER.CANCEL') && (
            <Button
              variant="destructive"
              onClick={() => {
                setCancelReason('');
                setCancelOpen(true);
              }}
            >
              Cancel {order.status === 'SKIPPED' ? 'the skip' : 'this order'}
            </Button>
          )}
        </div>

        {/*
          §5.4 rule 2: cancelling is the only way back, and the number is never
          reused — so the reason is worth asking for properly.
        */}
        <Modal open={cancelOpen} onOpenChange={setCancelOpen} title={`Cancel ${order.code}?`}>
          <div className="flex flex-col gap-4">
            <p className="text-body text-steel">
              {order.code} stops being the instruction the warehouse works to. Its number is never
              reused — a corrected order gets a new one.
            </p>
            <Field id="cancelReason" label="Reason" required>
              <Input
                id="cancelReason"
                autoFocus
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Wrong vessel on the order"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCancelOpen(false)}>
                Keep it
              </Button>
              <Button
                variant="destructive"
                disabled={isPending || cancelReason.trim() === ''}
                onClick={() => void act('/cancel', { reason: cancelReason.trim() }, 'Cancelled')}
              >
                {isPending ? 'Cancelling…' : 'Cancel it'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    );
  }

  // ------------------------------------------------------------- not yet issued
  return (
    <div className="flex flex-col gap-4">
      {!readyToIssue ? (
        <EmptyState
          title="No shipping order yet"
          description="A shipping order is issued once the customer has approved the schedule."
        />
      ) : (
        <section className="rounded-manifest border border-line bg-surface p-4 shadow-manifest">
          <h2 className="mb-3 text-section text-hull">Issue the shipping order</h2>
          <p className="mb-4 text-body text-steel">
            It carries the approved POs only, and the schedule the customer accepted. Issuing is
            one-way: a mistake is cancelled and reissued under a new number.
          </p>
          <div className="max-w-md">
            <Field id="warehouseCfs" label="Warehouse / CFS">
              <Input
                id="warehouseCfs"
                value={warehouseCfs}
                onChange={(e) => setWarehouseCfs(e.target.value)}
                placeholder="Where the cargo is delivered"
              />
            </Field>
          </div>
        </section>
      )}

      {error !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {readyToIssue && can('CUSTOMER_SERVICE.SHIPPING_ORDER.ISSUE') && (
          <Button
            disabled={isPending}
            onClick={() =>
              void act(
                '',
                { warehouseCfs: warehouseCfs.trim() === '' ? null : warehouseCfs.trim() },
                'Shipping order issued',
              )
            }
          >
            {isPending ? 'Issuing…' : 'ISSUE SHIPPING ORDER'}
          </Button>
        )}
        {/* §6.6: "Also show SKIP S/O when the movement is Inbound." */}
        {isInbound && can('CUSTOMER_SERVICE.SHIPPING_ORDER.SKIP') && (
          <Button
            variant="secondary"
            disabled={isPending}
            onClick={() => {
              setSkipReason('');
              setSkipOpen(true);
            }}
          >
            SKIP S/O
          </Button>
        )}
      </div>

      <Modal open={skipOpen} onOpenChange={setSkipOpen} title="Skip the shipping order?">
        <div className="flex flex-col gap-4">
          <p className="text-body text-steel">
            An inbound shipment needs no shipping order (§5.4). The booking moves on without one,
            and cargo can still be received against it. Say why, so the file explains itself later.
          </p>
          <Field id="skipReason" label="Reason" required>
            <Input
              id="skipReason"
              autoFocus
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value)}
              placeholder="Inbound shipment — no S/O required"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSkipOpen(false)}>
              Back
            </Button>
            <Button
              disabled={isPending || skipReason.trim() === ''}
              onClick={() => void act('/skip', { reason: skipReason.trim() }, 'Shipping order skipped')}
            >
              {isPending ? 'Saving…' : 'Skip it'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
