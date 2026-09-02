'use client';

import { ShipmentBookingList } from '@/components/cs/shipment-booking-list';

/** MODULE_BOOKING_CARGO.md §3 — one of the two menu items, one component. */
export default function Page() {
  return <ShipmentBookingList mode="SEA" />;
}
