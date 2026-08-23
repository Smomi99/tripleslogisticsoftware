import { PrismaPg } from '@prisma/adapter-pg';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { signAccessToken } from '../lib/jwt';

/**
 * Phase 6: every route, enumerated from the Express router itself.
 *
 * The design asked for this specifically, and the reason is that a hand-written
 * list of routes is wrong the day someone adds one — and the route somebody
 * forgot is exactly the route that is open. This walks the real router tree, so
 * an endpoint added next year is swept the moment it is mounted.
 *
 * Three questions are asked of every path:
 *   - with no token at all, is it refused?
 *   - with an AGENT token, is every staff route refused?
 *   - with a STAFF token, is every portal route refused?
 *
 * Anything deliberately public is named in PUBLIC_PATHS below, and the test
 * fails if a route becomes public without being added there. Making a route
 * reachable without a session should cost a line in this file.
 */

// The mount path is only knowable at registration time — Express 5 fills
// layer.path when a request matches, not before. Recording it as routers are
// mounted is the one way to rebuild a full path without parsing regexps.
const mounts = new Map<unknown, string>();
{
  const proto = (express.Router as unknown as { prototype: Record<string, unknown> }).prototype;
  const original = proto['use'] as (...args: unknown[]) => unknown;
  proto['use'] = function patched(this: unknown, ...args: unknown[]) {
    const [first, ...handlers] = args;
    if (typeof first === 'string') {
      for (const handler of handlers) {
        if (typeof handler === 'function' && 'stack' in handler) mounts.set(handler, first);
      }
    }
    return original.apply(this, args);
  };
}

// Imported AFTER the patch, so every mount in the tree is recorded.
const { createApp } = await import('../app');

const owner = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});
const app = createApp();

const SLUG = 'gate-alpha';
let tenantId: bigint;
let staffToken: string;
let agentToken: string;

interface Endpoint {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** With :params substituted, so it can actually be requested. */
  path: string;
  /** As declared, for readable failure messages. */
  template: string;
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

function collect(stack: Layer[], prefix: string, out: Endpoint[]): void {
  for (const layer of stack) {
    if (layer.route !== undefined) {
      for (const method of Object.keys(layer.route.methods)) {
        if (!['get', 'post', 'patch', 'put', 'delete'].includes(method)) continue;
        // A router's own '/' route leaves a trailing slash on the mount path.
        const template = `${prefix}${layer.route.path}`
          .replace(/\/+/g, '/')
          .replace(/(.)\/$/, '$1');
        out.push({
          method: method as Endpoint['method'],
          template,
          // Any id will do: the guard runs before the handler ever looks it up.
          path: template.replace(/:[A-Za-z0-9_]+/g, '1'),
        });
      }
      continue;
    }
    const nested = layer.handle?.stack;
    if (nested !== undefined) {
      const mount = mounts.get(layer.handle) ?? '';
      collect(nested, `${prefix}${mount}`, out);
    }
  }
}

function endpoints(): Endpoint[] {
  const root = (app as unknown as { router: { stack: Layer[] } }).router;
  const found: Endpoint[] = [];
  collect(root.stack, '', found);
  return found;
}

/**
 * Routes that are reachable without a session, and why.
 *
 * Every one of these is a door: it exists before anyone is authenticated, so it
 * cannot be behind authentication. They are the paths that need the most care —
 * rate limiting, constant-time comparisons, identical answers for known and
 * unknown accounts — and they should be countable on two hands.
 */
const PUBLIC_PATHS = new Set([
  'get /api/health',
  // Sign-in, and the cookie exchange that keeps a session alive. Both must
  // work before a bearer token exists.
  'post /api/tenant/auth/login',
  'post /api/tenant/auth/refresh',
  'post /api/tenant/auth/logout',
  // Which workspace the host resolved to. Carries no tenant data beyond an id
  // and a status, and the app shell needs it before sign-in.
  'get /api/tenant/context',
]);

const key = (e: Endpoint): string => `${e.method} ${e.template}`;

async function send(endpoint: Endpoint, token: string | null) {
  const call = request(app)[endpoint.method](endpoint.path).set('X-Tenant-Slug', SLUG);
  if (token !== null) call.set('Authorization', `Bearer ${token}`);
  return call.send({});
}

beforeAll(async () => {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of ['"user"', 'agent']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;

  const tenant = await owner.tenant.create({
    data: { name: 'Gate Alpha', slug: SLUG, country: 'Bangladesh' },
    select: { id: true },
  });
  tenantId = tenant.id;

  const agent = await owner.agent.create({
    data: {
      tenantId,
      code: 'GATE-A',
      name: 'Gate Agent',
      country: 'Denmark',
      agentType: 'GENERAL',
    },
    select: { id: true },
  });
  const staff = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-gate-s',
      username: 'gate-staff',
      email: 'staff@gate.test',
      passwordHash: 'x',
      isSuperadmin: true,
    },
    select: { id: true },
  });
  const agentUser = await owner.user.create({
    data: {
      tenantId,
      code: 'USR-gate-a',
      agentId: agent.id,
      username: 'agent@gate.test',
      email: 'agent@gate.test',
      passwordHash: 'x',
    },
    select: { id: true },
  });

  // A superadmin token, so nothing below can be refused merely for want of a
  // §7 permission — the only thing that may refuse it is the session gate.
  staffToken = await signAccessToken({
    sub: staff.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: true,
    permissions: [],
    tokenVersion: 0,
  });
  agentToken = await signAccessToken({
    sub: agentUser.id.toString(),
    tenantId: tenantId.toString(),
    isSuperadmin: false,
    permissions: [],
    tokenVersion: 0,
    agentId: agent.id.toString(),
  });
});

afterAll(async () => {
  const scope = `(SELECT id FROM tenant WHERE slug = '${SLUG}')`;
  for (const table of ['"user"', 'agent']) {
    await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id IN ${scope}`);
  }
  await owner.$executeRaw`DELETE FROM tenant WHERE slug = ${SLUG}`;
  await owner.$disconnect();
});

describe('the route table', () => {
  it('is discovered from the router, not from a list someone maintains', () => {
    const found = endpoints();
    // A floor, so a broken walk that finds nothing cannot pass silently — the
    // same guard the §4 rule 10 sweep carries.
    expect(found.length).toBeGreaterThan(100);
    const templates = [...new Set(found.map((e) => e.template))].sort();
    expect(templates).toContain('/api/tenant/setting/ports');
    expect(templates).toContain('/api/tenant/agent/inquiries');
  });

  it('names every publicly reachable path', () => {
    // Not a formality: this is the list of doors. If it grows, someone made a
    // route reachable without a session and should have to say so here.
    const found = endpoints();
    const declared = [...PUBLIC_PATHS].filter((p) => found.some((e) => key(e) === p));
    expect(declared.sort()).toEqual([...PUBLIC_PATHS].sort());
  });
});

describe('nothing is reachable without a session', () => {
  it('refuses every non-public route to an anonymous caller', async () => {
    const open: string[] = [];
    let checked = 0;
    for (const endpoint of endpoints()) {
      if (PUBLIC_PATHS.has(key(endpoint))) continue;
      checked += 1;
      const res = await send(endpoint, null);
      // 401, not 404: every one of these paths resolves. That is what makes the
      // sweep self-validating — a mis-reconstructed path would answer 404 and
      // fail here rather than passing as "nothing to see".
      if (res.status !== 401) open.push(`${key(endpoint)} -> ${res.status}`);
    }
    expect(checked).toBeGreaterThan(100);
    expect(open, `routes that answered an anonymous caller:\n${open.join('\n')}`).toEqual([]);
  });
});

/** The one module an agent account may reach. */
const AGENT_PREFIX = '/api/tenant/agent/';

/**
 * Routes that deliberately serve BOTH kinds of user, and the list is one long.
 *
 * `/auth/me` returns the caller's own identity and their own permission set and
 * nothing else, so neither kind learns anything about the other. Anything that
 * returns business data has to pick a side.
 */
const BOTH_KINDS = new Set(['get /api/tenant/auth/me']);

describe('an agent credential opens no staff route', () => {
  it('is refused by every route under /api/tenant except its own module', async () => {
    // Agents now sign in at the same door as staff and hold a role like anyone
    // else — so this is the test that matters most. A role is a list somebody
    // ticked; ticking CRM.CUSTOMER.VIEW onto an agent's role must not show them
    // your customers, and the kind check above the permission check is why it
    // cannot.
    const reachable: string[] = [];
    let checked = 0;
    for (const endpoint of endpoints()) {
      if (!endpoint.template.startsWith('/api/tenant')) continue;
      if (endpoint.template.startsWith(AGENT_PREFIX)) continue;
      if (PUBLIC_PATHS.has(key(endpoint)) || BOTH_KINDS.has(key(endpoint))) continue;
      checked += 1;
      const res = await send(endpoint, agentToken);
      if (res.status !== 403) reachable.push(`${key(endpoint)} -> ${res.status}`);
    }
    // A sweep that swept nothing would otherwise pass forever.
    expect(checked).toBeGreaterThan(100);
    expect(
      reachable,
      `staff routes an agent token was not refused by:\n${reachable.join('\n')}`,
    ).toEqual([]);
  });
});

describe('a staff credential opens no agent route', () => {
  it('is refused by every route under /api/tenant/agent', async () => {
    // The other direction matters too. A staff member reading Agent Inquiry
    // would see it through that agent's row level security, which is a
    // confusing and untestable state to allow.
    const reachable: string[] = [];
    let checked = 0;
    for (const endpoint of endpoints()) {
      if (!endpoint.template.startsWith(AGENT_PREFIX)) continue;
      checked += 1;
      const res = await send(endpoint, staffToken);
      if (res.status !== 403) reachable.push(`${key(endpoint)} -> ${res.status}`);
    }
    expect(checked).toBeGreaterThan(3);
    expect(
      reachable,
      `agent routes a staff token was not refused by:` + reachable.join(', '),
    ).toEqual([]);
  });
});
