'use client';

import { RateEntryScreen } from '@/components/purchase/rate-entry-screen';

/**
 * Purchase → Sea Freight (FCL) — MODULE_PURCHASE_SALES §5.1.
 *
 * The reference implementation for all nine purchase screens. Sea LCL and Air
 * are this same component with a different mode, which is why everything
 * mode-specific lives in the data rather than here.
 */
export default function SeaFreightFclPage() {
  return (
    <RateEntryScreen
      mode="SEA_FCL"
      feature="PURCHASE.SEA_FREIGHT_FCL"
      title="Sea Freight (FCL)"
      description="Rates bought per container. Tab across the row and press Enter to add."
    />
  );
}
