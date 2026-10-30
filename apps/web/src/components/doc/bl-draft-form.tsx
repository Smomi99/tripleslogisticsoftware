'use client';

import {
  type AirRouteLegDto,
  AWB_ORIGINALS,
  type BlDraftDto,
  type BlDraftPrefillDto,
  type BlTemplateDto,
} from '@ff/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

/**
 * The bill of lading form — docs/MODULE_DOCUMENTATION.md §2.3 and §2.4.
 *
 * One form for both sheets. The customer's copy differs in four things and
 * they are all props: the party labels say which company is meant, `Pull`
 * fills their own details in, the delivery-agent selector is absent, and the
 * third button says Submit rather than Send (§2.4).
 *
 * Writing it twice would mean two field lists drifting apart over one document
 * that only ever has one final version.
 *
 * An air booking's bill is a House Air Waybill (MODULE_DOCUMENTATION §14): the
 * same form showing the waybill's boxes instead — pieces, chargeable weight,
 * the flights as the advise holds them — and none of the sea bill's
 * pre-carriage, vessel, references or containers.
 */

export interface BlDraftFormValues {
  manifestNo: string;
  shipperText: string;
  consigneeText: string;
  notifyText: string;
  alsoNotifyText: string;
  exportReferences: string;
  forwardingAgentReferences: string;
  pointCountryOfOrigin: string;
  preCarriageByModeId: string;
  placeOfReceipt: string;
  deliveryAgentId: string;
  deliveryAgentText: string;
  oceanVesselVoyage: string;
  polId: string;
  podId: string;
  placeOfDelivery: string;
  packagesDescription: string;
  marksAndNumbers: string;
  grossWeightKg: string;
  measurementCbm: string;
  packageCount: string;
  chargeableWeightKg: string;
  freightPayableAt: string;
  originalBlCount: string;
  ladenOnBoardDate: string;
}

export function valuesFrom(source: BlDraftDto | BlDraftPrefillDto): BlDraftFormValues {
  return {
    manifestNo: source.manifestNo ?? '',
    shipperText: source.shipperText,
    consigneeText: source.consigneeText,
    notifyText: source.notifyText,
    alsoNotifyText: source.alsoNotifyText ?? '',
    exportReferences: source.exportReferences ?? '',
    forwardingAgentReferences: source.forwardingAgentReferences ?? '',
    pointCountryOfOrigin: source.pointCountryOfOrigin ?? '',
    preCarriageByModeId: source.preCarriageByModeId ?? '',
    placeOfReceipt: source.placeOfReceipt ?? '',
    deliveryAgentId: source.deliveryAgentId ?? '',
    deliveryAgentText: source.deliveryAgentText ?? '',
    oceanVesselVoyage: source.oceanVesselVoyage ?? '',
    polId: source.polId,
    podId: source.podId,
    placeOfDelivery: source.placeOfDelivery ?? '',
    packagesDescription: source.packagesDescription ?? '',
    marksAndNumbers: source.marksAndNumbers ?? '',
    grossWeightKg: source.grossWeightKg ?? '',
    measurementCbm: source.measurementCbm ?? '',
    packageCount: source.packageCount === null ? '' : String(source.packageCount),
    chargeableWeightKg: source.chargeableWeightKg ?? '',
    freightPayableAt: source.freightPayableAt ?? '',
    originalBlCount: source.originalBlCount === null ? '' : String(source.originalBlCount),
    ladenOnBoardDate: source.ladenOnBoardDate ?? '',
  };
}

/** What goes on the wire. Empty strings become nulls; numbers become numbers. */
export function bodyFrom(values: BlDraftFormValues): Record<string, unknown> {
  const text = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  return {
    manifestNo: text(values.manifestNo),
    shipperText: values.shipperText,
    consigneeText: values.consigneeText,
    notifyText: values.notifyText,
    alsoNotifyText: text(values.alsoNotifyText),
    exportReferences: text(values.exportReferences),
    forwardingAgentReferences: text(values.forwardingAgentReferences),
    pointCountryOfOrigin: text(values.pointCountryOfOrigin),
    // Null rather than empty, so the server can name a missing sea box.
    preCarriageByModeId: text(values.preCarriageByModeId),
    placeOfReceipt: text(values.placeOfReceipt),
    deliveryAgentId: text(values.deliveryAgentId),
    deliveryAgentText: text(values.deliveryAgentText),
    oceanVesselVoyage: text(values.oceanVesselVoyage),
    polId: values.polId,
    podId: values.podId,
    placeOfDelivery: text(values.placeOfDelivery),
    packagesDescription: text(values.packagesDescription),
    marksAndNumbers: text(values.marksAndNumbers),
    grossWeightKg: num(values.grossWeightKg),
    measurementCbm: num(values.measurementCbm),
    packageCount: num(values.packageCount),
    chargeableWeightKg: num(values.chargeableWeightKg),
    freightPayableAt: text(values.freightPayableAt),
    originalBlCount: num(values.originalBlCount),
    ladenOnBoardDate: text(values.ladenOnBoardDate),
  };
}

function Block({
  id,
  label,
  hint,
  required,
  rows = 4,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  rows?: number;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <Field id={id} label={label} hint={hint} required={required}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-manifest border border-line bg-surface px-3 py-2 text-base text-hull transition-[border-color,box-shadow] duration-[120ms] hover:border-steel/50 focus:border-harbour focus:outline-none focus:ring-3 focus:ring-harbour/20 disabled:cursor-not-allowed disabled:bg-paper disabled:text-steel sm:text-body"
      />
    </Field>
  );
}

/** Stored UTC, read in Dhaka (CLAUDE.md §9). */
const departureInDhaka = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

/** The waybill's flights, read-only: they are the advise's (§14). */
function AirRoute({ legs }: { legs: AirRouteLegDto[] }) {
  return (
    <div>
      <h3 className="mb-1 text-section text-hull">Routing and flights</h3>
      <p className="mb-2 text-cell text-steel">
        From the shipment advise, as the waybill prints them. A wrong flight is corrected on the
        advise.
      </p>
      {legs.length === 0 ? (
        <p className="text-cell text-steel">The advise records no flight yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-manifest border border-line">
          <table className="w-full whitespace-nowrap border-collapse text-cell">
            <thead>
              <tr className="bg-module-soft text-left label-manifest">
                <th className="px-3 py-2">Leg</th>
                <th className="px-3 py-2">Flight</th>
                <th className="px-3 py-2">Airline</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2 text-right">Departure</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg) => (
                <tr key={leg.legNo} className="border-t border-line">
                  <td className="px-3 py-2 font-mono tabular-nums">{leg.legNo}</td>
                  <td className="px-3 py-2 font-mono tabular-nums">{leg.flightNo ?? '—'}</td>
                  <td className="px-3 py-2 font-mono">{leg.carrier ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className="font-mono">{leg.fromCode}</span> {leg.fromName}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono">{leg.toCode}</span> {leg.toName}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {leg.departure === null ? '—' : departureInDhaka(leg.departure)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function BlDraftForm({
  values,
  setValues,
  disabled,
  isCustomerView,
  isAir,
  airRoute,
  modes,
  agents,
  containers,
  templates,
  onUseTemplate,
  onPullParties,
}: {
  values: BlDraftFormValues;
  setValues: (v: BlDraftFormValues) => void;
  disabled: boolean;
  /** The customer's copy of the screen (§2.4). */
  isCustomerView: boolean;
  /** An air booking: the House Air Waybill's boxes (§14). */
  isAir: boolean;
  airRoute: AirRouteLegDto[];
  modes: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  containers: BlDraftDto['containers'];
  templates: BlTemplateDto[];
  onUseTemplate: (template: BlTemplateDto) => void;
  onPullParties: () => void;
}) {
  const [templateId, setTemplateId] = useState('');
  const set = (patch: Partial<BlDraftFormValues>): void => setValues({ ...values, ...patch });

  const templatePicker = templates.length > 0 && !disabled && (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="flex w-full flex-col gap-1.5 sm:w-72">
        <span className="label-field">Use template</span>
        <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Choose a saved template</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>
      <Button
        variant="secondary"
        disabled={templateId === ''}
        onClick={() => {
          const found = templates.find((t) => t.id === templateId);
          if (found !== undefined) onUseTemplate(found);
        }}
      >
        Apply
      </Button>
    </div>
  );

  /*
   * G34 with H37's "There will be an option to select the agent." Absent from
   * the customer's sheet, and absent here for the same reason: choosing the
   * destination agent is the forwarder's call.
   */
  const agentPicker = !isCustomerView && (
    <Field
      id="deliveryAgentId"
      label={isAir ? 'Delivery agent' : 'For Delivery of Goods Apply to'}
      hint={isAir ? 'Printed under the goods on the waybill.' : undefined}
    >
      <Select
        id="deliveryAgentId"
        value={values.deliveryAgentId}
        disabled={disabled}
        onChange={(e) => set({ deliveryAgentId: e.target.value })}
      >
        <option value="">No agent chosen</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
    </Field>
  );

  // B16 and B29 on the customer sheet: `Pull`.
  const pullButton = isCustomerView && !disabled && (
    <div>
      <Button variant="secondary" onClick={onPullParties}>
        Pull my details
      </Button>
    </div>
  );

  const numberField = (
    id: 'packageCount' | 'grossWeightKg' | 'chargeableWeightKg' | 'measurementCbm',
    label: string,
    inputMode: 'numeric' | 'decimal' = 'decimal',
  ) => (
    <Field id={id} label={label}>
      <Input
        id={id}
        numeric
        inputMode={inputMode}
        value={values[id]}
        disabled={disabled}
        onChange={(e) => set({ [id]: e.target.value })}
      />
    </Field>
  );

  /*
   * §14: the House Air Waybill. Its parties are the bill's three; its figures
   * start from the advise's totals; its flights are shown, not typed.
   */
  if (isAir) {
    return (
      <div className="flex flex-col gap-5">
        {templatePicker}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Block
            id="shipperText"
            label={isCustomerView ? 'Shipper (Exporter)' : "Shipper's name and address"}
            required
            value={values.shipperText}
            disabled={disabled}
            onChange={(v) => set({ shipperText: v })}
          />
          <Block
            id="consigneeText"
            label="Consignee's name and address"
            required
            value={values.consigneeText}
            disabled={disabled}
            onChange={(v) => set({ consigneeText: v })}
          />
          <Block
            id="notifyText"
            label={isCustomerView ? 'Notify Party (Importer)' : 'Notify Party'}
            required
            value={values.notifyText}
            disabled={disabled}
            onChange={(v) => set({ notifyText: v })}
          />
        </div>

        {pullButton}

        <AirRoute legs={airRoute} />

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {numberField('packageCount', 'No. of pieces', 'numeric')}
          {numberField('grossWeightKg', 'Gross weight (KG)')}
          {numberField('chargeableWeightKg', 'Chargeable weight (KG)')}
          {numberField('measurementCbm', 'Volume (CBM)')}
        </div>

        <Block
          id="packagesDescription"
          label="Nature and quantity of goods"
          hint="Order, style, HS code, invoice and EXP numbers, as they should read on the waybill. The volume and the delivery agent print under it."
          rows={6}
          value={values.packagesDescription}
          disabled={disabled}
          onChange={(v) => set({ packagesDescription: v })}
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field id="ladenOnBoardDate" label="Executed on (date)">
            <Input
              id="ladenOnBoardDate"
              type="date"
              value={values.ladenOnBoardDate}
              disabled={disabled}
              onChange={(e) => set({ ladenOnBoardDate: e.target.value })}
            />
          </Field>
          <Field
            id="freightPayableAt"
            label="Freight payable at"
            hint="Prints as At (Place). The booking's TOS decides it when it has one."
          >
            <Input
              id="freightPayableAt"
              value={values.freightPayableAt}
              disabled={disabled}
              onChange={(e) => set({ freightPayableAt: e.target.value })}
            />
          </Field>
          {agentPicker}
        </div>

        <p className="text-cell text-steel">
          Issued in {AWB_ORIGINALS.length} originals — for the issuing carrier, the consignee and
          the shipper.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* N13 `Use Templet` — beside the BL number on the client's sheet. */}
      {templatePicker}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/*
          §2.4 rule 1: the customer's sheet names the company behind each block,
          because "Shipper" and "Consignee" are the forwarder's words.
        */}
        <Block
          id="shipperText"
          label={isCustomerView ? 'Shipper (Exporter)' : 'Shipper'}
          required
          value={values.shipperText}
          disabled={disabled}
          onChange={(v) => set({ shipperText: v })}
        />
        <Block
          id="consigneeText"
          label="Consignee"
          required
          value={values.consigneeText}
          disabled={disabled}
          onChange={(v) => set({ consigneeText: v })}
        />
        <Block
          id="notifyText"
          label={isCustomerView ? 'Notify Party (Importer)' : 'Notify Party'}
          required
          value={values.notifyText}
          disabled={disabled}
          onChange={(v) => set({ notifyText: v })}
        />
        <Block
          id="alsoNotifyText"
          label="Also Notify Party"
          value={values.alsoNotifyText}
          disabled={disabled}
          onChange={(v) => set({ alsoNotifyText: v })}
        />
      </div>

      {pullButton}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field id="manifestNo" label="Manifest No">
          <Input
            id="manifestNo"
            value={values.manifestNo}
            disabled={disabled}
            onChange={(e) => set({ manifestNo: e.target.value })}
          />
        </Field>
        <Field id="exportReferences" label="Export References">
          <Input
            id="exportReferences"
            value={values.exportReferences}
            disabled={disabled}
            onChange={(e) => set({ exportReferences: e.target.value })}
          />
        </Field>
        <Field id="forwardingAgentReferences" label="Forwarding Agent References">
          <Input
            id="forwardingAgentReferences"
            value={values.forwardingAgentReferences}
            disabled={disabled}
            onChange={(e) => set({ forwardingAgentReferences: e.target.value })}
          />
        </Field>
        <Field id="pointCountryOfOrigin" label="Point &amp; Country of Origin">
          <Input
            id="pointCountryOfOrigin"
            value={values.pointCountryOfOrigin}
            disabled={disabled}
            onChange={(e) => set({ pointCountryOfOrigin: e.target.value })}
          />
        </Field>
        {/* B34 and F34 are starred on the client's sheet. */}
        <Field id="preCarriageByModeId" label="Pre-Carriage By (mode)" required>
          <Select
            id="preCarriageByModeId"
            value={values.preCarriageByModeId}
            disabled={disabled}
            onChange={(e) => set({ preCarriageByModeId: e.target.value })}
          >
            <option value="">Choose one</option>
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="placeOfReceipt" label="Place of Receipt" required>
          <Input
            id="placeOfReceipt"
            value={values.placeOfReceipt}
            disabled={disabled}
            onChange={(e) => set({ placeOfReceipt: e.target.value })}
          />
        </Field>
        <Field id="oceanVesselVoyage" label="Ocean Vessel / Voyage">
          <Input
            id="oceanVesselVoyage"
            value={values.oceanVesselVoyage}
            disabled={disabled}
            onChange={(e) => set({ oceanVesselVoyage: e.target.value })}
          />
        </Field>
        <Field id="placeOfDelivery" label="Place of Delivery">
          <Input
            id="placeOfDelivery"
            value={values.placeOfDelivery}
            disabled={disabled}
            onChange={(e) => set({ placeOfDelivery: e.target.value })}
          />
        </Field>
        {agentPicker}
      </div>

      {/* B40's block: the containers, pulled from the load plans. */}
      <div>
        <h3 className="mb-2 text-section text-hull">Marks and Numbers, Container and Seal</h3>
        {containers.length === 0 ? (
          <p className="text-cell text-steel">
            {isCustomerView
              ? 'Your forwarder fills in the container and seal numbers.'
              : 'No finalised container plan found for this booking yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-manifest border border-line">
            <table className="w-full whitespace-nowrap border-collapse text-cell">
              <thead>
                <tr className="bg-module-soft text-left label-manifest">
                  <th className="px-3 py-2">Container no</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Seal no</th>
                  <th className="px-3 py-2 text-right">CTN</th>
                  <th className="px-3 py-2 text-right">Gross weight (KG)</th>
                  <th className="px-3 py-2 text-right">Measurement (CBM)</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="px-3 py-2 font-mono tabular-nums">{c.containerNo ?? '—'}</td>
                    <td className="px-3 py-2">{c.containerSize ?? '—'}</td>
                    <td className="px-3 py-2 font-mono tabular-nums">{c.sealNo ?? '—'}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {c.ctnQty ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {c.grossWeightKg ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {c.measurementCbm ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Block
          id="packagesDescription"
          label="Numbers and Description of Packages and Goods"
          rows={6}
          value={values.packagesDescription}
          disabled={disabled}
          onChange={(v) => set({ packagesDescription: v })}
        />
        <Block
          id="marksAndNumbers"
          label="Marks and Numbers"
          rows={6}
          value={values.marksAndNumbers}
          disabled={disabled}
          onChange={(v) => set({ marksAndNumbers: v })}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field id="grossWeightKg" label="Gross Weight (KG)">
          <Input
            id="grossWeightKg"
            numeric
            inputMode="decimal"
            value={values.grossWeightKg}
            disabled={disabled}
            onChange={(e) => set({ grossWeightKg: e.target.value })}
          />
        </Field>
        <Field id="measurementCbm" label="Measurement (cubic meters)">
          <Input
            id="measurementCbm"
            numeric
            inputMode="decimal"
            value={values.measurementCbm}
            disabled={disabled}
            onChange={(e) => set({ measurementCbm: e.target.value })}
          />
        </Field>
        <Field id="freightPayableAt" label="Freight Payable at">
          <Input
            id="freightPayableAt"
            value={values.freightPayableAt}
            disabled={disabled}
            onChange={(e) => set({ freightPayableAt: e.target.value })}
          />
        </Field>
        <Field id="originalBlCount" label="No. of Original BL">
          <Input
            id="originalBlCount"
            numeric
            inputMode="numeric"
            value={values.originalBlCount}
            disabled={disabled}
            onChange={(e) => set({ originalBlCount: e.target.value })}
          />
        </Field>
        <Field id="ladenOnBoardDate" label="Laden on Board Date">
          <Input
            id="ladenOnBoardDate"
            type="date"
            value={values.ladenOnBoardDate}
            disabled={disabled}
            onChange={(e) => set({ ladenOnBoardDate: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}
