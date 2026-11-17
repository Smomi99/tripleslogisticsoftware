import { letterheadDetailLines } from '@ff/shared';

import { openFile } from './storage';
import type { TenantDb } from './tenant-client';

/**
 * The workspace's own name and details, for the head of a printed document.
 *
 * MODULE_BOOKING_CARGO §5.4 rule 4: "from tenant settings, not hardcoded".
 * Settings → Business Settings (owner, 2026-11-17) is where they are kept: the
 * name, the logo (logoOf), and the address, contact and registration lines
 * under the name. The email signature block is still printed on nothing — the
 * client asked for it off every print (2026-10-21); these lines are what took
 * its place.
 *
 * A workspace that has never saved Business Settings prints as it always did:
 * the workspace name, no lines under it, and the logo on the tenant row.
 *
 * Pulled out of shipping-order.route when the advise and the BL draft needed
 * the same two lines — three copies of this would have been three places for a
 * renamed company to be half-applied.
 */
export interface Letterhead {
  companyName: string;
  /**
   * Printed under the name, top to bottom: the address line for line, a
   * contact line, a registration line. Empty when none is filled in.
   */
  companyDetails: string[];
}

export async function letterheadOf(db: TenantDb, tenantId: bigint): Promise<Letterhead> {
  // A customer printing their own draft cannot read the profile (RLS); they
  // get the name on the tenant row, as before, rather than an error.
  const profile = await db.businessProfile.findFirst({
    select: {
      businessName: true,
      address: true,
      phone: true,
      email: true,
      website: true,
      binNo: true,
      tinNo: true,
      tradeLicenceNo: true,
    },
  });
  if (profile !== null) {
    return {
      companyName: profile.businessName,
      companyDetails: letterheadDetailLines({
        address: profile.address ?? '',
        phone: profile.phone ?? '',
        email: profile.email ?? '',
        website: profile.website ?? '',
        binNo: profile.binNo ?? '',
        tinNo: profile.tinNo ?? '',
        tradeLicenceNo: profile.tradeLicenceNo ?? '',
      }),
    };
  }
  const tenant = await db.tenant.findFirst({ where: { id: tenantId }, select: { name: true } });
  return { companyName: tenant?.name ?? 'Freight Forwarder', companyDetails: [] };
}

/**
 * The storage key of the logo a document should carry, or null.
 *
 * Once Business Settings has been saved its logo is the only one — removing
 * it there must remove it from the documents. Before then, the tenant row's.
 */
export async function logoKeyOf(db: TenantDb, tenantId: bigint): Promise<string | null> {
  const profile = await db.businessProfile.findFirst({ select: { logoFile: true } });
  const key =
    profile !== null
      ? profile.logoFile
      : (await db.tenant.findFirst({ where: { id: tenantId }, select: { logoFile: true } }))?.logoFile;
  return key == null || key === '' ? null : key;
}

/**
 * The workspace's uploaded logo, or null.
 *
 * A workspace that has not uploaded one still gets a letterhead — the name
 * carries it — so a missing or unreadable file is never a reason to withhold
 * the document.
 */
export async function logoOf(db: TenantDb, tenantId: bigint): Promise<Buffer | null> {
  const key = await logoKeyOf(db, tenantId);
  if (key === null) return null;
  try {
    const file = await openFile(tenantId, key);
    const parts: Buffer[] = [];
    for await (const chunk of file.stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(parts);
  } catch {
    return null;
  }
}
