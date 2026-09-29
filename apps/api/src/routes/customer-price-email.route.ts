import {
  type ApiSuccess,
  composePriceEmailBody,
  type EmailCheckDto,
  emailSyntaxProblem,
  freightRateListQuerySchema,
  type LookupOption,
  PRICE_EMAIL_MAX_CUSTOMERS,
  PRICE_EMAIL_MAX_RATES,
  priceEmailCheckSchema,
  type PriceEmailContextDto,
  type PriceEmailOptionsDto,
  priceEmailRatesQuerySchema,
  type PriceEmailRatesDto,
  priceEmailRecipientQuerySchema,
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

import { customerFilterWhere } from '../lib/customer-filter';
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
 * CRM → Customer → Email prices (2026-09-29).
 *
 * The customers the list is filtered to, their contacts' addresses checked,
 * a lane from the Price List, and one letter per customer. The rules are set
 * out in @ff/shared's customer-price-email; the ones this file enforces:
 *
 *  - CRM.CUSTOMER.PRICE_EMAIL on every route, and the Price List's own VIEW
 *    for whichever mode is being read — nobody emails prices they may not see.
 *  - Selling side only. visibleRates(…, false) whatever the caller holds.
 *  - Replies go to the Price team. No Price team, no send.
 */
export const customerPriceEmailRouter: Router = Router();
customerPriceEmailRouter.use(authenticate);

const PERMISSION = 'CRM.CUSTOMER.PRICE_EMAIL';
export const CUSTOMER_PRICE_OFFER = 'CUSTOMER_PRICE_OFFER';

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

/** GET …/context — what the screen needs before anything is picked. */
customerPriceEmailRouter.get('/context', requirePermission(PERMISSION), async (req, res) => {
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
customerPriceEmailRouter.get('/options', requirePermission(PERMISSION), async (req, res) => {
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
 * GET …/recipients — the active customers the Customer list's filters select,
 * with every address on their active contacts, already checked.
 *
 * A contact's email field sometimes holds two addresses ("a@x.com; b@x.com");
 * they are split, because that is plainly what was meant.
 */
customerPriceEmailRouter.get('/recipients', requirePermission(PERMISSION), async (req, res) => {
  const auth = req.auth!;
  const query = priceEmailRecipientQuerySchema.parse(req.query);

  const customers = await withTenant(auth.tenantId, (db) =>
    db.customer.findMany({
      // Active only: a deactivated customer is one we have stopped dealing with.
      where: customerFilterWhere({ ...query, isActive: true }),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: PRICE_EMAIL_MAX_CUSTOMERS + 1,
      select: {
        id: true,
        code: true,
        name: true,
        pics: {
          where: { deletedAt: null, isActive: true, email: { not: null } },
          orderBy: { id: 'asc' },
          select: { name: true, email: true },
        },
      },
    }),
  );
  if (customers.length > PRICE_EMAIL_MAX_CUSTOMERS) {
    throw HttpError.badRequest(
      `Those filters match more than ${PRICE_EMAIL_MAX_CUSTOMERS} customers. Narrow them on the Customer list first.`,
    );
  }

  // Per customer, each address once — two contacts sharing an inbox is one letter.
  const listed = customers.map((customer) => {
    const seen = new Set<string>();
    const emails: { address: string; picName: string | null }[] = [];
    for (const pic of customer.pics) {
      for (const address of parseAddressList(pic.email)) {
        if (seen.has(address.toLowerCase())) continue;
        seen.add(address.toLowerCase());
        emails.push({ address, picName: pic.name });
      }
    }
    return { customer, emails };
  });

  // Outside the transaction: DNS can take seconds, and a held transaction is a held connection.
  const checks = await checkAddresses(listed.flatMap((l) => l.emails.map((e) => e.address)));
  const byAddress = new Map(checks.map((c) => [c.address, c]));

  const data: PriceEmailRecipientsDto = {
    customers: listed.map(({ customer, emails }) => ({
      customerId: customer.id.toString(),
      customerCode: customer.code,
      customerName: customer.name,
      emails: emails.map((e) => ({ ...byAddress.get(e.address)!, picName: e.picName })),
    })),
  };
  const payload: ApiSuccess<PriceEmailRecipientsDto> = { success: true, data };
  res.json(payload);
});

/** POST …/check — an address typed or corrected on the screen, checked the same way. */
customerPriceEmailRouter.post('/check', requirePermission(PERMISSION), async (req, res) => {
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
customerPriceEmailRouter.get('/rates', requirePermission(PERMISSION), async (req, res) => {
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
 * POST …/send — one letter per customer into the outbox.
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
customerPriceEmailRouter.post('/send', requirePermission(PERMISSION), async (req, res) => {
  const auth = req.auth!;
  const input = priceEmailSendSchema.parse(req.body);
  assertPriceList(auth, input.mode);

  // The same customer twice is one letter to all of the addresses given for it.
  const merged = new Map<string, Set<string>>();
  for (const recipient of input.recipients) {
    const emails = merged.get(recipient.customerId) ?? new Set<string>();
    for (const email of recipient.emails) emails.add(email.trim());
    merged.set(recipient.customerId, emails);
  }

  const bad = [...merged.values()].flatMap((emails) =>
    [...emails].filter((email) => emailSyntaxProblem(email) !== null),
  );
  if (bad.length > 0) {
    const named = bad.slice(0, 5).join(', ') + (bad.length > 5 ? ` and ${bad.length - 5} more` : '');
    throw HttpError.badRequest(`Fix or remove before sending: ${named}.`);
  }

  const ids = [...merged.keys()].map((id) => BigInt(id));
  const { customers, replyTo, sender } = await withTenant(auth.tenantId, async (db) => ({
    customers: await db.customer.findMany({
      where: { id: { in: ids }, deletedAt: null, isActive: true },
      // The outbox fills in a stable order, the one the recipients were listed in.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    }),
    replyTo: await priceTeam(db),
    sender: await signOff(db),
  }));

  if (replyTo.length === 0) {
    throw HttpError.conflict(
      'Add the Price team address under Settings → Notifications first — customer replies go there.',
    );
  }
  if (customers.length !== ids.length) {
    throw HttpError.badRequest(
      'Some of those customers are no longer active. Reload the page to see who is left.',
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
   * is built once. Each customer still gets their own copy, addressed to
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
  for (const customer of customers) {
    const result = await queueMail({
      tenantId: auth.tenantId,
      templateKey: CUSTOMER_PRICE_OFFER,
      to: [...merged.get(customer.id.toString())!],
      replyTo,
      variables,
      relatedType: 'customer',
      relatedId: customer.id,
      actorId: auth.userId,
      fallback: { subject: input.subject, bodyText: composePriceEmailBody(variables) },
      html,
    });
    if (result.queued) queued += 1;
  }

  const payload: ApiSuccess<PriceEmailSendResultDto> = { success: true, data: { queued } };
  res.json(payload);
});
