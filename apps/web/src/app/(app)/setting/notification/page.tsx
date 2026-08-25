'use client';

import { type NotificationSettingDto, notificationSettingSchema } from '@ff/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { SignatureLogos } from './signature-logos';

const ENDPOINT = '/api/tenant/setting/notifications';

/**
 * Settings → Notifications.
 *
 * One field, so no list and no modal: the screen IS the form. It exists because
 * "who hears about an outbound lane with no rate" is a thing the client should
 * be able to change without a developer.
 */
export default function NotificationSettingPage() {
  const { authorizedRequest, can } = useSession();
  const [priceTeamEmails, setPriceTeamEmails] = useState('');
  const [signatureBlock, setSignatureBlock] = useState('');
  const [isLoading, setLoading] = useState(true);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void authorizedRequest<NotificationSettingDto>(ENDPOINT)
      .then((data) => {
        if (!cancelled) {
          setPriceTeamEmails(data.priceTeamEmails);
          setSignatureBlock(data.signatureBlock);
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
    const parsed = notificationSettingSchema.safeParse({ priceTeamEmails, signatureBlock });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the addresses.');
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

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Notifications"
        description="Who the software writes to when an inquiry needs a price."
      />

      <div className="max-w-2xl rounded-manifest border border-line bg-surface p-4 shadow-manifest">
        <Field
          id="priceTeamEmails"
          label="Price team"
          hint="Told when an outbound lane has no live buying rate. Separate addresses with commas."
          error={error ?? undefined}
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

        <div className="mt-5 border-t border-line pt-4">
          <Field
            id="signatureBlock"
            label="Email signature"
            hint="The company block at the foot of every rate request sent to an agent or a carrier. Your name and designation are added above it from the inquiry's salesman."
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
              className="w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
            />
          </Field>
          <p className="mt-2 text-cell text-steel">
            Left empty, the letters still go — unsigned. Nothing is filled in for you, because a
            sign-off is the one part of a rate request that has to be yours.
          </p>
        </div>

        <SignatureLogos mayEdit={mayEdit} />

        {mayEdit && (
          <div className="mt-4">
            <Button onClick={() => void save()} disabled={isSaving || isLoading}>
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
