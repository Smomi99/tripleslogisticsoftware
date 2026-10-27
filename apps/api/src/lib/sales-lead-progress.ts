import type { TenantDb } from './tenant-client';

/**
 * What raising an inquiry from a lead does to the lead (docs/SALES_LEAD_FOB.md
 * §5).
 *
 * Step 03, "Request Rate — create a linked rate request for the pricing team",
 * is exactly an inquiry raised from the lead: an outbound inquiry with no live
 * rate is the pricing team's queue. So the lead moves to RATE_REQUESTED, but
 * only forward — a lead already quoted or decided is not pulled back by a
 * second inquiry.
 *
 * Step 06 links the lead to its customer. The inquiry names one, so a lead that
 * was still a prospect takes that customer; one already linked keeps its own.
 *
 * Runs inside the inquiry's transaction, so neither half lands without the
 * other.
 */
export async function progressLeadForInquiry(
  db: TenantDb,
  leadId: bigint,
  customerId: bigint,
  userId: bigint,
): Promise<void> {
  const lead = await db.salesLead.findFirst({
    where: { id: leadId, deletedAt: null },
    select: { status: true, customerId: true },
  });
  if (lead === null) return;

  const advance = lead.status === 'NEW' || lead.status === 'QUALIFIED';
  const link = lead.customerId === null;
  if (!advance && !link) return;

  await db.salesLead.update({
    where: { id: leadId },
    data: {
      ...(advance ? { status: 'RATE_REQUESTED' as const } : {}),
      ...(link ? { customerId } : {}),
      updatedBy: userId,
    },
  });
}
