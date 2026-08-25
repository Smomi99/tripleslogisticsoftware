import { MANAGE_PROFIT } from './rate-visibility';
import type { TenantDb } from './tenant-client';

/**
 * §5.1 — where an inquiry goes the moment it is saved.
 *
 * The client's rule, as one explicit service rather than conditionals spread
 * through the save handler. There are exactly three outcomes and the whole
 * point of putting them here is that you can read all three at once:
 *
 *   INBOUND   → share it with the selected agents, ask them to price it.
 *               RFQ_SENT. Unless the lane already has a live rate, in which
 *               case share it but send nothing — the client is explicit that
 *               we do not spam agents for lanes we can already price.
 *
 *   OUTBOUND  → look for a live rate on the lane.
 *               found     → PRICED, and nobody needs telling.
 *               not found → the pricing team is asked for one. The status
 *                           stays OPEN and the inquiry is flagged awaiting-rate.
 *
 * Deciding and delivering are separate on purpose. `decideRoute` runs inside the
 * save transaction, so an inquiry can never be committed with a status that
 * disagrees with its own routing. `deliverRoute` runs after the commit, because
 * a mail server has no business rolling back an inquiry that saved correctly.
 */

export type RouteBranch =
  | 'INBOUND_SHARED'
  | 'INBOUND_RATE_EXISTS'
  | 'OUTBOUND_PRICED'
  | 'OUTBOUND_AWAITING_RATE'
  | 'NOWHERE';

export interface RoutePlan {
  branch: RouteBranch;
  /** What the inquiry's status becomes. */
  status: 'OPEN' | 'RFQ_SENT' | 'PRICED';
  awaitingRate: boolean;
  /** Agent contacts to ask, empty when nobody is being asked. */
  agentEmails: string[];
  /**
   * Carrier contacts to ask.
   *
   * inquiry_party_contact has carried carrier_pic_id since §6.1's "Share to
   * Agent / Carrier", and until now nothing read it — a user could tick a
   * carrier's contact and no letter would ever go. These are the people the
   * client's "Email To Carrier" template is addressed to.
   */
  carrierEmails: string[];
  /** Pricing team addresses, empty unless the lane needs buying. */
  priceTeamEmails: string[];
  /** How many live rates matched. Zero on the inbound-share path. */
  liveRates: number;
}

export interface RouteInput {
  inquiryId: bigint;
  movementType: 'INBOUND' | 'OUTBOUND';
  shipmentType: 'SEA' | 'AIR';
  polId: bigint;
  podId: bigint;
  goodsTypeId: bigint | null;
}

const MODES_FOR: Record<'SEA' | 'AIR', ('SEA_FCL' | 'SEA_LCL' | 'AIR')[]> = {
  SEA: ['SEA_FCL', 'SEA_LCL'],
  AIR: ['AIR'],
};

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Does a live rate already cover this lane?
 *
 * §5.1's test: "matching mode, POL, POD, goods type, today within validity".
 * Goods type is only applied when the inquiry names one — an inquiry raised
 * before the field existed, or by someone who has not decided yet, should not
 * silently match nothing.
 */
export async function liveRatesForLane(db: TenantDb, input: RouteInput): Promise<number> {
  return db.freightRate.count({
    where: {
      deletedAt: null,
      status: 'PUBLISHED',
      mode: { in: MODES_FOR[input.shipmentType] },
      polId: input.polId,
      podId: input.podId,
      ...(input.goodsTypeId === null ? {} : { goodsTypeId: input.goodsTypeId }),
      validFrom: { lte: startOfToday() },
      validTo: { gte: startOfToday() },
    },
  });
}

/**
 * Everyone who can buy a rate, by permission rather than by an address list.
 *
 * §5.1 is specific: "The Price Team recipient resolves from the role, not a
 * hardcoded address — everyone holding PURCHASE.RATE.MANAGE_PROFIT in that
 * tenant." A typed list of addresses goes stale the first time somebody leaves,
 * and nobody notices until a lane goes unpriced.
 *
 * Resolution follows §7 exactly: role grants, plus per-user ALLOW, minus
 * per-user DENY, and a superadmin holds everything. An inactive user or an
 * inactive role drops out, because §7 rule 5 says they have no access at all —
 * and mailing somebody who cannot act on it is worse than mailing nobody.
 */
export async function priceTeamAddresses(db: TenantDb): Promise<string[]> {
  const permission = await db.permission.findFirst({
    where: { key: MANAGE_PROFIT },
    select: { id: true },
  });
  if (permission === null) return [];

  const users = await db.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      // An external login is never on the pricing team, whatever its role says.
      agentId: null,
      customerId: null,
      vendorId: null,
    },
    select: {
      id: true,
      email: true,
      isSuperadmin: true,
      role: {
        select: {
          isActive: true,
          permissions: { where: { permissionId: permission.id }, select: { id: true } },
        },
      },
      permissions: {
        where: { permissionId: permission.id },
        select: { effect: true },
      },
    },
  });

  const addresses: string[] = [];
  for (const user of users) {
    const denied = user.permissions.some((p) => p.effect === 'DENY');
    if (denied && !user.isSuperadmin) continue;

    const allowed =
      user.isSuperadmin ||
      user.permissions.some((p) => p.effect === 'ALLOW') ||
      (user.role?.isActive === true && user.role.permissions.length > 0);
    if (!allowed) continue;

    const email = user.email.trim();
    if (email !== '') addresses.push(email);
  }
  return [...new Set(addresses)];
}

/**
 * The routing decision, made inside the save transaction.
 *
 * Reads only; the caller applies `status` and `awaitingRate` to the row it is
 * already writing, so an inquiry cannot exist for even an instant with a status
 * that contradicts its own routing.
 */
export async function decideRoute(db: TenantDb, input: RouteInput): Promise<RoutePlan> {
  const liveRates = await liveRatesForLane(db, input);

  if (input.movementType === 'INBOUND') {
    // The contacts the operator picked on the form, not every contact the
    // agent has. Choosing them was a deliberate act.
    const contacts = await db.inquiryPartyContact.findMany({
      where: { inquiryId: input.inquiryId, agentPicId: { not: null } },
      select: { agentPic: { select: { email: true } } },
    });
    const agentEmails = [
      ...new Set(
        contacts
          .map((c) => c.agentPic?.email?.trim() ?? '')
          .filter((email) => email !== ''),
      ),
    ];
    const carrierEmails = await carrierContacts(db, input.inquiryId);

    const shared = await db.inquiryParty.count({
      where: { inquiryId: input.inquiryId, agentId: { not: null } },
    });
    if (shared === 0) {
      // Nobody was asked, so nothing was sent. An inquiry that claims RFQ_SENT
      // with no agent on it is a lie the board would repeat every morning.
      return {
        branch: 'NOWHERE',
        status: 'OPEN',
        awaitingRate: false,
        agentEmails: [],
        carrierEmails: [],
        priceTeamEmails: [],
        liveRates,
      };
    }

    // The exception is scoped to the email. The agents still hold the inquiry
    // on their RFQ screen and can still quote it; we simply did not chase them
    // for a lane we can already price ourselves.
    return {
      branch: liveRates > 0 ? 'INBOUND_RATE_EXISTS' : 'INBOUND_SHARED',
      status: 'RFQ_SENT',
      awaitingRate: false,
      agentEmails: liveRates > 0 ? [] : agentEmails,
      carrierEmails: liveRates > 0 ? [] : carrierEmails,
      priceTeamEmails: [],
      liveRates,
    };
  }

  // Outbound. The carriers ticked on the form are asked for a rate on the same
  // terms as the agents: the client's exception is about not chasing anyone for
  // a lane we can already price, and it does not care who the letter is to.
  const carrierEmails = await carrierContacts(db, input.inquiryId);

  if (liveRates > 0) {
    return {
      branch: 'OUTBOUND_PRICED',
      status: 'PRICED',
      awaitingRate: false,
      agentEmails: [],
      carrierEmails: [],
      priceTeamEmails: [],
      liveRates,
    };
  }

  return {
    branch: 'OUTBOUND_AWAITING_RATE',
    status: 'OPEN',
    awaitingRate: true,
    agentEmails: [],
    carrierEmails,
    /*
     * The price team is still told, even when carriers are being asked
     * directly. Their job is to make sure the lane ends up with a rate, and an
     * inquiry that quietly asked two carriers and nobody else is how a lane
     * goes unpriced for a week while everyone assumes somebody has it.
     */
    priceTeamEmails: await priceTeamAddresses(db),
    liveRates,
  };
}

/**
 * The carrier contacts ticked on this inquiry.
 *
 * Same shape as the agent gather above, and deliberately so: the operator
 * chose these people on the form, and choosing them was the act of deciding
 * who to ask.
 */
async function carrierContacts(db: TenantDb, inquiryId: bigint): Promise<string[]> {
  const contacts = await db.inquiryPartyContact.findMany({
    where: { inquiryId, carrierPicId: { not: null } },
    select: { carrierPic: { select: { email: true } } },
  });
  return [
    ...new Set(
      contacts.map((c) => c.carrierPic?.email?.trim() ?? '').filter((email) => email !== ''),
    ),
  ];
}

/**
 * Routes a saved inquiry and writes the outcome onto it.
 *
 * Called at the end of the save transaction, so the row is never committed with
 * a status that disagrees with its own routing. Returns the plan for the caller
 * to deliver once the transaction has landed.
 *
 * A status is only moved while the inquiry is still in play. Editing one that
 * has already been quoted or settled must not drag it backwards to PRICED —
 * that would erase what the sales team knows and the board reports. The
 * awaiting-rate flag is still refreshed, because whether the lane has a rate is
 * true or false regardless of how far the inquiry has got.
 */
const ROUTABLE = new Set(['OPEN', 'RFQ_SENT', 'PRICED']);

export async function routeAndApply(db: TenantDb, inquiryId: bigint): Promise<RoutePlan> {
  const inquiry = await db.inquiry.findFirstOrThrow({
    where: { id: inquiryId },
    select: {
      id: true,
      status: true,
      movementType: true,
      shipmentType: true,
      polId: true,
      podId: true,
      goodsTypeId: true,
    },
  });

  const plan = await decideRoute(db, {
    inquiryId: inquiry.id,
    movementType: inquiry.movementType,
    shipmentType: inquiry.shipmentType,
    polId: inquiry.polId,
    podId: inquiry.podId,
    goodsTypeId: inquiry.goodsTypeId,
  });

  const settled = !ROUTABLE.has(inquiry.status);
  await db.inquiry.update({
    where: { id: inquiry.id },
    data: {
      ...(settled ? {} : { status: plan.status }),
      awaitingRate: plan.awaitingRate,
    },
  });

  return settled ? { ...plan, status: inquiry.status as RoutePlan['status'] } : plan;
}
