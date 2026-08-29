'use client';

import { AGENT_TYPE_LABEL, type AgentDto } from '@ff/shared';
import Link from 'next/link';

import { Status } from '@/components/ui/status';
import { Modal } from '@/components/ui/modal';

/**
 * One agent, read without leaving the list.
 *
 * The list can only carry a handful of columns, and an agent is mostly the
 * things that do not fit in one: which lanes they cover, what they are expert
 * in, which networks they belong to, and what is owed either way. Opening the
 * edit form to read any of that is how a record gets changed by accident.
 *
 * Everything here is already on the row — the list fetches whole agents — so
 * this costs no request and cannot show something staler than the table behind
 * it.
 */
export function AgentDetailDrawer({
  agent,
  onClose,
}: {
  agent: AgentDto | null;
  onClose: () => void;
}) {
  if (agent === null) return null;

  const facts: [string, string | null][] = [
    ['Code', agent.code],
    ['Type', AGENT_TYPE_LABEL[agent.agentType]],
    ['Country', agent.country],
    ['Address', agent.address],
    ['Contacts', `${agent.picCount}`],
    ['Agreement', agent.agreementFileName],
  ];

  const money: [string, string | null][] = [
    ['We owe', agent.weOwe],
    ['Agent owes', agent.agentOwe],
  ];
  const hasMoney = money.some(([, value]) => value !== null && value !== '');

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      title={agent.name}
      description={`${AGENT_TYPE_LABEL[agent.agentType]} agent in ${agent.country}.`}
      size="wide"
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <Status tone={agent.isActive ? 'active' : 'inactive'}>
            {agent.isActive ? 'Active' : 'Inactive'}
          </Status>
        </div>

        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="label-manifest">{label}</dt>
              <dd
                className={
                  label === 'Code' || label === 'Contacts'
                    ? 'font-mono text-body tabular-nums text-hull'
                    : 'whitespace-pre-line text-body text-hull'
                }
              >
                {value === null || value === '' ? '—' : value}
              </dd>
            </div>
          ))}
        </dl>

        {hasMoney && (
          <div className="grid gap-x-6 gap-y-3 border-t border-line pt-4 sm:grid-cols-2">
            {money.map(([label, value]) => (
              <div key={label}>
                <dt className="label-manifest">{label}</dt>
                <dd className="font-mono text-body tabular-nums text-hull">
                  {value === null || value === '' ? '—' : `${agent.openingCurrencyCode ?? ''} ${value}`.trim()}
                </dd>
              </div>
            ))}
          </div>
        )}

        {/*
          The three multi-selects, which are the whole reason this exists: a
          list column can hold one of them at most, and choosing who to send an
          RFQ to means reading all three at once.
        */}
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <Chips label="Expert areas" items={agent.expertAreas.map((a) => a.name)} />
          <Chips label="Port coverage" items={agent.portCoverage.map((p) => p.name)} />
          <Chips label="Networks" items={agent.networks.map((n) => n.name)} />
        </div>

        <div className="border-t border-line pt-4">
          <Link
            href={{ pathname: `/crm/agent/${agent.id}/pic` }}
            className="text-body text-harbour hover:underline"
          >
            Contacts ({agent.picCount})
          </Link>
        </div>
      </div>
    </Modal>
  );
}

/** A labelled row of values, or an honest dash when there are none. */
function Chips({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <span className="label-manifest">{label}</span>
      {items.length === 0 ? (
        <p className="text-body text-steel">— none recorded</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li
              key={item}
              className="rounded-manifest border border-line bg-paper px-2 py-0.5 text-cell text-hull"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
