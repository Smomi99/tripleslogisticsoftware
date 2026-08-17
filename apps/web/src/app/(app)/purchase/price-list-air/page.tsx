'use client';

import { PriceListScreen } from '@/components/purchase/price-list-screen';

/** Purchase → Price List (Air) — MODULE_PURCHASE_SALES §5.3, phase F. */
export default function PriceListAirPage() {
  return (
    <PriceListScreen
      mode="AIR"
      feature="PURCHASE.PRICE_LIST_AIR"
      title="Price List — Air"
      description="Published air rates you can quote today. Filter by lane, then download for a customer."
    />
  );
}
