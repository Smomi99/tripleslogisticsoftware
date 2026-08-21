'use client';

import {
  type CustomerDto,
  type InquiryDto,
  type InquiryPartyOption,
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
import { MultiSelect } from '@/components/ui/multi-select';
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

/**
 * One column of the client's Required-container grid.
 *
 * Their wireframe puts four rows under each container size: the quantity, a
 * free-text container type, a weight and a target price. `amount` is whichever
 * the column measures — containers for FCL, CBM for LCL, KG for Air.
 */
interface VolumeCell {
  amount: string;
  note: string;
  weightKg: string;
  targetPrice: string;
}

const EMPTY_CELL: VolumeCell = { amount: '', note: '', weightKg: '', targetPrice: '' };

/** Turns saved volume rows back into the grid's keyed cells. */
function volumesOf(inquiry: InquiryDto | null): Record<string, VolumeCell> {
  if (inquiry === null) return {};
  const values: Record<string, VolumeCell> = {};
  for (const volume of inquiry.volumes) {
    const key =
      volume.volumeKind === 'AIR'
        ? 'air'
        : volume.volumeKind === 'LCL'
          ? 'lcl'
          : volume.containerTypeId === null
            ? null
            : `fcl:${volume.containerTypeId}`;
    if (key === null) continue;
    values[key] = {
      amount:
        volume.volumeKind === 'AIR'
          ? (volume.weightKg ?? '')
          : volume.volumeKind === 'LCL'
            ? (volume.cbm ?? '')
            : String(volume.quantity ?? ''),
      note: volume.containerTypeNote ?? '',
      weightKg: volume.weightKg ?? '',
      targetPrice: volume.targetPrice ?? '',
    };
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
  const [loadingType, setLoadingType] = useState<'' | 'FCL' | 'LCL'>(
    inquiry?.loadingType ?? '',
  );
  const [volumes, setVolumes] = useState<Record<string, VolumeCell>>(volumesOf(inquiry));
  // Who the inquiry goes to. Inbound offers agents, Outbound customers.
  const [partyOptions, setPartyOptions] = useState<InquiryPartyOption[]>([]);
  const [partyIds, setPartyIds] = useState<string[]>(
    inquiry?.parties.map((p) => p.partyId) ?? [],
  );
  const [partyContactIds, setPartyContactIds] = useState<string[]>(
    inquiry?.partyContacts.map((c) => c.contactId) ?? [],
  );
  const [notifyEmails, setNotifyEmails] = useState(inquiry?.notifyEmails ?? '');
  /** Once the operator edits the box by hand, stop overwriting what they typed. */
  const [emailsTouched, setEmailsTouched] = useState(inquiry?.notifyEmails != null);
  const [currencyId, setCurrencyId] = useState(inquiry?.currencyId ?? '');
  const [expectedShipmentDate, setExpectedShipmentDate] = useState(
    inquiry?.expectedShipmentDate ?? '',
  );
  const [validTo, setValidTo] = useState(inquiry?.validTo ?? '');
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
    // Air is neither FCL nor LCL, and a Sea inquiry has to be asked afresh.
    setLoadingType('');
  }

  /**
   * Switching FCL to LCL changes which columns exist, so what was typed into
   * the old ones has nowhere to go. Clearing is honest; carrying four container
   * counts silently into a single CBM column would not be.
   */
  function changeLoadingType(next: '' | 'FCL' | 'LCL'): void {
    if (next === loadingType) return;
    setLoadingType(next);
    setVolumes({});
  }

  useEffect(() => {
    let cancelled = false;
    void authorizedRequest<InquiryPartyOption[]>(
      `/api/tenant/sales/inquiry-parties?movement=${movementType}`,
    )
      .then((rows) => {
        if (!cancelled) setPartyOptions(rows);
      })
      .catch(() => {
        if (!cancelled) setPartyOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, movementType]);

  /** Contacts belonging to the parties currently ticked. */
  const contactOptions = useMemo(() => {
    const chosen = new Set(partyIds);
    return partyOptions
      .filter((party) => chosen.has(party.id))
      .flatMap((party) =>
        party.contacts.map((contact) => ({
          id: contact.id,
          name: `${contact.name} — ${party.name}`,
          email: contact.email,
        })),
      );
  }, [partyOptions, partyIds]);

  /**
   * Seed the email box from the ticked contacts, until someone edits it.
   *
   * The client asked for it to be editable, which means it can legitimately
   * disagree with the contacts beside it — so once they have typed, their text
   * wins and this stops interfering.
   */
  useEffect(() => {
    if (emailsTouched) return;
    const chosen = new Set(partyContactIds);
    setNotifyEmails(
      contactOptions
        .filter((c) => chosen.has(c.id) && c.email !== null && c.email !== '')
        .map((c) => c.email)
        .join(', '),
    );
  }, [contactOptions, partyContactIds, emailsTouched]);

  /** Changing the movement swaps agents for customers, so the picks go with it. */
  function changeMovementType(next: MovementType): void {
    if (next === movementType) return;
    setMovementType(next);
    setPartyIds([]);
    setPartyContactIds([]);
    if (!emailsTouched) setNotifyEmails('');
  }

  const customers = useMemo(
    () => [...extraCustomers, ...options.customers],
    [extraCustomers, options.customers],
  );

  /**
   * The grid's columns, exactly as the client's wireframe draws them: the four
   * container sizes for Sea FCL, a single LCL(CBM) column for Sea LCL, and
   * Air(kG) for air. Loading Type is what chooses between the first two — the
   * arrows on their sketch run from "( FCL , LCL )" to those two groups.
   */
  const volumeColumns = useMemo(() => {
    if (shipmentType === 'AIR') {
      return [{ key: 'air', label: 'Air (kG)', containerTypeId: null }];
    }
    if (loadingType === 'LCL') {
      return [{ key: 'lcl', label: 'LCL (CBM)', containerTypeId: null }];
    }
    if (loadingType === 'FCL') {
      return options.containerTypes.map((type) => ({
        key: `fcl:${type.id}`,
        label: type.name,
        containerTypeId: type.id,
      }));
    }
    // Sea with no loading type chosen yet: nothing to fill in.
    return [];
  }, [options.containerTypes, shipmentType, loadingType]);

  function cell(key: string): VolumeCell {
    return volumes[key] ?? EMPTY_CELL;
  }

  function setCell(key: string, patch: Partial<VolumeCell>): void {
    setVolumes({ ...volumes, [key]: { ...cell(key), ...patch } });
  }

  function buildVolumes(): InquiryVolumeInput[] {
    const rows: InquiryVolumeInput[] = [];
    for (const column of volumeColumns) {
      const value = cell(column.key);
      const amount = value.amount.trim();
      const note = value.note.trim();
      const weight = value.weightKg.trim();
      const price = value.targetPrice.trim();
      // A column with nothing in any of its four boxes is not a row.
      if (amount === '' && note === '' && weight === '' && price === '') continue;

      const shared = {
        containerTypeNote: note,
        targetPrice: price,
      };
      if (column.key === 'air') {
        // Air measures the column in KG, so the amount IS the weight.
        rows.push({ volumeKind: 'AIR', weightKg: amount === '' ? weight : amount, ...shared });
      } else if (column.key === 'lcl') {
        rows.push({ volumeKind: 'LCL', cbm: amount, weightKg: weight, ...shared });
      } else {
        rows.push({
          volumeKind: 'FCL',
          containerTypeId: column.containerTypeId ?? '',
          quantity: amount,
          weightKg: weight,
          ...shared,
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
            partyIds,
            partyContactIds,
            notifyEmails,
            polId,
            podId,
            placeOfReceipt,
            commodityItemId,
            hsCode,
            tosId,
            loadingType: loadingType === '' ? undefined : loadingType,
            currencyId,
            expectedShipmentDate,
            validTo,
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
              onChange={(e) => changeMovementType(e.target.value as MovementType)}
            >
              {MOVEMENT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {MOVEMENT_TYPE_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>

          {/*
            Who the inquiry is sent to. Inbound offers agents, Outbound
            customers — the client's rule. Separate from Customer above, which
            is the party the inquiry is FOR.
          */}
          <Field
            id="partyIds"
            label={movementType === 'INBOUND' ? 'Agents' : 'Customers to notify'}
            error={errorFor('partyIds')}
            wide
          >
            <MultiSelect
              id="partyIds"
              options={partyOptions.map((p) => ({ id: p.id, name: p.name }))}
              value={partyIds}
              onChange={(next) => {
                setPartyIds(next);
                // A contact whose party has just been unticked cannot stay.
                const stillOffered = new Set(
                  partyOptions
                    .filter((p) => next.includes(p.id))
                    .flatMap((p) => p.contacts.map((c) => c.id)),
                );
                setPartyContactIds((ids) => ids.filter((id) => stillOffered.has(id)));
              }}
              placeholder={movementType === 'INBOUND' ? 'Choose agents' : 'Choose customers'}
            />
          </Field>

          {partyIds.length > 0 && (
            <Field id="partyContactIds" label="Contacts" error={errorFor('partyContactIds')} wide>
              <MultiSelect
                id="partyContactIds"
                options={contactOptions.map((c) => ({ id: c.id, name: c.name }))}
                value={partyContactIds}
                onChange={setPartyContactIds}
                placeholder="Choose contacts"
              />
            </Field>
          )}

          {partyIds.length > 0 && (
            <Field
              id="notifyEmails"
              label="Emails"
              hint="Filled from the contacts above. Edit it if you need a one-off address."
              error={errorFor('notifyEmails')}
              wide
            >
              <Input
                id="notifyEmails"
                value={notifyEmails}
                onChange={(e) => {
                  setEmailsTouched(true);
                  setNotifyEmails(e.target.value);
                }}
              />
            </Field>
          )}

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


          {/* Sea only: an air shipment is neither FCL nor LCL. */}
          {shipmentType === 'SEA' && (
            <Field id="loadingType" label="Loading type" error={errorFor('loadingType')}>
              <Select
                id="loadingType"
                value={loadingType}
                onChange={(e) => changeLoadingType(e.target.value as '' | 'FCL' | 'LCL')}
              >
                <option value="">Select FCL or LCL</option>
                <option value="FCL">FCL</option>
                <option value="LCL">LCL</option>
              </Select>
            </Field>
          )}
        </div>

        {/* The client's Required-container grid. */}
        <div className="border-t border-line pt-4">
          <h3 className="text-section text-hull">Required container</h3>
          <p className="mt-0.5 text-cell text-steel">
            {shipmentType === 'AIR'
              ? 'Chargeable weight, and what you are aiming to quote.'
              : loadingType === ''
                ? 'Choose FCL or LCL above and the sizes will appear here.'
                : loadingType === 'FCL'
                  ? 'Fill in only the sizes this inquiry needs.'
                  : 'One consolidated column, measured in CBM.'}
          </p>

          {volumeColumns.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse text-cell">
                <thead>
                  <tr>
                    <th className="w-40 border border-line bg-paper px-2 py-1.5 text-left text-label text-steel">
                      Required container
                    </th>
                    {volumeColumns.map((column) => (
                      <th
                        key={column.key}
                        className="border border-line bg-paper px-2 py-1.5 text-center font-mono text-label text-hull"
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      { field: 'amount', label: shipmentType === 'AIR' ? 'Weight (kG)' : loadingType === 'LCL' ? 'Volume (CBM)' : 'Quantity', numeric: true },
                      { field: 'note', label: 'Container type', numeric: false },
                      { field: 'weightKg', label: 'Weight in Kg', numeric: true },
                      { field: 'targetPrice', label: 'Target price ($)', numeric: true },
                    ] as const
                  )
                    // Air measures its single column in KG already, so a second
                    // weight row would be the same number asked for twice.
                    .filter((row) => !(shipmentType === 'AIR' && row.field === 'weightKg'))
                    .map((row) => (
                      <tr key={row.field}>
                        <th className="border border-line px-2 py-1 text-left text-cell font-normal text-steel">
                          {row.label}
                        </th>
                        {volumeColumns.map((column) => (
                          <td key={column.key} className="border border-line p-0">
                            <Input
                              id={`vol-${column.key}-${row.field}`}
                              aria-label={`${column.label} ${row.label}`}
                              numeric={row.numeric}
                              inputMode={row.numeric ? 'decimal' : 'text'}
                              className="border-0 text-center"
                              value={cell(column.key)[row.field]}
                              onChange={(e) => setCell(column.key, { [row.field]: e.target.value })}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 md:grid-cols-3">
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
