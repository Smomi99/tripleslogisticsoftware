import { Router } from 'express';

import {
  type AgentDto,
  agentInputSchema,
  agentListQuerySchema,
  type AgentPicDto,
  agentPicInputSchema,
  type ApiSuccess,
  buildMeta,
  CODE_PREFIX,
  listQuerySchema,
  type LookupOption,
  type SelectedOption,
} from '@ff/shared';

import { CODE_RETRY_LIMIT, isUniqueViolation, nextCode } from '../lib/codes';
import { HttpError } from '../lib/http-error';
import { assertRowDeletable, deleteOwnedChildren } from '../lib/references';
import { parseId } from '../lib/request';
import { displayNameFromKey, openFile, putFile, removeFile } from '../lib/storage';
import { type TenantDb, withTenant } from '../lib/tenant-client';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { uploadSingle } from '../middleware/upload';

/**
 * CRM → Agent (CLAUDE.md §6, §8).
 *
 * Two things here are new to the codebase:
 *   - three M:N relationships (expert area, port coverage, network), which §8
 *     insists write to the join table rather than a comma-joined column;
 *   - the first file upload, against the §2 storage layer.
 */
export const agentRouter: Router = Router();

agentRouter.use(authenticate);

const FEATURE = 'CRM.AGENT';

const SELECT = {
  id: true,
  code: true,
  name: true,
  country: true,
  address: true,
  agentType: true,
  agreementFile: true,
  isActive: true,
  expertAreas: { select: { expertArea: { select: { id: true, name: true } } } },
  portCoverages: { select: { port: { select: { id: true, name: true, portCode: true } } } },
  networkMembers: { select: { network: { select: { id: true, name: true } } } },
  _count: { select: { pics: true } },
} as const;

type AgentRow = {
  id: bigint;
  code: string;
  name: string;
  country: string;
  address: string | null;
  agentType: 'GENERAL' | 'EXCLUSIVE';
  agreementFile: string | null;
  isActive: boolean;
  expertAreas: { expertArea: { id: bigint; name: string } }[];
  portCoverages: { port: { id: bigint; name: string; portCode: string } }[];
  networkMembers: { network: { id: bigint; name: string } }[];
  _count: { pics: number };
};

function toDto(row: AgentRow): AgentDto {
  const option = (o: { id: bigint; name: string }): SelectedOption => ({
    id: o.id.toString(),
    name: o.name,
  });
  return {
    id: row.id.toString(),
    code: row.code,
    name: row.name,
    country: row.country,
    address: row.address,
    agentType: row.agentType,
    agreementFile: row.agreementFile,
    agreementFileName:
      row.agreementFile === null ? null : displayNameFromKey(row.agreementFile),
    expertAreas: row.expertAreas.map((e) => option(e.expertArea)),
    portCoverage: row.portCoverages.map((p) => ({
      id: p.port.id.toString(),
      name: `${p.port.name} (${p.port.portCode})`,
    })),
    networks: row.networkMembers.map((n) => option(n.network)),
    isActive: row.isActive,
    picCount: row._count.pics,
  };
}

/**
 * Ids the caller sent that the workspace cannot actually see are rejected.
 *
 * The loader closes over the scoped client at the call site, so this only needs
 * the ids — a client parameter here would be unused and misleading.
 */
async function resolveIds(
  raw: string[] | undefined,
  loader: (ids: bigint[]) => Promise<{ id: bigint }[]>,
  label: string,
): Promise<bigint[]> {
  if (raw === undefined || raw.length === 0) return [];
  const ids = [...new Set(raw)].map((value) => BigInt(value));
  const found = await loader(ids);
  if (found.length !== ids.length) {
    throw HttpError.badRequest(`One of the selected ${label} is not available.`);
  }
  return ids;
}

/**
 * Replaces an agent's M:N selections.
 *
 * Delete-then-insert inside the caller's transaction rather than diffing: these
 * are pure join rows with no history of their own, so the simpler operation is
 * also the correct one. deleteMany is permitted here because the join carries
 * no state to preserve — §4 rule 3 is about business records.
 */
async function replaceJoins(
  db: TenantDb,
  tenantId: bigint,
  agentId: bigint,
  userId: bigint,
  selection: { expertAreaIds: bigint[]; portIds: bigint[]; networkIds: bigint[] },
): Promise<void> {
  await db.$executeRaw`DELETE FROM agent_expert_area WHERE agent_id = ${agentId} AND tenant_id = ${tenantId}`;
  await db.$executeRaw`DELETE FROM agent_port_coverage WHERE agent_id = ${agentId} AND tenant_id = ${tenantId}`;
  await db.$executeRaw`DELETE FROM agent_network_member WHERE agent_id = ${agentId} AND tenant_id = ${tenantId}`;

  if (selection.expertAreaIds.length > 0) {
    await db.agentExpertArea.createMany({
      data: selection.expertAreaIds.map((expertAreaId) => ({
        tenantId,
        agentId,
        expertAreaId,
        createdBy: userId,
      })),
    });
  }
  if (selection.portIds.length > 0) {
    await db.agentPortCoverage.createMany({
      data: selection.portIds.map((portId) => ({ tenantId, agentId, portId, createdBy: userId })),
    });
  }
  if (selection.networkIds.length > 0) {
    await db.agentNetworkMember.createMany({
      data: selection.networkIds.map((networkId) => ({
        tenantId,
        agentId,
        networkId,
        createdBy: userId,
      })),
    });
  }
}

agentRouter.get('/', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const query = agentListQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    const where = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.agentType !== undefined ? { agentType: query.agentType } : {}),
      ...(query.expertAreaId !== undefined
        ? { expertAreas: { some: { expertAreaId: BigInt(query.expertAreaId) } } }
        : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { code: { contains: query.search, mode: 'insensitive' as const } },
              { country: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      db.agent.findMany({
        where,
        select: SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.agent.count({ where }),
    ]);
    return { rows: rows.map(toDto), total };
  });

  const payload: ApiSuccess<AgentDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

/** Everything the three multi-selects need, in one round trip. */
agentRouter.get('/options', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const options = await withTenant(auth.tenantId, async (db) => {
    const [expertAreas, ports, networks] = await Promise.all([
      db.expertArea.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true },
        orderBy: { code: 'asc' },
      }),
      db.port.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true, portCode: true },
        orderBy: { name: 'asc' },
      }),
      db.network.findMany({
        where: { deletedAt: null, isActive: true },
        select: { id: true, name: true },
        orderBy: { code: 'asc' },
      }),
    ]);
    return {
      expertAreas: expertAreas.map((e) => ({ id: e.id.toString(), name: e.name })),
      ports: ports.map((p) => ({ id: p.id.toString(), name: `${p.name} (${p.portCode})` })),
      networks: networks.map((n) => ({ id: n.id.toString(), name: n.name })),
    };
  });

  const payload: ApiSuccess<{
    expertAreas: LookupOption[];
    ports: LookupOption[];
    networks: LookupOption[];
  }> = { success: true, data: options };
  res.json(payload);
});

agentRouter.get('/:id', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'agent');
  const agent = await withTenant(auth.tenantId, async (db) => {
    const row = await db.agent.findFirst({ where: { id, deletedAt: null }, select: SELECT });
    if (row === null) throw HttpError.notFound('Agent not found.');
    return row;
  });
  const payload: ApiSuccess<AgentDto> = { success: true, data: toDto(agent) };
  res.json(payload);
});

agentRouter.get('/:id/summary', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'agent');
  const agent = await withTenant(auth.tenantId, async (db) => {
    const row = await db.agent.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true },
    });
    if (row === null) throw HttpError.notFound('Agent not found.');
    return row;
  });
  const payload: ApiSuccess<{ id: string; name: string }> = {
    success: true,
    data: { id: agent.id.toString(), name: agent.name },
  };
  res.json(payload);
});

agentRouter.post('/', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const input = agentInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    const expertAreaIds = await resolveIds(
      input.expertAreaIds,
      (ids) => db.expertArea.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, select: { id: true } }),
      'expert areas',
    );
    const portIds = await resolveIds(
      input.portCoverageIds,
      (ids) => db.port.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, select: { id: true } }),
      'ports',
    );
    const networkIds = await resolveIds(
      input.networkIds,
      (ids) => db.network.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, select: { id: true } }),
      'networks',
    );

    let agentId: bigint | null = null;
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'agent', CODE_PREFIX.agent, auth.tenantId);
      try {
        const row = await db.agent.create({
          data: {
            tenantId: auth.tenantId,
            code,
            name: input.name,
            country: input.country,
            address: input.address || null,
            agentType: input.agentType,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: { id: true },
        });
        agentId = row.id;
        break;
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    if (agentId === null) {
      throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate an agent code.');
    }

    await replaceJoins(db, auth.tenantId, agentId, auth.userId, {
      expertAreaIds,
      portIds,
      networkIds,
    });

    const row = await db.agent.findFirst({ where: { id: agentId }, select: SELECT });
    if (row === null) throw HttpError.notFound('Agent not found.');
    return row;
  });

  const payload: ApiSuccess<AgentDto> = { success: true, data: toDto(created) };
  res.status(201).json(payload);
});

agentRouter.patch('/:id', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'agent');
  const input = agentInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.agent.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Agent not found.');

    const expertAreaIds = await resolveIds(
      input.expertAreaIds,
      (ids) => db.expertArea.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, select: { id: true } }),
      'expert areas',
    );
    const portIds = await resolveIds(
      input.portCoverageIds,
      (ids) => db.port.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, select: { id: true } }),
      'ports',
    );
    const networkIds = await resolveIds(
      input.networkIds,
      (ids) => db.network.findMany({ where: { id: { in: ids }, isActive: true, deletedAt: null }, select: { id: true } }),
      'networks',
    );

    await db.agent.update({
      where: { id },
      data: {
        name: input.name,
        country: input.country,
        address: input.address || null,
        agentType: input.agentType,
        updatedBy: auth.userId,
      },
    });

    await replaceJoins(db, auth.tenantId, id, auth.userId, {
      expertAreaIds,
      portIds,
      networkIds,
    });

    const row = await db.agent.findFirst({ where: { id }, select: SELECT });
    if (row === null) throw HttpError.notFound('Agent not found.');
    return row;
  });

  const payload: ApiSuccess<AgentDto> = { success: true, data: toDto(updated) };
  res.json(payload);
});

agentRouter.post(
  '/:id/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'agent');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.agent.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Agent not found.');
      const updated = await db.agent.update({
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
// Agreement file (§2: only the key is stored)
// ===========================================================================

agentRouter.post(
  '/:id/agreement',
  requirePermission(`${FEATURE}.EDIT`),
  uploadSingle,
  async (req, res) => {
    const auth = req.auth!;
    const id = parseId(req.params.id, 'agent');
    const file = req.file;
    if (file === undefined) throw HttpError.badRequest('Choose a file to upload.');

    const result = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.agent.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, agreementFile: true },
      });
      if (existing === null) throw HttpError.notFound('Agent not found.');

      const stored = await putFile(auth.tenantId, 'agent-agreement', file);
      await db.agent.update({
        where: { id },
        data: { agreementFile: stored.key, updatedBy: auth.userId },
      });

      // Replaced files are removed after the row points at the new one, so a
      // failure here never leaves the record referencing a deleted file.
      if (existing.agreementFile !== null) {
        await removeFile(existing.agreementFile);
      }
      return stored;
    });

    const payload: ApiSuccess<{ key: string; fileName: string }> = {
      success: true,
      data: { key: result.key, fileName: displayNameFromKey(result.key) },
    };
    res.status(201).json(payload);
  },
);

agentRouter.get('/:id/agreement', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'agent');

  const key = await withTenant(auth.tenantId, async (db) => {
    const agent = await db.agent.findFirst({
      where: { id, deletedAt: null },
      select: { agreementFile: true },
    });
    if (agent === null || agent.agreementFile === null) {
      throw HttpError.notFound('No agreement has been uploaded.');
    }
    return agent.agreementFile;
  });

  const { stream, sizeBytes } = await openFile(auth.tenantId, key);
  res.setHeader('Content-Length', sizeBytes);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${displayNameFromKey(key).replace(/"/g, '')}"`,
  );
  stream.pipe(res);
});

// ===========================================================================
// Agent → PIC
// ===========================================================================

const PIC_SELECT = {
  id: true,
  code: true,
  name: true,
  department: true,
  designation: true,
  mobile: true,
  email: true,
  isActive: true,
} as const;

function picToDto(row: {
  id: bigint;
  code: string;
  name: string;
  department: string | null;
  designation: string | null;
  mobile: string | null;
  email: string | null;
  isActive: boolean;
}): AgentPicDto {
  return { ...row, id: row.id.toString() };
}

async function findAgent(db: TenantDb, id: bigint): Promise<void> {
  const agent = await db.agent.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (agent === null) throw HttpError.notFound('Agent not found.');
}

agentRouter.get('/:id/pics', requirePermission(`${FEATURE}.VIEW`), async (req, res) => {
  const auth = req.auth!;
  const agentId = parseId(req.params.id, 'agent');
  const query = listQuerySchema.parse(req.query);

  const result = await withTenant(auth.tenantId, async (db) => {
    await findAgent(db, agentId);
    const where = {
      agentId,
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search !== undefined
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.agentPic.findMany({
        where,
        select: PIC_SELECT,
        orderBy: [{ name: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.agentPic.count({ where }),
    ]);
    return { rows: rows.map(picToDto), total };
  });

  const payload: ApiSuccess<AgentPicDto[]> = {
    success: true,
    data: result.rows,
    meta: buildMeta(query.page, query.limit, result.total),
  };
  res.json(payload);
});

agentRouter.post('/:id/pics', requirePermission(`${FEATURE}.CREATE`), async (req, res) => {
  const auth = req.auth!;
  const agentId = parseId(req.params.id, 'agent');
  const input = agentPicInputSchema.parse(req.body);

  const created = await withTenant(auth.tenantId, async (db) => {
    await findAgent(db, agentId);
    for (let attempt = 0; attempt < CODE_RETRY_LIMIT; attempt += 1) {
      const code = await nextCode(db, 'agentPic', CODE_PREFIX.agentPic, auth.tenantId);
      try {
        return await db.agentPic.create({
          data: {
            tenantId: auth.tenantId,
            code,
            agentId,
            name: input.name,
            department: input.department || null,
            designation: input.designation || null,
            mobile: input.mobile || null,
            email: input.email || null,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          },
          select: PIC_SELECT,
        });
      } catch (error) {
        if (isUniqueViolation(error, 'code')) continue;
        throw error;
      }
    }
    throw new HttpError(409, 'CODE_GENERATION_FAILED', 'Could not allocate a contact code.');
  });

  const payload: ApiSuccess<AgentPicDto> = { success: true, data: picToDto(created) };
  res.status(201).json(payload);
});

agentRouter.patch('/:id/pics/:picId', requirePermission(`${FEATURE}.EDIT`), async (req, res) => {
  const auth = req.auth!;
  const agentId = parseId(req.params.id, 'agent');
  const picId = parseId(req.params.picId, 'contact');
  const input = agentPicInputSchema.parse(req.body);

  const updated = await withTenant(auth.tenantId, async (db) => {
    const existing = await db.agentPic.findFirst({
      where: { id: picId, agentId, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) throw HttpError.notFound('Contact not found.');
    return db.agentPic.update({
      where: { id: picId },
      data: {
        name: input.name,
        department: input.department || null,
        designation: input.designation || null,
        mobile: input.mobile || null,
        email: input.email || null,
        updatedBy: auth.userId,
      },
      select: PIC_SELECT,
    });
  });

  const payload: ApiSuccess<AgentPicDto> = { success: true, data: picToDto(updated) };
  res.json(payload);
});

agentRouter.post(
  '/:id/pics/:picId/toggle-status',
  requirePermission(`${FEATURE}.TOGGLE_STATUS`),
  async (req, res) => {
    const auth = req.auth!;
    const agentId = parseId(req.params.id, 'agent');
    const picId = parseId(req.params.picId, 'contact');

    const isActive = await withTenant(auth.tenantId, async (db) => {
      const existing = await db.agentPic.findFirst({
        where: { id: picId, agentId, deletedAt: null },
        select: { id: true, isActive: true },
      });
      if (existing === null) throw HttpError.notFound('Contact not found.');
      const updated = await db.agentPic.update({
        where: { id: picId },
        data: { isActive: !existing.isActive, updatedBy: auth.userId },
        select: { isActive: true },
      });
      return updated.isActive;
    });

    const payload: ApiSuccess<{ isActive: boolean }> = { success: true, data: { isActive } };
    res.json(payload);
  },
);

/**
 * DELETE /api/tenant/.../:id — CR-002.
 *
 * A soft delete: it sets `deleted_at`, so §4 rule 3 holds and every foreign key
 * survives. Refused when anything still references the row, and refused on a
 * shared system row — so it only ever removes a agent entered by mistake.
 */
agentRouter.delete('/:id', requirePermission(`${FEATURE}.DELETE`), async (req, res) => {
  const auth = req.auth!;
  const id = parseId(req.params.id, 'agent');

  await withTenant(auth.tenantId, async (db) => {
    const existing = await db.agent.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, tenantId: true, name: true },
    });
    await assertRowDeletable(
      db,
      'agent',
      id,
      existing === null ? null : { tenantId: existing.tenantId, name: existing.name },
      'Agent not found.',
    );

    // Its own contacts, service ports and links go with it.
    await deleteOwnedChildren(db, 'agent', id, auth.userId);

    await db.agent.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, updatedBy: auth.userId },
    });
  });

  const payload: ApiSuccess<{ deleted: true }> = { success: true, data: { deleted: true } };
  res.json(payload);
});
