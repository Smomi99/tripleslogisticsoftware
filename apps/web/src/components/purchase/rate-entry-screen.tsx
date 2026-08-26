'use client';

import {
  type ApiMeta,
  DEFAULT_PAGE_SIZE,
  type FreightRateDto,
  type LocalChargeInput,
  type LookupOption,
  PROFIT_TYPES,
  PROFIT_TYPE_LABEL,
  PURCHASE_SOURCE_LABEL,
  PURCHASE_SOURCE_TYPES,
  type PurchaseSourceType,
  type RateMode,
  RATE_STATUS_LABEL,
} from '@ff/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { ConfirmDialog } from '@/components/ui/modal';
import { Status } from '@/components/ui/status';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session';

import { LocalChargePanel } from './local-charge-panel';

/**
 * Purchase rate entry (MODULE_PURCHASE_SALES §5.1).
 *
 * One component for all three modes. Which tiers become columns comes from the
 * server's rate-tier list for this mode, so Sea LCL and Air are this same screen
 * with a different `mode` prop — §7 phase F asks for nine screens and one
 * component set, and that only holds if nothing here is FCL-specific.
 *
 * Keyboard-first by §5.1: the add row is a real row of inputs, Tab walks it in
 * column order, and Enter anywhere in it submits. The pricing team enters dozens
 * of lanes in a sitting and will not reach for the mouse.
 */

interface RateOptions {
  ports: LookupOption[];
  carriers: LookupOption[];
  containerSizes: LookupOption[];
  goodsTypes: LookupOption[];
  currencies: LookupOption[];
  vendors: LookupOption[];
  agents: LookupOption[];
  tiers: { id: string; code: string; label: string }[];
  costHeads: LookupOption[];
  canSeeBuyPrice: boolean;
  canManageProfit: boolean;
}

const EMPTY_OPTIONS: RateOptions = {
  ports: [],
  carriers: [],
  containerSizes: [],
  goodsTypes: [],
  currencies: [],
  vendors: [],
  agents: [],
  tiers: [],
  costHeads: [],
  canSeeBuyPrice: false,
  canManageProfit: false,
};

interface DraftRow {
  polId: string;
  podId: string;
  carrierId: string;
  goodsTypeId: string;
  purchaseSourceType: PurchaseSourceType;
  purchaseSourceId: string;
  currencyId: string;
  validFrom: string;
  validTo: string;
  transitDays: string;
  freeDays: string;
  status: string;
  /** tierId → buy price, as typed. */
  prices: Record<string, string>;
  profitType: string;
  profitValue: string;
  localCharges: LocalChargeInput[];
}

function emptyDraft(currencyId: string): DraftRow {
  return {
    polId: '',
    podId: '',
    carrierId: '',
    goodsTypeId: '',
    purchaseSourceType: 'CARRIER',
    purchaseSourceId: '',
    currencyId,
    validFrom: '',
    validTo: '',
    transitDays: '',
    freeDays: '',
    // A buyer records a rate because it has been bought, so the default is the
    // one that reaches sales. Draft is there for staging a lane that is not
    // agreed yet — see the note on status in the report for phase E.
    status: 'PUBLISHED',
    prices: {},
    profitType: 'FLAT',
    profitValue: '',
    localCharges: [],
  };
}

export function RateEntryScreen({
  mode,
  feature,
  title,
  description,
}: {
  mode: RateMode;
  feature: string;
  title: string;
  description: string;
}) {
  const { authorizedRequest, authorizedList, can } = useSession();

  const [options, setOptions] = useState<RateOptions>(EMPTY_OPTIONS);
  const [rows, setRows] = useState<FreightRateDto[]>([]);
  const [meta, setMeta] = useState<ApiMeta>({
    page: 1,
    limit: DEFAULT_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [page, setPage] = useState(1);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [isPending, setPending] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<DraftRow>(emptyDraft(''));
  /** The rate the add row is currently editing, if any (§5.1's Edit action). */
  const [editing, setEditing] = useState<FreightRateDto | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [isPanelOpen, setPanelOpen] = useState(false);
  const [toDelete, setToDelete] = useState<FreightRateDto | null>(null);
  const [isDeleting, setDeleting] = useState(false);

  const firstFieldRef = useRef<HTMLSelectElement>(null);

  // ------------------------------------------------------------ data loading

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authorizedList<RateOptions>(
          `/api/tenant/purchase/rate-options?mode=${mode}`,
        );
        if (cancelled) return;
        setOptions(response.data);
        setDraft((current) =>
          current.currencyId === '' && response.data.currencies[0] !== undefined
            ? { ...current, currencyId: response.data.currencies[0].id }
            : current,
        );
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof ApiError ? error.message : 'Could not load the form options.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authorizedList, mode]);

  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setPending(true);
    const params = new URLSearchParams({
      mode,
      page: String(page),
      limit: String(DEFAULT_PAGE_SIZE),
      sortBy: 'validFrom',
      sortOrder: 'desc',
      includeExpired: String(includeExpired),
    });
    try {
      const response = await authorizedList<FreightRateDto[]>(
        `/api/tenant/purchase/rates?${params.toString()}`,
      );
      if (requestId !== requestIdRef.current) return;
      setRows(response.data);
      if (response.meta !== undefined) setMeta(response.meta);
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setLoadError(error instanceof ApiError ? error.message : 'Could not load rates.');
    } finally {
      if (requestId === requestIdRef.current) setPending(false);
    }
  }, [authorizedList, includeExpired, mode, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // ------------------------------------------------------------------ saving

  const sourceOptions: LookupOption[] =
    draft.purchaseSourceType === 'CARRIER'
      ? options.carriers
      : draft.purchaseSourceType === 'VENDOR'
        ? options.vendors
        : options.agents;

  /**
   * Loads an existing rate back into the add row.
   *
   * §5.1's list carries Edit | Delete, and this screen's shape is a row of
   * inputs — so Edit fills that row rather than opening a second form the user
   * would have to learn. On a published rate the save supersedes it (§4 rule 1);
   * on a draft it edits in place. Either way the server decides, not this.
   */
  function beginEdit(rate: FreightRateDto): void {
    const prices: Record<string, string> = {};
    for (const line of rate.lines) {
      if (line.buyPrice !== undefined) prices[line.tierId] = line.buyPrice;
    }
    const first = rate.lines[0];

    setEditing(rate);
    setAddError(null);
    setDraft({
      polId: rate.polId,
      podId: rate.podId,
      carrierId: rate.carrierId,
      goodsTypeId: rate.goodsTypeId,
      purchaseSourceType: rate.purchaseSourceType,
      purchaseSourceId: rate.purchaseSourceId,
      currencyId: rate.currencyId,
      validFrom: rate.validFrom,
      validTo: rate.validTo,
      transitDays: rate.transitDays === null ? '' : String(rate.transitDays),
      freeDays: rate.freeDays === null ? '' : String(rate.freeDays),
      status: rate.status === 'EXPIRED' ? 'PUBLISHED' : rate.status,
      prices,
      profitType: first?.profitType ?? 'FLAT',
      profitValue: first?.profitValue ?? '',
      localCharges: rate.localCharges.map((charge) => ({
        costHeadId: charge.costHeadId,
        side: charge.side,
        amount: charge.amount,
        currencyId: charge.currencyId,
        ...(charge.remarks === null ? {} : { remarks: charge.remarks }),
      })),
    });
    firstFieldRef.current?.focus();
  }

  function cancelEdit(): void {
    setEditing(null);
    setAddError(null);
    setDraft(emptyDraft(draft.currencyId));
  }

  async function submitDraft(): Promise<void> {
    setAddError(null);

    const lines = options.tiers
      .filter((tier) => (draft.prices[tier.id] ?? '').trim() !== '')
      .map((tier) => ({
        tierId: tier.id,
        buyPrice: (draft.prices[tier.id] ?? '').trim(),
        ...(options.canManageProfit
          ? { profitType: draft.profitType, profitValue: draft.profitValue.trim() }
          : {}),
      }));

    if (lines.length === 0) {
      setAddError('Enter a price for at least one tier.');
      return;
    }

    const body = {
      mode,
      polId: draft.polId,
      podId: draft.podId,
      carrierId: draft.carrierId,
      goodsTypeId: draft.goodsTypeId,
      purchaseSourceType: draft.purchaseSourceType,
      purchaseCarrierId: draft.purchaseSourceType === 'CARRIER' ? draft.purchaseSourceId : '',
      purchaseVendorId: draft.purchaseSourceType === 'VENDOR' ? draft.purchaseSourceId : '',
      purchaseAgentId: draft.purchaseSourceType === 'AGENT' ? draft.purchaseSourceId : '',
      currencyId: draft.currencyId,
      validFrom: draft.validFrom,
      validTo: draft.validTo,
      transitDays: draft.transitDays,
      freeDays: draft.freeDays,
      status: draft.status,
      lines,
      localCharges: draft.localCharges,
    };

    setSaving(true);
    try {
      if (editing === null) {
        await authorizedRequest('/api/tenant/purchase/rates', { method: 'POST', body });
        toast.success('Rate added');
      } else {
        await authorizedRequest(`/api/tenant/purchase/rates/${editing.id}`, {
          method: 'PATCH',
          body,
        });
        // §4 rule 1: a published rate is replaced by a new version rather than
        // changed, so say which happened instead of a bare "Saved".
        toast.success(
          editing.status === 'PUBLISHED' ? 'Rate superseded by a new version' : 'Rate saved',
        );
        setEditing(null);
      }
      setDraft(emptyDraft(draft.currencyId));
      await load();
      firstFieldRef.current?.focus();
    } catch (error) {
      setAddError(
        error instanceof ApiError ? error.message : 'Could not save the rate. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (toDelete === null) return;
    setDeleting(true);
    try {
      await authorizedRequest(`/api/tenant/purchase/rates/${toDelete.id}/delete`, {
        method: 'POST',
        body: { mode },
      });
      toast.success('Rate deleted');
      setToDelete(null);
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not delete the rate.');
    } finally {
      setDeleting(false);
    }
  }

  // -------------------------------------------------------------------- view

  const canCreate = can(`${feature}.CREATE`);
  const canEdit = can(`${feature}.EDIT`);
  const chargeCount = draft.localCharges.length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={description} />

      {loadError !== null && (
        <p
          role="alert"
          className="rounded-manifest border border-alert/30 bg-alert/5 px-3 py-2 text-body text-alert"
        >
          {loadError}
        </p>
      )}

      {canCreate && (
        <section
          aria-label={editing === null ? 'Add a rate' : 'Edit a rate'}
          className="rounded-manifest border border-line bg-surface p-3 shadow-manifest"
          // §5.1: Enter submits from anywhere in the add row.
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isSaving) {
              event.preventDefault();
              void submitDraft();
            }
          }}
        >
          <div className="flex flex-wrap items-end gap-2">
            <LabelledControl label="POL" width="w-44">
              <Select
                ref={firstFieldRef}
                aria-label="Port of loading"
                value={draft.polId}
                onChange={(e) => setDraft({ ...draft, polId: e.target.value })}
              >
                <option value="">Select</option>
                {options.ports.map((port) => (
                  <option key={port.id} value={port.id}>
                    {port.name}
                  </option>
                ))}
              </Select>
            </LabelledControl>

            <LabelledControl label="POD" width="w-44">
              <Select
                aria-label="Port of discharge"
                value={draft.podId}
                onChange={(e) => setDraft({ ...draft, podId: e.target.value })}
              >
                <option value="">Select</option>
                {options.ports.map((port) => (
                  <option key={port.id} value={port.id}>
                    {port.name}
                  </option>
                ))}
              </Select>
            </LabelledControl>

            <LabelledControl label="Carrier" width="w-40">
              <Select
                aria-label="Carrier"
                value={draft.carrierId}
                onChange={(e) => setDraft({ ...draft, carrierId: e.target.value })}
              >
                <option value="">Select</option>
                {options.carriers.map((carrier) => (
                  <option key={carrier.id} value={carrier.id}>
                    {carrier.name}
                  </option>
                ))}
              </Select>
            </LabelledControl>

            <LabelledControl label="Goods type" width="w-36">
              <Select
                aria-label="Goods type"
                value={draft.goodsTypeId}
                onChange={(e) => setDraft({ ...draft, goodsTypeId: e.target.value })}
              >
                <option value="">Select</option>
                {options.goodsTypes.map((goods) => (
                  <option key={goods.id} value={goods.id}>
                    {goods.name}
                  </option>
                ))}
              </Select>
            </LabelledControl>

            {/* The tier inputs — driven by rate_tier, not by four fixed columns. */}
            {options.tiers.map((tier) => (
              <LabelledControl key={tier.id} label={tier.code} width="w-24" title={tier.label}>
                <Input
                  numeric
                  inputMode="decimal"
                  aria-label={`Buy price for ${tier.label}`}
                  value={draft.prices[tier.id] ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, prices: { ...draft.prices, [tier.id]: e.target.value } })
                  }
                />
              </LabelledControl>
            ))}

            <LabelledControl label="Currency" width="w-24">
              <Select
                aria-label="Currency"
                value={draft.currencyId}
                onChange={(e) => setDraft({ ...draft, currencyId: e.target.value })}
              >
                {options.currencies.map((currency) => (
                  <option key={currency.id} value={currency.id}>
                    {currency.name}
                  </option>
                ))}
              </Select>
            </LabelledControl>

            {/* §4 rule 6: the margin fields exist only for the price team. */}
            {options.canManageProfit && (
              <>
                <LabelledControl label="Profit" width="w-28">
                  <Select
                    aria-label="Profit type"
                    value={draft.profitType}
                    onChange={(e) => setDraft({ ...draft, profitType: e.target.value })}
                  >
                    {PROFIT_TYPES.map((value) => (
                      <option key={value} value={value}>
                        {PROFIT_TYPE_LABEL[value]}
                      </option>
                    ))}
                  </Select>
                </LabelledControl>
                <LabelledControl label="Value" width="w-24">
                  <Input
                    numeric
                    inputMode="decimal"
                    aria-label="Profit value"
                    value={draft.profitValue}
                    onChange={(e) => setDraft({ ...draft, profitValue: e.target.value })}
                  />
                </LabelledControl>
              </>
            )}

            <LabelledControl label="Local charges" width="w-32">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPanelOpen(true)}
                className="h-9 w-full justify-center"
              >
                {chargeCount === 0 ? 'Add' : `${chargeCount} line${chargeCount === 1 ? '' : 's'}`}
              </Button>
            </LabelledControl>

            {/* §5.1: the two dates always travel together. */}
            <LabelledControl label="Valid from" width="w-36">
              <Input
                type="date"
                numeric
                aria-label="Valid from"
                value={draft.validFrom}
                onChange={(e) => {
                  const validFrom = e.target.value;
                  setDraft((d) => ({
                    ...d,
                    validFrom,
                    validTo: d.validTo !== '' && d.validTo < validFrom ? validFrom : d.validTo,
                  }));
                }}
              />
            </LabelledControl>
            <LabelledControl label="Valid to" width="w-36">
              <Input
                type="date"
                numeric
                aria-label="Valid to"
                min={draft.validFrom === '' ? undefined : draft.validFrom}
                value={draft.validTo}
                onChange={(e) => setDraft({ ...draft, validTo: e.target.value })}
              />
            </LabelledControl>

            {/* §9 Q13: sales are asked both of these on every call. */}
            <LabelledControl label="Transit" width="w-20">
              <Input
                numeric
                inputMode="numeric"
                aria-label="Transit days"
                value={draft.transitDays}
                onChange={(e) => setDraft({ ...draft, transitDays: e.target.value })}
              />
            </LabelledControl>
            <LabelledControl label="Free days" width="w-20">
              <Input
                numeric
                inputMode="numeric"
                aria-label="Free days"
                value={draft.freeDays}
                onChange={(e) => setDraft({ ...draft, freeDays: e.target.value })}
              />
            </LabelledControl>

            {/* Published is what sales can quote (§4 rule 2). Draft stages a
                lane that is not agreed yet, and is exempt from the overlap
                constraint so alternatives can sit side by side. */}
            <LabelledControl label="Status" width="w-28">
              <Select
                aria-label="Status"
                value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              >
                <option value="PUBLISHED">Published</option>
                <option value="DRAFT">Draft</option>
              </Select>
            </LabelledControl>

            <LabelledControl label="Purchase via" width="w-32">
              <Select
                aria-label="Purchase source type"
                value={draft.purchaseSourceType}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    purchaseSourceType: e.target.value as PurchaseSourceType,
                    purchaseSourceId: '',
                  })
                }
              >
                {PURCHASE_SOURCE_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {PURCHASE_SOURCE_LABEL[value]}
                  </option>
                ))}
              </Select>
            </LabelledControl>
            <LabelledControl label="Bought from" width="w-40">
              <Select
                aria-label="Bought from"
                value={draft.purchaseSourceId}
                onChange={(e) => setDraft({ ...draft, purchaseSourceId: e.target.value })}
              >
                <option value="">Select</option>
                {sourceOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </LabelledControl>

            <Button type="button" onClick={() => void submitDraft()} disabled={isSaving}>
              {isSaving ? 'Saving…' : editing === null ? 'Add' : 'Save changes'}
            </Button>
            {editing !== null && (
              <Button type="button" variant="secondary" onClick={cancelEdit} disabled={isSaving}>
                Cancel
              </Button>
            )}
          </div>

          {editing !== null && (
            <p className="mt-2 text-cell text-steel">
              Editing <span className="font-mono tabular-nums text-hull">{editing.code}</span>
              {editing.status === 'PUBLISHED'
                ? ' — saving closes this rate off and records a new version, so quotations already issued against it stay correct.'
                : ' — this draft will be updated in place.'}
            </p>
          )}

          {addError !== null && (
            <p role="alert" className="mt-2 text-cell text-alert">
              {addError}
            </p>
          )}
        </section>
      )}

      {/*
        The count sat immediately after the checkbox and read as "Include
        expired 1 rate" — as though one expired rate were waiting. It is the
        total on the list. Pushed to the other end and given a verb, so the two
        controls stop forming a sentence they never meant.
      */}
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-body text-steel">
          <input
            type="checkbox"
            checked={includeExpired}
            onChange={(e) => {
              setIncludeExpired(e.target.checked);
              setPage(1);
            }}
            className="size-4 accent-harbour"
          />
          Include expired
        </label>
        <span className="text-cell text-steel">
          Showing {meta.total} rate{meta.total === 1 ? '' : 's'}
        </span>
      </div>

      <div className="overflow-x-auto rounded-manifest border border-line bg-surface shadow-manifest">
        <table className="w-full min-w-max border-collapse">
          <thead>
            <tr className="border-b border-line bg-paper text-left">
              <Th>Code</Th>
              <Th>POL</Th>
              <Th>POD</Th>
              <Th>Carrier</Th>
              <Th>Goods</Th>
              {options.tiers.map((tier) => (
                <Th key={tier.id} numeric>
                  {tier.code}
                </Th>
              ))}
              <Th numeric>Local</Th>
              <Th>Validity</Th>
              <Th>Purchase via</Th>
              <Th>Status</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((rate) => (
              <tr
                key={rate.id}
                className="border-b border-line last:border-0 hover:bg-row-hover [&>td]:align-top"
              >
                <td className="bg-paper/40 px-2.5 py-2 font-mono text-cell tabular-nums text-hull">
                  {rate.code}
                </td>
                <Td>{rate.polName ?? rate.polCode}</Td>
                <Td>{rate.podName ?? rate.podCode}</Td>
                <Td>{rate.carrierName}</Td>
                <Td>{rate.goodsTypeName}</Td>
                {options.tiers.map((tier) => {
                  const line = rate.lines.find((l) => l.tierId === tier.id);
                  return (
                    <td
                      key={tier.id}
                      className="px-2.5 py-2 text-right font-mono text-cell tabular-nums"
                    >
                      {line === undefined ? (
                        <span className="text-steel">—</span>
                      ) : (
                        <>
                          <div>{line.sellPrice}</div>
                          {/* Absent when the server withheld it (§4 rule 5). */}
                          {line.buyPrice !== undefined && (
                            <div className="text-steel">buy {line.buyPrice}</div>
                          )}
                        </>
                      )}
                    </td>
                  );
                })}
                <td className="px-2.5 py-2 text-right font-mono text-cell tabular-nums">
                  {rate.localChargeCount === 0 ? (
                    <span className="text-steel">—</span>
                  ) : (
                    <>
                      <div>
                        {rate.localChargeTotal} {rate.currencyCode}
                      </div>
                      <div className="text-steel">
                        {rate.localChargeCount} line{rate.localChargeCount === 1 ? '' : 's'}
                      </div>
                    </>
                  )}
                </td>
                <td className="px-2.5 py-2 font-mono text-cell tabular-nums">
                  <div>{rate.validFrom}</div>
                  <div className={rate.expiringSoon ? 'text-signal' : 'text-steel'}>
                    {rate.validTo}
                    {rate.expiringSoon && ' • expiring'}
                  </div>
                </td>
                <Td>{rate.purchaseSourceName}</Td>
                <td className="px-2.5 py-2">
                  <Status
                    tone={
                      rate.status === 'PUBLISHED'
                        ? 'active'
                        : rate.status === 'DRAFT'
                          ? 'pending'
                          : 'inactive'
                    }
                  >
                    {RATE_STATUS_LABEL[rate.status]}
                  </Status>
                </td>
                <td className="whitespace-nowrap px-2.5 py-2">
                  {/* Editing rewrites every price, so it needs the buy prices
                      to load. Without VIEW_BUY_PRICE they arrive absent
                      (§4 rule 5) and saving would silently blank the costs. */}
                  {canEdit && options.canSeeBuyPrice && rate.status !== 'EXPIRED' && (
                    <Button variant="text" size="inline" onClick={() => beginEdit(rate)}>
                      Edit
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      variant="destructive"
                      size="inline"
                      onClick={() => setToDelete(rate)}
                    >
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !isPending && (
              <tr>
                <td colSpan={11 + options.tiers.length} className="p-8">
                  <EmptyState
                    title="No rates yet"
                    description={
                      canCreate
                        ? 'Use the row above to add the first lane you have bought.'
                        : 'No rates have been bought for this mode yet.'
                    }
                  />
                </td>
              </tr>
            )}
            {isPending && rows.length === 0 && (
              <tr>
                <td
                  colSpan={11 + options.tiers.length}
                  className="p-8 text-center text-body text-steel"
                >
                  Loading rates…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {meta.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="inline"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span className="text-cell text-steel">
            Page {meta.page} of {meta.totalPages}
          </span>
          <Button
            variant="secondary"
            size="inline"
            disabled={page >= meta.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <LocalChargePanel
        open={isPanelOpen}
        onOpenChange={setPanelOpen}
        charges={draft.localCharges}
        costHeads={options.costHeads}
        containerSizes={options.containerSizes}
        currencies={options.currencies}
        defaultCurrencyId={draft.currencyId}
        onChange={(localCharges) => setDraft((d) => ({ ...d, localCharges }))}
      />

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        title="Delete this rate?"
        message={
          toDelete === null
            ? ''
            : `${toDelete.code} will stop appearing in price lists. Quotations that already reference it are unaffected.`
        }
        confirmLabel="Delete"
        destructive
        isPending={isDeleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

/** A column-header label sitting above an add-row control. */
function LabelledControl({
  label,
  width,
  title,
  children,
}: {
  label: string;
  width: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 ${width}`} title={title}>
      <span className="label-manifest">{label}</span>
      {children}
    </div>
  );
}

function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <th className={`label-manifest px-2.5 py-2 ${numeric === true ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-2.5 py-2 text-cell text-hull">{children}</td>;
}
