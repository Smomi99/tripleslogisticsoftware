import {
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  type SalesLeadDto,
  type SalesLeadFollowupDto,
  salesLeadFollowupInputSchema,
  salesLeadInputSchema,
  salesLeadListQuerySchema,
} from '@ff/shared';
import { Router } from 'express';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { Prisma } from '../generated/prisma/client';
import { HttpError } from '../lib/http-error';
import { parseId } from '../lib/request';
import { withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';

/**
 * Sales leads (CLAUDE.md §3, MODULE_PURCHASE_SALES §9 Q12).
 *
 * A lead is a conversation before there is a lane. The record is deliberately
 * thin because neither screen has a wireframe (§11) — see packages/shared's
 * sales-lead.ts for what that does and does not carry.
 *
 * §8's master-data pattern throughout: search, sort, pagination, Edit plus an
 * Active/Inactive toggle rather than a delete, and a child screen scoped to the
 * parent by URL.
 */
export const salesLeadRouter: Router = Router();

salesLeadRouter.use(authenticate);

const LEAD_FEATURE = 'SALES.NEW_SALES_LEAD';
const FOLLOWUP_FEATURE = 'SALES.SALES_LEAD_FOLLOWUP';

const isoDate = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

const leadInclude = {
  _count: {
    select: {
      followups: { where: { deletedAt: null } },
      inquiries: { where: { deletedAt: null } },
    },
  },
  followups: {
    where: { deletedAt: null, nextFollowupDate: { not: null } },
    orderBy: { nextFollowupDate: 'asc' },
    take: 1,
    select: { nextFollowupDate: true },
  },
} satisfies Prisma.SalesLeadInclude;

type LeadWithCounts = Prisma.SalesLeadGetPayload<{ include: typeof leadInclude }>;

function toDto(lead: LeadWithCounts): SalesLeadDto {
  return {
    id: lead.id.toString(),
    code: lead.code,
    name: lead.name,
    notes: lead.notes,
    isActive: lead.isActive,
    followupCount: lead._count.followups,
    inquiryCount: lead._count.inquiries,
    nextFollowupDate: isoDate(lead.followups[0]?.nextFollowupDate ?? null),
    createdAt: lead.createdAt.toISOString(),
  };
}

// ===========================================================================
// Leads
// ===========================================================================

salesLeadRouter.get('/leads', requirePermission(`${LEAD_FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = salesLeadListQuerySchema.parse(req.query);

  const where: Prisma.SalesLeadWhereInput = {
    deletedAt: null,
    ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    ...(query.search !== undefined
      ? {
          OR: [
            { code: { contains: query.search, mode: 'insensitive' } },
            { name: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const { rows, total } = await withTenant(auth.tenantId, async (db) => {
    const [rows, total] = await Promise.all([
      db.salesLead.findMany({
        where,
        include: leadInclude,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.salesLead.count({ where }),
    ]);
    return { rows, total };
  });

  const payload: ApiSuccess<SalesLeadDto[]> = {
    success: true,
    data: rows.map(toDto),
    meta: buildMeta(query.page, query.limit, total),
  };
  res.json(payload);
});

salesLeadRouter.get('/leads/:id', requirePermission(`${LEAD_FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'lead');

  const lead = await withTenant(auth.tenantId, (db) =>
    db.salesLead.findFirst({ where: { id, deletedAt: null }, include: leadInclude }),
  );
  if (lead === null) throw HttpError.notFound('Lead not found.');

  const payload: ApiSuccess<SalesLeadDto> = { success: true, data: toDto(lead) };
  res.json(payload);
});

salesLeadRouter.post('/leads', requirePermission(`${LEAD_FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = salesLeadInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'salesLead', CODE_PREFIX.salesLead, auth.tenantId);
      try {
        return await db.salesLead.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            notes: input.notes === undefined || input.notes === '' ? null : input.notes,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          include: leadInclude,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not add the lead. Try again.');
  });

  const payload: ApiSuccess<SalesLeadDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

salesLeadRouter.patch('/leads/:id', requirePermission(`${LEAD_FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'lead');
  const input = salesLeadInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.salesLead.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Lead not found.');

    return db.salesLead.update({
      where: { id },
      data: {
        name: input.name,
        notes: input.notes === undefined || input.notes === '' ? null : input.notes,
        updatedBy: auth.userId,
      },
      include: leadInclude,
    });
  });

  const payload: ApiSuccess<SalesLeadDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

/** §8: Active/Inactive rather than delete — §4 rule 3 forbids the latter. */
salesLeadRouter.post(
  '/leads/:id/toggle-status',
  requirePermission(`${LEAD_FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'lead');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.salesLead.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Lead not found.');

      const updated = await db.salesLead.update({
        where: { id },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

// ===========================================================================
// Follow-ups — §8's child screen, scoped to the parent
// ===========================================================================

/** Confirms the lead exists inside this tenant before touching its children. */
async function assertLead(
  db: Parameters<Parameters<typeof withTenant>[1]>[0],
  leadId: bigint,
): Promise<{ id: bigint; name: string; code: string }> {
  const lead = await db.salesLead.findFirst({
    where: { id: leadId, deletedAt: null },
    select: { id: true, name: true, code: true },
  });
  if (lead === null) throw HttpError.notFound('Lead not found.');
  return lead;
}

export interface LeadFollowupPayload {
  lead: { id: string; code: string; name: string };
  followups: SalesLeadFollowupDto[];
}

salesLeadRouter.get(
  '/leads/:id/followups',
  requirePermission(`${FOLLOWUP_FEATURE}.VIEW`),
  async (req, res) => {
    const auth = req.auth!;
    const leadId = parseId(req.params.id, 'lead');

    const data = await withTenant(auth.tenantId, async (db) => {
      const lead = await assertLead(db, leadId);
      const rows = await db.salesLeadFollowup.findMany({
        where: { leadId, deletedAt: null },
        orderBy: [{ followupDate: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          followupDate: true,
          contactMode: true,
          contactPerson: true,
          notes: true,
          nextFollowupDate: true,
          createdAt: true,
          createdByUser: { select: { username: true } },
        },
      });
      return { lead, rows };
    });

    const payload: ApiSuccess<LeadFollowupPayload> = {
      success: true,
      data: {
        lead: {
          id: data.lead.id.toString(),
          code: data.lead.code,
          name: data.lead.name,
        },
        followups: data.rows.map((row) => ({
          id: row.id.toString(),
          followupDate: isoDate(row.followupDate)!,
          contactMode: row.contactMode,
          contactPerson: row.contactPerson,
          notes: row.notes,
          nextFollowupDate: isoDate(row.nextFollowupDate),
          createdBy: row.createdByUser?.username ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
      },
    };
    res.json(payload);
  },
);

salesLeadRouter.post(
  '/leads/:id/followups',
  requirePermission(`${FOLLOWUP_FEATURE}.CREATE`),
  async (req, res) => {
    const auth = req.auth!;
    const leadId = parseId(req.params.id, 'lead');
    const input = salesLeadFollowupInputSchema.parse(req.body);

    const created = await withTenant(auth.tenantId, async (db) => {
      await assertLead(db, leadId);
      return db.salesLeadFollowup.create({
        data: {
          tenantId: auth.tenantId,
          leadId,
          followupDate: new Date(input.followupDate),
          contactMode: input.contactMode,
          contactPerson:
            input.contactPerson === undefined || input.contactPerson === ''
              ? null
              : input.contactPerson,
          notes: input.notes === undefined || input.notes === '' ? null : input.notes,
          nextFollowupDate:
            input.nextFollowupDate === undefined || input.nextFollowupDate === ''
              ? null
              : new Date(input.nextFollowupDate),
          createdBy: auth.userId,
          updatedBy: auth.userId,
        },
        select: {
          id: true,
          followupDate: true,
          contactMode: true,
          contactPerson: true,
          notes: true,
          nextFollowupDate: true,
          createdAt: true,
        },
      });
    });

    const payload: ApiSuccess<SalesLeadFollowupDto> = {
      success: true,
      data: {
        id: created.id.toString(),
        followupDate: isoDate(created.followupDate)!,
        contactMode: created.contactMode,
        contactPerson: created.contactPerson,
        notes: created.notes,
        nextFollowupDate: isoDate(created.nextFollowupDate),
        createdBy: null,
        createdAt: created.createdAt.toISOString(),
      },
    };
    res.status(201).json(payload);
  },
);

/** Lead options for the New Inquiry form's optional "from lead" field. */
salesLeadRouter.get(
  '/lead-options',
  requirePermission('SALES.INQUIRY.VIEW'),
  async (req, res) => {
    const auth = req.auth!;
    const rows = await withTenant(auth.tenantId, (db) =>
      db.salesLead.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, code: true, name: true },
        orderBy: { name: 'asc' },
        take: 200,
      }),
    );

    const payload: ApiSuccess<{ id: string; name: string }[]> = {
      success: true,
      data: rows.map((r) => ({ id: r.id.toString(), name: `${r.code} — ${r.name}` })),
    };
    res.json(payload);
  },
);
