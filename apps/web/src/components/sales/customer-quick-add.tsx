'use client';

import {
  BUSINESS_AREAS,
  BUSINESS_AREA_LABEL,
  CUSTOMER_TYPES,
  CUSTOMER_TYPE_LABEL,
  type CustomerDto,
  type LookupOption,
} from '@ff/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CountrySelect } from '@/components/ui/country-select';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * §5.4: "The `+ +` beside Customer is a quick-add modal creating a customer
 * inline without leaving the form — gated by CRM.CUSTOMER.CREATE, and it must
 * return to the inquiry with the new customer selected."
 *
 * Only the fields the customer table requires. Everything optional is left to
 * the full CRM screen: a salesman on a call needs a name and a sector, not a
 * monthly TEU forecast.
 */
export function CustomerQuickAdd({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (customer: CustomerDto) => void;
}) {
  const { authorizedRequest, authorizedList } = useSession();

  const [sectors, setSectors] = useState<LookupOption[]>([]);
  const [name, setName] = useState('');
  const [country, setCountry] = useState('Bangladesh');
  const [customerType, setCustomerType] = useState<string>('EXPORTER');
  const [businessArea, setBusinessArea] = useState<string>('OUTBOUND');
  const [industrySectorId, setIndustrySectorId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await authorizedList<{ id: string; name: string }[]>(
          '/api/tenant/setting/commodity-categories?limit=100&isActive=true',
        );
        if (!cancelled) {
          setSectors(response.data.map((s) => ({ id: s.id, name: s.name })));
        }
      } catch {
        // The field stays empty and the form reports the missing choice.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedList, open]);

  async function save(): Promise<void> {
    setError(null);
    if (name.trim() === '') {
      setError('Enter the customer name.');
      return;
    }
    if (industrySectorId === '') {
      setError('Choose a commodity category.');
      return;
    }

    setSaving(true);
    try {
      const created = await authorizedRequest<CustomerDto>('/api/tenant/crm/customers', {
        method: 'POST',
        body: {
          name: name.trim(),
          country,
          customerType,
          businessArea,
          industrySectorId,
          exSeaVolumeTeuMonth: '',
          exAirVolumeKgMonth: '',
          imSeaVolumeTeuMonth: '',
          imAirVolumeKgMonth: '',
        },
      });
      toast.success('Customer added');
      // §5.4: hand it straight back so the inquiry continues with it selected.
      onCreated(created);
      setName('');
      setIndustrySectorId('');
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not add the customer. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add a customer"
      description="Just enough to raise the inquiry — the rest can be filled in under CRM later."
    >
      <div className="flex flex-col gap-4">
        <Field id="qa-name" label="Customer name" required>
          <Input
            id="qa-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              }
            }}
          />
        </Field>
        <Field id="qa-country" label="Country" required>
          <CountrySelect
            id="qa-country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          />
        </Field>
        <Field id="qa-type" label="Customer type" required>
          <Select
            id="qa-type"
            value={customerType}
            onChange={(e) => setCustomerType(e.target.value)}
          >
            {CUSTOMER_TYPES.map((value) => (
              <option key={value} value={value}>
                {CUSTOMER_TYPE_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="qa-area" label="Business area" required>
          <Select
            id="qa-area"
            value={businessArea}
            onChange={(e) => setBusinessArea(e.target.value)}
          >
            {BUSINESS_AREAS.map((value) => (
              <option key={value} value={value}>
                {BUSINESS_AREA_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="qa-sector" label="Commodity category" required>
          <Select
            id="qa-sector"
            value={industrySectorId}
            onChange={(e) => setIndustrySectorId(e.target.value)}
          >
            <option value="">Select a category</option>
            {sectors.map((sector) => (
              <option key={sector.id} value={sector.id}>
                {sector.name}
              </option>
            ))}
          </Select>
        </Field>

        {error !== null && (
          <p role="alert" className="text-cell text-alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 border-t border-line pt-4">
          <Button type="button" onClick={() => void save()} disabled={isSaving}>
            {isSaving ? 'Adding…' : 'Add customer'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
