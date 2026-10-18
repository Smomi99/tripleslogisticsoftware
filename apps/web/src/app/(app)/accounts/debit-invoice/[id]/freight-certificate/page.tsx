'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  type FreightCertificateDto,
  type FreightCertificateFields,
  freightCertificateLabels,
  type FreightCertificateSaveInput,
  freightCertificateSaveSchema,
  type FreightCertificateViewDto,
} from '@ff/shared';
import Link from 'next/link';
import { type ReactNode, use, useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { amount } from '@/components/accounts/format';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

/**
 * Accounts → Debit Invoice → Freight Certificate (the client's sample of
 * 2026-10-18). Opened from the invoice's popup.
 *
 * Twelve fields, so a full page (§8). A new certificate starts from what the
 * booking says; the operator adds the shipper's invoice, EXP and LC numbers
 * and corrects anything else before saving. The dollar figure is the
 * server's, worked out from the invoice on every save.
 */

const FEATURE = 'ACCOUNTS.FREIGHT_CERTIFICATE';

const TEXTAREA = cn(
  'w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull',
  'focus:outline-2 focus:outline-offset-0 focus:outline-harbour',
  'disabled:cursor-not-allowed disabled:bg-paper disabled:text-steel',
  'aria-[invalid=true]:border-alert',
);

/** The form holds every box as a string; null is an empty box. */
function formValues(fields: FreightCertificateFields): FreightCertificateSaveInput {
  return {
    certificateDate: fields.certificateDate,
    shipperText: fields.shipperText,
    packages: fields.packages ?? '',
    commodity: fields.commodity ?? '',
    commercialInvoiceNo: fields.commercialInvoiceNo ?? '',
    commercialInvoiceDate: fields.commercialInvoiceDate ?? '',
    expNo: fields.expNo ?? '',
    expDate: fields.expDate ?? '',
    blNo: fields.blNo ?? '',
    lcNo: fields.lcNo ?? '',
    portOfLoading: fields.portOfLoading ?? '',
    portOfDelivery: fields.portOfDelivery ?? '',
  };
}

export default function FreightCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { authorizedRequest } = useSession();
  const endpoint = `/api/tenant/accounts/debit-invoices/${id}/freight-certificate`;
  const [view, setView] = useState<FreightCertificateViewDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await authorizedRequest<FreightCertificateViewDto>(endpoint));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the freight certificate.');
    }
  }, [authorizedRequest, endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <Link href={{ pathname: '/accounts/debit-invoice' }} className="text-cell text-harbour hover:underline">
      ← Back to list
    </Link>
  );

  if (error !== null) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyState title="Not available" description={error} />
      </div>
    );
  }
  if (view === null) return <p className="text-body text-steel">Loading…</p>;

  return (
    <CertificateForm
      // Rebuilt from what the server stored after every save.
      key={view.certificate?.updatedAt ?? 'new'}
      view={view}
      endpoint={endpoint}
      back={back}
      onSaved={(saved) => {
        // Only a standing invoice can be saved against, so it is printable now.
        setView({ ...view, certificate: saved, fields: saved.fields, figure: saved, printable: true });
      }}
    />
  );
}

function CertificateForm({
  view,
  endpoint,
  back,
  onSaved,
}: {
  view: FreightCertificateViewDto;
  endpoint: string;
  back: ReactNode;
  onSaved: (saved: FreightCertificateDto) => void;
}) {
  const { can, authorizedRequest, authorizedDownload } = useSession();
  const [formError, setFormError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const certificate = view.certificate;
  const labels = freightCertificateLabels(view.isAir);
  const figure = view.figure;

  const writable =
    view.lockedReason === null && (certificate === null ? can(`${FEATURE}.CREATE`) : can(`${FEATURE}.EDIT`));
  const canPrint = view.printable && can(`${FEATURE}.EXPORT_PDF`);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FreightCertificateSaveInput>({
    resolver: zodResolver(freightCertificateSaveSchema),
    defaultValues: formValues(view.fields),
  });

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const saved = await authorizedRequest<FreightCertificateDto>(endpoint, {
        method: certificate === null ? 'POST' : 'PATCH',
        body: values,
      });
      toast.success(certificate === null ? `Freight certificate ${saved.code} created` : 'Saved');
      onSaved(saved);
    } catch (caught) {
      if (caught instanceof ApiError && caught.fields !== undefined) {
        for (const [field, messages] of Object.entries(caught.fields)) {
          if (field in values) {
            setError(field as keyof FreightCertificateSaveInput, { message: messages[0] ?? 'Check this value.' });
          }
        }
        return;
      }
      setFormError(caught instanceof ApiError ? caught.message : 'Could not reach the server. Check your connection and try again.');
    }
  });

  async function download(): Promise<void> {
    if (certificate === null) return;
    setDownloading(true);
    try {
      await authorizedDownload(`${endpoint}/pdf`, `${certificate.code}.pdf`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not download the certificate.');
    } finally {
      setDownloading(false);
    }
  }

  /** register() plus the aria wiring every field here needs. */
  const field = (name: keyof FreightCertificateSaveInput) => ({
    id: name,
    disabled: !writable,
    'aria-invalid': errors[name] !== undefined,
    ...register(name),
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="label-manifest">Debit Invoice · {view.debitInvoiceCode}</p>
            <h1 className="text-page-title text-hull">
              Freight Certificate{' '}
              {certificate !== null && <span className="font-mono tabular-nums">{certificate.code}</span>}
            </h1>
            <p className="mt-0.5 text-body text-steel">
              <span className="font-mono tabular-nums">{view.bookingCode}</span> · {view.customerName}
            </p>
          </div>
          {canPrint && (
            <Button variant="secondary" disabled={downloading} onClick={() => void download()}>
              {downloading ? 'Downloading…' : 'Download PDF'}
            </Button>
          )}
        </div>
      </div>

      {view.lockedReason !== null && (
        <p className="rounded-manifest border border-signal/30 bg-signal/5 px-3 py-2 text-body text-hull">
          {view.lockedReason} The certificate cannot be {certificate === null ? 'made' : 'changed'} now.
        </p>
      )}

      {/* The figure is the invoice's, not the operator's — shown, never typed. */}
      <section className="grid gap-x-8 gap-y-3 rounded-manifest border border-line bg-surface p-5 shadow-manifest sm:grid-cols-3">
        <div>
          <p className="label-manifest">Ref No</p>
          <p className="font-mono text-body tabular-nums text-hull">{certificate?.code ?? 'Given when you create it'}</p>
        </div>
        <div className="sm:col-span-2">
          <p className="label-manifest">{labels.charges}</p>
          <p className="font-mono text-section tabular-nums text-hull">USD {amount(figure.amount)}</p>
          <p className="text-cell text-steel">{figure.amountInWords}</p>
        </div>
        {figure.baseCurrencyCode !== 'USD' && (
          <div>
            <p className="label-manifest">Conversion Rate</p>
            <p className="font-mono text-body tabular-nums text-hull">
              1 USD = {Number(figure.conversionRate).toString()} {figure.baseCurrencyCode}
            </p>
          </div>
        )}
        <p className="text-cell text-steel sm:col-span-2 sm:self-end">
          The invoice total in US dollars, worked out again each time the certificate is saved.
        </p>
      </section>

      <form
        onSubmit={(e) => void submit(e)}
        noValidate
        className="flex flex-col gap-5 rounded-manifest border border-line bg-surface p-5 shadow-manifest"
      >
        {formError !== null && (
          <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
            {formError}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field id="certificateDate" label="Date (DT)" required error={errors.certificateDate?.message}>
            <Input type="date" numeric {...field('certificateDate')} />
          </Field>
          <div className="hidden md:block" />

          <Field
            id="shipperText"
            label="Shipper / Exporter Name and Address"
            required
            error={errors.shipperText?.message}
            wide
          >
            <textarea rows={4} className={TEXTAREA} {...field('shipperText')} />
          </Field>

          <Field id="packages" label="Cartons/Bales" error={errors.packages?.message}>
            <Input {...field('packages')} />
          </Field>
          <Field id="commodity" label="Commodity" error={errors.commodity?.message}>
            <Input {...field('commodity')} />
          </Field>

          <Field id="commercialInvoiceNo" label="Invoice No" hint="The shipper's commercial invoice." error={errors.commercialInvoiceNo?.message}>
            <Input numeric {...field('commercialInvoiceNo')} />
          </Field>
          <Field id="commercialInvoiceDate" label="Invoice Date" error={errors.commercialInvoiceDate?.message}>
            <Input type="date" numeric {...field('commercialInvoiceDate')} />
          </Field>

          <Field id="expNo" label="Exp No" error={errors.expNo?.message}>
            <Input numeric {...field('expNo')} />
          </Field>
          <Field id="expDate" label="Exp Date" error={errors.expDate?.message}>
            <Input type="date" numeric {...field('expDate')} />
          </Field>

          <Field id="blNo" label={labels.blNo} error={errors.blNo?.message}>
            <Input numeric {...field('blNo')} />
          </Field>
          <Field id="lcNo" label="LC/TT/Sales Contract No" error={errors.lcNo?.message}>
            <Input numeric {...field('lcNo')} />
          </Field>

          <Field id="portOfLoading" label={labels.portOfLoading} error={errors.portOfLoading?.message}>
            <Input {...field('portOfLoading')} />
          </Field>
          <Field id="portOfDelivery" label={labels.portOfDelivery} error={errors.portOfDelivery?.message}>
            <Input {...field('portOfDelivery')} />
          </Field>
        </div>

        {writable && (
          <div className="flex items-center gap-2 border-t border-line pt-4">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : certificate === null ? 'Create certificate' : 'Save changes'}
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
