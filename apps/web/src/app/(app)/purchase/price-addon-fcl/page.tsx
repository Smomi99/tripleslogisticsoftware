'use client';

import { PriceAddonScreen } from '@/components/purchase/price-addon-screen';

/**
 * Purchase → Price Add-on (FCL-Sea) — MODULE_PURCHASE_SALES §5.2.
 *
 * Gated behind PURCHASE.RATE.MANAGE_PROFIT on the server as well as by this
 * screen's own permission: a screen whose only purpose is setting margin is
 * meaningless to someone who may not set one.
 */
export default function PriceAddonFclPage() {
  return (
    <PriceAddonScreen
      mode="SEA_FCL"
      title="Price Add-on (FCL-Sea)"
      description="Set the margin on bought rates. Sell price is computed by the database, never typed."
    />
  );
}
