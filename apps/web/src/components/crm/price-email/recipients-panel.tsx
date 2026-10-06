'use client';

import { PRICE_EMAIL_PARTY_NOUN, type PriceEmailParty } from '@ff/shared';
import { type KeyboardEvent, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { Status } from '@/components/ui/status';
import { cn } from '@/lib/utils';

/** One address on the screen, with where its check has got to. */
export interface AddressRow {
  /** Stable across edits, so React keeps the chip it was editing. */
  key: string;
  address: string;
  picName: string | null;
  valid: boolean;
  reason: string | null;
  checking: boolean;
}

/** A customer or agent, and the addresses their letter goes to. */
export interface RecipientRow {
  partyId: string;
  partyCode: string;
  partyName: string;
  emails: AddressRow[];
}

/**
 * Step 1 — who the letter goes to.
 *
 * Every address is a chip: green when it can be sent to, red with the reason
 * when it cannot. Click the address to correct it in place, × to drop it.
 * A red address is never sent to, so tidying is optional — but the reason is
 * right there, because fixing a typo is usually quicker than losing the
 * customer or agent.
 */
export function RecipientsPanel({
  party,
  recipients,
  onEdit,
  onRemove,
  onAdd,
  onRemoveAllInvalid,
}: {
  party: PriceEmailParty;
  recipients: RecipientRow[];
  onEdit: (partyId: string, key: string, next: string) => void;
  onRemove: (partyId: string, key: string) => void;
  onAdd: (partyId: string, address: string) => void;
  onRemoveAllInvalid: () => void;
}) {
  const noun = PRICE_EMAIL_PARTY_NOUN[party];
  const [view, setView] = useState<'all' | 'invalid'>('all');

  const all = recipients.flatMap((r) => r.emails);
  const invalid = all.filter((e) => !e.checking && !e.valid).length;
  const valid = all.filter((e) => !e.checking && e.valid).length;
  const shown =
    view === 'invalid'
      ? recipients.filter((r) => r.emails.some((e) => !e.checking && !e.valid))
      : recipients;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-body text-hull">
          <span className="font-mono tabular-nums">{recipients.length}</span> {noun.many} ·{' '}
          <span className="font-mono tabular-nums text-verified">{valid}</span> valid ·{' '}
          <span className={cn('font-mono tabular-nums', invalid > 0 ? 'text-alert' : 'text-steel')}>
            {invalid}
          </span>{' '}
          invalid
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label={`Which ${noun.many} to show`}
            value={view}
            options={[
              ['all', 'All'],
              ['invalid', `Invalid only (${invalid})`],
            ]}
            onChange={setView}
          />
          {invalid > 0 && (
            <Button variant="destructive" size="inline" onClick={onRemoveAllInvalid}>
              Remove all invalid
            </Button>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-manifest border border-line">
        <table className="w-full min-w-180 border-collapse text-cell">
          <thead>
            <tr className="border-b border-line bg-paper">
              <th className="label-manifest w-64 px-3 py-2 text-left">{noun.label}</th>
              <th className="label-manifest px-3 py-2 text-left">Email addresses</th>
              <th className="label-manifest w-36 px-3 py-2 text-left">Will receive</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-steel">
                  {view === 'invalid' ? 'Every address checks out.' : `No ${noun.many}.`}
                </td>
              </tr>
            ) : (
              shown.map((row) => (
                <PartyRow
                  key={row.partyId}
                  row={row}
                  onEdit={(key, next) => onEdit(row.partyId, key, next)}
                  onRemove={(key) => onRemove(row.partyId, key)}
                  onAdd={(address) => onAdd(row.partyId, address)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PartyRow({
  row,
  onEdit,
  onRemove,
  onAdd,
}: {
  row: RecipientRow;
  onEdit: (key: string, next: string) => void;
  onRemove: (key: string) => void;
  onAdd: (address: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const good = row.emails.filter((e) => !e.checking && e.valid).length;
  const problems = row.emails.filter((e) => !e.checking && !e.valid);

  return (
    <tr className="border-b border-line align-top last:border-0 hover:bg-row-hover">
      <td className="px-3 py-2">
        <span className="block font-mono tabular-nums text-steel">{row.partyCode}</span>
        <span className="text-body text-hull">{row.partyName}</span>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {row.emails.length === 0 && !adding && (
            <span className="text-steel">No email on file.</span>
          )}
          {row.emails.map((email) => (
            <AddressChip
              key={email.key}
              row={email}
              onCommit={(next) => onEdit(email.key, next)}
              onRemove={() => onRemove(email.key)}
            />
          ))}
          {adding ? (
            <AddressInput
              initial=""
              label={`New address for ${row.partyName}`}
              onDone={(value) => {
                setAdding(false);
                if (value !== '') onAdd(value);
              }}
            />
          ) : (
            <Button variant="text" size="inline" onClick={() => setAdding(true)}>
              + Add
            </Button>
          )}
        </div>
        {/* The reasons, in words, under the chips they belong to. */}
        {problems.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {problems.map((email) => (
              <li key={email.key} className="text-cell text-alert">
                {email.address} — {email.reason}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2">
        {good > 0 ? (
          <Status tone="active">
            Yes · <span className="font-mono tabular-nums">{good}</span>
          </Status>
        ) : (
          <Status tone="pending">Skipped — no valid address</Status>
        )}
      </td>
    </tr>
  );
}

/** A chip: the dot says the verdict, the address opens for editing, × drops it. */
function AddressChip({
  row,
  onCommit,
  onRemove,
}: {
  row: AddressRow;
  onCommit: (next: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <AddressInput
        initial={row.address}
        label={`Edit ${row.address}`}
        onDone={(value) => {
          setEditing(false);
          if (value === '') onRemove();
          else if (value !== row.address) onCommit(value);
        }}
      />
    );
  }

  const state = row.checking ? 'checking' : row.valid ? 'valid' : 'invalid';
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-manifest border pl-2 pr-0.5',
        state === 'valid' && 'border-verified/40 bg-verified/5',
        state === 'invalid' && 'border-alert/40 bg-alert/5',
        state === 'checking' && 'border-line bg-paper',
      )}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          state === 'valid' && 'bg-verified',
          state === 'invalid' && 'bg-alert',
          state === 'checking' && 'animate-pulse bg-steel motion-reduce:animate-none',
        )}
        aria-hidden="true"
      />
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={cn(
          'text-cell hover:underline underline-offset-2',
          state === 'invalid' ? 'text-alert' : 'text-hull',
        )}
        title={row.picName === null ? 'Click to edit' : `${row.picName} — click to edit`}
      >
        {row.address}
        <span className="sr-only">
          {state === 'checking' ? ', checking' : state === 'valid' ? ', valid' : `, invalid: ${row.reason ?? ''}`}
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${row.address}`}
        className="grid size-6 place-items-center rounded-manifest text-steel transition-colors duration-120 hover:bg-line hover:text-hull"
      >
        ×
      </button>
    </span>
  );
}

/**
 * The inline editor. Enter or leaving the field saves, Escape abandons.
 *
 * Enter followed by the blur that unmounting causes would save twice, so the
 * first one wins and the second is ignored.
 */
function AddressInput({
  initial,
  label,
  onDone,
}: {
  initial: string;
  label: string;
  onDone: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);

  const finish = (value: string): void => {
    if (done.current) return;
    done.current = true;
    onDone(value.trim());
  };

  return (
    <input
      autoFocus
      aria-label={label}
      value={draft}
      placeholder="name@company.com"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(draft)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(draft);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(initial);
        }
      }}
      className="h-7 w-64 rounded-manifest border border-harbour bg-surface px-2 text-cell text-hull focus:outline-2 focus:outline-offset-0 focus:outline-harbour"
    />
  );
}
