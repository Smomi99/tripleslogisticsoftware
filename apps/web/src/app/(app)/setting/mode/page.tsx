'use client';

import { type TosDto, tosInputSchema } from '@ff/shared';

import type { DataTableColumn } from '@/components/ui/data-table';
import { LookupScreen } from '@/components/ui/lookup-screen';
import { SimpleLookupForm } from '@/components/ui/simple-lookup-form';

/**
 * Settings → Modes.
 *
 * The client's name for the screen; the values are the eleven Incoterms 2020
 * rules. It answers a different question from TOS: TOS says where the carrier
 * takes the cargo and hands it back (CY, CFS, door), while the Incoterm says
 * which party carries cost and risk over each leg.
 *
 * Same shape as TOS — a code and a name — so it reuses the same form and the
 * same lookup screen rather than repeating either.
 */
export default function ModePage() {
  const columns: DataTableColumn<TosDto>[] = [
    { id: 'name', header: 'Mode', sortable: true, cell: (r) => r.name },
  ];

  return (
    <LookupScreen<TosDto>
      endpoint="/api/tenant/setting/modes"
      feature="SETTING.MODE"
      title="Modes"
      description="Terms of shipment — where the carrier takes the cargo and where it hands it back."
      noun="mode"
      addLabel="+ Add mode"
      searchPlaceholder="Search modes"
      columns={columns}
      emptyDescription="Add a mode so an inquiry can record the agreed Incoterm."
      renderForm={({ row, onSubmit, onCancel }) => (
        <SimpleLookupForm
          row={row}
          schema={tosInputSchema}
          submitLabel="Add mode"
          nameLabel="Mode"
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      )}
    />
  );
}
