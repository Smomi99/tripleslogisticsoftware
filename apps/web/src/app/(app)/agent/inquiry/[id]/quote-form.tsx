'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type AgentQuoteDto,
  type AgentQuoteInput,
  agentQuoteInputSchema,
  type AgentQuoteReferenceDto,
} from '@ff/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type Control,
  type FieldErrors,
  useFieldArray,
  useForm,
  type UseFormRegister,
  useWatch,
} from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The agent's quotation: one or more alternative offers, each a table of charge
 * lines under its own routing.
 *
 * The shape is the client's wireframe. Two blocks is what it draws and two is
 * what a new form opens with, but nothing here is fixed at two — an agent with
 * one routing removes the second, and one with three adds a third.
 */

const EMPTY_LINE = {
  carrierId: '',
  costHeadId: '',
  containerTypeId: '',
  costUnitId: '',
  quantity: '',
  unitPrice: '',
  currencyId: '',
  remarks: '',
};

const emptyOption = () => ({
  carrierId: '',
  transitDays: '' as const,
  via: '',
  podFreeDays: '' as const,
  validUntil: '',
  etd: '',
  eta: '',
  remarks: '',
  lines: [{ ...EMPTY_LINE }],
});

const EMPTY_REFERENCE: AgentQuoteReferenceDto = {
  currencies: [],
  carriers: [],
  costHeads: [],
  containerTypes: [],
  costUnits: [],
};

/** Turns a saved quote back into form values, so an amendment starts where the agent left off. */
function toFormValues(quote: AgentQuoteDto | null): AgentQuoteInput {
  if (quote === null || quote.options.length === 0) {
    return { options: [emptyOption()] } as AgentQuoteInput;
  }
  return {
    options: quote.options.map((option) => ({
      carrierId: option.carrierId ?? '',
      transitDays: option.transitDays ?? '',
      via: option.via ?? '',
      podFreeDays: option.podFreeDays ?? '',
      validUntil: option.validUntil ?? '',
      etd: option.etd ?? '',
      eta: option.eta ?? '',
      remarks: option.remarks ?? '',
      lines: option.lines.map((line) => ({
        carrierId: line.carrierId ?? '',
        costHeadId: line.costHeadId,
        containerTypeId: line.containerTypeId ?? '',
        costUnitId: line.costUnitId ?? '',
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        currencyId: line.currencyId,
        remarks: line.remarks ?? '',
      })),
    })),
  } as AgentQuoteInput;
}

/**
 * A dropdown over a lookup list, with a blank first entry when optional.
 *
 * `width` is required rather than defaulted. These sit in a nine-column grid
 * where the browser will happily shrink a select until its own options are
 * unreadable — "Documentati…" does not tell an operator which documentation
 * fee they picked, and a quotation is a number somebody is held to.
 */
function LookupCell({
  options,
  placeholder,
  width,
  ...props
}: {
  options: { id: string; label: string }[];
  placeholder: string;
  width: string;
} & ReturnType<UseFormRegister<AgentQuoteInput>>) {
  return (
    <Select {...props} className={`h-8 text-cell ${width}`}>
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}

/** Shown under a cell when that cell is what is wrong. */
function CellError({ message }: { message?: string }) {
  if (message === undefined) return null;
  return <p className="mt-0.5 text-[11px] leading-tight text-alert">{message}</p>;
}

/**
 * Qty × Unit Price, echoed back live.
 *
 * The database computes the stored total; this is the same arithmetic shown
 * while typing, so an agent catches a misplaced decimal before they send it
 * rather than after we have quoted their customer on it.
 */
function LineTotal({
  control,
  path,
}: {
  control: Control<AgentQuoteInput>;
  path: `options.${number}.lines.${number}`;
}) {
  const quantity = useWatch({ control, name: `${path}.quantity` });
  const unitPrice = useWatch({ control, name: `${path}.unitPrice` });
  const q = Number(quantity);
  const p = Number(unitPrice);
  const usable =
    quantity !== '' && unitPrice !== '' && Number.isFinite(q) && Number.isFinite(p);
  return (
    <span className="font-mono text-cell tabular-nums text-hull">
      {usable
        ? (q * p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : '—'}
    </span>
  );
}

function ChargeLines({
  optionIndex,
  control,
  register,
  errors,
  reference,
  disabled,
}: {
  optionIndex: number;
  control: Control<AgentQuoteInput>;
  register: UseFormRegister<AgentQuoteInput>;
  errors: FieldErrors<AgentQuoteInput>;
  reference: AgentQuoteReferenceDto;
  disabled: boolean;
}) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: `options.${optionIndex}.lines`,
  });
  const lineErrors = errors.options?.[optionIndex]?.lines;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-260 border-collapse">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className="label-manifest px-2 py-2 text-left">Carrier</th>
              <th className="label-manifest px-2 py-2 text-left">Cost head *</th>
              <th className="label-manifest px-2 py-2 text-left">Container size</th>
              <th className="label-manifest px-2 py-2 text-left">Unit</th>
              <th className="label-manifest px-2 py-2 text-right">Qty *</th>
              <th className="label-manifest px-2 py-2 text-right">Unit price *</th>
              <th className="label-manifest px-2 py-2 text-left">Currency *</th>
              <th className="label-manifest px-2 py-2 text-right">Total</th>
              <th className="label-manifest px-2 py-2 text-right">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, lineIndex) => {
              const path = `options.${optionIndex}.lines.${lineIndex}` as const;
              const cell = lineErrors?.[lineIndex];
              return (
                <tr key={field.id} className="border-b border-line align-top last:border-0">
                  <td className="px-2 py-1.5">
                    <LookupCell
                      options={reference.carriers}
                      width="w-36"
                      placeholder="—"
                      {...register(`${path}.carrierId`)}
                      disabled={disabled}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <LookupCell
                      options={reference.costHeads}
                      width="w-44"
                      placeholder="Choose"
                      {...register(`${path}.costHeadId`)}
                      disabled={disabled}
                    />
                    <CellError message={cell?.costHeadId?.message} />
                  </td>
                  <td className="px-2 py-1.5">
                    <LookupCell
                      options={reference.containerTypes}
                      width="w-36"
                      placeholder="—"
                      {...register(`${path}.containerTypeId`)}
                      disabled={disabled}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <LookupCell
                      options={reference.costUnits}
                      width="w-32"
                      placeholder="—"
                      {...register(`${path}.costUnitId`)}
                      disabled={disabled}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      numeric
                      inputMode="decimal"
                      className="h-8 w-14 text-cell"
                      placeholder="2"
                      aria-label="Quantity"
                      {...register(`${path}.quantity`)}
                      disabled={disabled}
                    />
                    <CellError message={cell?.quantity?.message} />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      numeric
                      inputMode="decimal"
                      className="h-8 w-24 text-cell"
                      placeholder="1850.00"
                      aria-label="Unit price"
                      {...register(`${path}.unitPrice`)}
                      disabled={disabled}
                    />
                    <CellError message={cell?.unitPrice?.message} />
                  </td>
                  <td className="px-2 py-1.5">
                    <LookupCell
                      options={reference.currencies.map((c) => ({ id: c.id, label: c.code }))}
                      placeholder="Choose"
                      width="w-24"
                      {...register(`${path}.currencyId`)}
                      disabled={disabled}
                    />
                    <CellError message={cell?.currencyId?.message} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <LineTotal control={control} path={path} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    {/* The last line stays: an offer with no charges is not an
                        offer, and the schema refuses it anyway. */}
                    {fields.length > 1 && !disabled && (
                      <Button
                        type="button"
                        variant="destructive"
                        size="inline"
                        aria-label={`Remove charge line ${lineIndex + 1}`}
                        title="Remove this line"
                        onClick={() => remove(lineIndex)}
                      >
                        ×
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {typeof lineErrors?.message === 'string' && (
        <p className="text-cell text-alert">{lineErrors.message}</p>
      )}

      {!disabled && (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="compact"
            onClick={() => append({ ...EMPTY_LINE })}
          >
            Add charge line
          </Button>
        </div>
      )}
    </div>
  );
}

/** One alternative offer: its charges, then the routing they travel on. */
function OptionBlock({
  index,
  control,
  register,
  errors,
  reference,
  disabled,
  onRemove,
}: {
  index: number;
  control: Control<AgentQuoteInput>;
  register: UseFormRegister<AgentQuoteInput>;
  errors: FieldErrors<AgentQuoteInput>;
  reference: AgentQuoteReferenceDto;
  disabled: boolean;
  onRemove: (() => void) | null;
}) {
  const optionErrors = errors.options?.[index];
  const footer = [
    { name: 'transitDays', label: 'T/T (days)', placeholder: '22', numeric: true },
    { name: 'via', label: 'Via', placeholder: 'Singapore', numeric: false },
    { name: 'podFreeDays', label: 'POD free days', placeholder: '14', numeric: true },
    { name: 'validUntil', label: 'Validity', type: 'date', numeric: true },
    { name: 'etd', label: 'ETD', type: 'date', numeric: true },
    { name: 'eta', label: 'ETA', type: 'date', numeric: true },
  ] as const;

  return (
    <section className="rounded-manifest border border-line">
      <header className="flex items-center justify-between border-b border-line bg-paper px-4 py-2">
        <h3 className="text-section text-hull">Option {index + 1}</h3>
        {onRemove !== null && !disabled && (
          <Button type="button" variant="destructive" size="inline" onClick={onRemove}>
            Remove option
          </Button>
        )}
      </header>

      <div className="flex flex-col gap-4 p-4">
        <ChargeLines
          optionIndex={index}
          control={control}
          register={register}
          errors={errors}
          reference={reference}
          disabled={disabled}
        />

        <div className="grid grid-cols-2 gap-3 border-t border-line pt-4 md:grid-cols-6">
          {footer.map((f) => (
            <div key={f.name} className="flex flex-col gap-1">
              <label
                htmlFor={`options.${index}.${f.name}`}
                className="label-manifest"
              >
                {f.label}
              </label>
              <Input
                id={`options.${index}.${f.name}`}
                className="h-8 text-cell"
                numeric={f.numeric}
                {...('type' in f ? { type: f.type } : {})}
                {...('placeholder' in f ? { placeholder: f.placeholder } : {})}
                {...register(`options.${index}.${f.name}`, {
                  // The two day counts are numbers in the schema; an empty box
                  // must stay empty rather than becoming NaN.
                  ...(f.name === 'transitDays' || f.name === 'podFreeDays'
                    ? { setValueAs: (v: string) => (v === '' ? '' : Number(v)) }
                    : {}),
                })}
                disabled={disabled}
              />
              <CellError
                message={
                  (optionErrors as Record<string, { message?: string }> | undefined)?.[f.name]
                    ?.message
                }
              />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`options.${index}.remarks`} className="label-manifest">
            Remarks
          </label>
          <textarea
            id={`options.${index}.remarks`}
            rows={2}
            className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour disabled:bg-paper disabled:text-steel"
            placeholder="Anything the forwarder should know about this routing."
            {...register(`options.${index}.remarks`)}
            disabled={disabled}
          />
          <CellError message={optionErrors?.remarks?.message} />
        </div>
      </div>
    </section>
  );
}

export function QuoteForm({
  inquiryId,
  quote,
  quotable,
  onSaved,
}: {
  inquiryId: string;
  quote: AgentQuoteDto | null;
  quotable: boolean;
  onSaved: (saved: AgentQuoteDto) => void;
}) {
  const { authorizedRequest: request, authorizedList: list } = useSession();
  const [reference, setReference] = useState<AgentQuoteReferenceDto>(EMPTY_REFERENCE);
  const [formError, setFormError] = useState<string | null>(null);

  const defaults = useMemo(() => toFormValues(quote), [quote]);

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AgentQuoteInput>({
    resolver: zodResolver(agentQuoteInputSchema),
    defaultValues: defaults,
  });

  useEffect(() => {
    reset(defaults);
  }, [defaults, reset]);

  const { fields, append, remove } = useFieldArray({ control, name: 'options' });

  useEffect(() => {
    void (async () => {
      try {
        const result = await list<AgentQuoteReferenceDto>('/api/tenant/agent/currencies');
        setReference(result.data);
      } catch {
        // A quote cannot be typed without these, and the message below says so.
        setReference(EMPTY_REFERENCE);
      }
    })();
  }, [list]);

  const onSubmit = handleSubmit(
    useCallback(
      async (values: AgentQuoteInput) => {
        setFormError(null);
        try {
          const saved =
            quote === null
              ? await request<AgentQuoteDto>(`/api/tenant/agent/inquiries/${inquiryId}/quote`, {
                  method: 'POST',
                  body: values,
                })
              : await request<AgentQuoteDto>(`/api/tenant/agent/quotes/${quote.id}`, {
                  method: 'PATCH',
                  body: values,
                });
          // §9: the toast carries the same verb as the button.
          toast.success(quote === null ? 'Quote sent' : 'Quote updated');
          onSaved(saved);
        } catch (error) {
          setFormError(
            error instanceof ApiError
              ? error.message
              : 'Could not send your quote. Try again in a moment.',
          );
        }
      },
      [quote, request, inquiryId, onSaved],
    ),
  );

  const referenceMissing = reference.costHeads.length === 0 || reference.currencies.length === 0;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      {referenceMissing && quotable && (
        <p className="rounded-manifest border border-line bg-paper px-4 py-3 text-cell text-steel">
          The cost heads and currencies needed to price this have not loaded. Reload the page — if
          it keeps happening, tell your forwarder.
        </p>
      )}

      {fields.map((field, index) => (
        <OptionBlock
          key={field.id}
          index={index}
          control={control}
          register={register}
          errors={errors}
          reference={reference}
          disabled={!quotable}
          onRemove={fields.length > 1 ? () => remove(index) : null}
        />
      ))}

      {typeof errors.options?.message === 'string' && (
        <p className="text-cell text-alert">{errors.options.message}</p>
      )}

      {quotable && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? quote === null
                ? 'Sending…'
                : 'Updating…'
              : quote === null
                ? 'Send quote'
                : 'Update quote'}
          </Button>
          {fields.length < 5 && (
            <Button type="button" variant="secondary" onClick={() => append(emptyOption())}>
              Add another option
            </Button>
          )}
        </div>
      )}

      {formError !== null && <p className="text-body text-alert">{formError}</p>}
    </form>
  );
}
