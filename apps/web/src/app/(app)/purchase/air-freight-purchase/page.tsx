'use client';

import { RateEntryScreen } from '@/components/purchase/rate-entry-screen';

/**
 * Purchase → Air Freight Purchase — MODULE_PURCHASE_SALES §5.1, phase F.
 *
 * Same component again. §4 rule 9 restricts this screen to airports and
 * airlines, and that filtering happens on the server — the dropdowns here are
 * a convenience, not the constraint.
 */
export default function AirFreightPurchasePage() {
  return (
    <RateEntryScreen
      mode="AIR"
      feature="PURCHASE.AIR_FREIGHT_PURCHASE"
      title="Air Freight Purchase"
      description="Rates bought per KG against weight breaks. Tab across the row and press Enter to add."
    />
  );
}
