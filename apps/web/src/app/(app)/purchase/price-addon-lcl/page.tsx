'use client';

import { PriceAddonScreen } from '@/components/purchase/price-addon-screen';

/** Purchase → Price Add-on (LCL-Sea) — MODULE_PURCHASE_SALES §5.2, phase F. */
export default function PriceAddonLclPage() {
  return (
    <PriceAddonScreen
      mode="SEA_LCL"
      title="Price Add-on (LCL-Sea)"
      description="Set the margin on bought LCL rates. Sell price is computed by the database, never typed."
    />
  );
}
