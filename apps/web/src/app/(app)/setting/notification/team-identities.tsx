'use client';

import {
  NOTIFICATION_TEAM_APPLICABLE_FOR,
  NOTIFICATION_TEAM_LABEL,
  type NotificationTeamDto,
  type NotificationTeamsDto,
  notificationTeamsSaveSchema,
} from '@ff/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

const ENDPOINT = '/api/tenant/setting/notifications/teams';

const TEXTAREA =
  'w-full rounded-manifest border border-line bg-surface px-2.5 py-1.5 text-body text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour';

/**
 * The client's Notification sheet: five teams, each with the letters it sends,
 * its sender, its reply-to address and its signature
 * (docs/DESIGN-UPDATE-2026-10-04.md §7). A team left blank sends exactly as the
 * workspace always has.
 */
export function TeamIdentities({ mayEdit }: { mayEdit: boolean }) {
  const { authorizedRequest } = useSession();
  const [sendAsTeam, setSendAsTeam] = useState(false);
  const [teams, setTeams] = useState<NotificationTeamDto[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void authorizedRequest<NotificationTeamsDto>(ENDPOINT)
      .then((data) => {
        if (cancelled) return;
        setSendAsTeam(data.sendAsTeam);
        setTeams(data.teams);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest]);

  function edit(index: number, patch: Partial<NotificationTeamDto>): void {
    setTeams((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  }

  async function save(): Promise<void> {
    const parsed = notificationTeamsSaveSchema.safeParse({ sendAsTeam, teams });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the addresses.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const saved = await authorizedRequest<NotificationTeamsDto>(ENDPOINT, { method: 'PUT', body: parsed.data });
      setSendAsTeam(saved.sendAsTeam);
      setTeams(saved.teams);
      toast.success('Team settings saved');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the team settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-5xl rounded-manifest border border-line bg-surface p-4 shadow-manifest">
      <p className="text-body text-steel">
        Each team&apos;s letters go out with its reply-to address and its signature. Replies reach the team,
        not the sending account.
      </p>

      <label className="mt-3 flex items-start gap-2 text-body text-hull">
        <input
          type="checkbox"
          checked={sendAsTeam}
          disabled={isLoading || !mayEdit}
          onChange={(e) => setSendAsTeam(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-harbour"
        />
        <span>
          Our mail server may send as these addresses
          <span className="block text-cell text-steel">
            Tick only once your email provider allows the sending account to send as each team address.
            Otherwise the letters are refused or land in spam. Until then they come from the usual account,
            under your company name, with the team&apos;s address to reply to.
          </span>
        </span>
      </label>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {teams.map((team, index) => (
          <section key={team.team} className="rounded-manifest border border-line p-3">
            <h3 className="text-body font-semibold text-hull">{NOTIFICATION_TEAM_LABEL[team.team]}</h3>
            <p className="mb-3 text-cell text-steel">Sends: {NOTIFICATION_TEAM_APPLICABLE_FOR[team.team].join(' · ')}</p>
            <div className="flex flex-col gap-3">
              <Field id={`sender-${team.team}`} label="Sender email">
                <Input
                  id={`sender-${team.team}`}
                  type="email"
                  value={team.senderEmail}
                  disabled={isLoading || !mayEdit}
                  placeholder="team@example.com"
                  onChange={(e) => edit(index, { senderEmail: e.target.value })}
                />
              </Field>
              <Field id={`reply-${team.team}`} label="Reply to" hint="Left blank, replies go to the sender email.">
                <Input
                  id={`reply-${team.team}`}
                  type="email"
                  value={team.replyTo}
                  disabled={isLoading || !mayEdit}
                  onChange={(e) => edit(index, { replyTo: e.target.value })}
                />
              </Field>
              <Field id={`signature-${team.team}`} label="Email signature">
                <textarea
                  id={`signature-${team.team}`}
                  rows={3}
                  value={team.signature}
                  disabled={isLoading || !mayEdit}
                  placeholder={'Kind regards\nName\nDesignation'}
                  onChange={(e) => edit(index, { signature: e.target.value })}
                  className={TEXTAREA}
                />
              </Field>
            </div>
          </section>
        ))}
      </div>

      {error !== null && (
        <p role="alert" className="mt-3 text-cell text-alert">
          {error}
        </p>
      )}
      {mayEdit && (
        <div className="mt-4">
          <Button onClick={() => void save()} disabled={isSaving || isLoading}>
            {isSaving ? 'Saving…' : 'Save team settings'}
          </Button>
        </div>
      )}
    </div>
  );
}
