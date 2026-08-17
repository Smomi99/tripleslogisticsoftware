'use client';

import { PriceAddonScreen } from '@/components/purchase/price-addon-screen';

/** Purchase → Price Add-on (Air) — MODULE_PURCHASE_SALES §5.2, phase F. */
export default function PriceAddonAirPage() {
  return (
    <PriceAddonScreen
      mode="AIR"
      title="Price Add-on (Air)"
      description="Set the margin on bought air rates. Sell price is computed by the database, never typed."
    />
  );
}
