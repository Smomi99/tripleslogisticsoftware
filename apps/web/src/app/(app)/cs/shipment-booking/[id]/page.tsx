'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import { ShipmentFileScreen } from '@/components/cs/shipment-file-screen';

/**
 * The shipment file (MODULE_BOOKING_CARGO.md §6.3).
 *
 * The tab lives in `?tab=`, which useSearchParams reads — so the page needs a
 * Suspense boundary around it.
 */
function File() {
  const params = useParams<{ id: string }>();
  return <ShipmentFileScreen shipmentId={params.id} />;
}

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <File />
    </Suspense>
  );
}
