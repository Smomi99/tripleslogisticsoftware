'use client';

import { type NotificationSettingDto, notificationSettingSchema } from '@ff/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { SignatureLogos } from './signature-logos';
import { TeamIdentities } from './team-identities';

const ENDPOINT = '/api/tenant/setting/notifications';

type Section = 'recipients' | 'signature' | 'quotation' | 'teams';

const SECTIONS = [
  { id: 'recipients', label: 'Recipients' },
  { id: 'signature', label: 'Signature' },
  { id: 'quotation', label: 'Quotation notes' },
  { id: 'teams', label: 'Teams' },
] as const satisfies readonly { id: Section; label: string }[];

type SettingField = keyof NotificationSettingDto;

/** The tab each field sits on, so a refused save opens the one that needs fixing. */
const FIELD_SECTION: Record<SettingField, Section> = {
  priceTeamEmails: 'recipients',
  bccAddresses: 'recipients',
  signatureBlock: 'signature',
  quotationNotes: 'quotation',
};

const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour';

const CARD = 'max-w-2xl rounded-manifest border border-line bg-surface p-4 shadow-manifest';

/**
 * Settings → Notifications.
 *
 * The screen is the form: no list, no modal. It grew one section at a time —
 * who hears about a lane with no rate, the blind copy, the signature and its
 * logos, the quotation notes, then the five teams — so it is split into tabs
 * rather than read as one long page. Recipients, Signature and Quotation notes
 * are one settings row and save together from whichever tab you are on; logos
 * and teams save on their own.
 */
export default function NotificationSettingPage() {
  const { authorizedRequest, can } = useSession();
  const [section, setSection] = useState<Section>('recipients');
  const [priceTeamEmails, setPriceTeamEmails] = useState('');
  const [signatureBlock, setSignatureBlock] = useState('');
  const [quotationNotes, setQuotationNotes] = useState('');
  const [bccAddresses, setBccAddresses] = useState('');
  const [isLoading, setLoading] = useState(true);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<{ field: SettingField; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void authorizedRequest<NotificationSettingDto>(ENDPOINT)
      .then((data) => {
        if (!cancelled) {
          setPriceTeamEmails(data.priceTeamEmails);
          setSignatureBlock(data.signatureBlock);
          setQuotationNotes(data.quotationNotes);
          setBccAddresses(data.bccAddresses);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest]);

  async function save(): Promise<void> {
    const parsed = notificationSettingSchema.safeParse({
      priceTeamEmails,
      signatureBlock,
      quotationNotes,
      bccAddresses,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = (issue?.path[0] ?? 'priceTeamEmails') as SettingField;
      setError({ field, message: issue?.message ?? 'Check the addresses.' });
      setSection(FIELD_SECTION[field]);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await authorizedRequest<NotificationSettingDto>(ENDPOINT, {
        method: 'PUT',
        body: parsed.data,
      });
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  const mayEdit = can('SETTING.NOTIFICATION.EDIT');
  const errorOf = (field: SettingField): string | undefined =>
    error?.field === field ? error.message : undefined;

  const saveButton = mayEdit && (
    <div className="mt-4">
      <Button onClick={() => void save()} disabled={isSaving || isLoading}>
        {isSaving ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Notifications"
        description="Who the software writes to, and how each team's letters are sent and signed."
      />

      <Tabs label="Notification settings" value={section} tabs={SECTIONS} onChange={setSection} idBase="notification" />

      <TabPanel idBase="notification" id="recipients" selected={section === 'recipients'}>
        <div className={CARD}>
          <Field
            id="priceTeamEmails"
            label="Price team"
            hint="Told when an outbound lane has no live buying rate. Separate addresses with commas."
            error={errorOf('priceTeamEmails')}
            wide
          >
            <Input
              id="priceTeamEmails"
              value={priceTeamEmails}
              disabled={isLoading || !mayEdit}
              placeholder="pricing@example.com, ops@example.com"
              onChange={(e) => setPriceTeamEmails(e.target.value)}
            />
          </Field>
          <p className="mt-3 text-cell text-steel">
            An inbound inquiry goes to the agent contacts chosen on it instead, and nothing is sent
            at all when the lane already has a live rate — there is nothing to ask for.
          </p>

          {/* Asked for by the client on 2026-09-01. */}
          <div className="mt-5 border-t border-line pt-4">
            <Field
              id="bccAddresses"
              label="Blind copy every message to"
              hint="Copied on everything the software sends — rate requests, quotations, alerts. The recipient never sees it. Separate addresses with commas."
              error={errorOf('bccAddresses')}
              wide
            >
              <Input
                id="bccAddresses"
                value={bccAddresses}
                disabled={isLoading || !mayEdit}
                placeholder="pricing@example.com"
                onChange={(e) => setBccAddresses(e.target.value)}
              />
            </Field>
            <p className="mt-2 text-cell text-steel">
              Two jobs at once: a copy in your own inbox is how you know a message actually left,
              and it puts the pricing team on every rate request without anybody having to remember
              to add them. Each address appears on the outbox record, so what was sent stays
              answerable later.
            </p>
          </div>

          {saveButton}
        </div>
      </TabPanel>

      <TabPanel idBase="notification" id="signature" selected={section === 'signature'}>
        <div className={CARD}>
          <Field
            id="signatureBlock"
            label="Email signature"
            hint="The company block at the foot of every rate request sent to an agent or a carrier. Your name and designation are added above it from the inquiry's salesman."
            error={errorOf('signatureBlock')}
            wide
          >
            <textarea
              id="signatureBlock"
              rows={5}
              value={signatureBlock}
              disabled={isLoading || !mayEdit}
              placeholder={[
                'YOUR COMPANY LTD',
                'Office address',
                'Tel: +880 ... | web: www.example.com',
              ].join('\n')}
              onChange={(e) => setSignatureBlock(e.target.value)}
              className={TEXTAREA}
            />
          </Field>
          <p className="mt-2 text-cell text-steel">
            Left empty, the letters still go — unsigned. Nothing is filled in for you, because a
            sign-off is the one part of a rate request that has to be yours.
          </p>

          {saveButton}

          <SignatureLogos mayEdit={mayEdit} />
        </div>
      </TabPanel>

      {/*
        §6.6 of the quotation module: "Standard notes, stored as editable
        tenant text, not hardcoded." They are commercial terms — what the
        quotation is not, who pays the tax, when payment is due — so a
        forwarder who words them differently must be able to say so without
        waiting for a release.

        Living on this screen because notification_setting is the workspace's
        one settings row and already carries the signature the Shipping Order
        PDF prints. The table's name is now narrower than its contents.
      */}
      <TabPanel idBase="notification" id="quotation" selected={section === 'quotation'}>
        <div className={CARD}>
          <Field
            id="quotationNotes"
            label="Quotation notes"
            hint="Printed at the foot of every quotation PDF, numbered in order. One per line."
            error={errorOf('quotationNotes')}
            wide
          >
            <textarea
              id="quotationNotes"
              rows={6}
              value={quotationNotes}
              disabled={isLoading || !mayEdit}
              onChange={(e) => setQuotationNotes(e.target.value)}
              className={TEXTAREA}
            />
          </Field>
          <p className="mt-2 text-cell text-steel">
            These start as the product&apos;s own wording. Clear them and the quotation prints no
            notes at all — which is a choice, not an accident.
          </p>

          {saveButton}
        </div>
      </TabPanel>

      <TabPanel idBase="notification" id="teams" selected={section === 'teams'}>
        <TeamIdentities mayEdit={mayEdit} />
      </TabPanel>
    </div>
  );
}
