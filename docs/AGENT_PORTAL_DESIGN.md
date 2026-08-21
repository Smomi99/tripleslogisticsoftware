# Agent Portal — architecture and security design

**Status:** design only. No code, no migrations, no data touched.
**Read with:** CLAUDE.md §7 (RBAC), §7A (multi-tenancy), §4 rules 3, 5 and 10.

This document exists because the agent portal is the first time an outsider is
given a login to this system. Everything before it has been staff-only, and the
tenant boundary was the only boundary that mattered. A portal adds a second one
*inside* each workspace, and the two must hold independently.

---

## 0. What I found in the code (corrections first)

I told you last session that `user.employee_id` is required. **That was wrong.**
It is nullable in both the schema and the database, and your seeded superadmin
already has no employee:

| username | employee_id | is_superadmin |
|---|---|---|
| clerk1 | set | no |
| rahimu | set | no |
| superadmin | **null** | yes |

What is required is the *staff creation form* — `userInputSchema.employeeId` is
`z.string().regex(/^\d+$/)`. So the constraint lives in the application, not the
database, and agent accounts need **no destructive change** to `user`. That
makes the account model below considerably cheaper and safer than I implied.

Other findings the design leans on:

- **RLS is a single GUC.** `app_current_tenant()` reads
  `current_setting('app.tenant_id')`, set transaction-locally by `withTenant`.
  Every tenant-owned policy is `tenant_id = app_current_tenant()`.
- **The access token already caches permissions** and is invalidated by
  `token_version`. `authenticate` re-checks active/role/version per request.
- **Buy price is stripped in the response**, not hidden in React
  (`lib/rate-visibility.ts`). That enforcement point is the right shape and the
  portal will not weaken it.
- **There is no self-service password reset.** `user.route.ts` has an
  admin-initiated reset only. An external user has no admin to ask.
- **`audit_log` is empty — nothing writes to it.** See §8; this is a
  prerequisite, not a nice-to-have.

---

## 1. Account model

### Decision: extend `user`, do not create a parallel table

```
user
  id, tenant_id, code, username, email, password_hash
  employee_id  BIGINT NULL   -- staff: set. agent: always NULL.
  agent_id     BIGINT NULL   -- agent: set. staff: always NULL.   ← NEW
  role_id      BIGINT NULL   -- agent: always NULL.
  is_superadmin BOOLEAN      -- agent: always false.
```

**Why not a separate `agent_user` table?** Because it would need its own login
route, its own token shape, its own active/`token_version` checks, and its own
logout. Two implementations of authentication is how one of them drifts, and the
one that drifts is the one that leaks. One table, one auth path, one place to
deactivate an account.

**What makes that safe is a database constraint, not discipline:**

```sql
ALTER TABLE "user" ADD CONSTRAINT user_agent_is_external CHECK (
  agent_id IS NULL
  OR (employee_id IS NULL AND role_id IS NULL AND is_superadmin = false)
);
```

This is the single most important line in the design. It makes "an agent account
that is also a superadmin" **unrepresentable**, rather than merely something no
code path currently does. A future bug, a bad import, a careless SQL fix — none
of them can produce that row.

Discriminator: `agent_id IS NOT NULL`. No separate `kind` column, because two
sources of truth for the same fact eventually disagree.

### Consequence to handle (compatibility)

`user.route.ts` lists users for CRM → User. It must gain `agentId: null` in its
`where`, or agent accounts appear in the staff user list. This is a required
change, not optional — see §9.

---

## 2. Authentication

### Token

Add one claim: `agentId: string | null`. `authenticate` puts it on
`req.auth.agentId`. Everything else — 15-minute access token, httpOnly refresh
cookie, `token_version`, the per-request active check — is reused unchanged.

### Keeping agents out of staff routes

**Do not add `requireStaff` to forty route files.** A guard you must remember to
add is a guard you will one day forget, and the forgotten one is the hole. Mount
it once:

```
tenantRouter.use(authenticate)
tenantRouter.use(staffOnly)        ← rejects any token carrying agentId
tenantRouter.use('/setting', ...)  ← every existing router, unchanged
...

portalRouter.use(authenticate)
portalRouter.use(agentOnly)        ← rejects any token WITHOUT agentId
portalRouter.use('/inquiries', ...)
```

Two mutually exclusive gates at two mount points. A new staff route added next
year is behind `staffOnly` by construction, because it is mounted under a router
that already carries it. §11 includes a test that walks the route table and
asserts every path is behind exactly one of them.

### Activation and reset

Neither exists today, and an external user cannot phone your office for a
password. One new table serves both:

```
user_credential_token
  id, tenant_id, user_id, purpose ENUM('INVITE','RESET'),
  token_hash VARCHAR(255),   -- argon2 of the token. NEVER the token itself.
  expires_at TIMESTAMPTZ, used_at TIMESTAMPTZ NULL,
  created_at, created_by
```

- **Invite:** staff invites an *agent PIC* (a person with an email, which
  `agent_pic` already holds). A single-use token is emailed; the agent sets
  their own password. The forwarder never types a password on the agent's
  behalf — a password your staff chose is a password your staff knows.
- **Reset:** self-service. Same table, `purpose = 'RESET'`, short expiry.
- **Both are stored hashed.** A leaked database backup must not hand over live
  invite links.
- **Uniform responses.** "If that address has an account, a link is on its way"
  — whether or not it does. Otherwise the reset form is an account-enumeration
  oracle against your agent list.
- Accepting an invite or completing a reset bumps `token_version`, which kills
  every session already open on that account.

### Session and logout

Unchanged mechanism. Two portal-specific notes:

- The portal must be served **same-origin** with the API (Caddy already
  path-routes `/api`), because the refresh cookie is `SameSite=Lax`. A portal on
  its own subdomain would sign agents in and then silently stop refreshing —
  the same trap documented in `docs/DEPLOY_VPS.md` §1.
- Deactivating an agent (`is_active = false`) or the agent record itself takes
  effect on the next request, not the next login, because `authenticate`
  re-reads the account every time.

---

## 3. Permissions

### Decision: agents are not in the §7 permission matrix at all

Agent capability is **derived from `agentId IS NOT NULL`**, not granted by role
or by `user_permission` rows.

**Why:** the §7 matrix is a staff-facing screen. If agent capability were
expressed there, a superadmin could tick `PURCHASE.PRICE_LIST_FCL.VIEW` for an
agent account and hand a competitor's partner your entire buying position with
one checkbox. Keeping agents out of the matrix makes that over-grant
unrepresentable rather than merely discouraged. It also keeps §7's resolution
order (superadmin → role → ALLOW/DENY) exactly as it is today.

### What an agent may do

| | Allowed |
|---|---|
| **View** | Inquiries where their agent row is a selected party (§6); their own agent and contact records; their own submitted quotes; the lookup data needed to render a form (ports, container types, currencies, units) |
| **Create** | A quote against an inquiry they can see |
| **Update** | Their own quote while the inquiry is still open; their own password and profile |
| **Delete** | Nothing. Ever. |

### What an agent may never do — enumerated deliberately

Purchase rates and the price list · other agents · customers · vendors ·
carriers · employees · users · roles and permissions · settings of any kind ·
inquiries they were not selected for · another agent's quotes · exports ·
anything under `/api/tenant/*`.

Staff and admin permissions are **completely unchanged**. Nothing in §7 or §7B
is edited by this work.

---

## 4. Row Level Security

This is the layer that must hold when the application layer is wrong. The
assumption throughout is: *a route forgot its filter — what stops the leak?*

### A second GUC

```sql
CREATE FUNCTION app_current_agent() RETURNS BIGINT
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.agent_id', true), '')::bigint $$;
```

`withTenant` gains a sibling, `withAgent(tenantId, agentId, fn)`, which sets
**both** GUCs transaction-locally in the same way. Staff sessions never set
`app.agent_id`, so it reads NULL for them.

**`app.agent_id` is taken from the authenticated user's `agent_id` column and
from nowhere else** — never a header, a query parameter or a body field. This is
§7A rule 1 applied to the second boundary: a client that can name its own agent
id can read another agent's inquiries.

### Step 1 — every existing policy becomes staff-only

```sql
-- before
USING (tenant_id = app_current_tenant())
-- after
USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
```

Applied to every tenant-owned table an agent has no business reading — which is
almost all of them, `freight_rate` and `rate_local_charge` emphatically included.

**This is backward compatible by construction.** A staff session leaves
`app.agent_id` unset, so `app_current_agent() IS NULL` is true and the predicate
reduces to exactly what it is today. The existing 407 tests should pass without
modification; if any fails, the change is wrong.

The default for an agent session is therefore **deny everything**. Access is
then opened one table at a time, deliberately.

### Step 2 — the narrow openings

```sql
-- An inquiry is visible to an agent only if that agent was selected on it.
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

-- Children reachable only through a visible parent.
CREATE POLICY agent_read ON inquiry_volume FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM inquiry i WHERE i.id = inquiry_volume.inquiry_id)
  );
```

That inner `SELECT 1 FROM inquiry` is itself filtered by the inquiry policy, so
the child inherits the parent's rule rather than restating it — one place to get
right instead of five.

Same shape for `agent` and `agent_pic` (`id = app_current_agent()` / belongs to
it), and for the new `agent_quote` (`agent_id = app_current_agent()`).

Shared reference data — `port`, `container_type`, `currency`, `cost_unit` — gets
a read-only agent policy. An agent needs to render a lane, and none of it is
confidential.

### How each attack is stopped

**Agent A reading Agent B's inquiry.** The `EXISTS` requires an `inquiry_party`
row naming *A*. B's inquiries have rows naming B. `SELECT * FROM inquiry` with
no WHERE clause returns A's rows only. A route that forgets its filter leaks
nothing.

**An agent reading confidential rates.** `freight_rate` has no agent policy at
all, and its staff policy requires `app_current_agent() IS NULL`. An agent
session reads **zero rows** from it — not filtered columns, no rows. The buy
price cannot leak because the record cannot be reached. This is the answer to
"confidential rates must never be exposed": it is a database fact, not an API
behaviour.

**Cross-forwarder access.** Both predicates apply. `tenant_id =
app_current_tenant()` is untouched, and `app.agent_id` derives from a `user` row
that was itself found under the tenant scope. An agent of forwarder X whose
session somehow carried forwarder Y's tenant id would still fail the `user`
lookup that produces the agent id.

**The application layer being wrong.** Assumed throughout. Every statement above
holds with the API removed entirely — they are testable by opening `psql` as
`ff_app`, setting the two GUCs by hand, and selecting. §11 includes exactly that
test, because a test that goes through the API only proves the API.

---

## 5. Agent ↔ forwarder relationship

`agent` is already tenant-owned (`tenant_id NOT NULL`), so **an agent row
belongs to exactly one forwarder.** Nothing in the schema changes.

It follows that if one real-world company partners with two forwarders on this
platform, they are two `agent` rows in two tenants and therefore **two logins**.

**My recommendation: keep it that way.** A single account spanning forwarders
would mean a session whose `app.tenant_id` can change, and every policy in the
system assumes that value is fixed for the life of a transaction. Supporting it
would be a rewrite of the tenancy model to serve a convenience. Two logins is a
mild annoyance for the agent; one switchable session is a new class of bug in
the boundary that protects your clients from each other.

This is **decision 1** in §12 — it is a business call, and I have only made the
engineering case.

New relationships required: `user.agent_id → agent.id`. That is all. Because
`agent` is tenant-owned and `user` is tenant-owned, this is a §4 rule 10
composite key: `FOREIGN KEY (tenant_id, agent_id) REFERENCES agent(tenant_id, id)`.

---

## 6. Inquiry flow, end to end

```
1. Staff raise an inquiry, choose POL and POD
        │
2. Lane check  ──► live purchased rate exists?
        │
        ├─ YES ──► "Matched". No agent block. No email. No portal visibility.
        │           Nothing is being asked of anyone, so nobody is told.
        │
        └─ NO  ──► agent/carrier block appears
                    │
3. Inbound: staff pick agents (filtered to the POL country) and their contacts
                    │
4. Save ──► inquiry_party + inquiry_party_contact rows written
        │
5. Email to the chosen PICs                      ← EXISTS TODAY, unchanged
        │
6. Portal visibility: the SAME inquiry_party rows │ ← NEW
   are what the RLS policy in §4 keys on
        │
7. Agent signs in, sees the inquiry, submits a quote (agent_quote)
        │
8. Staff see quotes beside the inquiry and accept one
```

**Step 2's "no notification on a matched lane" is preserved, and preserved for
free.** When the lane matches, the party block never appears, so no
`inquiry_party` rows are written — which means no email *and* no portal
visibility, from the same fact. It needs no special case, and it cannot drift
apart later.

Step 5 is untouched code. Step 6 reuses the rows step 4 already writes.

**Open question (decision 2):** what does an agent see *on* the inquiry?
Customer name and target price are commercially sensitive — telling an overseas
agent which of your customers is shipping, and what you hope to pay, is a
negotiating position handed over. I recommend the portal shows lane, volumes,
commodity, dates and remarks, and **withholds customer identity and target
price** unless you say otherwise.

---

## 7. Rate visibility

| Data | Agent sees |
|---|---|
| `freight_rate`, `rate_line`, `rate_local_charge` | **Nothing.** No rows, at the RLS layer. |
| Buy price / margin | Not reachable — the parent row is invisible. |
| Their own `agent_quote` rows | Yes. |
| Another agent's quotes | No — RLS predicate `agent_id = app_current_agent()`. |
| Whether a lane is already rated | No. They are only asked when it is not. |

Two layers, as requested:

- **Database:** no agent policy on the rate tables. Zero rows.
- **API:** the portal router never mounts the rate routers at all, and
  `agentOnly` rejects an agent token on `/api/tenant/*` where they live.

Either layer alone would be sufficient. Both are present because the question
"could a bug expose a competitor's buying rates" should have two independent
answers.

---

## 8. Audit and security

### `audit_log` is a prerequisite, not a follow-up

The table exists, the model exists, and **nothing has ever written to it**
(`SELECT count(*) FROM audit_log` = 0). CLAUDE.md §4 rule 7 requires a Prisma
middleware for every create/update/deactivate; it was never built.

Shipping an external portal on top of a system with no audit trail means that
when an agent says "I never saw that inquiry", or you suspect an account is
compromised, there is nothing to consult. **Phase 0 of §10 is building it**, and
I would not ship the portal without it.

### Actions to audit

| Event | Why |
|---|---|
| Agent login — success **and** failure | Failures are the signal of a credential-stuffing attempt |
| Invite issued, accepted, expired | Who let this outsider in, and when |
| Password reset requested and completed | The classic account-takeover path |
| Inquiry viewed by an agent | Answers "who saw this commercial detail" |
| Quote submitted or amended | It is a commercial commitment |
| Agent account activated, deactivated, deleted | Access changes |
| Staff impersonating a tenant user | §7B already requires this and it is also unbuilt |

### Risks and what stops each

| Risk | Mitigation |
|---|---|
| Agent escalates to staff | CHECK constraint makes the row unrepresentable; no role; `staffOnly` at the mount point |
| Agent A reads Agent B's data | RLS `EXISTS` on `inquiry_party`; holds with the API removed |
| Agent reads confidential rates | No agent policy on rate tables — zero rows |
| Cross-forwarder leak | Existing `tenant_id` predicates, plus `app.agent_id` derived from a tenant-scoped row |
| A new staff route added without a guard | Single mount point + a test that enumerates the route table |
| Token still valid after deactivation | Per-request active check and `token_version`, both already built |
| Invite/reset token stolen from the database | Hashed at rest, single-use, short expiry |
| Account enumeration via the reset form | Uniform response regardless of whether the address exists |
| Agent brute-forces a login | Rate limit per IP and per account on the portal login; lockout after N failures |
| Notification email leaks detail | The body already carries code, lane and movement — no prices, no customer contact |
| Agent id spoofed in a request | Never read from the request; taken from the authenticated user row |

### Residual risks I am not solving here

- **No 2FA for agent accounts.** Worth considering later; out of scope now.
- **Session fixation across the two portals** is prevented by the exclusive
  mounts, but the *cookie* is shared. Recommend a distinct cookie name and path
  for portal refresh tokens so a staff session and an agent session cannot
  co-exist confusingly in one browser.

---

## 9. Migration and backward compatibility

**Everything proposed is additive.** No column is dropped, no table is removed,
no data is rewritten.

| Change | Effect on existing data |
|---|---|
| `user.agent_id` nullable + CHECK | Your 3 users have `agent_id NULL` and satisfy the constraint unchanged |
| `agent_quote`, `user_credential_token` | New, empty |
| `app_current_agent()` | New function; nothing calls it for staff |
| Existing policies gain `AND app_current_agent() IS NULL` | **No behavioural change for staff** — the GUC is unset, so the clause is true |
| Agent policies | Only reachable when `app.agent_id` is set, which only a portal session does |
| `user.route.ts` gains `agentId: null` to its filter | Keeps agent accounts out of the staff user list |

Your **6 inquiries, 4 rates, 3 users, 2 vendors and 4 agents are untouched.**

**Rollback:** drop the agent policies, drop the `AND app_current_agent() IS NULL`
clauses, unmount the portal router. Nothing existing depends on any of it.

The one change with behavioural risk is tightening the existing policies. It is
mechanical and its correctness is verifiable: the current test suite must pass
unchanged. If it does not, the clause is wrong somewhere and we stop.

---

## 10. Phased implementation plan

| Phase | Scope | Done when |
|---|---|---|
| **0** | `audit_log` middleware in the tenant client extension (§4 rule 7) | Every create/update/deactivate writes a row; a test proves it |
| **1** | Schema: `user.agent_id` + CHECK, `agent_quote`, `user_credential_token`. No behaviour change | Migration applied; all 407 existing tests pass untouched |
| **2** | RLS: `app_current_agent()`, `withAgent`, tighten existing policies, add agent policies | Existing tests pass unchanged **and** the raw-SQL isolation tests in §11 pass |
| **3** | Auth: `agentId` claim, `staffOnly` / `agentOnly` mounts, portal login, invite and reset | An agent token is refused on every `/api/tenant/*` route |
| **4** | Portal API: inquiry list, inquiry detail, submit and amend a quote | Endpoints exist and are covered by the isolation tests |
| **5** | Portal UI: separate shell, sign-in, inquiry list, quote form | An agent can complete the §6 flow in a browser |
| **6** | Staff side: invite an agent PIC, see and accept quotes on the inquiry | Staff can run the whole loop |
| **7** | Rate limiting, deployment config, docs | Portal live behind Caddy on the VPS |

Phases 1 and 2 are the ones to do slowly. Everything after them is ordinary
feature work; those two are the boundary itself.

### Tests that must exist before phase 5

**Cross-agent isolation (raw SQL, no API):**
- Set `app.tenant_id` and `app.agent_id` to Agent A; `SELECT * FROM inquiry`
  returns only A's; `SELECT count(*) FROM freight_rate` returns 0.
- Same for `inquiry_volume`, `inquiry_party`, `agent_quote`.

**Cross-agent isolation (API):**
- Agent A requests B's inquiry by id → 404, not 403 (a 403 confirms it exists).
- Agent A cannot submit a quote against B's inquiry.

**Cross-tenant:**
- An agent of tenant X, token forged with tenant Y's id, is rejected.
- Two tenants each with an agent: neither sees the other's inquiries.

**Privilege separation:**
- An agent token is refused on every route under `/api/tenant/*` — enumerated
  from the router, so a route added later is covered automatically.
- A staff token is refused on every portal route.
- `INSERT`/`UPDATE` making an agent account a superadmin violates the CHECK.

**Regression:**
- The full existing suite passes unchanged after phase 2. This is the
  backward-compatibility proof and it is non-negotiable.

---

## 11. Decisions I need from you

1. **One login per forwarder, or one login across forwarders?**
   I recommend one per forwarder (§5). Multi-forwarder accounts would mean a
   session whose tenant can change, which every existing policy assumes cannot
   happen.

2. **What may an agent see on an inquiry?**
   I recommend withholding **customer identity** and **target price**, and
   showing lane, volumes, commodity, dates and remarks. Telling an overseas
   agent who is shipping and what you hope to pay is a negotiating position
   given away.

3. **What is a quote?**
   The simple version is one price, a currency and a validity date. The full
   version mirrors a purchase rate — per-container tiers plus local charges —
   and could be accepted straight into the price list. The second is more
   useful and roughly three times the work.

4. **Who may invite an agent?**
   Superadmin only, or anyone holding `CRM.AGENT.EDIT`? Inviting an outsider is
   a security action; I lean to superadmin only at first.

5. **Should an agent see inquiries on lanes they cover but were not selected
   for?** I recommend **no** — selection is the consent, and "all inquiries on
   lanes I cover" is a much wider door than it first appears.

6. **Do you want the audit trail (phase 0) built first?**
   I strongly recommend yes. It is the difference between investigating an
   incident and guessing about one.
