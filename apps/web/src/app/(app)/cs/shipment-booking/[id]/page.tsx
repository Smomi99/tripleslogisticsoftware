'use client';

import { useParams } from 'next/navigation';

import { ShipmentBookingScreen } from '@/components/cs/shipment-booking-screen';

/** An existing booking (MODULE_BOOKING_CARGO.md §6.1). */
export default function Page() {
  const params = useParams<{ id: string }>();
  return <ShipmentBookingScreen shipmentId={params.id} />;
}
