'use client';

import type { ClpLoadingFamily, ClpStatus } from '@ff/shared';
import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { ClpRegister } from '@/components/ops/clp-register';
import { ClpToPlan } from '@/components/ops/clp-to-plan';
import { FAMILY_HINT, FAMILY_TABS, type FamilyTab, familyFromParam } from '@/components/ops/clp-labels';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/form-layout';
import { Segmented } from '@/components/ui/segmented';

/**
 * Container Load Plan — one screen for the whole job.
 *
 * It used to be two: a booking queue here, whose `Make CLP` opened one way of
 * planning, and a separate "New container plan" screen with another, drawn
 * with different columns, different tabs and a different name. A planner saw
 * the same bookings twice and could not tell which screen was the real one.
 *
 * Now there are two tabs over the same controls:
 *
 *   To plan          tick the POs that go in one container and create it
 *                    (`Open` on a booking reaches its own plan — more
 *                    containers, a split, finalising)
 *   Container plans  every plan made, with its container number and status
 *
 * and one workflow switch, All / FCL / LCL / Consol box, meaning the same thing
 * on both. The tab and workflow live in the URL, so returning from a booking's
 * plan lands where the planner was.
 */

type View = 'plan' | 'plans';

const VIEWS = [
  ['plan', 'To plan'],
  ['plans', 'Container plans'],
] as const satisfies readonly (readonly [View, string])[];

export default function ContainerLoadPlanPage() {
  return (
    <Suspense fallback={<p className="text-body text-steel">Loading…</p>}>
      <ContainerLoadPlanScreen />
    </Suspense>
  );
}

function ContainerLoadPlanScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  /*
    Read once. `booking` is the `Make CLP` shortcut from Cargo Receipt; it is
    only meaningful on To plan, so its presence decides the tab.
  */
  const [preselect] = useState<string | null>(() => params.get('booking'));
  const [view, setView] = useState<View>(() =>
    preselect === null && params.get('view') === 'plans' ? 'plans' : 'plan',
  );
  const [family, setFamily] = useState<FamilyTab>(() => familyFromParam(params.get('family')));
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | ClpStatus>('');

  // Keep the URL saying what is on screen, without adding history entries.
  useEffect(() => {
    const query = new URLSearchParams();
    if (view === 'plans') query.set('view', 'plans');
    if (family !== '') query.set('family', family);
    const qs = query.toString();
    router.replace(`${pathname}${qs === '' ? '' : `?${qs}`}` as Route, { scroll: false });
  }, [family, pathname, router, view]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Container Load Plan"
        description={
          view === 'plan'
            ? 'Tick the POs that go in one container, then create the plan. Open a booking to add containers, split cartons or finalise.'
            : 'Every container plan, with its container number and status.'
        }
      />

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Which list to show"
            value={view}
            options={VIEWS}
            onChange={(next) => {
              // The two lists search different things, so a term does not carry over.
              setSearch('');
              setView(next);
            }}
          />
          <Segmented label="Which loading type to show" value={family} options={FAMILY_TABS} onChange={setFamily} />

          <Input
            type="search"
            aria-label={view === 'plan' ? 'Search bookings' : 'Search container plans'}
            placeholder={view === 'plan' ? 'Booking, customer, exporter or PO' : 'CLP, container no, booking or customer'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-72"
          />

          {view === 'plans' && (
            <Select
              aria-label="Status"
              value={status}
              onChange={(event) => setStatus(event.target.value as '' | ClpStatus)}
              className="w-40"
            >
              <option value="">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="FINAL">Final</option>
              <option value="CANCELLED">Cancelled</option>
            </Select>
          )}
        </div>
        {view === 'plan' && <p className="text-cell text-steel">{FAMILY_HINT[family]}</p>}
      </div>

      {view === 'plan' ? (
        <ClpToPlan
          family={family}
          search={search}
          preselect={preselect}
          onFamilyFromBooking={(next: ClpLoadingFamily) => setFamily(next)}
        />
      ) : (
        <ClpRegister family={family} search={search} status={status} />
      )}
    </div>
  );
}
