import type { Route } from 'next';
import { redirect } from 'next/navigation';

/**
 * The old "New container plan" address.
 *
 * Planning now happens on the Container Load Plan screen's To plan tab, so
 * this only forwards — keeping the `booking` and `family` a bookmark or an
 * older `Make CLP` link carried.
 */
export default async function NewContainerPlanRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const incoming = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['booking', 'family']) {
    const value = incoming[key];
    if (typeof value === 'string' && value !== '') query.set(key, value);
  }
  const qs = query.toString();
  redirect(`/operation/container-load-plan${qs === '' ? '' : `?${qs}`}` as Route);
}
