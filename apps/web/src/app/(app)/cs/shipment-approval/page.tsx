'use client';

import { WorklistScreen } from '@/components/cs/worklist-screen';

/** The direct Shipment Approval list (client decision, 2026-09-03). */
export default function Page() {
  return <WorklistScreen worklist="APPROVAL" />;
}
