'use client';

import type { BlDraftDto, BlDraftPrefillDto, BlTemplateDto } from '@ff/shared';
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
    preCarriageByModeId: source.preCarriageByModeId,
    placeOfReceipt: source.placeOfReceipt,
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
    preCarriageByModeId: values.preCarriageByModeId,
    placeOfReceipt: values.placeOfReceipt,
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
        className="w-full rounded-manifest border border-line bg-surface px-3 py-2 text-body text-hull outline-none transition-colors duration-120 ease-out focus:ring-2 focus:ring-harbour disabled:bg-paper disabled:text-steel"
      />
    </Field>
  );
}

export function BlDraftForm({
  values,
  setValues,
  disabled,
  isCustomerView,
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
  modes: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  containers: BlDraftDto['containers'];
  templates: BlTemplateDto[];
  onUseTemplate: (template: BlTemplateDto) => void;
  onPullParties: () => void;
}) {
  const [templateId, setTemplateId] = useState('');
  const set = (patch: Partial<BlDraftFormValues>): void => setValues({ ...values, ...patch });

  return (
    <div className="flex flex-col gap-5">
      {/* N13 `Use Templet` — beside the BL number on the client's sheet. */}
      {templates.length > 0 && !disabled && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex w-72 flex-col gap-1">
            <span className="label-manifest">Use template</span>
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
      )}

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

      {/* B16 and B29 on the customer sheet: `Pull`. */}
      {isCustomerView && !disabled && (
        <div>
          <Button variant="secondary" onClick={onPullParties}>
            Pull my details
          </Button>
        </div>
      )}

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
        {/*
          G34 with H37's "There will be an option to select the agent."
          Absent from the customer's sheet, and absent here for the same
          reason: choosing the destination agent is the forwarder's call.
        */}
        {!isCustomerView && (
          <Field id="deliveryAgentId" label="For Delivery of Goods Apply to">
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
        )}
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
            <table className="w-full border-collapse text-cell">
              <thead>
                <tr className="bg-paper text-left label-manifest">
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
