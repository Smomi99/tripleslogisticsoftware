'use client';

import { WorklistScreen } from '@/components/cs/worklist-screen';

/** Shipment Advise - Air — docs/MODULE_DOCUMENTATION.md §2. One screen, the mode already answered. */
export default function Page() {
  return <WorklistScreen worklist="SHIPMENT_ADVISE" fixedMode="AIR" />;
}
