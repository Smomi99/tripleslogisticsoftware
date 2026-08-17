'use client';

import { PriceListScreen } from '@/components/purchase/price-list-screen';

/**
 * Purchase → Price List (Sea FCL) — MODULE_PURCHASE_SALES §5.3.
 *
 * Published, currently-valid rates by default. Buy price and margin appear
 * only for a user the server sent them to.
 */
export default function PriceListFclPage() {
  return (
    <PriceListScreen
      mode="SEA_FCL"
      feature="PURCHASE.PRICE_LIST_SEA_FCL"
      title="Price List — Sea FCL"
      description="Published rates you can quote today. Filter by lane, then download for a customer."
    />
  );
}
