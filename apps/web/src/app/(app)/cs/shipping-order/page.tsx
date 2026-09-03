'use client';

import { WorklistScreen } from '@/components/cs/worklist-screen';

/** The direct Shipping Order list (client decision, 2026-09-03). */
export default function Page() {
  return <WorklistScreen worklist="SHIPPING_ORDER" />;
}
