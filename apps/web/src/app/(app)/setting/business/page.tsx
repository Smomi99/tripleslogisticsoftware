'use client';

import {
  BUSINESS_ADDRESS_MAX_LINES,
  type BusinessProfileDto,
  type BusinessProfileInput,
  type BusinessProfileValues,
  businessProfileSchema,
  letterheadDetailLines,
} from '@ff/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { ImagePlus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

const ENDPOINT = '/api/tenant/setting/business';
const LOGO_ENDPOINT = `${ENDPOINT}/logo`;
/** The API's own limit: the logo travels inside every PDF. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

// The Input's look, 16px on a phone so iOS does not zoom into it.
const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-3 py-2 text-base text-hull transition-[border-color,box-shadow] duration-[120ms] ease-manifest hover:border-steel/50 focus:border-harbour focus:outline-none focus:ring-3 focus:ring-harbour/20 disabled:cursor-not-allowed disabled:bg-paper disabled:text-steel sm:px-2.5 sm:py-1.5 sm:text-body';

const CARD = 'rounded-card border border-line bg-surface p-4 shadow-manifest sm:p-5';

const EMPTY: BusinessProfileValues = {
  businessName: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  binNo: '',
  tinNo: '',
  tradeLicenceNo: '',
};

function valuesOf(dto: BusinessProfileDto): BusinessProfileValues {
  return {
    businessName: dto.businessName,
    address: dto.address,
    phone: dto.phone,
    email: dto.email,
    website: dto.website,
    binNo: dto.binNo,
    tinNo: dto.tinNo,
    tradeLicenceNo: dto.tradeLicenceNo,
  };
}

/**
 * Settings → Business Settings (owner request, 2026-11-17).
 *
 * "We print lots of things; the business name and the rest should come from
 * here." The name, logo, address, contact and registration numbers, entered
 * once and read by every printed document. The preview beside the form draws
 * the same lines the PDFs draw (letterheadDetailLines in @ff/shared), so what
 * is on the screen is what goes on the page.
 *
 * The text saves with Save changes; the logo uploads and removes on its own,
 * the way Notifications' signature logos do — a file is not a field.
 */
export default function BusinessSettingsPage() {
  const { authorizedRequest, authorizedUpload, authorizedObjectUrl, can } = useSession();
  const mayEdit = can('SETTING.BUSINESS.EDIT');

  const [profile, setProfile] = useState<BusinessProfileDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** The object URL on screen, revoked when it is replaced or the page closes. */
  const shownLogo = useRef<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<BusinessProfileInput, unknown, BusinessProfileValues>({
    resolver: zodResolver(businessProfileSchema),
    defaultValues: EMPTY,
  });
  const watched = useWatch({ control });

  const showLogo = useCallback(
    async (hasLogo: boolean): Promise<void> => {
      // The image needs the bearer token, so it is fetched rather than linked.
      const url = hasLogo ? await authorizedObjectUrl(LOGO_ENDPOINT).catch(() => null) : null;
      if (shownLogo.current !== null) URL.revokeObjectURL(shownLogo.current);
      shownLogo.current = url;
      setLogoUrl(url);
    },
    [authorizedObjectUrl],
  );

  useEffect(() => {
    let cancelled = false;
    void authorizedRequest<BusinessProfileDto>(ENDPOINT)
      .then(async (data) => {
        if (cancelled) return;
        setProfile(data);
        reset(valuesOf(data));
        await showLogo(data.hasLogo);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setLoadError(caught instanceof ApiError ? caught.message : 'Could not load the business settings.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, reset, showLogo]);

  useEffect(
    () => () => {
      if (shownLogo.current !== null) URL.revokeObjectURL(shownLogo.current);
    },
    [],
  );

  const save = handleSubmit(async (values) => {
    try {
      const data = await authorizedRequest<BusinessProfileDto>(ENDPOINT, { method: 'PUT', body: values });
      setProfile(data);
      reset(valuesOf(data));
      toast.success('Saved');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not save.');
    }
  });

  async function uploadLogo(file: File): Promise<void> {
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      toast.error('The logo has to be a PNG or a JPG.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error('Keep the logo under 2 MB. It goes into every printed document.');
      return;
    }
    setLogoBusy(true);
    try {
      const data = await authorizedUpload<BusinessProfileDto>(LOGO_ENDPOINT, file);
      // Only the logo's state: the form may hold typing that is not saved yet.
      setProfile((old) => (old === null ? data : { ...old, hasLogo: data.hasLogo, updatedAt: data.updatedAt }));
      await showLogo(data.hasLogo);
      toast.success('Logo uploaded');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not upload the logo.');
    } finally {
      setLogoBusy(false);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  }

  async function removeLogo(): Promise<void> {
    setLogoBusy(true);
    try {
      const data = await authorizedRequest<BusinessProfileDto>(LOGO_ENDPOINT, { method: 'DELETE' });
      setProfile((old) => (old === null ? data : { ...old, hasLogo: data.hasLogo, updatedAt: data.updatedAt }));
      await showLogo(false);
      setConfirmRemove(false);
      toast.success('Logo removed');
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not remove the logo.');
    } finally {
      setLogoBusy(false);
    }
  }

  const editable = mayEdit && profile !== null;
  const previewName = (watched.businessName ?? '').trim();
  const previewLines = letterheadDetailLines({
    address: watched.address ?? '',
    phone: watched.phone ?? '',
    email: watched.email ?? '',
    website: watched.website ?? '',
    binNo: watched.binNo ?? '',
    tinNo: watched.tinNo ?? '',
    tradeLicenceNo: watched.tradeLicenceNo ?? '',
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Business Settings"
        description="Your company's name, logo, address and registration numbers. Every printed document takes them from here."
      />

      {loadError !== null && (
        <p role="alert" className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert">
          {loadError}
        </p>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <form onSubmit={(event) => void save(event)} noValidate className="min-w-0">
          {/* One switch for the whole form: read-only for a viewer, and while loading. */}
          <fieldset disabled={!editable} className="flex min-w-0 flex-col gap-4">
            <section className={CARD} aria-labelledby="business-company">
              <h2 id="business-company" className="text-section text-hull">
                Company
              </h2>
              <div className="mt-4 flex flex-col gap-4">
                <Field
                  id="businessName"
                  label="Business name"
                  required
                  error={errors.businessName?.message}
                  hint="Printed at the top of every document, exactly as typed."
                >
                  <Input
                    id="businessName"
                    autoComplete="organization"
                    aria-invalid={errors.businessName !== undefined}
                    {...register('businessName')}
                  />
                </Field>

                <div className="flex flex-col gap-1.5">
                  <span className="label-field">Logo</span>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex h-16 w-32 shrink-0 items-center justify-center overflow-hidden rounded-manifest border border-line bg-paper">
                      {logoUrl === null ? (
                        <ImagePlus className="size-5 text-steel" aria-hidden="true" />
                      ) : (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img src={logoUrl} alt="Your logo" className="max-h-14 max-w-28 object-contain" />
                      )}
                    </div>
                    {mayEdit && (
                      <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:*:flex-1">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={logoBusy}
                          onClick={() => fileInput.current?.click()}
                        >
                          {logoBusy ? 'Working…' : logoUrl === null ? 'Upload logo' : 'Replace logo'}
                        </Button>
                        {logoUrl !== null && (
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={logoBusy}
                            onClick={() => setConfirmRemove(true)}
                          >
                            Remove logo
                          </Button>
                        )}
                      </div>
                    )}
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg"
                      tabIndex={-1}
                      aria-hidden="true"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file !== undefined) void uploadLogo(file);
                      }}
                    />
                  </div>
                  <p className="text-cell text-steel">
                    PNG or JPG, under 2 MB. A wide logo on a clear background prints best. It uploads
                    straight away.
                  </p>
                </div>
              </div>
            </section>

            <section className={CARD} aria-labelledby="business-contact">
              <h2 id="business-contact" className="text-section text-hull">
                Address and contact
              </h2>
              <div className="mt-4 flex flex-col gap-4">
                <Field
                  id="address"
                  label="Office address"
                  error={errors.address?.message}
                  hint={`Printed under the name line for line, as you type it. Up to ${BUSINESS_ADDRESS_MAX_LINES} lines.`}
                >
                  <textarea
                    id="address"
                    rows={3}
                    autoComplete="street-address"
                    aria-invalid={errors.address !== undefined}
                    placeholder={['House 12, Road 5, Gulshan-1', 'Dhaka 1212, Bangladesh'].join('\n')}
                    className={TEXTAREA}
                    {...register('address')}
                  />
                </Field>
                <Field
                  id="phone"
                  label="Phone"
                  error={errors.phone?.message}
                  hint="Separate more than one number with commas."
                >
                  <Input
                    id="phone"
                    numeric
                    type="tel"
                    autoComplete="tel"
                    placeholder="+880 2 5501 2345, +880 1711 000000"
                    aria-invalid={errors.phone !== undefined}
                    {...register('phone')}
                  />
                </Field>
                <Field id="email" label="Email" error={errors.email?.message}>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="info@example.com"
                    aria-invalid={errors.email !== undefined}
                    {...register('email')}
                  />
                </Field>
                <Field id="website" label="Website" error={errors.website?.message}>
                  <Input
                    id="website"
                    inputMode="url"
                    autoComplete="url"
                    placeholder="www.example.com"
                    aria-invalid={errors.website !== undefined}
                    {...register('website')}
                  />
                </Field>
              </div>
            </section>

            <section className={CARD} aria-labelledby="business-registration">
              <h2 id="business-registration" className="text-section text-hull">
                Registration numbers
              </h2>
              <p className="mt-1 text-cell text-steel">
                Printed together on one line, under the contact details. Leave out any you do not want
                on your documents.
              </p>
              <div className="mt-4 flex flex-col gap-4">
                <Field id="binNo" label="BIN (VAT registration)" error={errors.binNo?.message}>
                  <Input id="binNo" numeric aria-invalid={errors.binNo !== undefined} {...register('binNo')} />
                </Field>
                <Field id="tinNo" label="TIN" error={errors.tinNo?.message}>
                  <Input id="tinNo" numeric aria-invalid={errors.tinNo !== undefined} {...register('tinNo')} />
                </Field>
                <Field id="tradeLicenceNo" label="Trade licence no" error={errors.tradeLicenceNo?.message}>
                  <Input
                    id="tradeLicenceNo"
                    numeric
                    aria-invalid={errors.tradeLicenceNo !== undefined}
                    {...register('tradeLicenceNo')}
                  />
                </Field>
              </div>
            </section>

            {mayEdit && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <Button type="submit" disabled={isSubmitting || profile === null} className="max-sm:w-full">
                  {isSubmitting ? 'Saving…' : 'Save changes'}
                </Button>
                {isDirty && <span className="text-cell text-signal-ink">You have changes that are not saved yet.</span>}
              </div>
            )}
          </fieldset>
        </form>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-4" aria-labelledby="business-preview">
          <section className={CARD}>
            <h2 id="business-preview" className="text-section text-hull">
              How it prints
            </h2>
            <p className="mt-1 text-cell text-steel">The top of a quotation, with what is on this page.</p>

            <LetterheadPreview name={previewName} lines={previewLines} logoUrl={logoUrl} />

            {profile !== null && profile.updatedAt === null && (
              <p className="mt-3 rounded-manifest bg-signal/10 px-3 py-2 text-cell text-signal-ink">
                Not saved yet. Until you save, documents print your workspace name with nothing under it.
              </p>
            )}

            <p className="mt-3 text-cell text-steel">
              The quotation, debit invoice, money receipt, shipping order, shipment advise and delivery
              order print all of this. The bill of lading and the air waybill keep their own layout and
              take the name and logo.
            </p>
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the logo?"
        message="Documents will print your business name without a logo until you upload another."
        confirmLabel="Remove logo"
        destructive
        isPending={logoBusy}
        onConfirm={() => void removeLogo()}
      />
    </div>
  );
}

/**
 * A sketch of the printed page's head: the logo left, the name beside it, the
 * detail lines under the name, then the title and its rule. Drawn on white
 * like the paper, with the PDF's proportions rather than the app's type scale.
 */
function LetterheadPreview({
  name,
  lines,
  logoUrl,
}: {
  name: string;
  lines: string[];
  logoUrl: string | null;
}) {
  return (
    <div className="mt-4 rounded-manifest border border-line bg-surface p-4 shadow-manifest" aria-live="polite">
      <div className="flex items-start gap-3">
        {logoUrl !== null && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={logoUrl} alt="" className="h-11 w-auto max-w-[6.5rem] shrink-0 object-contain object-left" />
        )}
        <div className="min-w-0">
          <p className={cn('break-words text-[15px] font-semibold leading-tight', name === '' ? 'text-steel' : 'text-hull')}>
            {name === '' ? 'Your business name' : name}
          </p>
          {lines.map((line, index) => (
            <p key={index} className="mt-0.5 break-words text-[11px] leading-snug text-steel">
              {line}
            </p>
          ))}
        </div>
      </div>
      <p className="mt-4 text-center text-[13px] font-semibold tracking-wide text-hull">QUOTATION</p>
      <div className="mt-2 border-t border-line" />
      {/* The rest of the page, suggested rather than drawn. */}
      <div className="mt-3 flex flex-col gap-1.5" aria-hidden="true">
        <div className="h-2 w-3/4 rounded-full bg-paper" />
        <div className="h-2 w-1/2 rounded-full bg-paper" />
        <div className="h-2 w-2/3 rounded-full bg-paper" />
      </div>
      {lines.length === 0 && (
        <p className="mt-3 text-cell text-steel">Add an address or a phone number and it appears under the name.</p>
      )}
    </div>
  );
}
