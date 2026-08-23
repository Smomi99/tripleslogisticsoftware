# Agent Portal — final architecture

**Status:** design, awaiting approval. No code, no migrations, no data touched.
**Supersedes:** the open-questions draft of this file (see git history).
**Read with:** CLAUDE.md §7 (RBAC), §7A (multi-tenancy), §4 rules 3, 5, 7 and 10.

---

## 0. Decisions, now locked

| # | Decision |
|---|---|
| 1 | **One login per forwarder.** An agent account belongs to exactly one tenant. Multi-forwarder access is a separate future design. |
| 2 | **Customer name and target price are hidden** from agents. They receive only what is needed to price the lane. |
| 3 | **MVP quote is a single price.** The model must extend to tiers and local charges later without redesign. |
| 4 | **Superadmin only** may invite or create agent accounts. |
| 5 | **Explicit selection is the authorization boundary.** `inquiry_party` decides visibility; covering the lane is not enough. |
| 6 | **Audit trail first**, tested, before any external login exists. |

### Correction carried forward

`user.employee_id` is **nullable** in schema and database — I said otherwise two
sessions ago. Your seeded superadmin already has none. Agent accounts therefore
need no destructive change to `user`.

---

## Phase 0 — Audit trail

`audit_log` exists, has RLS, and has **never been written to**. Three things are
wrong with it as it stands for this purpose.

### 0.1 Schema deltas

```sql
-- An audit trail the application can rewrite is not an audit trail.
REVOKE UPDATE ON TABLE audit_log FROM ff_app;
-- (DELETE was never granted; INSERT and SELECT remain.)

-- Events that are not about a row — a failed login has no record to point at.
ALTER TABLE audit_log ALTER COLUMN record_id DROP NOT NULL;

-- The existing enum covers data changes only.
ALTER TYPE audit_action ADD VALUE 'DELETE';           -- soft delete (CR-002)
ALTER TYPE audit_action ADD VALUE 'LOGIN_SUCCESS';
ALTER TYPE audit_action ADD VALUE 'LOGIN_FAILURE';
ALTER TYPE audit_action ADD VALUE 'LOGOUT';
ALTER TYPE audit_action ADD VALUE 'VIEW';             -- agent read of an inquiry
ALTER TYPE audit_action ADD VALUE 'INVITE_ISSUED';
ALTER TYPE audit_action ADD VALUE 'INVITE_ACCEPTED';
ALTER TYPE audit_action ADD VALUE 'PASSWORD_RESET_REQUESTED';
ALTER TYPE audit_action ADD VALUE 'PASSWORD_RESET_COMPLETED';
ALTER TYPE audit_action ADD VALUE 'QUOTE_SUBMITTED';
ALTER TYPE audit_action ADD VALUE 'QUOTE_AMENDED';
```

`actor_type` already has `USER | PLATFORM_USER | SYSTEM`. An agent **is** a
`USER` whose `agent_id` is set — no new actor type, because two ways of saying
the same thing eventually disagree. Queries that want agent activity join to
`user.agent_id`.

`ALTER TYPE … ADD VALUE` cannot run inside a transaction block in older
Postgres; on 16 it can, but the migration will add values in their own statement
either way.

### 0.2 Two mechanisms, because there are two kinds of event

**Data changes** — a Prisma client extension hook in `tenant-client.ts`, beside
the tenant injection. It covers every `create`, `update`, `updateMany` and the
soft-delete updates, for every model, which is what §4 rule 7 asks for and what
no route can forget.

Four things it must get right:

- **No recursion.** Operations on `auditLog` are skipped.
- **The actor.** `withTenant` currently carries only `tenantId` in
  AsyncLocalStorage. It gains `userId`, so the hook knows who acted without
  every call site passing it.
- **Old values cost a read.** Capturing `old_values` on an update means a SELECT
  before the write. That is a real cost and it is accepted: an audit row that
  says only "something changed" is not worth storing.
- **Bulk updates.** `updateMany` records one row per affected id, not one row
  for the batch — otherwise "who changed this record" has no answer.

**Events** — an explicit `recordAudit()` for things that are not writes: logins,
logouts, an agent opening an inquiry. Called from the route.

### 0.3 Event catalogue

| Event | actor | table_name / record_id | Captured |
|---|---|---|---|
| Any create/update/soft-delete | USER | the model and row | old and new values |
| `LOGIN_SUCCESS` / `LOGOUT` | USER | `user` / user id | — |
| `LOGIN_FAILURE` | SYSTEM | `user` / id when the username resolved, else NULL | attempted username, IP |
| `VIEW` (agent opens an inquiry) | USER | `inquiry` / inquiry id | — |
| `INVITE_ISSUED` / `INVITE_ACCEPTED` | USER | `user` / invited user | issuing superadmin |
| `PASSWORD_RESET_REQUESTED` / `_COMPLETED` | USER | `user` / user id | — |
| `QUOTE_SUBMITTED` / `QUOTE_AMENDED` | USER | `agent_quote` / quote id | amount, currency, validity |
| Agent account activated / deactivated | USER | `user` / user id | old and new `is_active` |

**Never recorded:** password hashes, invite or reset tokens, buy prices. An
audit trail that copies the secrets is a second place to steal them from.

### 0.4 Phase 0 exit criteria

- Every create/update/deactivate writes exactly one audit row, proven by a test.
- `ff_app` cannot UPDATE or DELETE an audit row — proven by SQL, expecting a
  privilege error.
- The existing 407 tests still pass.

---

## Phase 1 — Agent account schema

### 1.1 `user` gains one column and one constraint

```sql
ALTER TABLE "user" ADD COLUMN "agent_id" BIGINT;

-- §4 rule 10: agent is tenant-owned, so the key is composite.
ALTER TABLE "user" ADD CONSTRAINT "user_agent_fkey"
  FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "user_agent_id_idx" ON "user" ("agent_id");

-- The load-bearing line of the whole design.
ALTER TABLE "user" ADD CONSTRAINT "user_agent_is_external" CHECK (
  "agent_id" IS NULL
  OR ("employee_id" IS NULL AND "role_id" IS NULL AND "is_superadmin" = false)
);
```

That CHECK makes an agent-who-is-also-a-superadmin **unrepresentable**. Not
"prevented by the service layer" — impossible to store, by any code path, import
or hand-written SQL.

### 1.2 `agent_quote` — MVP shape, extensible

```sql
CREATE TABLE "agent_quote" (
  "tenant_id"    BIGINT NOT NULL,
  "id"           BIGSERIAL PRIMARY KEY,
  "code"         VARCHAR(32) NOT NULL,          -- §4 rule 2
  "inquiry_id"   BIGINT NOT NULL,
  "agent_id"     BIGINT NOT NULL,
  "submitted_by" BIGINT,                        -- the agent user
  "amount"       DECIMAL(18,4),                 -- nullable ON PURPOSE, see below
  "currency_id"  BIGINT NOT NULL,
  "valid_until"  DATE,
  "transit_days" INTEGER,
  "remarks"      TEXT,
  "status"       agent_quote_status NOT NULL DEFAULT 'SUBMITTED',
  "is_active"    BOOLEAN NOT NULL DEFAULT true,
  "created_at", "updated_at", "created_by", "updated_by", "deleted_at"
);
-- status: SUBMITTED | WITHDRAWN | ACCEPTED | DECLINED
```

**`amount` is nullable so that decision 3 stays extensible.** When tiered quotes
arrive, an `agent_quote_line` child table is added and a tiered quote carries
lines with `amount` NULL on the parent. A `NOT NULL` today would force either a
fake headline figure or an ALTER on a table with live commercial data. A CHECK
enforces the MVP rule instead:

```sql
CHECK ("amount" IS NOT NULL)   -- dropped when agent_quote_line lands
```

One live quote per agent per inquiry:

```sql
CREATE UNIQUE INDEX "agent_quote_one_live_per_agent"
  ON "agent_quote" ("tenant_id", "inquiry_id", "agent_id")
  WHERE "deleted_at" IS NULL AND "status" <> 'WITHDRAWN';
```

Composite FKs to `inquiry` and `agent`; plain FK plus the §4 rule 10 trigger to
`currency`, which is system-capable.

### 1.3 `user_credential_token`

```sql
CREATE TABLE "user_credential_token" (
  "tenant_id"  BIGINT NOT NULL,
  "id"         BIGSERIAL PRIMARY KEY,
  "user_id"    BIGINT NOT NULL,
  "purpose"    credential_token_purpose NOT NULL,   -- INVITE | RESET
  "token_hash" VARCHAR(255) NOT NULL,               -- argon2. Never the token.
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at"    TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" BIGINT
);

-- One live token per user per purpose: requesting a second reset invalidates
-- the first, so a stolen older link stops working.
CREATE UNIQUE INDEX "user_credential_token_live"
  ON "user_credential_token" ("tenant_id", "user_id", "purpose")
  WHERE "used_at" IS NULL;
```

Expiry: **invite 7 days, reset 1 hour.** An invite is expected to sit in an
inbox; a reset is expected to be used immediately.

---

## Phase 2 — Authentication and session

### 2.1 `agentId` comes from the database, never from the token

`loadAccount` already runs on every request and already reads the `user` row. It
gains `agentId`, and `req.auth.agentId` is set **from that read**.

The claim is also placed in the access token so the web app can route without an
extra call, but **the server never trusts it**. If claim and database disagree
the request is rejected — that is a tampered or stale token, and neither should
proceed. This is §7A rule 1 applied to the second boundary: a client that can
name its own agent id can read another agent's inquiries.

### 2.2 Two login endpoints, each with a narrow query

```
POST /api/tenant/auth/login    WHERE agent_id IS NULL       (staff)
POST /api/portal/auth/login    WHERE agent_id IS NOT NULL   (agents)
```

Separate endpoints rather than one that branches: a stolen agent credential is
useless at the staff endpoint even if some later check regresses. Both keep the
existing constant-time behaviour of hashing a dummy password when the user is
not found, so neither is an account-enumeration oracle.

### 2.3 Two mutually exclusive mounts

```
tenantRouter.use(authenticate);
tenantRouter.use(staffOnly);     // rejects any session with agentId set
tenantRouter.use('/setting', …); // every existing router, unchanged

portalRouter.use(authenticate);
portalRouter.use(agentOnly);     // rejects any session without agentId
portalRouter.use('/inquiries', …);
```

A guard you must remember to add is one you will forget, and the forgotten one
is the hole. One line above forty routers means a route added next year is
behind `staffOnly` by construction. Phase 6 enumerates the route table and
asserts every path sits behind exactly one gate.

### 2.4 Activation, reset, logout

```
Superadmin picks an agent PIC (agent_pic already holds name + email)
        │  creates user{agent_id, employee_id NULL, role_id NULL, is_superadmin false}
        │  is_active = false until the invite is accepted
        ▼
INVITE token generated, hashed, stored; the raw token goes only into the email
        ▼
Agent opens the link, sets their own password
        │  is_active = true · used_at set · token_version bumped
        ▼
Agent signs in at /portal
```

The forwarder never chooses the agent's password: a password your staff typed is
a password your staff knows.

**Reset** is self-service — an external user has no admin to phone. Same table,
1-hour expiry, and the response is identical whether or not the address exists.

**Logout** clears the cookie. Accepting an invite, completing a reset, or
deactivating the account bumps `token_version`, which kills every open session
on the next request.

### 2.5 Cookie separation

The portal refresh cookie is **`ff_portal_refresh`, scoped to `/api/portal`**,
distinct from the staff cookie. Two reasons: a staff session and an agent
session can coexist in one browser without overwriting each other, and the
portal cookie is never sent to a staff endpoint.

The portal must be served **same-origin** with the API — the cookie is
`SameSite=Lax`, and a portal on its own subdomain would sign agents in and then
silently stop refreshing. Caddy already path-routes `/api`.

### 2.6 Rate limiting

Portal login and reset get a per-IP and per-account limit with lockout after
repeated failures. The staff login is behind your own network and has not needed
it; a public portal is a different exposure.

---

## Phase 3 — Row Level Security

The layer that must hold when the application layer is wrong.

### 3.1 A second GUC

```sql
CREATE FUNCTION app_current_agent() RETURNS BIGINT
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.agent_id', true), '')::bigint $$;
```

`withAgent(tenantId, agentId, fn)` sets **both** GUCs transaction-locally, the
same way `withTenant` sets one. Staff sessions never set `app.agent_id`, so it
reads NULL for them.

### 3.2 Existing policies become staff-only

```sql
-- before
USING (tenant_id = app_current_tenant())
-- after
USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
```

Applied to **every** tenant-owned and system-capable table except the small
agent-visible set in 3.3 — `freight_rate`, `rate_line`, `rate_local_charge`,
`customer`, `vendor`, `employee`, `user`, `audit_log` and the rest.

**This is backward compatible by construction.** A staff session leaves the GUC
unset, so the added clause is true and the predicate reduces to exactly what it
is today. If any of the 407 existing tests fails after this, the change is wrong
somewhere and we stop — that is the agreed gate.

The default for an agent session is therefore **deny everything**, and access is
opened one table at a time below.

### 3.3 The openings, and one subtlety that will bite if ignored

**RLS applies inside a policy's own subqueries.** The `EXISTS` below runs as
`ff_app` and is itself filtered by `inquiry_party`'s policies. If
`inquiry_party` denied agents, the `EXISTS` would find nothing and every inquiry
would be invisible — the feature would fail closed and look like a bug. So
`inquiry_party` must be opened *first*, and to the agent's own rows only.

```sql
-- 1. The agent may see the rows that say they were selected.
CREATE POLICY agent_read ON inquiry_party FOR SELECT
  USING (tenant_id = app_current_tenant()
         AND app_current_agent() IS NOT NULL
         AND agent_id = app_current_agent());

-- 2. Decision 5: explicit selection IS the authorization boundary.
CREATE POLICY agent_read ON inquiry FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM inquiry_party ip
      WHERE ip.inquiry_id = inquiry.id
        AND ip.tenant_id  = inquiry.tenant_id
        AND ip.agent_id   = app_current_agent()
    )
  );

-- 3. Children inherit the parent's rule rather than restating it — the inner
--    SELECT is itself filtered by policy 2, so there is one place to get right.
CREATE POLICY agent_read ON inquiry_volume FOR SELECT
  USING (tenant_id = app_current_tenant()
         AND app_current_agent() IS NOT NULL
         AND EXISTS (SELECT 1 FROM inquiry i WHERE i.id = inquiry_volume.inquiry_id));

-- 4. Their own record and their own people.
CREATE POLICY agent_read ON agent FOR SELECT
  USING (tenant_id = app_current_tenant() AND id = app_current_agent());
CREATE POLICY agent_read ON agent_pic FOR SELECT
  USING (tenant_id = app_current_tenant() AND agent_id = app_current_agent());

-- 5. Their own quotes, read and write.
CREATE POLICY agent_rw ON agent_quote FOR ALL
  USING      (tenant_id = app_current_tenant() AND agent_id = app_current_agent())
  WITH CHECK (tenant_id = app_current_tenant() AND agent_id = app_current_agent());
```

**Reference data**, read-only, because a lane cannot be rendered without it and
none of it is confidential: `port`, `container_type`, `currency`,
`commodity_item`, `tos`. Deliberately short — every extra table is surface.

**Not opened, and worth stating explicitly:** `customer`, `freight_rate`,
`rate_line`, `rate_local_charge`, `inquiry_rate`, `user`, `employee`, `vendor`,
`carrier`, `audit_log`, every setting table.

### 3.4 Decision 2 needs a column guard, not just a table guard

`customer` is closed, so the customer *name* cannot be reached. But
`inquiry.customer_id` and the (now removed) target price live **on the inquiry
row itself**, which the agent can read.

RLS is row-level, not column-level. Two options, and I recommend both:

- **API:** the portal returns an `AgentInquiryDto` that simply has no
  `customerId`, `customerName` or price fields — omission is a type-level fact,
  the same trick `visibleLine` uses for buy price (§4 rule 5).
- **Database:** a `column_privileges` REVOKE of `customer_id` on `inquiry` from
  `ff_app` is *not* possible without breaking staff queries on the same role.
  So the second layer is instead a **view**, `agent_inquiry_v`, exposing only
  the permitted columns, with the portal reading the view and `ff_app` holding
  no SELECT on the base table for agent sessions.

I have marked this as the one place where the two layers are not fully
independent. **Decision needed — see §7 item A.**

---

## Phase 4 — Agent API authorization

```
POST   /api/portal/auth/login | refresh | logout
POST   /api/portal/auth/accept-invite | request-reset | reset
GET    /api/portal/me
GET    /api/portal/inquiries              list — RLS filters; route filters too
GET    /api/portal/inquiries/:id          writes a VIEW audit row
POST   /api/portal/inquiries/:id/quote    creates agent_quote
PATCH  /api/portal/quotes/:id             amend while the inquiry is open
```

Every route runs `withAgent(...)`, so RLS is active for the whole transaction.
Routes also filter explicitly — belt and braces, on the principle that either
layer alone should be sufficient.

`AgentInquiryDto`: code, dates, POL/POD, movement, shipment and loading type,
commodity, TOS, Incoterm, volumes, and the agent's own quote. **No customer, no
prices, no rates, no other agent's quote, and no staff remarks.**

`inquiry.remarks` was originally included — an agent has little context without
it — and flagged during Phase 3 as the one field where decision 2 was advisory
rather than structural, since it is free text the forwarder's own staff type and
a customer name could travel through it. The client's answer was to exclude it.
It is gone from `agent_inquiry_v`, from `AgentInquiryDto` and from the screen,
so the guarantee is now enforced the same way everywhere. If agents later turn
out to need context, that is a new field written for them to read — not this one
reinstated.

A quote may be amended only while its inquiry is `OPEN`. Once `QUOTED`, `WON` or
`LOST`, the portal is read-only for that inquiry — the same reasoning that stops
staff editing a WON inquiry.

---

## Phase 5 — Portal UI

A separate route group in the Next app — `/portal/*` — with its own shell: no
staff sidebar, no module navigation, a sign-in page, an inquiry list, an inquiry
detail with the quote form, and an account page. Its own session provider using
the portal cookie, so the two never share state.

Visually it stays inside §12's design system; it is the same product seen from
outside.

---

## Phase 6 — Security testing

### 6.1 The database-level tests you asked for

These connect **as `ff_app`** and set the GUCs by hand. They do not go through
the API at all — a test through the API only proves the API.

```sql
-- Agent A cannot read Agent B's inquiries
SELECT set_config('app.tenant_id', '<T>', true),
       set_config('app.agent_id',  '<A>', true);
SELECT count(*) FROM inquiry;                    -- expect: only A's
SELECT count(*) FROM inquiry WHERE id = <B_inquiry>;  -- expect: 0

-- Explicit selection is required: remove A's inquiry_party row, re-select
DELETE FROM inquiry_party WHERE …;               -- as owner, in the fixture
SELECT count(*) FROM inquiry WHERE id = <was_visible>;  -- expect: 0

-- Agents cannot read rates at all
SELECT count(*) FROM freight_rate;               -- expect: 0
SELECT count(*) FROM rate_local_charge;          -- expect: 0
SELECT count(*) FROM inquiry_rate;               -- expect: 0

-- Cross-tenant, with an agent id from another workspace
SELECT set_config('app.tenant_id', '<T2>', true),
       set_config('app.agent_id',  '<A_of_T1>', true);
SELECT count(*) FROM inquiry;                    -- expect: 0

-- An agent cannot become staff
UPDATE "user" SET is_superadmin = true WHERE agent_id IS NOT NULL;
                                                 -- expect: CHECK violation
INSERT INTO "user" (…, agent_id, role_id) VALUES (…);
                                                 -- expect: CHECK violation

-- Staff behaviour is unchanged: same queries with app.agent_id unset
SELECT set_config('app.agent_id', '', true);
SELECT count(*) FROM freight_rate;               -- expect: the tenant's rates
```

### 6.2 API-level tests

- Agent A requests B's inquiry by id → **404, not 403**. A 403 confirms the row
  exists, which is itself a leak.
- Agent A cannot POST a quote against B's inquiry.
- An agent token is refused on **every** route under `/api/tenant/*`, enumerated
  from the Express router so a route added later is covered automatically.
- A staff token is refused on every `/api/portal/*` route.
- An expired or used invite token is refused; a used reset token is refused.
- Reset for an unknown address returns the same body and status as for a known
  one.

### 6.3 Regression gate

**The existing 407 tests must pass unchanged after Phase 3.** They are the
backward-compatibility proof. If one fails, we stop and investigate before
proceeding — as agreed.

---

## Migration plan

Every change is **additive**. No column dropped, no table removed, no row
rewritten.

| Step | Change | Effect on your data |
|---|---|---|
| 0a | `REVOKE UPDATE ON audit_log`; `record_id` nullable; new enum values | None — the table is empty |
| 0b | Audit middleware | New rows only, from the moment it lands |
| 1a | `user.agent_id` + FK + CHECK | Your 3 users have NULL and satisfy the CHECK |
| 1b | `agent_quote`, `user_credential_token` | New, empty |
| 3a | Existing policies gain `AND app_current_agent() IS NULL` | **No behavioural change** — staff never set the GUC |
| 3b | Agent policies | Unreachable without an agent session |
| 4 | `user.route.ts` filters `agentId: null` | Keeps agent accounts out of the staff user list |

Untouched: **6 inquiries, 4 rates, 3 users, 4 agents, 2 vendors, 2 customers**,
and every existing screen.

**Rollback:** drop the agent policies, drop the added clauses, unmount the portal
router. Phase 0 is worth keeping regardless.

---

## §7 — What I still need from you

**A. The Decision 2 second layer.** Hiding customer and price in the DTO is
certain. A database-level guarantee needs a view (`agent_inquiry_v`) because RLS
cannot restrict columns and `ff_app` is one role serving both audiences.
The view is perhaps half a day and makes the guarantee independent of the API.
**Do you want it, or is the DTO sufficient for now?** I recommend the view — it
is the same argument as the rate tables, and decision 2 says this data is
sensitive.

**B. Failed-login audit for unknown usernames.** Recording them means writing a
row for traffic that may be pure noise from the internet. Recording only known
usernames means credential-stuffing against guessed names is invisible.
I recommend recording both, with the attempted username in `new_values`.

**C. Notification on quote submission.** When an agent submits a quote, should
the software email your staff? Not in your list, and easy to add now while the
mailer is fresh. I recommend yes, to the price team address already configured.

Everything else is settled. On your word I start at **Phase 0** and stop at each
phase gate for the regression check.
