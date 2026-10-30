'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  CONTACT_MODE_LABEL,
  CONTACT_MODES,
  type SalesLeadFollowupInput,
  salesLeadFollowupInputSchema,
} from '@ff/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Field, Input, Select } from '@/components/ui/field';
import { FormLayout } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-3 py-2 text-base text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour sm:px-2.5 sm:py-1.5 sm:text-body';

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * One conversation with a lead (docs/SALES_LEAD_FOB.md §5 step 05, §6 "Lead
 * activity history"): when, how, with whom, what was discussed, how it ended,
 * the target rate and objections heard, and what happens next.
 *
 * The next follow-up date set here becomes the lead's own — the latest
 * conversation decides when the next one is due.
 */
export function LeadFollowupForm({
  leadId,
  onSaved,
  onCancel,
}: {
  leadId: string;
  onSaved: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const { authorizedRequest } = useSession();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SalesLeadFollowupInput>({
    resolver: zodResolver(salesLeadFollowupInputSchema),
    defaultValues: {
      followupDate: today(),
      contactMode: 'CALL',
      contactPerson: '',
      notes: '',
      outcome: '',
      nextAction: '',
      targetRate: '',
      objections: '',
      nextFollowupDate: '',
    },
  });

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await authorizedRequest(`/api/tenant/sales/leads/${leadId}/followups`, {
        method: 'POST',
        body: values,
      });
      toast.success('Follow-up recorded');
      reset({ ...values, contactPerson: '', notes: '', outcome: '', nextAction: '', targetRate: '', objections: '', nextFollowupDate: '' });
      await onSaved();
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not record the follow-up. Try again.',
      );
    }
  });

  return (
    <FormLayout
      onSubmit={submit}
      {...(onCancel === undefined ? {} : { onCancel })}
      isPending={isSubmitting}
      submitLabel="Record follow-up"
      error={formError ?? undefined}
      columns={2}
    >
      <Field id="followupDate" label="Date" required error={errors.followupDate?.message}>
        <Input id="followupDate" type="date" numeric {...register('followupDate')} />
      </Field>
      <Field id="contactMode" label="Contact method" required error={errors.contactMode?.message}>
        <Select id="contactMode" {...register('contactMode')}>
          {CONTACT_MODES.map((value) => (
            <option key={value} value={value}>
              {CONTACT_MODE_LABEL[value]}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="contactPerson" label="Who you spoke to" error={errors.contactPerson?.message}>
        <Input id="contactPerson" {...register('contactPerson')} />
      </Field>
      <Field
        id="targetRate"
        label="Target rate heard (USD)"
        error={errors.targetRate?.message}
        hint="The customer's target, per container (CBM, KG)."
      >
        <Input id="targetRate" numeric inputMode="decimal" className="text-right" {...register('targetRate')} />
      </Field>
      <Field id="notes" label="Discussion" error={errors.notes?.message} wide>
        <textarea id="notes" rows={2} className={TEXTAREA} {...register('notes')} />
      </Field>
      <Field id="outcome" label="Outcome" error={errors.outcome?.message}>
        <Input id="outcome" {...register('outcome')} />
      </Field>
      <Field id="objections" label="Objections" error={errors.objections?.message}>
        <Input id="objections" {...register('objections')} />
      </Field>
      <Field id="nextAction" label="Next action" error={errors.nextAction?.message}>
        <Input id="nextAction" {...register('nextAction')} />
      </Field>
      <Field
        id="nextFollowupDate"
        label="Next follow-up"
        error={errors.nextFollowupDate?.message}
        hint="Becomes the lead's next follow-up date. Leave blank if none is planned."
      >
        <Input id="nextFollowupDate" type="date" numeric {...register('nextFollowupDate')} />
      </Field>
    </FormLayout>
  );
}
