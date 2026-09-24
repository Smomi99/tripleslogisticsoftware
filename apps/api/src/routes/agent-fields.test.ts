import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../app';
import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * CRM → Agent: what the client asked for on 2026-09-24.
 *
 *   - "Cross Border" as an expert area;
 *   - Delivery agent details, under the address;
 *   - Note, last on the form.
 *
 * None of the three is in §6. The two fields are nullable columns, so every
 * agent already in production has neither, and blank has to be an ordinary
 * state rather than an error.
 */

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'agent-fields';

let token: string;

async function cleanup(): Promise<void> {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  await owner.$executeRawUnsafe(`DELETE FROM agent_expert_area WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM agent_port_coverage WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM agent_network_member WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM agent_pic WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM agent WHERE tenant_id IN ${scope}`);
  await owner.$executeRawUnsafe(`DELETE FROM "user" WHERE tenant_id IN ${scope}`);
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
}

beforeAll(async () => {
  await cleanup();
  const tenant = await owner.tenant.create({
    data: { name: 'Agent Fields', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  const user = await owner.user.create({
    data: {
      tenantId: tenant.id,
      code: `USR-${SLUG}`,
      username: `admin-${SLUG}`,
      email: `admin@${SLUG}.test`,
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  token = await signAccessToken({
    sub: user.id.toString(),
    tenantId: tenant.id.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

function call(method: 'get' | 'post' | 'patch', path: string) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Slug', SLUG);
}

describe('agent fields asked for on 2026-09-24', () => {
  it('offers Cross Border as an expert area', async () => {
    const res = await call('get', '/api/tenant/crm/agents/options');
    expect(res.status).toBe(200);
    const names = res.body.data.expertAreas.map((o: { name: string }) => o.name);
    expect(names).toContain('Cross Border');
  });

  it('records delivery agent details, the note and a Cross Border expert area', async () => {
    const options = await call('get', '/api/tenant/crm/agents/options');
    const crossBorder = options.body.data.expertAreas.find(
      (o: { name: string }) => o.name === 'Cross Border',
    );

    const created = await call('post', '/api/tenant/crm/agents').send({
      name: 'Delivered Ltd',
      country: 'India',
      agentType: 'GENERAL',
      address: 'Kolkata',
      deliveryAgentDetails: 'Petrapole desk\nContact: Ravi, +91 90000 00000',
      note: 'Handles the Benapole crossing.',
      expertAreaIds: [crossBorder.id],
    });
    expect(created.status, JSON.stringify(created.body.error ?? {})).toBe(201);

    const read = await call('get', `/api/tenant/crm/agents/${created.body.data.id}`);
    expect(read.status).toBe(200);
    expect(read.body.data.deliveryAgentDetails).toBe(
      'Petrapole desk\nContact: Ravi, +91 90000 00000',
    );
    expect(read.body.data.note).toBe('Handles the Benapole crossing.');
    expect(read.body.data.expertAreas.map((o: { name: string }) => o.name)).toEqual([
      'Cross Border',
    ]);
  });

  it('leaves both blank when they are not given, and clears them on edit', async () => {
    const created = await call('post', '/api/tenant/crm/agents').send({
      name: 'Plain Ltd',
      country: 'India',
      agentType: 'EXCLUSIVE',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.deliveryAgentDetails).toBeNull();
    expect(created.body.data.note).toBeNull();

    const id = created.body.data.id as string;
    const filled = await call('patch', `/api/tenant/crm/agents/${id}`).send({
      name: 'Plain Ltd',
      country: 'India',
      agentType: 'EXCLUSIVE',
      deliveryAgentDetails: 'Chennai office',
      note: 'Temporary',
    });
    expect(filled.status).toBe(200);
    expect(filled.body.data.deliveryAgentDetails).toBe('Chennai office');
    expect(filled.body.data.note).toBe('Temporary');

    // The form posts empty strings for cleared inputs; they must store as NULL.
    const cleared = await call('patch', `/api/tenant/crm/agents/${id}`).send({
      name: 'Plain Ltd',
      country: 'India',
      agentType: 'EXCLUSIVE',
      deliveryAgentDetails: '',
      note: '   ',
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.deliveryAgentDetails).toBeNull();
    expect(cleared.body.data.note).toBeNull();
  });
});
