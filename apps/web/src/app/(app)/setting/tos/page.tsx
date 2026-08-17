'use client';

import { type TosDto, tosInputSchema } from '@ff/shared';

import type { DataTableColumn } from '@/components/ui/data-table';
import { LookupScreen } from '@/components/ui/lookup-screen';
import { SimpleLookupForm } from '@/components/ui/simple-lookup-form';

/**
 * Settings → TOS (MODULE_PURCHASE_SALES §3.1).
 *
 * Terms of shipment — CY/CY, CFS/CY and the rest. It says where the carrier's
 * responsibility starts and ends, so the same lane at CY/CY and door/door are
 * two different rates.
 */
export default function TosPage() {
  const columns: DataTableColumn<TosDto>[] = [
    { id: 'name', header: 'Terms of Shipment', sortable: true, cell: (r) => r.name },
  ];

  return (
    <LookupScreen<TosDto>
      endpoint="/api/tenant/setting/tos"
      feature="SETTING.TOS"
      title="TOS"
      description="Terms of shipment — where the carrier takes the cargo and where it hands it back."
      noun="term"
      addLabel="+ Add term"
      searchPlaceholder="Search terms of shipment"
      columns={columns}
      emptyDescription="Add a term of shipment so rates can record what the price covers."
      renderForm={({ row, onSubmit, onCancel }) => (
        <SimpleLookupForm
          row={row}
          schema={tosInputSchema}
          submitLabel="Add term"
          nameLabel="Terms of shipment"
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      )}
    />
  );
}
