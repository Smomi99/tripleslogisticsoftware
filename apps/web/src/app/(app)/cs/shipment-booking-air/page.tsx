'use client';

import { ShipmentBookingList } from '@/components/cs/shipment-booking-list';

/** MODULE_BOOKING_CARGO.md §3 — the other menu item, the same component. */
export default function Page() {
  return <ShipmentBookingList mode="AIR" />;
}
