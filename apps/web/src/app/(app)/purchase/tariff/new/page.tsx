'use client';

import { TariffForm } from '@/components/purchase/tariff-form';

/** Purchase → Tariff → Add (docs/DESIGN-UPDATE-2026-10-04.md §5). */
export default function Page() {
  return <TariffForm tariff={null} />;
}
