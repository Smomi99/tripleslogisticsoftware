'use client';

import {
  type CustomerDto,
  type InquiryDto,
  type InquiryVolumeInput,
  type LookupOption,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABEL,
  type MovementType,
  SHIPMENT_TYPES,
  SHIPMENT_TYPE_LABEL,
  type ShipmentType,
} from '@ff/shared';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CustomerQuickAdd } from '@/components/sales/customer-quick-add';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The §5.4 inquiry form, for raising one or editing one.
 *
 * Extracted from the New Inquiry page so that Edit is the same form rather than
 * a second implementation of it — the row action previously linked at the
 * capture page, which only ever POSTed, so editing silently raised a duplicate.
 *
 * Two behaviours the spec calls out are the reason this is not a generic form:
 *   - Volume is a grid whose rows depend on Shipment Type — container types for
 *     Sea, a single CBM row for LCL, a single KG row for Air.
 *   - The customer quick-add creates a customer without leaving the form, and
 *     returns with it selected.
 */

interface InquiryOptions {
  sources: LookupOption[];
  customers: LookupOption[];
  seaPorts: LookupOption[];
  airPorts: LookupOption[];
  commodities: { id: string; name: string; hsCode: string | null }[];
  termsOfShipment: LookupOption[];
  currencies: LookupOption[];
  salesmen: LookupOption[];
  containerTypes: LookupOption[];
  defaultSalesmanId: string | null;
  canSetOutcome: boolean;
  canViewAll: boolean;
}

const EMPTY: InquiryOptions = {
  sources: [],
  customers: [],
  seaPorts: [],
  airPorts: [],
  commodities: [],
  termsOfShipment: [],
  currencies: [],
  salesmen: [],
  containerTypes: [],
  defaultSalesmanId: null,
  canSetOutcome: false,
  canViewAll: false,
};

const today = (): string => new Date().toISOString().slice(0, 10);

/** Turns saved volume rows back into the grid's keyed values. */
function volumesOf(inquiry: InquiryDto | null): Record<string, string> {
  if (inquiry === null) return {};
  const values: Record<string, string> = {};
  for (const volume of inquiry.volumes) {
    if (volume.volumeKind === 'AIR') values['air'] = volume.weightKg ?? '';
    else if (volume.volumeKind === 'LCL') values['lcl'] = volume.cbm ?? '';
    else if (volume.containerTypeId !== null) {
      values[`fcl:${volume.containerTypeId}`] = String(volume.quantity ?? '');
    }
  }
  return values;
}

export function InquiryForm({
  inquiry,
  onSaved,
  onCancel,
}: {
  /** null raises a new inquiry; an inquiry edits that one. */
  inquiry: InquiryDto | null;
  onSaved: (inquiry: InquiryDto) => void;
  onCancel: () => void;
}) {
  const { authorizedRequest, authorizedList, can } = useSession();
  const isEdit = inquiry !== null;

  const [options, setOptions] = useState<InquiryOptions>(EMPTY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [isSaving, setSaving] = useState(false);
  const [isQuickAddOpen, setQuickAddOpen] = useState(false);

  // §5.4's field order, kept as the order of this state block.
  const [inquiryDate, setInquiryDate] = useState(inquiry?.inquiryDate ?? today());
  const [sourceId, setSourceId] = useState(inquiry?.sourceId ?? '');
  const [shipmentType, setShipmentType] = useState<ShipmentType>(inquiry?.shipmentType ?? 'SEA');
  const [customerId, setCustomerId] = useState(inquiry?.customerId ?? '');
  const [movementType, setMovementType] = useState<MovementType>(
    inquiry?.movementType ?? 'OUTBOUND',
  );
  const [polId, setPolId] = useState(inquiry?.polId ?? '');
  const [podId, setPodId] = useState(inquiry?.podId ?? '');
  const [commodityItemId, setCommodityItemId] = useState(inquiry?.commodityItemId ?? '');
  const [hsCode, setHsCode] = useState(inquiry?.hsCode ?? '');
  const [placeOfReceipt, setPlaceOfReceipt] = useState(inquiry?.placeOfReceipt ?? '');
  const [tosId, setTosId] = useState(inquiry?.tosId ?? '');
  const [volumes, setVolumes] = useState<Record<string, string>>(volumesOf(inquiry));
  const [targetPrice, setTargetPrice] = useState(inquiry?.targetPrice ?? '');
  const [currencyId, setCurrencyId] = useState(inquiry?.currencyId ?? '');
  const [expectedShipmentDate, setExpectedShipmentDate] = useState(
    inquiry?.expectedShipmentDate ?? '',
  );
  const [validTo, setValidTo] = useState(inquiry?.validTo ?? '');
  const [weightKg, setWeightKg] = useState(inquiry?.weightKg ?? '');
  const [remarks, setRemarks] = useState(inquiry?.remarks ?? '');
  const [salesmanId, setSalesmanId] = useState(inquiry?.salesmanId ?? '');

  const [extraCustomers, setExtraCustomers] = useState<LookupOption[]>([]);
  const [leads, setLeads] = useState<LookupOption[]>([]);
  const [leadId, setLeadId] = useState(inquiry?.leadId ?? '');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authorizedList<InquiryOptions>(
          '/api/tenant/sales/inquiry-options',
        );
        if (cancelled) return;
        setOptions(response.data);
        // §5.4: "Salesman defaults to the logged-in user's employee record."
        // Only when raising — an existing inquiry keeps whoever owns it.
        if (!isEdit && response.data.defaultSalesmanId !== null) {
          setSalesmanId(response.data.defaultSalesmanId);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof ApiError ? error.message : 'Could not load the form.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedList, isEdit]);

  // §9 Q12: an inquiry records the lead it came from, when it came from one.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authorizedList<LookupOption[]>('/api/tenant/sales/lead-options');
        if (!cancelled) setLeads(response.data);
      } catch {
        // Leads are optional; the field simply stays empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedList]);

  // §4 rule 9's reasoning again: an air inquiry runs between airports.
  const ports = shipmentType === 'AIR' ? options.airPorts : options.seaPorts;

  /**
   * Switching mode invalidates any port chosen from the other set, and the
   * volume grid changes shape with it.
   *
   * This is deliberately NOT an effect on shipmentType. As an effect it also
   * fires on mount, and React double-invokes effects in development, so a
   * first-render guard held by a ref survives the first pass and clears on the
   * second — which wiped the lane off every inquiry opened for edit. Clearing
   * is a consequence of the user changing the field, so it lives on the change.
   */
  function changeShipmentType(next: ShipmentType): void {
    if (next === shipmentType) return;
    setShipmentType(next);
    setPolId('');
    setPodId('');
    setVolumes({});
  }

  const customers = useMemo(
    () => [...extraCustomers, ...options.customers],
    [extraCustomers, options.customers],
  );

  /** §5.4: rows appear based on Shipment Type. */
  const volumeRows = useMemo(() => {
    if (shipmentType === 'AIR') {
      return [{ key: 'air', label: 'Chargeable weight', unit: 'KG', containerTypeId: null }];
    }
    return [
      ...options.containerTypes.map((type) => ({
        key: `fcl:${type.id}`,
        label: type.name,
        unit: 'containers',
        containerTypeId: type.id,
      })),
      { key: 'lcl', label: 'LCL', unit: 'CBM', containerTypeId: null },
    ];
  }, [options.containerTypes, shipmentType]);

  function buildVolumes(): InquiryVolumeInput[] {
    const rows: InquiryVolumeInput[] = [];
    for (const row of volumeRows) {
      const value = (volumes[row.key] ?? '').trim();
      if (value === '') continue;
      if (row.key === 'air') rows.push({ volumeKind: 'AIR', weightKg: value });
      else if (row.key === 'lcl') rows.push({ volumeKind: 'LCL', cbm: value });
      else {
        rows.push({
          volumeKind: 'FCL',
          containerTypeId: row.containerTypeId ?? '',
          quantity: value,
        });
      }
    }
    return rows;
  }

  function errorFor(field: string): string | undefined {
    return fieldErrors[field]?.[0];
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});
    setSaving(true);

    try {
      const saved = await authorizedRequest<InquiryDto>(
        isEdit ? `/api/tenant/sales/inquiries/${inquiry.id}` : '/api/tenant/sales/inquiries',
        {
          method: isEdit ? 'PATCH' : 'POST',
          body: {
            inquiryDate,
            sourceId,
            shipmentType,
            customerId,
            movementType,
            polId,
            podId,
            placeOfReceipt,
            commodityItemId,
            hsCode,
            tosId,
            targetPrice,
            currencyId,
            expectedShipmentDate,
            validTo,
            weightKg,
            remarks,
            salesmanId,
            leadId,
            volumes: buildVolumes(),
          },
        },
      );
      toast.success(isEdit ? `Inquiry ${saved.code} saved` : `Inquiry ${saved.code} raised`);
      onSaved(saved);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
        setFieldErrors(error.fields ?? {});
      } else {
        setFormError('Could not save the inquiry. Check your connection and try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {loadError !== null && (
        <p
          role="alert"
          className="mb-3 rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {loadError}
        </p>
      )}

      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-5">
        {formError !== null && (
          <p
            role="alert"
            className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
          >
            {formError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field id="inquiryDate" label="Inquiry date" required error={errorFor('inquiryDate')}>
            <Input
              id="inquiryDate"
              type="date"
              numeric
              value={inquiryDate}
              onChange={(e) => setInquiryDate(e.target.value)}
            />
          </Field>

          <Field id="sourceId" label="Source" required error={errorFor('sourceId')}>
            <Select id="sourceId" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">Select a source</option>
              {options.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="shipmentType" label="Shipment type" required error={errorFor('shipmentType')}>
            <Select
              id="shipmentType"
              value={shipmentType}
              onChange={(e) => changeShipmentType(e.target.value as ShipmentType)}
            >
              {SHIPMENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {SHIPMENT_TYPE_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="customerId" label="Customer" required error={errorFor('customerId')}>
            <div className="flex items-center gap-1">
              <Select
                id="customerId"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">Select a customer</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                  </option>
                ))}
              </Select>
              {/* §5.4's "+ +" — gated by CRM.CUSTOMER.CREATE. */}
              {can('CRM.CUSTOMER.CREATE') && (
                <Button
                  type="button"
                  variant="secondary"
                  aria-label="Add a customer"
                  title="Add a customer without leaving this form"
                  onClick={() => setQuickAddOpen(true)}
                  className="h-9 shrink-0 px-3"
                >
                  +
                </Button>
              )}
            </div>
          </Field>

          <Field
            id="movementType"
            label="Type of movement"
            required
            error={errorFor('movementType')}
          >
            <Select
              id="movementType"
              value={movementType}
              onChange={(e) => setMovementType(e.target.value as MovementType)}
            >
              {MOVEMENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {MOVEMENT_TYPE_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="salesmanId" label="Salesman" error={errorFor('salesmanId')}>
            <Select
              id="salesmanId"
              value={salesmanId}
              onChange={(e) => setSalesmanId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {options.salesmen.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="leadId"
            label="Raised from lead"
            hint="Optional — links this inquiry to the conversation it came from."
            error={errorFor('leadId')}
          >
            <Select id="leadId" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              <option value="">Not from a lead</option>
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="polId" label="POL" required error={errorFor('polId')}>
            <Select id="polId" value={polId} onChange={(e) => setPolId(e.target.value)}>
              <option value="">Select a port</option>
              {ports.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="podId" label="POD" required error={errorFor('podId')}>
            <Select id="podId" value={podId} onChange={(e) => setPodId(e.target.value)}>
              <option value="">Select a port</option>
              {ports.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="placeOfReceipt" label="Place of receipt" error={errorFor('placeOfReceipt')}>
            <Input
              id="placeOfReceipt"
              value={placeOfReceipt}
              onChange={(e) => setPlaceOfReceipt(e.target.value)}
            />
          </Field>

          <Field id="commodityItemId" label="Commodity" error={errorFor('commodityItemId')}>
            <Select
              id="commodityItemId"
              value={commodityItemId}
              onChange={(e) => {
                const next = e.target.value;
                setCommodityItemId(next);
                // §5.4: HS code prefills from the commodity and stays editable.
                const match = options.commodities.find((c) => c.id === next);
                if (match?.hsCode != null) setHsCode(match.hsCode);
              }}
            >
              <option value="">Select a commodity</option>
              {options.commodities.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="hsCode"
            label="HS code"
            hint="Prefilled from the commodity; edit if the customer's differs."
            error={errorFor('hsCode')}
          >
            <Input id="hsCode" numeric value={hsCode} onChange={(e) => setHsCode(e.target.value)} />
          </Field>

          <Field id="tosId" label="TOS" error={errorFor('tosId')}>
            <Select id="tosId" value={tosId} onChange={(e) => setTosId(e.target.value)}>
              <option value="">Select terms</option>
              {options.termsOfShipment.map((tos) => (
                <option key={tos.id} value={tos.id}>
                  {tos.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {/* §5.4: a small grid, not six loose inputs. */}
        <div className="border-t border-line pt-4">
          <h3 className="text-section text-hull">Volume</h3>
          <p className="mt-0.5 text-cell text-steel">
            {shipmentType === 'AIR'
              ? 'Chargeable weight for the shipment.'
              : 'Container counts for FCL, or a CBM figure for LCL. Leave the rest blank.'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
            {volumeRows.map((row) => (
              <Field key={row.key} id={`vol-${row.key}`} label={`${row.label} (${row.unit})`}>
                <Input
                  id={`vol-${row.key}`}
                  numeric
                  inputMode={row.key.startsWith('fcl') ? 'numeric' : 'decimal'}
                  value={volumes[row.key] ?? ''}
                  onChange={(e) => setVolumes({ ...volumes, [row.key]: e.target.value })}
                />
              </Field>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 md:grid-cols-3">
          <Field id="targetPrice" label="Target price" error={errorFor('targetPrice')}>
            <Input
              id="targetPrice"
              numeric
              inputMode="decimal"
              value={targetPrice}
              onChange={(e) => setTargetPrice(e.target.value)}
            />
          </Field>

          <Field id="currencyId" label="Currency" error={errorFor('currencyId')}>
            <Select
              id="currencyId"
              value={currencyId}
              onChange={(e) => setCurrencyId(e.target.value)}
            >
              <option value="">Select a currency</option>
              {options.currencies.map((currency) => (
                <option key={currency.id} value={currency.id}>
                  {currency.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field id="weightKg" label="Weight (KG)" error={errorFor('weightKg')}>
            <Input
              id="weightKg"
              numeric
              inputMode="decimal"
              value={weightKg}
              onChange={(e) => setWeightKg(e.target.value)}
            />
          </Field>

          <Field
            id="expectedShipmentDate"
            label="Expected shipment date"
            error={errorFor('expectedShipmentDate')}
          >
            <Input
              id="expectedShipmentDate"
              type="date"
              numeric
              value={expectedShipmentDate}
              onChange={(e) => setExpectedShipmentDate(e.target.value)}
            />
          </Field>

          <Field id="validTo" label="Inquiry valid upto" error={errorFor('validTo')}>
            <Input
              id="validTo"
              type="date"
              numeric
              min={inquiryDate}
              value={validTo}
              onChange={(e) => setValidTo(e.target.value)}
            />
          </Field>

          <Field id="remarks" label="Remarks" error={errorFor('remarks')} wide>
            <Input id="remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSaving}>
            {isSaving
              ? isEdit
                ? 'Saving…'
                : 'Raising…'
              : isEdit
                ? 'Save changes'
                : 'Raise inquiry'}
          </Button>
        </div>
      </form>

      <CustomerQuickAdd
        open={isQuickAddOpen}
        onOpenChange={setQuickAddOpen}
        onCreated={(customer: CustomerDto) => {
          setExtraCustomers((prev) => [{ id: customer.id, name: customer.name }, ...prev]);
          setCustomerId(customer.id);
        }}
      />
    </>
  );
}
