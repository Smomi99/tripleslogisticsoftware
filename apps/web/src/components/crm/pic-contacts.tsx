'use client';

import type { AgentPicDto, CustomerPicDto } from '@ff/shared';
import type { Route } from 'next';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

type PicContact = CustomerPicDto | AgentPicDto;

/** The most a list endpoint will return in one page (listQuerySchema). */
const MAX_CONTACTS = 100;

/**
 * The contacts of one customer or agent, read inside its detail drawer.
 *
 * A count told the reader that people exist and nothing about how to reach
 * them — the one thing somebody opening a customer usually wants. The PIC
 * screen stays the place to add and edit them; this only reads.
 *
 * Active contacts first: an inactive one is somebody who has left, still shown
 * so the history is honest, but not the first number anyone should dial.
 */
export function PicContacts({
  endpoint,
  manageHref,
  emptyText,
}: {
  /** e.g. /api/tenant/crm/customers/12/pics */
  endpoint: string;
  manageHref: Route;
  emptyText: string;
}) {
  const { authorizedList } = useSession();
  const [contacts, setContacts] = useState<PicContact[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A drawer closed and reopened on another record must not show the
    // previous one's contacts if its response lands late.
    let cancelled = false;
    setContacts(null);
    setError(null);

    const params = new URLSearchParams({
      page: '1',
      limit: String(MAX_CONTACTS),
      sortBy: 'name',
      sortOrder: 'asc',
    });
    authorizedList<PicContact[]>(`${endpoint}?${params.toString()}`)
      .then(({ data, meta }) => {
        if (cancelled) return;
        setContacts([...data].sort((a, b) => Number(b.isActive) - Number(a.isActive)));
        setTotal(meta?.total ?? data.length);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause.message : 'Could not load the contacts.');
      });

    return () => {
      cancelled = true;
    };
  }, [authorizedList, endpoint]);

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4" aria-label="Contacts">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="label-manifest">
          Contacts
          {contacts !== null && (
            <span className="ml-1.5 font-mono tabular-nums text-hull">{total}</span>
          )}
        </span>
        <Link href={manageHref} className="text-body text-harbour hover:underline">
          Manage contacts
        </Link>
      </div>

      {error !== null ? (
        <p role="alert" className="text-body text-alert">
          {error}
        </p>
      ) : contacts === null ? (
        <p role="status" className="text-body text-steel">
          Loading contacts…
        </p>
      ) : contacts.length === 0 ? (
        <p className="text-body text-steel">{emptyText}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-manifest border border-line">
            <table className="w-full border-collapse text-cell">
              <thead>
                <tr className="bg-paper">
                  <th className="label-manifest border-b border-line px-3 py-2 text-left">Name</th>
                  <th className="label-manifest border-b border-line px-3 py-2 text-left">Department</th>
                  <th className="label-manifest border-b border-line px-3 py-2 text-left">Designation</th>
                  <th className="label-manifest border-b border-line px-3 py-2 text-right">Mobile</th>
                  <th className="label-manifest border-b border-line px-3 py-2 text-left">Email</th>
                  <th className="label-manifest border-b border-line px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr
                    key={contact.id}
                    className={
                      contact.isActive
                        ? 'h-9 border-b border-line text-hull last:border-b-0'
                        : 'h-9 border-b border-line text-steel last:border-b-0'
                    }
                  >
                    <td className="px-3">{contact.name}</td>
                    <td className="px-3">{contact.department ?? '—'}</td>
                    <td className="px-3">{contact.designation ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 text-right font-mono tabular-nums">
                      {contact.mobile ?? '—'}
                    </td>
                    <td className="px-3">{contact.email ?? '—'}</td>
                    <td className="px-3">
                      <Status tone={contact.isActive ? 'active' : 'inactive'}>
                        {contact.isActive ? 'Active' : 'Inactive'}
                      </Status>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > contacts.length && (
            <p className="text-cell text-steel">
              Showing the first{' '}
              <span className="font-mono tabular-nums text-hull">{contacts.length}</span> of{' '}
              <span className="font-mono tabular-nums text-hull">{total}</span>. Manage contacts
              lists them all.
            </p>
          )}
        </>
      )}
    </section>
  );
}
