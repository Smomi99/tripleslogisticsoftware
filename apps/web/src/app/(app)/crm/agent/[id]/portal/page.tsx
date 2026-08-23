'use client';

import type { AgentPicDto, PortalUserDto } from '@ff/shared';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ChildScreenHeader } from '@/components/ui/form-layout';
import { Modal } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * CRM → Agent → Portal access.
 *
 * The forwarder-facing half of the agent portal: this is where a contact
 * becomes a login. Without it the portal exists and nobody can reach it, which
 * is exactly the state this screen was written to fix.
 *
 * Superadmin only, and not behind a §7 permission key — handing an outside
 * company a way into the workspace is a different kind of decision from
 * editing a record, and there is no §7 feature that means "may create accounts
 * for people outside this company". See require-superadmin.ts.
 *
 * The forwarder never chooses the password. Inviting creates a dormant account
 * and emails a one-time link; the agent sets their own. A password your staff
 * typed is a password your staff knows.
 */

/** One line on the screen: a contact, the login it has, or both. */
interface Row {
  key: string;
  name: string;
  email: string | null;
  contactId: string | null;
  user: PortalUserDto | null;
}

function buildRows(contacts: AgentPicDto[], users: PortalUserDto[]): Row[] {
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
  const claimed = new Set<string>();

  const rows: Row[] = contacts.map((contact) => {
    const email = contact.email?.trim() ?? '';
    const user = email === '' ? null : (byEmail.get(email.toLowerCase()) ?? null);
    if (user !== null) claimed.add(user.id);
    return {
      key: `pic-${contact.id}`,
      name: contact.name,
      email: email === '' ? null : email,
      contactId: contact.id,
      user,
    };
  });

  // A login whose contact was renamed or removed still exists and still works,
  // so it has to be visible — otherwise the only way to revoke it would be the
  // database.
  for (const user of users) {
    if (claimed.has(user.id)) continue;
    rows.push({
      key: `user-${user.id}`,
      name: user.contactName ?? user.email,
      email: user.email,
      contactId: null,
      user,
    });
  }
  return rows;
}

function AccessStatus({ user }: { user: PortalUserDto | null }) {
  if (user === null) return <Status tone="inactive">No access</Status>;
  if (!user.isActive && user.invitePending) return <Status tone="pending">Invited</Status>;
  if (!user.isActive) return <Status tone="inactive">Disabled</Status>;
  return <Status tone="active">Active</Status>;
}

export default function AgentPortalAccessPage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;
  const { authorizedRequest, user: signedIn } = useSession();

  const [agentName, setAgentName] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toInvite, setToInvite] = useState<Row | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [parent, users, contacts] = await Promise.all([
        authorizedRequest<{ name: string }>(`/api/tenant/crm/agents/${agentId}/summary`),
        authorizedRequest<PortalUserDto[]>(`/api/tenant/crm/agents/${agentId}/portal-users`),
        authorizedRequest<AgentPicDto[]>(`/api/tenant/crm/agents/${agentId}/pics?limit=100`),
      ]);
      setAgentName(parent.name);
      setRows(buildRows(contacts, users));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load portal access.');
    }
  }, [authorizedRequest, agentId]);

  useEffect(() => {
    if (signedIn?.isSuperadmin === true) void load();
  }, [load, signedIn]);

  async function invite(row: Row): Promise<void> {
    if (row.contactId === null) return;
    setBusy(row.key);
    try {
      await authorizedRequest(`/api/tenant/crm/agents/${agentId}/portal-users`, {
        method: 'POST',
        body: { agentPicId: row.contactId },
      });
      toast.success(`Invitation sent to ${row.email ?? row.name}`);
      setToInvite(null);
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not send the invitation.');
    } finally {
      setBusy(null);
    }
  }

  async function resend(row: Row): Promise<void> {
    if (row.user === null) return;
    setBusy(row.key);
    try {
      await authorizedRequest(
        `/api/tenant/crm/agents/${agentId}/portal-users/${row.user.id}/reinvite`,
        { method: 'POST' },
      );
      // Worth saying out loud: the previous link stops working, which is the
      // reason to resend rather than ask the agent to find the old email.
      toast.success('New invitation sent. The previous link no longer works.');
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not resend.');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(row: Row): Promise<void> {
    if (row.user === null) return;
    setBusy(row.key);
    try {
      await authorizedRequest(
        `/api/tenant/crm/agents/${agentId}/portal-users/${row.user.id}/toggle-status`,
        { method: 'POST' },
      );
      toast.success(row.user.isActive ? 'Access withdrawn' : 'Access restored');
      await load();
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : 'Could not change access.');
    } finally {
      setBusy(null);
    }
  }

  if (signedIn?.isSuperadmin !== true) {
    return (
      <div className="flex flex-col gap-4">
        <ChildScreenHeader
          parentLabel="Agent"
          parentName="Portal access"
          title="Superadmin only"
          backHref="/crm/agent"
        />
        <p className="text-body text-steel">
          Only a superadmin can give an outside company a way into this workspace.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <ChildScreenHeader
        parentLabel="Agent"
        parentName={agentName === '' ? '…' : agentName}
        title="Portal access"
        backHref="/crm/agent"
      />

      <p className="max-w-3xl text-body text-steel">
        An invited contact can sign in at <span className="font-mono">/portal</span> and quote the
        inquiries you send them. They see the lane, the volumes and their own quote — never the
        customer, the target price or another agent&rsquo;s offer.
      </p>

      {error !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {error}
        </p>
      )}

      {rows === null && error === null && <p className="text-body text-steel">Loading…</p>}

      {rows !== null && rows.length === 0 && (
        <EmptyState
          title="No contacts to invite"
          description="Portal access is given to a named contact, so add a contact with an email address first."
        />
      )}

      {rows !== null && rows.length > 0 && (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full min-w-max border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Contact</th>
                <th className="label-manifest px-3 py-2 text-left">Email</th>
                <th className="label-manifest px-3 py-2 text-left">Access</th>
                <th className="label-manifest px-3 py-2 text-left">Last signed in</th>
                <th className="label-manifest px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-line last:border-0 hover:bg-row-hover [&>td]:align-top"
                >
                  <td className="whitespace-nowrap px-3 py-2 text-cell text-hull">{row.name}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-cell text-steel">
                    {row.email ?? <span className="text-alert">no email address</span>}
                  </td>
                  <td className="px-3 py-2 text-cell">
                    <AccessStatus user={row.user} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-cell tabular-nums text-steel">
                    {row.user?.lastLoginAt == null
                      ? '—'
                      : new Date(row.user.lastLoginAt).toISOString().slice(0, 10)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <span className="inline-flex gap-3">
                      {row.user === null && row.email !== null && (
                        <Button
                          variant="text"
                          size="inline"
                          disabled={busy === row.key}
                          onClick={() => setToInvite(row)}
                        >
                          Invite
                        </Button>
                      )}
                      {row.user === null && row.email === null && (
                        <span className="text-cell text-steel">Add an email first</span>
                      )}
                      {/*
                        Three states, three actions. An invited account is
                        dormant BECAUSE the agent has not chosen a password
                        yet — offering "Restore access" there would switch it
                        on with a password nobody has ever set, which is
                        confusing rather than dangerous, and reads as though
                        the invite had been skipped.
                      */}
                      {row.user !== null && row.user.invitePending && (
                        <Button
                          variant="text"
                          size="inline"
                          disabled={busy === row.key}
                          onClick={() => void resend(row)}
                        >
                          Resend invite
                        </Button>
                      )}
                      {row.user !== null && row.user.isActive && (
                        <Button
                          variant="destructive"
                          size="inline"
                          disabled={busy === row.key}
                          onClick={() => void toggle(row)}
                        >
                          Withdraw access
                        </Button>
                      )}
                      {row.user !== null && !row.user.isActive && !row.user.invitePending && (
                        <Button
                          variant="text"
                          size="inline"
                          disabled={busy === row.key}
                          onClick={() => void toggle(row)}
                        >
                          Restore access
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* §12: every outward-facing action confirms. This one sends an email to
          somebody outside the company, which is not undoable. */}
      <Modal
        open={toInvite !== null}
        onOpenChange={(open) => !open && setToInvite(null)}
        title="Invite to the portal"
        description={
          toInvite === null
            ? ''
            : `${toInvite.name} at ${agentName} will be emailed a link to set their own password.`
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-body text-steel">
            The link goes to <span className="font-mono text-hull">{toInvite?.email}</span> and can
            be used once, within seven days. Nobody here sees the password they choose.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setToInvite(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null}
              onClick={() => toInvite !== null && void invite(toInvite)}
            >
              {busy !== null ? 'Sending…' : 'Send invitation'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
