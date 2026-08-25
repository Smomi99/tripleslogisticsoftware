'use client';

import type { MailSignatureLogoDto } from '@ff/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The logos at the foot of an outgoing rate request.
 *
 * The client's signature carries three — their own mark, and the BAFFA and DP
 * Alliance memberships. The second two are credentials a carrier's pricing desk
 * looks for before answering a company it has not dealt with, so this screen
 * shows them at the size they will actually be sent rather than as filenames.
 *
 * They travel inside the message as inline attachments. A hosted image is
 * blocked by default in Outlook and Gmail, which would turn the one part of the
 * letter meant to establish credibility into three broken boxes.
 */
export function SignatureLogos({ mayEdit }: { mayEdit: boolean }) {
  const { authorizedRequest, authorizedUpload, authorizedObjectUrl } = useSession();
  const [logos, setLogos] = useState<MailSignatureLogoDto[] | null>(null);
  const [altText, setAltText] = useState('');
  const [heightPx, setHeightPx] = useState('40');
  const [busy, setBusy] = useState(false);
  /** Object URLs for the previews, revoked when the list is replaced. */
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const rows = await authorizedRequest<MailSignatureLogoDto[]>(
        '/api/tenant/setting/notifications/logos',
      );
      setLogos(rows);

      // The images need the bearer token, so they are fetched rather than
      // linked. Previous URLs are revoked so the tab does not leak blobs.
      setPreviews((old) => {
        for (const url of Object.values(old)) URL.revokeObjectURL(url);
        return {};
      });
      const fetched: Record<string, string> = {};
      for (const row of rows) {
        try {
          fetched[row.id] = await authorizedObjectUrl(
            `/api/tenant/setting/notifications/logos/${row.id}/file`,
          );
        } catch {
          // Shown as its alt text instead; not worth an error toast.
        }
      }
      setPreviews(fetched);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not load the logos.');
    }
  }, [authorizedRequest, authorizedObjectUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload(): Promise<void> {
    const file = fileInput.current?.files?.[0];
    if (file === undefined) {
      toast.error('Choose an image first.');
      return;
    }
    if (altText.trim() === '') {
      toast.error('Say what the logo is, for readers who block images.');
      return;
    }
    setBusy(true);
    try {
      await authorizedUpload('/api/tenant/setting/notifications/logos', file, {
        altText: altText.trim(),
        heightPx,
      });
      toast.success(`${altText.trim()} added`);
      setAltText('');
      if (fileInput.current !== null) fileInput.current.value = '';
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not add that logo.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(logo: MailSignatureLogoDto): Promise<void> {
    setBusy(true);
    try {
      await authorizedRequest(`/api/tenant/setting/notifications/logos/${logo.id}`, {
        method: 'DELETE',
      });
      toast.success(`${logo.altText} removed`);
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not remove that logo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="text-section text-hull">Signature logos</h3>
      <p className="mt-1 text-cell text-steel">
        Shown in a row beneath the signature on every rate request. Sent inside the message, so
        they arrive even when the recipient blocks remote images.
      </p>

      {logos !== null && logos.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {logos.map((logo) => (
            <li
              key={logo.id}
              className="flex flex-wrap items-center gap-4 rounded-manifest border border-line px-3 py-2"
            >
              {/* Shown at the height it will be sent at, so what you see here
                  is what a carrier sees. */}
              {previews[logo.id] === undefined ? (
                <span className="text-cell text-steel">{logo.altText}</span>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={previews[logo.id]}
                  alt={logo.altText}
                  style={{ height: `${logo.heightPx}px` }}
                  className="w-auto"
                />
              )}
              <span className="text-cell text-hull">{logo.altText}</span>
              <span className="font-mono text-cell tabular-nums text-steel">
                {logo.heightPx}px
              </span>
              <span className="ml-auto">
                {mayEdit && (
                  <Button
                    variant="destructive"
                    size="inline"
                    disabled={busy}
                    onClick={() => void remove(logo)}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {logos !== null && logos.length === 0 && (
        <p className="mt-3 text-cell text-steel">
          No logos yet. Your own mark and any association memberships belong here — they are the
          part of a rate request that tells a stranger who they are dealing with.
        </p>
      )}

      {mayEdit && (
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <Field id="logoAlt" label="What it is">
            <Input
              id="logoAlt"
              value={altText}
              onChange={(event) => setAltText(event.target.value)}
              placeholder="BAFFA member"
            />
          </Field>
          <Field id="logoHeight" label="Height">
            <Input
              id="logoHeight"
              value={heightPx}
              inputMode="numeric"
              onChange={(event) => setHeightPx(event.target.value)}
              className="font-mono tabular-nums"
            />
          </Field>
          <div className="flex items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              aria-label="Logo image"
              className="text-cell text-steel file:mr-2 file:rounded-manifest file:border file:border-line file:bg-surface file:px-2 file:py-1 file:text-cell file:text-hull"
            />
            <Button onClick={() => void upload()} disabled={busy}>
              {busy ? 'Adding…' : 'Add logo'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
