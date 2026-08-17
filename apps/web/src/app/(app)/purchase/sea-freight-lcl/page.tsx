'use client';

import { RateEntryScreen } from '@/components/purchase/rate-entry-screen';

/**
 * Purchase → Sea Freight (LCL) — MODULE_PURCHASE_SALES §5.1, phase F.
 *
 * The same component as Sea FCL. The tier columns become CBM bands rather than
 * container sizes because rate_tier says so, not because this file says so.
 */
export default function SeaFreightLclPage() {
  return (
    <RateEntryScreen
      mode="SEA_LCL"
      feature="PURCHASE.SEA_FREIGHT_LCL"
      title="Sea Freight (LCL)"
      description="Rates bought per CBM. Tab across the row and press Enter to add."
    />
  );
}
