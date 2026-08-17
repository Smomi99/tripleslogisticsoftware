'use client';

import { PriceListScreen } from '@/components/purchase/price-list-screen';

/** Purchase → Price List (Sea LCL) — MODULE_PURCHASE_SALES §5.3, phase F. */
export default function PriceListLclPage() {
  return (
    <PriceListScreen
      mode="SEA_LCL"
      feature="PURCHASE.PRICE_LIST_SEA_LCL"
      title="Price List — Sea LCL"
      description="Published LCL rates you can quote today. Filter by lane, then download for a customer."
    />
  );
}
