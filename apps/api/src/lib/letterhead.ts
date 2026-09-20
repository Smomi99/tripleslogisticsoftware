import type { TenantDb } from './tenant-client';

/**
 * The workspace's own name and address, for the top of a printed document.
 *
 * MODULE_BOOKING_CARGO §5.4 rule 4: "from tenant settings, not hardcoded".
 * The signature block is where a workspace already keeps its address, so the
 * letterhead and the foot of every outgoing email cannot disagree.
 *
 * Pulled out of shipping-order.route when the advise and the BL draft needed
 * the same two lines — three copies of this would have been three places for a
 * renamed company to be half-applied.
 */
export interface Letterhead {
  companyName: string;
  companyAddress: string | null;
}

export async function letterheadOf(db: TenantDb, tenantId: bigint): Promise<Letterhead> {
  const [settings, tenant] = await Promise.all([
    db.notificationSetting.findFirst({ select: { signatureBlock: true } }),
    db.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
  ]);
  return {
    companyName: tenant?.name ?? 'Freight Forwarder',
    companyAddress: settings?.signatureBlock ?? null,
  };
}
