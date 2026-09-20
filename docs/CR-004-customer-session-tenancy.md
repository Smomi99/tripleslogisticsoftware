# CR-004 — TENANT ISOLATION AUDIT, AND THE SAFE SHAPE FOR CUSTOMER SESSIONS

> **Status: audit only. Nothing in this document has been applied.**
> Written before Phase F of `/docs/MODULE_DOCUMENTATION.md` (customer access), because that phase
> proposed a `withCustomer()` helper and the audit says that helper, built the obvious way, opens
> every row in the workspace.
> Findings were verified against the live dev database (`ff-erp-postgres`, 2026-09-20), not inferred
> from the migration files alone.

---

## 1. WHAT WAS INSPECTED

| Area | Where |
|---|---|
| Session accessors | `app_current_tenant()`, `app_current_agent()`, `app_staff_tenant()`, `app_current_user_id()` — live `pg_proc` dump |
| Policies | all 81 `tenant_isolation` / `tenant_self` rows plus 19 `agent_read` / `agent_rw` / `agent_write` rows — live `pg_policies` dump |
| GUC writers | every `set_config` call site in `apps/api/src` (there are exactly three) |
| Application scoping | the Prisma `tenant-scope` extension, `withTenant`, `withAgent` |
| Session establishment | `resolveTenant`, `authenticateAs`, `loadAccount`, the JWT claim set, `POST /auth/login` |
| External accounts | `user.agent_id / customer_id / vendor_id`, `USER_TYPES`, `isExternal` |
| Privileges | `ff_app` vs `ff_erp` role attributes and table grants |

---

## 2. HOW TENANCY WORKS TODAY

### 2.1 Where `tenant_id` comes from

Never from the client. `resolveTenant` derives a slug from `DEFAULT_TENANT_SLUG`, then the `Host`
header (`acme.yourapp.com` → `acme`), then — in development only — `X-Tenant-Slug`. The slug is
resolved through `app_resolve_tenant()`, a `SECURITY DEFINER` function that returns only `(id,
status)`, because `tenant_self` hides the tenant table until `app.tenant_id` is already known.

The access token carries `tenantId`, and `authenticateAs` **rejects** a request whose resolved host
tenant disagrees with the token's tenant rather than reconciling them. That is the property that
makes cross-tenant access unreachable, and this CR does not change it.

### 2.2 The two layers

1. **The Prisma `tenant-scope` extension** injects `tenant_id` into every `where`, `create` and
   `update`, refuses `delete`/`deleteMany`, and throws on a model with no declared tier.
2. **RLS**, because the API connects as `ff_app` — `rolsuper = false`, `rolbypassrls = false`, owns
   no tables. Verified live.

**The extension knows about tenants and nothing else.** It has no concept of an agent or a customer.
For an agent session, the only thing narrowing rows to *that agent* is RLS plus the explicit `where`
in the agent routes. The same will be true of a customer: **RLS is not a net under the application
here, it is the primary row-scope control.**

### 2.3 The three GUC writers

| Call site | `app.tenant_id` | `app.user_id` | `app.agent_id` |
|---|---|---|---|
| `withTenant()` | set | set | **explicitly cleared to `''`** |
| `withAgent()` | set | set | set to the agent id |
| `recordAudit()` (`lib/audit.ts:80`) | set | — | **not set at all** |

`recordAudit` opens its own transaction with only the tenant. It works today purely because an unset
`app.agent_id` means "staff". Note also that it swallows every error by design, so if it ever lost
access it would fail **silently**.

The mail worker (`email-queue.ts`) claims rows through `app_claim_email_batch()`, a `SECURITY
DEFINER` function, and is unaffected by any of this.

### 2.4 The policy inventory, as it actually stands

| Shape | Count | Predicate |
|---|---|---|
| Tenant-owned | **64** | `tenant_id = app_staff_tenant()` |
| System-capable | **16** | `(tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NULL` |
| The tenant row | **1** | `id = app_staff_tenant()` |
| Agent openings | 19 | require `app_current_agent() IS NOT NULL` or `… = app_current_agent()` |

Tables with RLS disabled: `_prisma_migrations`, `permission`, `platform_user` — all three
deliberate. `platform_user` carries no grant to `ff_app` at all, so it is unreadable at runtime.

### 2.5 External accounts

`user` carries `agent_id | customer_id | vendor_id`, at most one set. `USER_TYPES` already includes
`CUSTOMER` and `VENDOR`, and the CRM → User screen can create both. `loadAccount` returns
`agentId` and a boolean `isExternal` — **it does not return `customerId`**. `AuthContext` likewise
has `agentId` but no `customerId`. `authenticateAs` knows three kinds: `STAFF`, `AGENT`, `ANY`.

So today a customer account can sign in and reach exactly one endpoint, `/auth/me`; every other
router calls `authenticate` (STAFF), which refuses any `isExternal` account. **The application layer
is closed. The database layer is not.**

---

## 3. THE FINDING

`app_staff_tenant()` does not mean "this is a staff session". It means **"this is not an agent
session"**:

```sql
SELECT CASE WHEN app_current_agent() IS NULL THEN app_current_tenant() END
```

That is an open-world assumption: every session that is not explicitly an agent is treated as staff.
It was correct when the only two kinds were staff and agent. It becomes wrong the moment a third
kind exists, and it fails **open**, not closed.

A `withCustomer()` written the obvious way — set `app.tenant_id`, set `app.customer_id`, leave
`app.agent_id` alone — produces a session that every one of the 81 staff policies admits.

### 3.1 Proven, not argued

Run as `ff_app` against the dev database (16 shipments, 10 customers, 6 users, 1 tenant):

| Session | GUCs set | shipment | customer | quotation | user | tenant | inquiry | port |
|---|---|---|---|---|---|---|---|---|
| **1 Staff** | `tenant=1`, `agent=''` | 16 | 10 | 25 | 6 | 1 | 12 | 14 |
| **2 Agent** | `tenant=1`, `agent=1849` | 0 | 0 | 0 | 0 | 0 | 0 | 14 |
| **3 Customer** | `tenant=1`, `agent=''`, `customer=1` | **16** | **10** | **25** | **6** | **1** | **12** | 14 |
| **4 No context** | none | 0 | 0 | — | — | — | — | 14 |

Row 3 is identical to row 1. Reading actual values out of that session returns other customers'
bookings and the staff account table:

```
CUST-SEES-USER  demo-nasir / nasir@demofreight.test / hash_visible=$argon2
CUST-SEES-SHIP  BKG-2026-000002 customer_id=2218 exporter=AOD international
```

### 3.2 Scope of the breach — stated precisely

The brief asked that an empty `agent_id` must never grant "access to every tenant". It does not, and
it is worth being exact about why, because it changes what has to be fixed:

- `app_current_tenant()` returns **NULL** when `app.tenant_id` is unset, and every policy compares
  against it, so a session with no tenant reads nothing (row 4 above — the 14 ports are system rows,
  `tenant_id IS NULL`, global by design under §7A rule 7).
- The tenant is resolved server-side from the host and cross-checked against the token, so a
  customer session can only ever have *its own* tenant in `app.tenant_id`.

So the exposure is **everything inside the customer's own tenant**, not other tenants: every other
customer's bookings and quotations, the inquiry pipeline, the CRM, and the `user` table including
argon2 hashes. That is a breach of customer-to-customer confidentiality, and of staff data, within
one workspace. Cross-tenant leakage stays blocked by §2.1 — but only as long as that holds, which
is a second reason not to lean on it.

### 3.3 Secondary findings

| # | Finding | Severity |
|---|---|---|
| **F2** | The 16 system-capable policies still carry the old `AND app_current_agent() IS NULL` conjunct. A fix applied only to `app_staff_tenant()` leaves a customer reading every tenant-private carrier, currency, port, cost unit, expert area, network, vendor type and carrier type. | High — easy to miss |
| **F3** | `recordAudit` sets only `app.tenant_id` and relies on the open-world default. Any closed-world fix must update it, and because it swallows errors the failure would be invisible. | High — silent |
| **F4** | `loadAccount` / `AuthContext` carry no `customerId`, so no handler can answer "which customer is this?". `authenticateAs` has no `CUSTOMER` kind. | Blocking for the feature |
| **F5** | `withAgent` does not clear `app.customer_id` (it does not exist yet). Whatever scheme is adopted, every helper must write **all** kind GUCs positively rather than relying on absence. | Design rule |
| **F6** | `runtimeDatabaseUrl = DATABASE_URL_APP ?? DATABASE_URL` silently falls back to the owner role, which bypasses RLS entirely. `docker-compose.prod.yml` makes `FF_APP_PASSWORD` mandatory so the real deploy path cannot hit it; a hand-rolled one could. | Low — worth removing the fallback |

---

## 4. THE THREE SCENARIOS, END TO END

### 4.1 Staff — `demo-nasir` signs in

1. `resolveTenant` → slug `demo` → `app_resolve_tenant('demo')` → tenant 1.
2. `POST /auth/login` runs inside `withTenant(1)`; password verified; `loadAccount` →
   `agentId: null, customerId: null, isExternal: false`.
3. Token issued with `tenantId: "1"`, `agentId: null`, the resolved permission set and `tokenVersion`.
4. Each request: `authenticateAs('STAFF')` re-reads the user row, compares host tenant vs token
   tenant, compares the `agentId` claim vs the row, refuses an inactive user or role.
5. Handler calls `withTenant(1)`: `app.tenant_id='1'`, `app.user_id='<id>'`, `app.agent_id=''`.
6. RLS: `app_staff_tenant()` → agent is NULL → returns 1 → `tenant_id = 1`. **16 shipments.**
   Correct.

### 4.2 Agent — `agent-aaa` signs in

Steps 1–4 identical, except `loadAccount` returns `agentId: 1849, isExternal: true`, and the token
carries `agentId: "1849"`.

- Any staff router: `authenticateAs('STAFF')` sees `isExternal` → **403 before any handler runs**.
- The agent router: `authenticateAgent` passes, and the handler uses `withAgent(1, 1849)` →
  `app.agent_id='1849'`.
- RLS: `app_staff_tenant()` → agent is not NULL → **NULL** → every staff policy denies. The session
  starts from deny-everything and reaches only the 19 explicit `agent_read` / `agent_rw` openings —
  the inquiries this agent was selected for, their own `agent` row and PICs, their own quotes, and
  five reference tables. Verified: `own_row=1, all_agents=1`.
- Column-level leakage is handled separately by `agent_inquiry_v` / `agent_inquiry_volume_v`, views
  with `security_invoker = true` that drop `customer_id`, `target_price`, `created_by`.

### 4.3 Customer — signs in today, and what happens the day a route exists

Today: login succeeds, `isExternal` is true, and every router refuses. The only reachable endpoint
is `/auth/me`. **Nothing leaks, because nothing is reachable.**

The day Phase F adds `withCustomer(1, 2218)` setting tenant + customer and leaving `app.agent_id`
empty:

- `app_current_agent()` → NULL.
- `app_staff_tenant()` → `CASE WHEN NULL IS NULL THEN 1 END` → **1**.
- Every `tenant_isolation` policy → `tenant_id = 1` → **true for every row in the workspace**.
- The Prisma extension adds `WHERE tenant_id = 1` — which is already satisfied — and nothing else,
  because it has no customer concept.

The customer's own route would probably carry `where: { customerId: 2218 }` and look fine in review.
The hole is everything else: one forgotten `where`, one `include`, one raw query, one new endpoint
written by whoever picks this up in six months. That is precisely the class of mistake RLS exists to
catch, and here it would not.

---

## 5. PROPOSED DESIGN

### 5.1 The principle

**A session's kind must be asserted positively. Absence must mean "deny", never "staff".**

Two ways to get there:

| | Option A — mirror the agent pattern | Option B — declare the kind |
|---|---|---|
| Change | `app_staff_tenant()` also requires `app_current_customer() IS NULL` | a new `app.actor_kind` GUC; staff means `kind = 'STAFF'` |
| Adding a vendor portal later | must remember to edit the function again, or it fails open | nothing to change — an unrecognised kind already denies |
| Risk profile | open-world; the same bug is available next year | closed-world; the default is deny |

**Recommendation: Option B.** The cost difference is one GUC and three call sites; the difference in
failure mode is open versus closed. Option A is the exact mistake being fixed, made one kind later.

### 5.2 The functions

```sql
-- Which kind of session this is. NULL when nobody said.
CREATE OR REPLACE FUNCTION app_actor_kind() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.actor_kind', true), '') $$;

-- The customer this session belongs to. Mirrors app_current_agent().
CREATE OR REPLACE FUNCTION app_current_customer() RETURNS BIGINT
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.customer_id', true), '')::bigint $$;

-- STEP 1 — the bridge. Identical behaviour to today when no kind is declared,
-- so this can be deployed before the API writes the GUC.
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT CASE
                 WHEN app_actor_kind() IS NOT NULL THEN app_actor_kind() = 'STAFF'
                 ELSE app_current_agent() IS NULL AND app_current_customer() IS NULL
               END $$;

-- STEP 2 — the flip, once every writer declares a kind. An undeclared session
-- is no longer staff.
CREATE OR REPLACE FUNCTION app_is_staff() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(app_actor_kind() = 'STAFF', false) $$;

-- Delegates. The 64 tenant-owned policies and tenant_self are NOT touched:
-- they still read `tenant_id = app_staff_tenant()`, so the single-comparison
-- shape that 20260917090000 introduced for the planner is preserved exactly.
CREATE OR REPLACE FUNCTION app_staff_tenant() RETURNS BIGINT
  LANGUAGE sql STABLE
  AS $$ SELECT CASE WHEN app_is_staff() THEN app_current_tenant() END $$;
```

### 5.3 The 16 system-capable policies (F2)

Rewritten from the catalogue, as `20260823090000_agent_rls` and `20260917090000` both did, rather
than listed by hand:

```sql
DO $do$
DECLARE
  p record;
  old_using constant text :=
    '(((tenant_id IS NULL) OR (tenant_id = app_current_tenant())) AND (app_current_agent() IS NULL))';
  old_check constant text := '((tenant_id = app_current_tenant()) AND (app_current_agent() IS NULL))';
  n integer := 0;
BEGIN
  FOR p IN
    SELECT tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
      AND qual = old_using AND with_check IS NOT DISTINCT FROM old_check
  LOOP
    EXECUTE format(
      'ALTER POLICY %I ON %I
         USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_is_staff())
         WITH CHECK (tenant_id = app_current_tenant() AND app_is_staff())',
      p.policyname, p.tablename);
    n := n + 1;
  END LOOP;

  IF n <> 16 THEN
    RAISE EXCEPTION 'Expected 16 system-capable policies, rewrote %. Stopping rather than guessing.', n;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies
             WHERE schemaname = 'public' AND qual LIKE '%app_current_agent() IS NULL%') THEN
    RAISE EXCEPTION 'A policy still infers staff from an absent agent id.';
  END IF;
END
$do$;
```

Deliberately still two conjuncts: these are small lookup tables reached by primary key, and
`20260917090000` left them in this shape on purpose. The rewrite swaps one boolean for another and
changes nothing about how they plan.

### 5.4 The customer openings — an allow-list, one table at a time

Written the way the agent openings were: nothing is reachable until it is named here. For the tables
that exist today (the BL tables of `MODULE_DOCUMENTATION` §4 get the same treatment when they land):

```sql
-- Their own company record and their own people.
CREATE POLICY customer_read ON "customer" FOR SELECT
  USING (tenant_id = app_current_tenant() AND id = app_current_customer());
CREATE POLICY customer_read ON "customer_pic" FOR SELECT
  USING (tenant_id = app_current_tenant() AND customer_id = app_current_customer());

-- Their own bookings, and nothing about anybody else's.
CREATE POLICY customer_read ON "shipment" FOR SELECT
  USING (tenant_id = app_current_tenant() AND customer_id = app_current_customer());

-- Reference data the forms cannot render without. Short on purpose: every
-- extra table is surface.
CREATE POLICY customer_read ON "port" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant())
         AND app_current_customer() IS NOT NULL);
CREATE POLICY customer_read ON "mode" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant())
         AND app_current_customer() IS NOT NULL);

-- Writable tables get FOR ALL with a WITH CHECK, or a customer can create a row
-- in another customer's name and merely fail to see it afterwards.
-- CREATE POLICY customer_rw ON "bl_draft" FOR ALL
--   USING (tenant_id = app_current_tenant() AND customer_id = app_current_customer())
--   WITH CHECK (tenant_id = app_current_tenant() AND customer_id = app_current_customer());
```

**Not opened, and the absence is deliberate:** `user`, `employee`, `agent`, `vendor`, `quotation`,
`freight_rate` and every rate table, `inquiry`, `audit_log`, `tenant`, and every settings table.

**Column boundary.** `shipment` carries `created_by`, `updated_by` and `quotation_id` — staff
identities and the commercial trail. As with `agent_inquiry_v`, the portal should read a
`customer_shipment_v` view declared `WITH (security_invoker = true)`, not the table.

### 5.5 Application changes that go with it

| File | Change |
|---|---|
| `lib/tenant-client.ts` | `withTenant` also sets `app.actor_kind='STAFF'` and `app.customer_id=''`; `withAgent` sets `'AGENT'` and clears `app.customer_id`; new `withCustomer(tenantId, customerId, fn)` sets `'CUSTOMER'`, the customer id, and clears `app.agent_id`. Every helper writes every kind GUC. |
| `lib/audit.ts` | its transaction sets `app.actor_kind='STAFF'` (F3). |
| `lib/permissions.ts` | `loadAccount` returns `customerId` (F4). |
| `middleware/authenticate.ts` | `authenticateAs` gains `'CUSTOMER'`; `AuthContext` gains `customerId`; the claim-versus-row check that exists for `agentId` is repeated for `customerId`. |
| `lib/jwt.ts` | `customerId` claim, alongside `agentId`. |
| `config/env.ts` | drop the `?? env.DATABASE_URL` fallback (F6) and fail loudly instead. |

**Tenant resolution itself does not change.** A customer's tenant comes from the same host-resolved,
token-cross-checked path as a staff member's, which is what satisfies "a customer must only be able
to access its own tenant" without inventing a second mechanism. The customer *id* comes from the
user row on every request, never from the token — the same rule already applied to `agentId`.

**One deliberate exception, stated so it is not discovered later:** authentication itself still runs
through `withTenant` (a STAFF session) because `loadAccount` reads the `user` table, which no
external session may see. It is a single `findFirst` by primary key inside `authenticate`, and that
`db` handle is never passed to a handler. This is how agent sessions already work.

---

## 6. MIGRATION PLAN

Ordering matters, because migrations are applied by `db:deploy` as a separate step from the API
image. Flipping the database to closed-world while the running API still declares no kind would deny
every staff request — a total outage.

| Step | What | Deploy order |
|---|---|---|
| **0** | Merge the application change that makes all three GUC writers declare `app.actor_kind`. Writing an undeclared custom GUC is harmless against the current database, so this is safe to ship alone. | API first |
| **1** | Migration `…_actor_kind_bridge`: create `app_actor_kind()`, `app_current_customer()`, `app_is_staff()` **in its bridge form**, and repoint `app_staff_tenant()` at it. Behaviour is byte-identical for staff and agents. | after step 0 |
| **2** | Migration `…_actor_kind_closed_world`: replace `app_is_staff()` with the strict form and rewrite the 16 system-capable policies. Assert the post-conditions in §5.3. | after step 1 has soaked |
| **3** | Migration `…_customer_rls`: the §5.4 openings and the `customer_shipment_v` view, plus `withCustomer`, `authenticateCustomer`, the `CUSTOMER` module in the permission registry. | with Phase F |

Steps 1 and 2 are separate files on purpose. Step 2 is the one that can break staff access, and it
should be revertible on its own — `CREATE OR REPLACE FUNCTION app_is_staff()` back to the bridge
form is a one-line rollback that needs no policy changes, because no policy names the kind directly.

Nothing here alters a table, so there is no data migration and no downtime beyond the function
replacements.

---

## 7. TEST PLAN

Layer by layer, and the database tests run as `ff_app` with no Express and no Prisma extension in the
way — the shape `lib/agent-rls.test.ts` already establishes.

**Before anything ships**

1. `lib/agent-rls.test.ts` and the full existing suite pass unchanged after steps 1 and 2. This is
   the non-regression gate; if staff or agent behaviour moves at all, stop.
2. A new assertion in the existing RLS test: the role these tests run as is still not the owner.

**New — `lib/actor-kind.test.ts` (steps 1–2)**

3. Staff session (`kind='STAFF'`) reads its own tenant's rows; count matches the fixture.
4. Agent session reads only its openings — unchanged from today.
5. **An undeclared session reads zero rows** from every tenant-owned table. This is the test that
   proves the bridge is gone; it must fail against step 1 and pass against step 2.
6. `kind='CUSTOMER'` with no customer policies yet reads **zero** rows — the deny-by-default floor,
   asserted before any opening exists.
7. An unrecognised kind (`kind='ROBOT'`) reads zero rows.
8. A catalogue test: no policy in `pg_policies` matches `%app_current_agent() IS NULL%`. This is what
   fails the build when somebody adds a table with the old predicate copied from an older migration.

**New — `lib/audit-actor-kind.test.ts` (F3)**

9. `recordAudit` still writes a row after step 2. Asserted by reading the row back, **not** by the
   call not throwing — it swallows errors, so a silent failure looks like success.

**New — `lib/customer-rls.test.ts` (step 3)**, seeded with two customers in one tenant and a third in
a second tenant:

10. Customer A reads their own `customer` row and their own PICs; count is 1, not 10.
11. Customer A cannot read customer B's row, in the same tenant.
12. Customer A reads only their own shipments; B's bookings are invisible.
13. Customer A reads nothing at all from `user`, `employee`, `quotation`, `freight_rate`, `inquiry`,
    `audit_log`, `tenant`, or any settings table.
14. Customer A cannot read anything belonging to the second tenant, by any path.
15. Customer A cannot INSERT or UPDATE a row carrying another customer's id — the `WITH CHECK` half,
    which `USING` alone would not catch.
16. The `customer_shipment_v` view exposes no `created_by`, `updated_by` or `quotation_id`.

**API layer**

17. A customer token is refused by a staff router (already true; pin it with a test so it stays true).
18. A staff token is refused by a customer router.
19. An agent token is refused by a customer router, and vice versa.
20. A customer route returns only that customer's rows **with RLS temporarily disabled for the
    test** — proving the route's own `where` is correct rather than leaning on the policy. Both
    layers are supposed to be independently sufficient; a test that only ever exercises them together
    cannot tell you that.

---

## 8. WHAT I RECOMMEND DOING FIRST

Steps 0–2 are worth doing **whether or not customer access is built**, and before it. They are
small, they are testable against the existing suite, and they turn a latent open-world default into
a closed one while there is still no third kind of session to break. Step 3 then becomes an
ordinary feature rather than a security change.
