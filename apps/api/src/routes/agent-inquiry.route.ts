import { Router } from 'express';

import {
  acceptsAgentQuotes,
  AGENT_QUOTE_AMENDABLE,
  type AgentInquiryDto,
  type AgentInquiryVolumeDto,
  agentInquiryListQuerySchema,
  type AgentQuoteCommentDto,
  agentQuoteCommentInputSchema,
  type AgentQuoteDto,
  type AgentQuoteInput,
  agentQuoteInputSchema,
  type AgentQuoteReferenceDto,
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  statusShownToAgent,
} from '@ff/shared';

import {
  COMMENT_SELECT_FLAT,
  type FlatCommentRow,
  flatCommentToDto,
  resolveAuthors,
} from '../lib/agent-quote-comment';
import { optionToDto, OPTIONS_INCLUDE, type OptionRow } from '../lib/agent-quote-view';
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
  expected_shipment_date: Date | null;
  valid_to: Date | null;
  status: string;
  pol_name: string | null;
  pol_code: string | null;
  pol_country: string | null;
  pod_name: string | null;
  pod_code: string | null;
  pod_country: string | null;
  tos_name: string | null;
  mode_name: string | null;
}

interface VolumeRow {
  id: bigint;
  inquiry_id: bigint;
  volume_kind: string;
  container_size_name: string | null;
  container_size_note: string | null;
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
  options: OPTIONS_INCLUDE,
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
  options: OptionRow[];
};

function quoteToDto(row: QuoteRow): AgentQuoteDto {
  return {
    id: row.id.toString(),
    code: row.code,
    // Empty once options carry the figures; still filled on the quotes
    // submitted before the breakdown existed.
    amount: row.amount?.toString() ?? '',
    currencyId: row.currencyId.toString(),
    currencyCode: row.currency === null ? null : isoCurrency(row.currency.currency),
    validUntil: row.validUntil?.toISOString().slice(0, 10) ?? null,
    transitDays: row.transitDays,
    remarks: row.remarks,
    // A shortlist is the forwarder's working note. To this agent it still
    // reads as awaiting an answer, which is exactly what it is.
    status: statusShownToAgent(row.status),
    submittedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    options: row.options.map(optionToDto),
  };
}

function volumeToDto(row: VolumeRow): AgentInquiryVolumeDto {
  return {
    id: row.id.toString(),
    volumeKind: row.volume_kind,
    containerSizeName: row.container_size_name,
    containerSizeNote: row.container_size_note,
    quantity: row.quantity,
    cbm: row.cbm?.toString() ?? null,
    weightKg: row.weight_kg?.toString() ?? null,
  };
}

function inquiryToDto(
  row: InquiryRow,
  volumes: AgentInquiryVolumeDto[],
  commodities: { name: string; hsCode: string | null }[],
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
    commodities,
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
  v.place_of_receipt, v.expected_shipment_date, v.valid_to, v.status,
  pol.name AS pol_name, pol.port_code AS pol_code, pol.country AS pol_country,
  pod.name AS pod_name, pod.port_code AS pod_code, pod.country AS pod_country,
  t.name AS tos_name, m.name AS mode_name`;

const INQUIRY_JOINS = Prisma.sql`
  FROM agent_inquiry_v v
  LEFT JOIN port pol ON pol.id = v.pol_id
  LEFT JOIN port pod ON pod.id = v.pod_id
  LEFT JOIN tos t ON t.id = v.tos_id
  LEFT JOIN mode m ON m.id = v.mode_id`;

/** Volumes for a set of inquiries, from the view that has no target price. */
/**
 * What is in the box, for a set of inquiries.
 *
 * Read straight from inquiry_commodity rather than through a view: unlike
 * inquiry_volume it carries nothing an agent may not see — no target price, no
 * customer — so the agent_read policy is the whole boundary and there is no
 * column to hide behind one.
 */
async function commoditiesFor(db: TenantDb, inquiryIds: bigint[]) {
  const byInquiry = new Map<string, { name: string; hsCode: string | null }[]>();
  if (inquiryIds.length === 0) return byInquiry;
  const rows = await db.inquiryCommodity.findMany({
    where: { inquiryId: { in: inquiryIds }, deletedAt: null },
    orderBy: { id: 'asc' },
    select: { inquiryId: true, hsCode: true, commodityItem: { select: { name: true } } },
  });
  for (const row of rows) {
    const key = row.inquiryId.toString();
    byInquiry.set(key, [
      ...(byInquiry.get(key) ?? []),
      { name: row.commodityItem?.name ?? '', hsCode: row.hsCode },
    ]);
  }
  return byInquiry;
}

async function volumesFor(db: TenantDb, inquiryIds: bigint[]) {
  if (inquiryIds.length === 0) return new Map<string, AgentInquiryVolumeDto[]>();
  const rows = await db.$queryRaw<VolumeRow[]>`
    SELECT vol.id, vol.inquiry_id, vol.volume_kind, vol.container_size_note,
           vol.quantity, vol.cbm, vol.weight_kg,
           ct.name AS container_size_name
      FROM agent_inquiry_volume_v vol
      LEFT JOIN container_size ct ON ct.id = vol.container_size_id
     WHERE vol.inquiry_id IN (${Prisma.join(inquiryIds)})
     ORDER BY vol.id`;

  const byInquiry = new Map<string, AgentInquiryVolumeDto[]>();
  for (const row of rows) {
    const key = row.inquiry_id.toString();
    byInquiry.set(key, [...(byInquiry.get(key) ?? []), volumeToDto(row)]);
  }
  return byInquiry;
}

/**
 * The forwarder's own company name.
 *
 * Read with withTenant rather than withAgent, because `tenant` is one of the
 * tables Phase 3 closed to agents — the same reason nextCode allocates outside
 * the agent scope. What comes back is a name the agent already knows: the
 * company they are quoting. It signs staff messages in the Status thread so
 * they do not read as coming from nobody, while the individual who typed them
 * stays unnamed.
 */
async function forwarderNameFor(tenantId: bigint): Promise<string> {
  const tenant = await withTenant(tenantId, (db) =>
    db.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
  );
  return tenant?.name ?? 'The forwarder';
}

/** An id from the wire, or null when the field was left blank. */
const optionalBigInt = (v: string | undefined) =>
  v === undefined || v === '' ? null : BigInt(v);

const optionalDate = (v: string | undefined) =>
  v === undefined || v === '' ? null : new Date(v);

const optionalText = (v: string | undefined) => (v === undefined || v === '' ? null : v);

const optionalInt = (v: number | '' | undefined) => (typeof v === 'number' ? v : null);

/**
 * Writes the offers of a quote: one option row per alternative, one line row
 * per charge.
 *
 * Positions are assigned here from array order rather than accepted from the
 * client. A client that sends two options both numbered 1 would otherwise
 * violate the partial unique index and surface as a 500 — and worse, a client
 * that renumbers them could reorder somebody else's offer.
 */
async function writeOptions(
  db: TenantDb,
  args: { tenantId: bigint; quoteId: bigint; userId: bigint; options: AgentQuoteInput['options'] },
): Promise<void> {
  for (const [index, option] of args.options.entries()) {
    /*
     * The option's headline carrier, taken from its lines.
     *
     * The wireframe puts Carrier on each charge row, not on the routing footer,
     * so that is where the agent types it — but "Option 1 · Maersk Line" is what
     * a buyer scans a comparison by.
     *
     * Blank lines are ignored rather than counted as disagreement. A
     * documentation fee with no carrier against it is a charge nobody thought
     * to attribute, not evidence of a second shipping line — and treating it as
     * the latter would blank the carrier on almost every real quotation, since
     * local charges are usually left unattributed.
     *
     * Two DIFFERENT carriers is genuine disagreement: the option is co-loaded
     * and no single name is true, so it stays null rather than picking one and
     * being wrong on a screen someone buys from.
     *
     * Recomputed on every write, so it cannot drift from the lines it came
     * from.
     */
    const lineCarriers = new Set(
      option.lines
        .map((line) => line.carrierId)
        .filter((id): id is string => id !== undefined && id !== ''),
    );
    const sharedCarrier = lineCarriers.size === 1 ? [...lineCarriers][0] : undefined;
    // `??` is not enough: the form sends an unset select as '', not undefined,
    // and '' ?? x is ''. An empty string here means "not stated", the same as
    // a missing key.
    const optionCarrier =
      option.carrierId === undefined || option.carrierId === ''
        ? sharedCarrier
        : option.carrierId;

    const created = await db.agentQuoteOption.create({
      data: {
        tenantId: args.tenantId,
        quoteId: args.quoteId,
        position: index + 1,
        carrierId: optionalBigInt(optionCarrier),
        transitDays: optionalInt(option.transitDays),
        via: optionalText(option.via),
        podFreeDays: optionalInt(option.podFreeDays),
        validUntil: optionalDate(option.validUntil),
        etd: optionalDate(option.etd),
        eta: optionalDate(option.eta),
        remarks: optionalText(option.remarks),
        createdBy: args.userId,
        updatedBy: args.userId,
      },
      select: { id: true },
    });

    await db.agentQuoteLine.createMany({
      data: option.lines.map((line, lineIndex) => ({
        tenantId: args.tenantId,
        optionId: created.id,
        position: lineIndex + 1,
        carrierId: optionalBigInt(line.carrierId),
        costHeadId: BigInt(line.costHeadId),
        containerSizeId: optionalBigInt(line.containerSizeId),
        costUnitId: optionalBigInt(line.costUnitId),
        quantity: new Prisma.Decimal(line.quantity),
        unitPrice: new Prisma.Decimal(line.unitPrice),
        currencyId: BigInt(line.currencyId),
        remarks: optionalText(line.remarks),
        createdBy: args.userId,
        updatedBy: args.userId,
      })),
    });
  }
}

/**
 * Retires the offers currently on a quote so a fresh set can replace them.
 *
 * Soft delete, per §4 rule 3 — and here it earns its keep commercially as well
 * as structurally. What an agent offered last Tuesday is a thing both sides may
 * need to point at, and the partial unique index on position is scoped to
 * `deleted_at IS NULL`, so the new generation reuses 1 and 2 cleanly.
 */
async function retireOptions(
  db: TenantDb,
  args: { quoteId: bigint; userId: bigint },
): Promise<void> {
  const live = await db.agentQuoteOption.findMany({
    where: { quoteId: args.quoteId, deletedAt: null },
    select: { id: true },
  });
  if (live.length === 0) return;
  const ids = live.map((o) => o.id);
  const now = new Date();
  await db.agentQuoteLine.updateMany({
    where: { optionId: { in: ids }, deletedAt: null },
    data: { deletedAt: now, isActive: false, updatedBy: args.userId },
  });
  await db.agentQuoteOption.updateMany({
    where: { id: { in: ids } },
    data: { deletedAt: now, isActive: false, updatedBy: args.userId },
  });
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
    const [volumes, commodities, quotes] = await Promise.all([
      volumesFor(db, ids),
      commoditiesFor(db, ids),
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
          commodities.get(row.id.toString()) ?? [],
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

    const [volumes, commodities, quote] = await Promise.all([
      volumesFor(db, [row.id]),
      commoditiesFor(db, [row.id]),
      db.agentQuote.findFirst({
        where: { inquiryId: row.id, agentId, deletedAt: null, status: { not: 'WITHDRAWN' } },
        select: QUOTE_SELECT,
      }) as unknown as Promise<QuoteRow | null>,
    ]);

    return inquiryToDto(
      row,
      volumes.get(row.id.toString()) ?? [],
      commodities.get(row.id.toString()) ?? [],
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
  if (!acceptsAgentQuotes(status)) {
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
        const header = await db.agentQuote.create({
          data: {
            tenantId: auth.tenantId,
            code,
            inquiryId,
            // From the session, never from the body. A body-supplied agentId
            // would be refused by the RLS WITH CHECK anyway, which is the point
            // of having both.
            agentId,
            submittedBy: auth.userId,
            // No headline amount: the figures live on the lines, and the
            // currency below is only the one the form defaulted to.
            currencyId: BigInt(input.options[0]!.lines[0]!.currencyId),
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: { id: true },
        });

        await writeOptions(db, {
          tenantId: auth.tenantId,
          quoteId: header.id,
          userId: auth.userId,
          options: input.options,
        });

        const quote = (await db.agentQuote.findFirstOrThrow({
          where: { id: header.id },
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
    // Shortlisted counts as open: the forwarder is still deciding, and an
    // agent who has not been answered must not find themselves locked out of
    // their own price by a note they cannot see.
    if (!AGENT_QUOTE_AMENDABLE.includes(quote.status as 'SUBMITTED')) {
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

    /*
     * An amendment replaces the offers wholesale rather than patching them
     * field by field.
     *
     * A quotation is one commercial statement, not a bag of independent
     * values: "option 2 now routes via Colombo at a different rate, and its
     * third line is gone" has no sensible per-field merge. The agent edits the
     * whole form and sends the whole form, the previous generation is retired
     * with its rows intact, and both sides can still see what was offered
     * before.
     */
    await retireOptions(db, { quoteId: quote.id, userId: auth.userId });
    await writeOptions(db, {
      tenantId: auth.tenantId,
      quoteId: quote.id,
      userId: auth.userId,
      options: input.options,
    });

    return (await db.agentQuote.update({
      where: { id: quote.id },
      data: {
        // The header keeps only the default currency; the money is on the
        // lines. amount stays as it was, which for a quote first submitted
        // under the old single-price form preserves what it said.
        currencyId: BigInt(input.options[0]!.lines[0]!.currencyId),
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
 * Every dropdown the quote form needs, and nothing else. It lives beside the
 * routes that use it so the list an agent can enumerate stays one screenful.
 *
 * Currency is three columns wide on purpose: `conversion`, `tenantRate` and the
 * rate history say something about the forwarder's margins and are none of an
 * agent's business, so they are not selected rather than selected and dropped.
 *
 * Carrier, cost head, container size and cost unit are here because the
 * wireframe puts them in the agent's own hands. They are names — shipping
 * lines, charge labels, box sizes, units of charge. Nothing priced: cost_head
 * carries no amount, and freight_rate and rate_local_charge stay closed.
 */
export const agentReferenceRouter: Router = Router();

agentReferenceRouter.use(authenticateAgent);

agentReferenceRouter.get('/', requirePermission('AGENT.INQUIRY.VIEW'), async (req, res) => {
  const auth = req.auth!;
  if (auth.agentId === null) throw HttpError.forbidden('This area is for agent accounts.');

  const live = { isActive: true, deletedAt: null } as const;
  const byName = { name: 'asc' } as const;

  const data = await withAgent(auth.tenantId, auth.agentId, async (db) => {
    const [currencies, carriers, costHeads, containerSizes, costUnits] = await Promise.all([
      db.currency.findMany({
        where: live,
        select: { id: true, currency: true },
        orderBy: { currency: 'asc' },
      }),
      db.carrier.findMany({ where: live, select: { id: true, name: true }, orderBy: byName }),
      db.costHead.findMany({ where: live, select: { id: true, name: true }, orderBy: byName }),
      db.containerSize.findMany({ where: live, select: { id: true, name: true }, orderBy: byName }),
      db.costUnit.findMany({ where: live, select: { id: true, name: true }, orderBy: byName }),
    ]);

    const lookup = (rows: { id: bigint; name: string }[]) =>
      rows.map((r) => ({ id: r.id.toString(), label: r.name }));

    return {
      currencies: currencies.map((row) => ({
        id: row.id.toString(),
        code: isoCurrency(row.currency),
        label: row.currency,
      })),
      carriers: lookup(carriers),
      costHeads: lookup(costHeads),
      containerSizes: lookup(containerSizes),
      costUnits: lookup(costUnits),
    };
  });

  const payload: ApiSuccess<AgentQuoteReferenceDto> = { success: true, data };
  res.json(payload);
});

/**
 * The Status thread, from the agent's side.
 *
 * GET  /api/tenant/agent/quotes/:id/comments
 * POST /api/tenant/agent/quotes/:id/comments
 *
 * Both sides write here; this is the agent's door to the same thread the
 * forwarder reads on the inquiry screen. Guarded by VIEW rather than QUOTE:
 * answering a question about a quote is not amending it, and an agent whose
 * quote has been settled can still reply.
 */
agentQuoteRouter.get('/:id/comments', requirePermission('AGENT.INQUIRY.VIEW'), async (req, res) => {
  const auth = req.auth!;
  const agentId = auth.agentId;
  if (agentId === null) throw HttpError.forbidden('This area is for agent accounts.');
  const quoteId = parseId(req.params.id, 'quote');

  const rows = await withAgent(auth.tenantId, agentId, async (db) => {
    // RLS scopes agent_quote to this agent, so a quote id belonging to someone
    // else finds nothing rather than reading their thread.
    const quote = await db.agentQuote.findFirst({
      where: { id: quoteId, agentId, deletedAt: null },
      select: { id: true },
    });
    if (quote === null) return null;
    return db.agentQuoteComment.findMany({
      where: { quoteId: quote.id },
      orderBy: { createdAt: 'asc' },
      select: COMMENT_SELECT_FLAT,
    });
  });
  if (rows === null) throw HttpError.notFound('That quote is not available to you.');

  const [forwarderName, authors] = await Promise.all([
    forwarderNameFor(auth.tenantId),
    resolveAuthors(
      auth.tenantId,
      rows.map((row: FlatCommentRow) => row.authorId),
    ),
  ]);
  const payload: ApiSuccess<AgentQuoteCommentDto[]> = {
    success: true,
    data: rows.map((row: FlatCommentRow) =>
      flatCommentToDto(row, authors, 'AGENT', forwarderName),
    ),
  };
  res.json(payload);
});

agentQuoteRouter.post('/:id/comments', requirePermission('AGENT.INQUIRY.VIEW'), async (req, res) => {
  const auth = req.auth!;
  const agentId = auth.agentId;
  if (agentId === null) throw HttpError.forbidden('This area is for agent accounts.');
  const quoteId = parseId(req.params.id, 'quote');
  const input = agentQuoteCommentInputSchema.parse(req.body);

  const created = await withAgent(auth.tenantId, agentId, async (db) => {
    const quote = await db.agentQuote.findFirst({
      where: { id: quoteId, agentId, deletedAt: null },
      select: { id: true },
    });
    if (quote === null) return null;
    return db.agentQuoteComment.create({
      data: {
        tenantId: auth.tenantId,
        quoteId: quote.id,
        authorId: auth.userId,
        body: input.body,
      },
      select: COMMENT_SELECT_FLAT,
    });
  });
  if (created === null) throw HttpError.notFound('That quote is not available to you.');

  const [forwarderName, authors] = await Promise.all([
    forwarderNameFor(auth.tenantId),
    resolveAuthors(auth.tenantId, [created.authorId]),
  ]);
  const payload: ApiSuccess<AgentQuoteCommentDto> = {
    success: true,
    data: flatCommentToDto(created, authors, 'AGENT', forwarderName),
  };
  res.status(201).json(payload);
});
