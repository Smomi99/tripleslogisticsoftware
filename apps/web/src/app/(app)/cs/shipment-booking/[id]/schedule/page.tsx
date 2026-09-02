'use client';

import { useParams } from 'next/navigation';

import { ScheduleScreen } from '@/components/cs/schedule-screen';

/** Vessel / Flight Booking (MODULE_BOOKING_CARGO.md §6.4). */
export default function Page() {
  const params = useParams<{ id: string }>();
  return <ScheduleScreen shipmentId={params.id} />;
}
