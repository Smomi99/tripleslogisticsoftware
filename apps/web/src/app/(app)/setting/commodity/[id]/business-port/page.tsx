'use client';

import {
  BUSINESS_PORT_ONE_SIDE,
  businessPortAccepts,
  businessPortPairs,
  businessPortShape,
  type CommodityBusinessPortDto,
} from '@ff/shared';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { ChildScreenHeader, FormLayout } from '@/components/ui/form-layout';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { MultiSelect } from '@/components/ui/multi-select';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

interface PortOption {
  id: string;
  name: string;
  portCode: string | null;
}

/** "CGP — Chattogram", or the bare name where a port carries no code. */
function portLabel(code: string | null, name: string): string {
  return code === null ? name : `${code} — ${name}`;
}

/**
 * Commodity Category → Business Port (client, 2026-09-12).
 *
 * The lanes a category is traded on. Both sides are multi-select because a
 * lane is one decision rather than a row at a time: three loading ports into
 * one discharge port is a single thing somebody knows, and asking for it as
 * three separate saves made "select multiple POL" impossible to say.
 *
 * One rule shapes the set — many in to one, or one out to many, never both.
 * Choosing on one side narrows the other as you go, so the rule shows itself
 * before it refuses anything; the API checks regardless, because a narrowed
 * picker is a courtesy.
 *
 * Written out rather than built on ChildScreen: that component saves one row
 * per submit and offers an Edit that PATCHes, and neither fits a lane.
 */
export default function CommodityBusinessPortPage() {
  const params = useParams<{ id: string }>();
  const sectorId = params.id;
  const { authorizedRequest, can } = useSession();

  const [parentName, setParentName] = useState('');
  const [rows, setRows] = useState<CommodityBusinessPortDto[]>([]);
  const [ports, setPorts] = useState<PortOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [toDelete, setToDelete] = useState<CommodityBusinessPortDto | null>(null);
  const [busy, setBusy] = useState(false);

  const endpoint = `/api/tenant/setting/commodity-categories/${sectorId}`;

  const reload = useCallback(async () => {
    setRows(await authorizedRequest<CommodityBusinessPortDto[]>(`${endpoint}/business-ports`));
  }, [authorizedRequest, endpoint]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [parent, list, options] = await Promise.all([
          authorizedRequest<{ id: string; name: string }>(`${endpoint}/summary`),
          authorizedRequest<CommodityBusinessPortDto[]>(`${endpoint}/business-ports`),
          authorizedRequest<{ ports: PortOption[] }>(
            '/api/tenant/setting/commodity-categories/business-port-options',
          ),
        ]);
        if (cancelled) return;
        setParentName(parent.name);
        setRows(list);
        setPorts(options.ports);
      } catch (error) {
        if (!cancelled) {
          toast.error(
            error instanceof ApiError ? error.message : 'Could not load the business ports.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedRequest, endpoint]);

  async function remove(): Promise<void> {
    if (toDelete === null) return;
    setBusy(true);
    try {
      await authorizedRequest(`${endpoint}/business-ports/${toDelete.id}`, { method: 'DELETE' });
      toast.success('Business port deleted');
      setToDelete(null);
      await reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not delete it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ChildScreenHeader
          parentLabel="Commodity category"
          parentName={parentName === '' ? '…' : parentName}
          title="Business Port"
          backHref={'/setting/commodity' as Route}
        />
        {can('SETTING.COMMODITY_CATEGORY.CREATE') && (
          <Button onClick={() => setFormOpen(true)}>+ Add business port</Button>
        )}
      </div>

      {loading ? (
        <p className="text-body text-steel">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No business ports yet"
          description="Add the lane this category trades on — several loading ports into one discharge port, or one loading port out to several."
        />
      ) : (
        <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line bg-paper">
                <th className="label-manifest px-3 py-2 text-left">Code</th>
                <th className="label-manifest px-3 py-2 text-left">POL</th>
                <th className="label-manifest px-3 py-2 text-left">POD</th>
                <th className="label-manifest px-3 py-2 text-left">Status</th>
                <th className="label-manifest px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-mono text-cell tabular-nums text-hull">
                    {row.code}
                  </td>
                  <td className="px-3 py-2 text-cell text-hull">
                    {portLabel(row.polCode, row.polName)}
                  </td>
                  <td className="px-3 py-2 text-cell text-hull">
                    {portLabel(row.podCode, row.podName)}
                  </td>
                  <td className="px-3 py-2">
                    <Status tone={row.isActive ? 'active' : 'inactive'}>
                      {row.isActive ? 'Active' : 'Inactive'}
                    </Status>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {can('SETTING.COMMODITY_CATEGORY.DELETE') && (
                      <Button variant="destructive" size="inline" onClick={() => setToDelete(row)}>
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={formOpen}
        onOpenChange={setFormOpen}
        title="Add business port"
        description="Pick the ports this category trades between."
      >
        <BusinessPortForm
          rows={rows}
          ports={ports}
          onCancel={() => setFormOpen(false)}
          onSubmit={async (body) => {
            await authorizedRequest(`${endpoint}/business-ports`, { method: 'POST', body });
            toast.success('Business port added');
            setFormOpen(false);
            await reload();
          }}
        />
      </Modal>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title="Delete this business port?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.polName} → ${toDelete.podName} will be removed from this category.`
        }
        confirmLabel="Delete"
        destructive
        isPending={busy}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function BusinessPortForm({
  rows,
  ports,
  onSubmit,
  onCancel,
}: {
  rows: CommodityBusinessPortDto[];
  ports: PortOption[];
  onSubmit: (body: { polIds: string[]; podIds: string[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const [polIds, setPolIds] = useState<string[]>([]);
  const [podIds, setPodIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { shape, fixedPolId, fixedPodId } = businessPortShape(rows);
  const lockedPol = shape === 'FANS_OUT' ? fixedPolId : null;
  const lockedPod = shape === 'FANS_IN' ? fixedPodId : null;

  const options = useMemo(
    () => ports.map((p) => ({ id: p.id, name: portLabel(p.portCode, p.name) })),
    [ports],
  );

  /*
    What is already on file decides what this form may offer, and the choice
    so far narrows it further: pick two loading ports and the discharge side
    keeps only what is already selected there. The rule made visible, rather
    than a save that is accepted and then refused.
  */
  const polOptions = useMemo(() => {
    if (lockedPol !== null) return options.filter((o) => o.id === lockedPol);
    // Narrow to the one already chosen only once there is one: narrowing to an
    // empty selection would offer nothing, and the side still has to be picked.
    if (podIds.length > 1 && polIds.length > 0) {
      return options.filter((o) => polIds.includes(o.id));
    }
    return options;
  }, [lockedPol, options, podIds.length, polIds]);

  const podOptions = useMemo(() => {
    if (lockedPod !== null) return options.filter((o) => o.id === lockedPod);
    if (polIds.length > 1 && podIds.length > 0) {
      return options.filter((o) => podIds.includes(o.id));
    }
    return options;
  }, [lockedPod, options, podIds, polIds.length]);

  useEffect(() => {
    if (lockedPol !== null && polIds.length === 0) setPolIds([lockedPol]);
    if (lockedPod !== null && podIds.length === 0) setPodIds([lockedPod]);
  }, [lockedPod, lockedPol, podIds.length, polIds.length]);

  const pairs = businessPortPairs(polIds, podIds);
  const bothMany = polIds.length > 1 && podIds.length > 1;
  const wouldBreak =
    pairs.length > 0 &&
    !businessPortAccepts(
      rows.map((r) => ({ polId: r.polId, podId: r.podId })),
      pairs,
    );
  const ready = polIds.length > 0 && podIds.length > 0 && !bothMany && !wouldBreak;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await onSubmit({ polIds, podIds });
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <FormLayout
      onSubmit={submit}
      onCancel={onCancel}
      isPending={pending}
      submitDisabled={!ready}
      submitLabel={pairs.length > 1 ? `Add ${pairs.length} lanes` : 'Add business port'}
      error={error ?? undefined}
    >
      <Field
        id="polIds"
        label="POL"
        required
        hint={
          lockedPol !== null
            ? 'Fixed: this category already runs out of one loading port to several discharge ports.'
            : podIds.length > 1
              ? 'One loading port, because several discharge ports are selected.'
              : 'Choose one, or several feeding a single discharge port.'
        }
      >
        <MultiSelect
          id="polIds"
          options={polOptions}
          value={polIds}
          onChange={setPolIds}
          placeholder="Choose loading ports…"
          searchPlaceholder="Type to filter ports"
          invalid={bothMany || wouldBreak}
        />
      </Field>

      <Field
        id="podIds"
        label="POD"
        required
        hint={
          lockedPod !== null
            ? 'Fixed: this category already runs several loading ports into one discharge port.'
            : polIds.length > 1
              ? 'One discharge port, because several loading ports are selected.'
              : 'Choose one, or several served from a single loading port.'
        }
      >
        <MultiSelect
          id="podIds"
          options={podOptions}
          value={podIds}
          onChange={setPodIds}
          placeholder="Choose discharge ports…"
          searchPlaceholder="Type to filter ports"
          invalid={bothMany || wouldBreak}
        />
      </Field>

      <p
        className={
          bothMany || wouldBreak ? 'text-cell text-alert' : 'text-cell text-steel'
        }
        role={bothMany || wouldBreak ? 'alert' : undefined}
      >
        {BUSINESS_PORT_ONE_SIDE}
      </p>
    </FormLayout>
  );
}
