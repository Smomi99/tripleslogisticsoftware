'use client';

import { WorklistScreen } from '@/components/cs/worklist-screen';

/** The direct Cargo Receipt list (client decision, 2026-09-03). */
export default function Page() {
  return <WorklistScreen worklist="CARGO_RECEIPT" />;
}
