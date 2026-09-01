'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { ShipmentBookingScreen } from '@/components/cs/shipment-booking-screen';

/**
 * A new booking, raised against a quotation (MODULE_BOOKING_CARGO.md §6.1).
 *
 * The quotation is the entry point, not a field on this screen: §1's flow is
 * quotation -> booking, and §4.1 makes quotation_id NOT NULL. Reached from the
 * Booking action on the quotation list.
 */
function NewBooking() {
  const params = useSearchParams();
  const quotationId = params.get('quotationId');

  if (quotationId === null) {
    return (
      <p className="text-body text-steel">
        Open a booking from the Booking action on a quotation — a booking is always against one.
      </p>
    );
  }
  return <ShipmentBookingScreen quotationId={quotationId} />;
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <NewBooking />
    </Suspense>
  );
}
