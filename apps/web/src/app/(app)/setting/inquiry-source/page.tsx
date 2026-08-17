'use client';

import { type InquirySourceDto, inquirySourceInputSchema } from '@ff/shared';

import type { DataTableColumn } from '@/components/ui/data-table';
import { LookupScreen } from '@/components/ui/lookup-screen';
import { SimpleLookupForm } from '@/components/ui/simple-lookup-form';

/**
 * Settings → Inquiry Source (MODULE_PURCHASE_SALES §3.1).
 *
 * Where an inquiry came from — a referral, a call, an exhibition. It is what
 * turns "we won 40 of 120 inquiries" into "the exhibition paid for itself".
 */
export default function InquirySourcePage() {
  const columns: DataTableColumn<InquirySourceDto>[] = [
    { id: 'name', header: 'Inquiry Source', sortable: true, cell: (r) => r.name },
  ];

  return (
    <LookupScreen<InquirySourceDto>
      endpoint="/api/tenant/setting/inquiry-sources"
      feature="SETTING.INQUIRY_SOURCE"
      title="Inquiry Source"
      description="Where inquiries come from, so the win rate can be read per channel."
      noun="inquiry source"
      addLabel="+ Add inquiry source"
      searchPlaceholder="Search inquiry sources"
      columns={columns}
      emptyDescription="Add an inquiry source so every inquiry can record where it came from."
      renderForm={({ row, onSubmit, onCancel }) => (
        <SimpleLookupForm
          row={row}
          schema={inquirySourceInputSchema}
          submitLabel="Add inquiry source"
          nameLabel="Source name"
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      )}
    />
  );
}
