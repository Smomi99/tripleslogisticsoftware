import {
  type ApiSuccess,
  composePriceEmailBody,
  type EmailCheckDto,
  emailSyntaxProblem,
  freightRateListQuerySchema,
  type LookupOption,
  PRICE_EMAIL_MAX_RATES,
  PRICE_EMAIL_MAX_RECIPIENTS,
  PRICE_EMAIL_PARTY_NOUN,
  priceEmailCheckSchema,
  type PriceEmailContextDto,
  type PriceEmailOptionsDto,
  type PriceEmailParty,
  priceEmailRatesQuerySchema,
  type PriceEmailRatesDto,
  type PriceEmailRecipientsDto,
  priceEmailHtml,
  priceEmailRatesText,
  priceEmailSendSchema,
  type PriceEmailSendResultDto,
  RATE_MODE_LABEL,
  RATE_MODES,
  type RateMode,
} from '@ff/shared';
import { Router } from 'express';
import { z } from 'zod';

import { checkAddresses } from '../lib/email-check';
import { queueMail } from '../lib/email-queue';
import { HttpError } from '../lib/http-error';
import { parseAddressList } from '../lib/mailer';
import { excludeInactive, inactiveMasters } from '../lib/master-visibility';
import { visibleRates } from '../lib/rate-visibility';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { type AuthContext, authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { offeredRatesById, PRICE_LIST_FEATURE_BY_MODE, priceListRows } from './freight-rate.route';

/**
 * Email prices — CRM → Customer (2026-09-29) and CRM → Agent (2026-10-06).
 *
 * The customers or agents a CRM list is filtered to, their contacts' addresses
 * checked, a lane from the Price List, and one letter each. The rules are set
 * out in @ff/shared's price-email; the ones this file enforces:
 *
 *  - The party's own PRICE_EMAIL on every route, and the Price List's own VIEW
 *    for whichever mode is being read — nobody emails prices they may not see.
 *  - Selling side only. visibleRates(…, false) whatever the caller holds.
 *  - Replies go to the Price team. No Price team, no send.
 *
 * Everything but who the letter is for is the same for both, so it is built
 * once here and each party says only how to find its people.
 */

/** A customer or agent, with the active contacts that have an address. */
export interface PriceEmailPartyRow {
  id: bigint;
  code: string;
  name: string;
  pics: { name: string; email: string | null }[];
}

/** What one party brings: who it is, and how to read its list. */
export interface PriceEmailPartySource<Query> {
  party: PriceEmailParty;
  /** e.g. CRM.CUSTOMER.PRICE_EMAIL */
  permission: string;
  templateKey: string;
  /** The party's CRM list filters, and only those. */
  recipientQuery: z.ZodType<Query>;
  /** The active rows those filters select, in name order, at most `take` of them. */
  findRecipients(db: TenantDb, query: Query, take: number): Promise<PriceEmailPartyRow[]>;
  /** Which of these ids are active rows of this workspace, in name order. */
  findActive(db: TenantDb, ids: bigint[]): Promise<{ id: bigint }[]>;
}

const modeQuerySchema = z.object({
  mode: z.enum(RATE_MODES, { message: 'Choose a freight mode.' }),
});

function mayReadPriceList(auth: AuthContext, mode: RateMode): boolean {
  return auth.isSuperadmin || auth.permissions.has(`${PRICE_LIST_FEATURE_BY_MODE[mode]}.VIEW`);
}

function assertPriceList(auth: AuthContext, mode: RateMode): void {
  if (!mayReadPriceList(auth, mode)) {
    throw HttpError.forbidden(
      `You cannot see the ${RATE_MODE_LABEL[mode]} price list, so you cannot email it.`,
    );
  }
}

async function priceTeam(db: TenantDb): Promise<string[]> {
  const row = await db.notificationSetting.findFirst({ select: { priceTeamEmails: true } });
  return parseAddressList(row?.priceTeamEmails ?? '');
}

/**
 * How the letter ends: the email signature from Settings → Notifications,
 * closing words and all, and nothing else. The sender's name, designation
 * and a "Kind regards," of our own were all dropped at the client's request
 * (2026-09-29) — the signature already carries them, and one letter going to
 * many customers is from the company, not from whoever pressed Send.
 */
async function signOff(db: TenantDb): Promise<string> {
  const setting = await db.notificationSetting.findFirst({ select: { signatureBlock: true } });
  return setting?.signatureBlock?.trim() ?? '';
}

export function createPriceEmailRouter<Query>(source: PriceEmailPartySource<Query>): Router {
  const router = Router();
  router.use(authenticate);

  const { permission } = source;
  const noun = PRICE_EMAIL_PARTY_NOUN[source.party];
  const sendSchema = priceEmailSendSchema(source.party);

  /** GET …/context — what the screen needs before anything is picked. */
  router.get('/context', requirePermission(permission), async (req, res) => {
    const auth = req.auth!;
    const data = await withTenant(
      auth.tenantId,
      async (db): Promise<PriceEmailContextDto> => ({
        priceTeamEmails: await priceTeam(db),
        signOff: await signOff(db),
        modes: RATE_MODES.filter((mode) => mayReadPriceList(auth, mode)),
      }),
    );
    const payload: ApiSuccess<PriceEmailContextDto> = { success: true, data };
    res.json(payload);
  });

  /**
   * GET …/options?mode= — every active port of the mode's kind and every active
   * carrier, as the Price List offers them.
   *
   * It used to offer only lanes with a rate on offer today, which hid most of
   * the port list (client, 2026-09-29). A lane with no rate now says so under
   * the pickers instead.
   */
  router.get('/options', requirePermission(permission), async (req, res) => {
    const auth = req.auth!;
    const { mode } = modeQuerySchema.parse(req.query);
    assertPriceList(auth, mode);

    const { ports, carriers } = await withTenant(auth.tenantId, async (db) => {
      // A shared row this workspace switched off is an override, not a flag on
      // the row (§7A rule 7) — the same reading the Price List's pickers make.
      const inactive = await inactiveMasters(db);
      return {
        ports: await db.port.findMany({
          where: {
            ...excludeInactive(inactive, 'port'),
            deletedAt: null,
            isActive: true,
            type: mode === 'AIR' ? 'AIRPORT' : 'SEAPORT',
          },
          select: { id: true, name: true, portCode: true },
          orderBy: { name: 'asc' },
        }),
        carriers: await db.carrier.findMany({
          where: { ...excludeInactive(inactive, 'carrier'), deletedAt: null, isActive: true },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      };
    });

    const portOptions: LookupOption[] = ports.map((p) => ({
      id: p.id.toString(),
      name: `${p.name} (${p.portCode})`,
    }));
    const data: PriceEmailOptionsDto = {
      pols: portOptions,
      pods: portOptions,
      carriers: carriers.map((c) => ({ id: c.id.toString(), name: c.name })),
    };
    const payload: ApiSuccess<PriceEmailOptionsDto> = { success: true, data };
    res.json(payload);
  });

  /**
   * GET …/recipients — the active customers or agents the list's filters
   * select, with every address on their active contacts, already checked.
   *
   * A contact's email field sometimes holds two addresses ("a@x.com; b@x.com");
   * they are split, because that is plainly what was meant.
   */
  router.get('/recipients', requirePermission(permission), async (req, res) => {
    const auth = req.auth!;
    const query = source.recipientQuery.parse(req.query);

    const parties = await withTenant(auth.tenantId, (db) =>
      source.findRecipients(db, query, PRICE_EMAIL_MAX_RECIPIENTS + 1),
    );
    if (parties.length > PRICE_EMAIL_MAX_RECIPIENTS) {
      throw HttpError.badRequest(
        `Those filters match more than ${PRICE_EMAIL_MAX_RECIPIENTS} ${noun.many}. Narrow them on the ${noun.list} first.`,
      );
    }

    // Per recipient, each address once — two contacts sharing an inbox is one letter.
    const listed = parties.map((party) => {
      const seen = new Set<string>();
      const emails: { address: string; picName: string | null }[] = [];
      for (const pic of party.pics) {
        for (const address of parseAddressList(pic.email)) {
          if (seen.has(address.toLowerCase())) continue;
          seen.add(address.toLowerCase());
          emails.push({ address, picName: pic.name });
        }
      }
      return { party, emails };
    });

    // Outside the transaction: DNS can take seconds, and a held transaction is a held connection.
    const checks = await checkAddresses(listed.flatMap((l) => l.emails.map((e) => e.address)));
    const byAddress = new Map(checks.map((c) => [c.address, c]));

    const data: PriceEmailRecipientsDto = {
      recipients: listed.map(({ party, emails }) => ({
        partyId: party.id.toString(),
        partyCode: party.code,
        partyName: party.name,
        emails: emails.map((e) => ({ ...byAddress.get(e.address)!, picName: e.picName })),
      })),
    };
    const payload: ApiSuccess<PriceEmailRecipientsDto> = { success: true, data };
    res.json(payload);
  });

  /** POST …/check — an address typed or corrected on the screen, checked the same way. */
  router.post('/check', requirePermission(permission), async (req, res) => {
    const input = priceEmailCheckSchema.parse(req.body);
    const data = await checkAddresses(input.addresses);
    const payload: ApiSuccess<EmailCheckDto[]> = { success: true, data };
    res.json(payload);
  });

  /**
   * GET …/rates — the Price List's rows for the lanes picked, selling side only.
   *
   * Stripped here whatever the caller may see on the Price List itself: the
   * text becomes an email, and an email leaves the building the way a download
   * does (the client's 2026-09-06 rule for exports).
   */
  router.get('/rates', requirePermission(permission), async (req, res) => {
    const auth = req.auth!;
    const query = priceEmailRatesQuerySchema.parse(req.query);
    assertPriceList(auth, query.mode);

    const listQuery = freightRateListQuerySchema.parse({
      mode: query.mode,
      polIds: query.polIds.join(','),
      podIds: query.podIds.join(','),
      ...(query.carrierId === undefined ? {} : { carrierId: query.carrierId }),
      page: '1',
    });
    const { rates, total } = await priceListRows(auth, listQuery, PRICE_EMAIL_MAX_RATES);

    const data: PriceEmailRatesDto = {
      rates: visibleRates(rates, false),
      truncated: total > PRICE_EMAIL_MAX_RATES,
    };
    const payload: ApiSuccess<PriceEmailRatesDto> = { success: true, data };
    res.json(payload);
  });

  /**
   * POST …/send — one letter per customer or agent into the outbox.
   *
   * The screen sends which rates, never their figures: they are read back here
   * from the Price List, selling side only, and drawn into the table by the
   * same function the screen previews with. A rate that lapsed or was
   * withdrawn since it was ticked refuses the send rather than going out stale.
   *
   * The screen's green is a courtesy; every address is checked for shape again
   * here and a bad one refuses the whole send, naming it, rather than going out
   * to everyone else and failing quietly for one. The domain check is not
   * repeated: it ran when the address was shown, and a send should not wait on
   * DNS for hundreds of domains a second time.
   */
  router.post('/send', requirePermission(permission), async (req, res) => {
    const auth = req.auth!;
    const input = sendSchema.parse(req.body);
    assertPriceList(auth, input.mode);

    // The same recipient twice is one letter to all of the addresses given for them.
    const merged = new Map<string, Set<string>>();
    for (const recipient of input.recipients) {
      const emails = merged.get(recipient.partyId) ?? new Set<string>();
      for (const email of recipient.emails) emails.add(email.trim());
      merged.set(recipient.partyId, emails);
    }

    const bad = [...merged.values()].flatMap((emails) =>
      [...emails].filter((email) => emailSyntaxProblem(email) !== null),
    );
    if (bad.length > 0) {
      const named = bad.slice(0, 5).join(', ') + (bad.length > 5 ? ` and ${bad.length - 5} more` : '');
      throw HttpError.badRequest(`Fix or remove before sending: ${named}.`);
    }

    const ids = [...merged.keys()].map((id) => BigInt(id));
    const { parties, replyTo, sender } = await withTenant(auth.tenantId, async (db) => ({
      parties: await source.findActive(db, ids),
      replyTo: await priceTeam(db),
      sender: await signOff(db),
    }));

    if (replyTo.length === 0) {
      throw HttpError.conflict(
        `Add the Price team address under Settings → Notifications first — ${noun.one} replies go there.`,
      );
    }
    if (parties.length !== ids.length) {
      throw HttpError.badRequest(
        `Some of those ${noun.many} are no longer active. Reload the page to see who is left.`,
      );
    }

    const rateIds = [...new Set(input.rateIds)];
    const rates = await offeredRatesById(auth, input.mode, rateIds.map((id) => BigInt(id)));
    if (rates.length !== rateIds.length) {
      const gone = rateIds.length - rates.length;
      throw HttpError.conflict(
        `${gone === 1 ? 'One of those rates is' : `${gone} of those rates are`} no longer on offer — ` +
          'expired or withdrawn. Pick the lanes again to reload the rates.',
      );
    }
    /*
     * The same letter for everyone — the greeting is "Dear Sir/Madam," — so it
     * is built once. Each recipient still gets their own copy, addressed to
     * their own contacts only: the letter is shared, the address book is not.
     */
    const variables = {
      subject: input.subject,
      message: input.message,
      rates: priceEmailRatesText(rates, { includeLocalCharges: input.includeLocalCharges }),
      signOff: sender,
    };
    // The table. The text part is its stand-in for clients without HTML.
    const html = priceEmailHtml({
      message: input.message,
      rates,
      includeLocalCharges: input.includeLocalCharges,
      signOff: sender,
    });

    let queued = 0;
    for (const party of parties) {
      const result = await queueMail({
        tenantId: auth.tenantId,
        templateKey: source.templateKey,
        to: [...merged.get(party.id.toString())!],
        replyTo,
        variables,
        relatedType: source.party,
        relatedId: party.id,
        actorId: auth.userId,
        fallback: { subject: input.subject, bodyText: composePriceEmailBody(variables) },
        html,
      });
      if (result.queued) queued += 1;
    }

    const payload: ApiSuccess<PriceEmailSendResultDto> = { success: true, data: { queued } };
    res.json(payload);
  });

  return router;
}
