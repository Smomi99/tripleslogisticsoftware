import { Router } from 'express';

import {
  type AgentInquiryDto,
  type AgentInquiryVolumeDto,
  agentInquiryListQuerySchema,
  type AgentQuoteDto,
  agentQuoteInputSchema,
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type PortalCurrencyOption,
} from '@ff/shared';

import { recordAudit } from '../lib/audit';
import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { isoCurrency } from '../lib/currency-label';
import { HttpError } from '../lib/http-error';
import { notifyQuoteSubmitted } from '../lib/quote-notify';
import { parseId } from '../lib/request';
import { Prisma } from '../generated/prisma/client';
import { type TenantDb, withAgent, withTenant } from '../lib/tenant-client';
import { authenticateAgent } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Agent Inquiry — the one screen an agent account can reach.
 *
 * An agent is an ordinary user of this workspace: created on Add User, given a
 * role, holding permissions. What makes them different is that their role only
 * ever carries AGENT.INQUIRY, and `authenticateAgent` refuses their session on
 * every other router — so a misconfigured role cannot widen what they see.
 *
 * Every route opens its transaction with `withAgent`, so RLS is active for the
 * whole of it and an agent's reach is decided by the policies rather than by
 * the correctness of the queries below. The queries filter explicitly as well —
 * belt and braces, on the principle that either layer alone should be enough.
 *
 * Inquiries are read from `agent_inquiry_v`, never from `inquiry`. The base
 * table carries customer_id on the row itself; the view has no such column, so
 * there is nothing for a careless `SELECT *` to leak.
 */
export const agentInquiryRouter: Router = Router();

agentInquiryRouter.use(authenticateAgent);

const PAGE_SIZE = 25;

interface InquiryRow {
  id: bigint;
  code: string;
  inquiry_date: Date;
  shipment_type: string;
  movement_type: string;
  loading_type: string | null;
  place_of_receipt: string | null;
  hs_code: string | null;
  expected_shipment_date: Date | null;
  valid_to: Date | null;
  status: string;
  pol_name: string | null;
  pol_code: string | null;
  pol_country: string | null;
  pod_name: string | null;
  pod_code: string | null;
  pod_country: string | null;
  commodity_name: string | null;
  tos_name: string | null;
  mode_name: string | null;
}

interface VolumeRow {
  id: bigint;
  inquiry_id: bigint;
  volume_kind: string;
  container_type_name: string | null;
  container_type_note: string | null;
  quantity: number | null;
  cbm: Prisma.Decimal | null;
  weight_kg: Prisma.Decimal | null;
}

const QUOTE_SELECT = {
  id: true,
  code: true,
  amount: true,
  currencyId: true,
  validUntil: true,
  transitDays: true,
  remarks: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  inquiryId: true,
  currency: { select: { currency: true } },
} as const;

type QuoteRow = {
  id: bigint;
  code: string;
  amount: Prisma.Decimal | null;
  currencyId: bigint;
  validUntil: Date | null;
  transitDays: number | null;
  remarks: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  inquiryId: bigint;
  currency: { currency: string } | null;
};

function quoteToDto(row: QuoteRow): AgentQuoteDto {
  return {
    id: row.id.toString(),
    code: row.code,
    amount: row.amount?.toString() ?? '0',
    currencyId: row.currencyId.toString(),
    currencyCode: row.currency === null ? null : isoCurrency(row.currency.currency),
    validUntil: row.validUntil?.toISOString().slice(0, 10) ?? null,
    transitDays: row.transitDays,
    remarks: row.remarks,
    status: row.status,
    submittedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function volumeToDto(row: VolumeRow): AgentInquiryVolumeDto {
  return {
    id: row.id.toString(),
    volumeKind: row.volume_kind,
    containerTypeName: row.container_type_name,
    containerTypeNote: row.container_type_note,
    quantity: row.quantity,
    cbm: row.cbm?.toString() ?? null,
    weightKg: row.weight_kg?.toString() ?? null,
  };
}

function inquiryToDto(
  row: InquiryRow,
  volumes: AgentInquiryVolumeDto[],
  quote: AgentQuoteDto | null,
): AgentInquiryDto {
  return {
    id: row.id.toString(),
    code: row.code,
    inquiryDate: row.inquiry_date.toISOString().slice(0, 10),
    shipmentType: row.shipment_type,
    movementType: row.movement_type,
    loadingType: row.loading_type,
    polName: row.pol_name,
    polCode: row.pol_code,
    polCountry: row.pol_country,
    podName: row.pod_name,
    podCode: row.pod_code,
    podCountry: row.pod_country,
    placeOfReceipt: row.place_of_receipt,
    commodityName: row.commodity_name,
    hsCode: row.hs_code,
    tosName: row.tos_name,
    modeName: row.mode_name,
    expectedShipmentDate: row.expected_shipment_date?.toISOString().slice(0, 10) ?? null,
    validTo: row.valid_to?.toISOString().slice(0, 10) ?? null,
    status: row.status,
    volumes,
    quote,
  };
}

/**
 * LEFT JOIN throughout, and not by accident.
 *
 * Every joined table is one an agent may or may not be able to read. An INNER
 * JOIN to a table Phase 3 closed would make the inquiry itself disappear —
 * the feature would fail closed and look like data loss rather than a policy
 * decision. A LEFT JOIN degrades to a null label instead.
 */
const INQUIRY_COLUMNS = Prisma.sql`
  v.id, v.code, v.inquiry_date, v.shipment_type, v.movement_type, v.loading_type,
  v.place_of_receipt, v.hs_code, v.expected_shipment_date, v.valid_to, v.status,
  pol.name AS pol_name, pol.port_code AS pol_code, pol.country AS pol_country,
  pod.name AS pod_name, pod.port_code AS pod_code, pod.country AS pod_country,
  ci.name AS commodity_name, t.name AS tos_name, m.name AS mode_name`;

const INQUIRY_JOINS = Prisma.sql`
  FROM agent_inquiry_v v
  LEFT JOIN port pol ON pol.id = v.pol_id
  LEFT JOIN port pod ON pod.id = v.pod_id
  LEFT JOIN commodity_item ci ON ci.id = v.commodity_item_id
  LEFT JOIN tos t ON t.id = v.tos_id
  LEFT JOIN mode m ON m.id = v.mode_id`;

/** Volumes for a set of inquiries, from the view that has no target price. */
async function volumesFor(db: TenantDb, inquiryIds: bigint[]) {
  if (inquiryIds.length === 0) return new Map<string, AgentInquiryVolumeDto[]>();
  const rows = await db.$queryRaw<VolumeRow[]>`
    SELECT vol.id, vol.inquiry_id, vol.volume_kind, vol.container_type_note,
           vol.quantity, vol.cbm, vol.weight_kg,
           ct.name AS container_type_name
      FROM agent_inquiry_volume_v vol
      LEFT JOIN container_type ct ON ct.id = vol.container_type_id
     WHERE vol.inquiry_id IN (${Prisma.join(inquiryIds)})
     ORDER BY vol.id`;

  const byInquiry = new Map<string, AgentInquiryVolumeDto[]>();
  for (const row of rows) {
    const key = row.inquiry_id.toString();
    byInquiry.set(key, [...(byInquiry.get(key) ?? []), volumeToDto(row)]);
  }
  return byInquiry;
}

/** GET /api/portal/inquiries */
agentInquiryRouter.get('/', requirePermission('AGENT.INQUIRY.VIEW'), async (req, res) => {
  const auth = req.auth!;
  const agentId = auth.agentId;
  if (agentId === null) throw HttpError.forbidden('This area is for agent accounts.');

  const query = agentInquiryListQuerySchema.parse(req.query);
  const offset = (query.page - 1) * PAGE_SIZE;

  const search = query.search === undefined || query.search === '' ? null : `%${query.search}%`;
  const where = Prisma.sql`WHERE (${search}::text IS NULL OR v.code ILIKE ${search}
      OR pol.name ILIKE ${search} OR pod.name ILIKE ${search})`;

  const result = await withAgent(auth.tenantId, agentId, async (db) => {
    const rows = await db.$queryRaw<(InquiryRow & { total: bigint })[]>`
      SELECT ${INQUIRY_COLUMNS}, count(*) OVER () AS total
      ${INQUIRY_JOINS}
      ${where}
      ORDER BY v.inquiry_date DESC, v.id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

    const ids = rows.map((r) => r.id);
    const [volumes, quotes] = await Promise.all([
      volumesFor(db, ids),
      ids.length === 0
        ? Promise.resolve([] as QuoteRow[])
        : (db.agentQuote.findMany({
            where: { inquiryId: { in: ids }, agentId, deletedAt: null, status: { not: 'WITHDRAWN' } },
            select: QUOTE_SELECT,
          }) as unknown as Promise<QuoteRow[]>),
    ]);
    const quoteByInquiry = new Map(quotes.map((q) => [q.inquiryId.toString(), q]));

    return {
      total: Number(rows[0]?.total ?? 0),
      data: rows.map((row) => {
        const quote = quoteByInquiry.get(row.id.toString());
        return inquiryToDto(
          row,
          volumes.get(row.id.toString()) ?? [],
          quote === undefined ? null : quoteToDto(quote),
        );
      }),
    };
  });

  // "Not yet quoted" is applied after the join rather than in SQL: the quote is
  // a separate query because RLS scopes it to this agent on its own terms.
  const data =
    query.pending === 'true' ? result.data.filter((i) => i.quote === null) : result.data;

  const payload: ApiSuccess<AgentInquiryDto[]> = {
    success: true,
    data,
    meta: buildMeta(result.total, query.page, PAGE_SIZE),
  };
  res.json(payload);
});

/** GET /api/portal/inquiries/:id */
agentInquiryRouter.get('/:id', requirePermission('AGENT.INQUIRY.VIEW'), async (req, res) => {
  const auth = req.auth!;
  const agentId = auth.agentId;
  if (agentId === null) throw HttpError.forbidden('This area is for agent accounts.');
  const inquiryId = parseId(req.params.id, 'inquiry');

  const found = await withAgent(auth.tenantId, agentId, async (db) => {
    const rows = await db.$queryRaw<InquiryRow[]>`
      SELECT ${INQUIRY_COLUMNS}
      ${INQUIRY_JOINS}
      WHERE v.id = ${inquiryId}`;
    const row = rows[0];
    if (row === undefined) return null;

    const [volumes, quote] = await Promise.all([
      volumesFor(db, [row.id]),
      db.agentQuote.findFirst({
        where: { inquiryId: row.id, agentId, deletedAt: null, status: { not: 'WITHDRAWN' } },
        select: QUOTE_SELECT,
      }) as unknown as Promise<QuoteRow | null>,
    ]);

    return inquiryToDto(
      row,
      volumes.get(row.id.toString()) ?? [],
      quote === null ? null : quoteToDto(quote),
    );
  });

  // 404, not 403: an inquiry this agent was not selected for does not exist as
  // far as they are concerned, and a 403 would confirm that it does.
  if (found === null) throw HttpError.notFound('That inquiry is not available to you.');

  // Who looked at what, and when. An agent reading a lane is a commercially
  // meaningful event — it is the evidence behind "we sent it to them on
  // Tuesday and they never opened it".
  await recordAudit({
    tenantId: auth.tenantId,
    action: 'VIEW',
    tableName: 'inquiry',
    recordId: inquiryId,
    actorId: auth.userId,
    details: { agentId: agentId.toString() },
  });

  const payload: ApiSuccess<AgentInquiryDto> = { success: true, data: found };
  res.json(payload);
});

/** An inquiry stops taking quotes once it has left OPEN. */
function assertQuotable(status: string): void {
  if (status !== 'OPEN') {
    throw new HttpError(
      409,
      'INQUIRY_CLOSED',
      'This inquiry is no longer open for quoting.',
    );
  }
}

/** POST /api/portal/inquiries/:id/quote */
agentInquiryRouter.post('/:id/quote', requirePermission('AGENT.INQUIRY.QUOTE'), async (req, res) => {
  const auth = req.auth!;
  const agentId = auth.agentId;
  if (agentId === null) throw HttpError.forbidden('This area is for agent accounts.');
  const inquiryId = parseId(req.params.id, 'inquiry');
  const input = agentQuoteInputSchema.parse(req.body);

  const created = await withAgent(auth.tenantId, agentId, async (db) => {
    // Read through the view, so an inquiry this agent was not sent cannot be
    // quoted even by guessing the id.
    const rows = await db.$queryRaw<{ id: bigint; status: string; code: string }[]>`
      SELECT id, status, code FROM agent_inquiry_v WHERE id = ${inquiryId}`;
    const inquiry = rows[0];
    if (inquiry === undefined) return null;
    assertQuotable(inquiry.status);

    const existing = await db.agentQuote.findFirst({
      where: { inquiryId, agentId, deletedAt: null, status: { not: 'WITHDRAWN' } },
      select: { id: true },
    });
    if (existing !== null) {
      throw HttpError.conflict('You have already quoted this inquiry. Amend it instead.');
    }

    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      /*
       * Allocated with TENANT scope, not agent scope, and that distinction is
       * the whole bug this replaced.
       *
       * nextCode reads MAX(code) for the workspace. Run inside withAgent, row
       * level security hides every other agent's quotes from that read — so the
       * maximum an agent can see is always their own, and every agent computes
       * AQ-001. The first agent to quote a workspace succeeds; the second one
       * collides on a row it is not allowed to know exists, for ever.
       *
       * Not a race, which is what the retry loop was built for: a systematic
       * collision that no number of retries would clear. The agent still never
       * sees another agent's code — only the server does, for one query.
       */
      const code = await withTenant(auth.tenantId, (scoped) =>
        nextCode(scoped, 'agentQuote', CODE_PREFIX.agentQuote, auth.tenantId),
      );
      try {
        const quote = (await db.agentQuote.create({
          data: {
            tenantId: auth.tenantId,
            code,
            inquiryId,
            // From the session, never from the body. A body-supplied agentId
            // would be refused by the RLS WITH CHECK anyway, which is the point
            // of having both.
            agentId,
            submittedBy: auth.userId,
            amount: new Prisma.Decimal(input.amount),
            currencyId: BigInt(input.currencyId),
            validUntil:
              input.validUntil === undefined || input.validUntil === ''
                ? null
                : new Date(input.validUntil),
            transitDays:
              typeof input.transitDays === 'number' ? input.transitDays : null,
            remarks: input.remarks === undefined || input.remarks === '' ? null : input.remarks,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: QUOTE_SELECT,
        })) as unknown as QuoteRow;
        return { quote, inquiryCode: inquiry.code };
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a quote code.');
  });

  if (created === null) throw HttpError.notFound('That inquiry is not available to you.');

  await recordAudit({
    tenantId: auth.tenantId,
    action: 'QUOTE_SUBMITTED',
    tableName: 'agent_quote',
    recordId: created.quote.id,
    actorId: auth.userId,
    details: { inquiryId: inquiryId.toString(), agentId: agentId.toString() },
  });

  // Approved item C. After the transaction and never able to fail it.
  await notifyQuoteSubmitted({
    tenantId: auth.tenantId,
    agentId,
    inquiryId,
    inquiryCode: created.inquiryCode,
  });

  const payload: ApiSuccess<AgentQuoteDto> = { success: true, data: quoteToDto(created.quote) };
  res.status(201).json(payload);
});

/** PATCH /api/tenant/agent/quotes/:id — amend while the inquiry is open. */
export const agentQuoteRouter: Router = Router();

agentQuoteRouter.use(authenticateAgent);

agentQuoteRouter.patch('/:id', requirePermission('AGENT.INQUIRY.QUOTE'), async (req, res) => {
  const auth = req.auth!;
  const agentId = auth.agentId;
  if (agentId === null) throw HttpError.forbidden('This area is for agent accounts.');
  const quoteId = parseId(req.params.id, 'quote');
  const input = agentQuoteInputSchema.parse(req.body);

  const updated = await withAgent(auth.tenantId, agentId, async (db) => {
    const quote = await db.agentQuote.findFirst({
      where: { id: quoteId, agentId, deletedAt: null },
      select: { id: true, inquiryId: true, status: true },
    });
    if (quote === null) return null;
    if (quote.status !== 'SUBMITTED') {
      throw new HttpError(
        409,
        'QUOTE_CLOSED',
        'This quote has been answered and can no longer be changed.',
      );
    }

    const rows = await db.$queryRaw<{ status: string }[]>`
      SELECT status FROM agent_inquiry_v WHERE id = ${quote.inquiryId}`;
    const status = rows[0]?.status;
    if (status === undefined) return null;
    // The same reasoning that stops staff editing a WON inquiry.
    assertQuotable(status);

    return (await db.agentQuote.update({
      where: { id: quote.id },
      data: {
        amount: new Prisma.Decimal(input.amount),
        currencyId: BigInt(input.currencyId),
        // An omitted field is left alone; an empty one is cleared. The form
        // always sends all of them, so this only matters to a caller that does
        // not — and silently wiping an agent's remarks because a request did
        // not mention them is not a PATCH, it is a PUT wearing its badge.
        ...(input.validUntil === undefined
          ? {}
          : { validUntil: input.validUntil === '' ? null : new Date(input.validUntil) }),
        ...(input.transitDays === undefined
          ? {}
          : { transitDays: typeof input.transitDays === 'number' ? input.transitDays : null }),
        ...(input.remarks === undefined ? {} : { remarks: input.remarks === '' ? null : input.remarks }),
        updatedBy: auth.userId,
      },
      select: QUOTE_SELECT,
    })) as unknown as QuoteRow;
  });

  if (updated === null) throw HttpError.notFound('That quote is not available to you.');

  await recordAudit({
    tenantId: auth.tenantId,
    action: 'QUOTE_AMENDED',
    tableName: 'agent_quote',
    recordId: updated.id,
    actorId: auth.userId,
    details: { agentId: agentId.toString() },
  });

  const payload: ApiSuccess<AgentQuoteDto> = { success: true, data: quoteToDto(updated) };
  res.json(payload);
});

/**
 * GET /api/tenant/agent/currencies
 *
 * The only reference data an agent can enumerate, and it lives beside the
 * routes that use it so the list stays one screenful.
 *
 * Three columns. `conversion`, `tenantRate` and the rate history say something
 * about the forwarder's margins and are none of an agent's business, so they
 * are not selected rather than selected and dropped.
 */
export const agentReferenceRouter: Router = Router();

agentReferenceRouter.use(authenticateAgent);

agentReferenceRouter.get('/', requirePermission('AGENT.INQUIRY.VIEW'), async (req, res) => {
  const auth = req.auth!;
  if (auth.agentId === null) throw HttpError.forbidden('This area is for agent accounts.');

  const rows = await withAgent(auth.tenantId, auth.agentId, (db) =>
    db.currency.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, currency: true },
      orderBy: { currency: 'asc' },
    }),
  );

  const payload: ApiSuccess<PortalCurrencyOption[]> = {
    success: true,
    data: rows.map((row) => ({
      id: row.id.toString(),
      code: isoCurrency(row.currency),
      label: row.currency,
    })),
  };
  res.json(payload);
});
