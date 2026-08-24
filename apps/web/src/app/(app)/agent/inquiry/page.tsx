'use client';

import type { AgentInquiryDto, AgentInquiryVolumeDto } from '@ff/shared';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/field';
import { Status } from '@/components/ui/status';
import { useSession } from '@/lib/session';

/**
 * Agent Inquiry — the inquiries this agent was asked to price.
 *
 * The columns are the client's wireframe, in its order: inquiry no, date,
 * commodity, shipment type, POL/AOL, POD/AOD, required container, valid to
 * date, quotation, status, action.
 *
 * Every row is one the forwarder chose to show them. There is no browse, no
 * search across the workspace and no "open inquiries near you" — being selected
 * is the whole of the authorization model, and the screen should read that way.
 *
 * It lives inside the ordinary app shell because an agent is an ordinary user:
 * same sign-in, same session, a role that carries AGENT.INQUIRY and nothing
 * else. The sidebar shows them this group alone because §7 layer 3 already
 * hides a module the user holds no VIEW on.
 */

/**
 * "20STD(1) + 40HC(1)" for a box shipment, "200 Kg" for air.
 *
 * The wireframe writes both forms in the same column, which is right: what the
 * forwarder needs priced is a quantity of something, and what that something is
 * depends on the trade. A container shipment counts boxes, an air shipment
 * weighs, and an LCL one measures.
 */
function requiredLoad(volumes: AgentInquiryVolumeDto[]): string {
  const parts = volumes
    .map((volume) => {
      const box = volume.containerSizeName ?? volume.containerSizeNote;
      if (box !== null && box !== '') {
        return volume.quantity === null ? box : `${box}(${volume.quantity})`;
      }
      if (volume.weightKg !== null && volume.weightKg !== '') {
        return `${trimZeros(volume.weightKg)} Kg`;
      }
      if (volume.cbm !== null && volume.cbm !== '') {
        return `${trimZeros(volume.cbm)} CBM`;
      }
      return null;
    })
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? '—' : parts.join(' + ');
}

/** "200.000" -> "200". Postgres pads NUMERIC; a cargo weight does not need it. */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

const QUOTE_TONE: Record<string, 'active' | 'pending' | 'inactive'> = {
  SUBMITTED: 'pending',
  WON: 'active',
  LOST: 'inactive',
  WITHDRAWN: 'inactive',
};

const QUOTE_LABEL: Record<string, string> = {
  SUBMITTED: 'Awaiting answer',
  WON: 'Won',
  LOST: 'Lost',
  WITHDRAWN: 'Withdrawn',
};

export default function PortalInquiryListPage() {
  const { authorizedList: list } = useSession();
  const [inquiries, setInquiries] = useState<AgentInquiryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  // Debounced, like every other search box in the product (§8).
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (pendingOnly) params.set('pending', 'true');
      if (query !== '') params.set('search', query);
      const suffix = params.toString();
      const result = await list<AgentInquiryDto[]>(
        `/api/tenant/agent/inquiries${suffix === '' ? '' : `?${suffix}`}`,
      );
      setInquiries(result.data);
    } catch {
      setError('Could not load your inquiries. Try again in a moment.');
    }
  }, [list, pendingOnly, query]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-page-title text-hull">Inquiries</h1>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-body text-steel">
            <input
              type="checkbox"
              checked={pendingOnly}
              onChange={(event) => setPendingOnly(event.target.checked)}
              className="h-4 w-4 rounded-manifest border-line accent-harbour"
            />
            Not yet quoted
          </label>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            aria-label="Search inquiries"
            className="w-52"
          />
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="text-body text-alert">
          {error}
        </p>
      )}

      {inquiries === null && error === null && <p className="text-body text-steel">Loading…</p>}

      {inquiries !== null && inquiries.length === 0 && (
        <EmptyState
          title={
            query !== ''
              ? 'Nothing matches that'
              : pendingOnly
                ? 'Nothing waiting for a price'
                : 'No inquiries yet'
          }
          description={
            query !== ''
              ? 'Try an inquiry number, or a loading or discharge port.'
              : pendingOnly
                ? 'You have quoted everything your forwarder has sent you.'
                : 'When your forwarder sends you an inquiry to price, it will appear here and you will get an email.'
          }
        />
      )}

      {inquiries !== null && inquiries.length > 0 && (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full min-w-275 border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Inquiry No</th>
                <th className="label-manifest px-3 py-2 text-left">Date</th>
                <th className="label-manifest px-3 py-2 text-left">Commodity</th>
                <th className="label-manifest px-3 py-2 text-left">Shipment type</th>
                <th className="label-manifest px-3 py-2 text-left">POL/AOL</th>
                <th className="label-manifest px-3 py-2 text-left">POD/AOD</th>
                <th className="label-manifest px-3 py-2 text-left">Required container</th>
                <th className="label-manifest px-3 py-2 text-left">Valid to date</th>
                <th className="label-manifest px-3 py-2 text-left">Quotation</th>
                <th className="label-manifest px-3 py-2 text-left">Status</th>
                <th className="label-manifest px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {inquiries.map((inquiry) => {
                // typedRoutes will not accept a template literal carrying a
                // hash, so the anchored links go through the object form.
                const pathname = `/agent/inquiry/${inquiry.id}` as const;
                const at = (hash: string) => ({ pathname, hash });
                const quote = inquiry.quote;
                return (
                  <tr
                    key={inquiry.id}
                    className="border-b border-line last:border-0 hover:bg-row-hover"
                  >
                    {/* §12: the business code is mono, on a tinted gutter — the
                        anchor the eye returns to when scanning a column. */}
                    <td className="bg-paper/40 px-3 py-2 font-mono text-cell tabular-nums text-hull">
                      {inquiry.code}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-cell tabular-nums text-steel">
                      {inquiry.inquiryDate}
                    </td>
                    <td className="px-3 py-2 text-cell text-hull">
                      {inquiry.commodityName ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-cell text-steel">
                      {inquiry.shipmentType}
                      {inquiry.loadingType !== null && ` · ${inquiry.loadingType}`}
                    </td>
                    <td className="px-3 py-2 text-cell text-hull">{inquiry.polName ?? '—'}</td>
                    <td className="px-3 py-2 text-cell text-hull">{inquiry.podName ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-cell tabular-nums text-hull">
                      {requiredLoad(inquiry.volumes)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-cell tabular-nums text-steel">
                      {inquiry.validTo ?? '—'}
                    </td>
                    {/* The wireframe shows a View link here, and a dash before
                        anything has been quoted. */}
                    <td className="px-3 py-2 text-cell">
                      {quote === null ? (
                        <span className="text-steel">–</span>
                      ) : (
                        <Link href={at('quotation')} className="text-harbour hover:underline">
                          View
                        </Link>
                      )}
                    </td>
                    {/*
                      The wireframe labels this "Check". The state itself is
                      strictly more useful in a column being scanned, and it
                      still links to the same place — the messages, and the
                      won/lost answer when it comes.
                    */}
                    <td className="whitespace-nowrap px-3 py-2 text-cell">
                      {quote === null ? (
                        <span className="text-steel">–</span>
                      ) : (
                        <Link href={at('status')} className="hover:underline">
                          <Status tone={QUOTE_TONE[quote.status] ?? 'inactive'}>
                            {QUOTE_LABEL[quote.status] ?? quote.status}
                          </Status>
                        </Link>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-cell">
                      <span className="inline-flex items-center gap-3">
                        <Link href={pathname} className="text-harbour hover:underline">
                          View
                        </Link>
                        <Link href={at('quotation')} className="text-harbour hover:underline">
                          {quote === null ? 'Quote' : 'Amend'}
                        </Link>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
