-- Phase 1 of the agent portal: the shape an external account is allowed to take.
--
-- No routes, no login, no UI. This migration only decides what the database
-- will and will not hold, because that is the part that has to be right before
-- anyone outside the company is given a password.

CREATE TYPE "agent_quote_status" AS ENUM ('SUBMITTED', 'WITHDRAWN', 'ACCEPTED', 'DECLINED');
CREATE TYPE "credential_token_purpose" AS ENUM ('INVITE', 'RESET');

-- ---------------------------------------------------------------------------
-- 1. user.agent_id — and the constraint the whole design rests on
-- ---------------------------------------------------------------------------
ALTER TABLE "user" ADD COLUMN "agent_id" BIGINT;

-- §4 rule 10: agent is tenant-owned, so the key is composite. A user in one
-- workspace cannot be attached to another workspace's agent.
ALTER TABLE "user" ADD CONSTRAINT "user_agent_id_fkey"
  FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "user_agent_id_idx" ON "user" ("agent_id");

-- An agent who is also staff is not "prevented by the service layer" — it is
-- unrepresentable. No route, no seed, no import and no hand-written UPDATE can
-- produce one, because Postgres refuses to store the row.
--
-- Deliberately three separate denials rather than one flag: employee_id would
-- tie an outsider to a staff record, role_id would grant them staff permissions
-- through §7's resolution order, and is_superadmin would skip that resolution
-- altogether.
ALTER TABLE "user" ADD CONSTRAINT "user_agent_is_external" CHECK (
  "agent_id" IS NULL
  OR ("employee_id" IS NULL AND "role_id" IS NULL AND "is_superadmin" = false)
);

-- ---------------------------------------------------------------------------
-- 2. agent_quote
-- ---------------------------------------------------------------------------
CREATE TABLE "agent_quote" (
  "tenant_id"    BIGINT NOT NULL,
  "id"           BIGSERIAL NOT NULL,
  "code"         VARCHAR(32) NOT NULL,
  "inquiry_id"   BIGINT NOT NULL,
  "agent_id"     BIGINT NOT NULL,
  -- The agent user who submitted it. Nullable because a staff member may record
  -- a quote that arrived by phone on the agent's behalf.
  "submitted_by" BIGINT,
  -- Nullable ON PURPOSE. When tiered quotes arrive, agent_quote_line will hold
  -- the figures and the parent's amount will be NULL. NOT NULL today would force
  -- either a fabricated headline number or an ALTER on live commercial data; the
  -- CHECK below enforces the MVP rule and is dropped when the child table lands.
  "amount"       DECIMAL(18,4),
  "currency_id"  BIGINT NOT NULL,
  "valid_until"  DATE,
  "transit_days" INTEGER,
  "remarks"      TEXT,
  "status"       "agent_quote_status" NOT NULL DEFAULT 'SUBMITTED',
  "is_active"    BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL,
  "created_by"   BIGINT,
  "updated_by"   BIGINT,
  "deleted_at"   TIMESTAMPTZ(6),
  CONSTRAINT "agent_quote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_quote_amount_required" CHECK ("amount" IS NOT NULL),
  CONSTRAINT "agent_quote_amount_positive" CHECK ("amount" IS NULL OR "amount" > 0),
  CONSTRAINT "agent_quote_transit_days_sane" CHECK ("transit_days" IS NULL OR "transit_days" >= 0)
);

CREATE UNIQUE INDEX "agent_quote_tenant_id_code_key" ON "agent_quote" ("tenant_id", "code");
CREATE UNIQUE INDEX "agent_quote_tenant_id_id_key" ON "agent_quote" ("tenant_id", "id");

-- One live quote per agent per inquiry. A resubmission withdraws the previous
-- one rather than sitting beside it, so "the agent's price" is never ambiguous
-- at the moment someone reads it.
CREATE UNIQUE INDEX "agent_quote_one_live_per_agent"
  ON "agent_quote" ("tenant_id", "inquiry_id", "agent_id")
  WHERE "deleted_at" IS NULL AND "status" <> 'WITHDRAWN';

CREATE INDEX "agent_quote_tenant_id_idx" ON "agent_quote" ("tenant_id");
CREATE INDEX "agent_quote_inquiry_id_idx" ON "agent_quote" ("inquiry_id");
CREATE INDEX "agent_quote_agent_id_idx" ON "agent_quote" ("agent_id");
CREATE INDEX "agent_quote_status_idx" ON "agent_quote" ("status");

ALTER TABLE "agent_quote" ADD CONSTRAINT "agent_quote_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote" ADD CONSTRAINT "agent_quote_inquiry_id_fkey"
  FOREIGN KEY ("tenant_id", "inquiry_id") REFERENCES "inquiry"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote" ADD CONSTRAINT "agent_quote_agent_id_fkey"
  FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agent"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- currency is system-capable (§7A rule 7), so it cannot take a composite key —
-- a shared row has tenant_id NULL and would match no tenant. The trigger below
-- is the §4 rule 10 guard that the composite key would otherwise have been.
ALTER TABLE "agent_quote" ADD CONSTRAINT "agent_quote_currency_id_fkey"
  FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote" ADD CONSTRAINT "agent_quote_submitted_by_fkey"
  FOREIGN KEY ("submitted_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote" ADD CONSTRAINT "agent_quote_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote" ADD CONSTRAINT "agent_quote_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "agent_quote_currency_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "agent_quote"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');

-- ---------------------------------------------------------------------------
-- 3. user_credential_token
-- ---------------------------------------------------------------------------
-- Invites and password resets. The token itself is never stored, only an argon2
-- hash of it — so a stolen copy of this table is not a set of working links.
CREATE TABLE "user_credential_token" (
  "tenant_id"  BIGINT NOT NULL,
  "id"         BIGSERIAL NOT NULL,
  "user_id"    BIGINT NOT NULL,
  "purpose"    "credential_token_purpose" NOT NULL,
  "token_hash" VARCHAR(255) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at"    TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" BIGINT,
  CONSTRAINT "user_credential_token_pkey" PRIMARY KEY ("id")
);

-- One live token per user per purpose: asking for a second reset link kills the
-- first, so an older link intercepted in transit stops working.
CREATE UNIQUE INDEX "user_credential_token_live"
  ON "user_credential_token" ("tenant_id", "user_id", "purpose")
  WHERE "used_at" IS NULL;

CREATE INDEX "user_credential_token_tenant_id_idx" ON "user_credential_token" ("tenant_id");
CREATE INDEX "user_credential_token_user_id_idx" ON "user_credential_token" ("user_id");
CREATE INDEX "user_credential_token_expires_at_idx" ON "user_credential_token" ("expires_at");

ALTER TABLE "user_credential_token" ADD CONSTRAINT "user_credential_token_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_credential_token" ADD CONSTRAINT "user_credential_token_user_id_fkey"
  FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_credential_token" ADD CONSTRAINT "user_credential_token_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. RLS and grants — a new table inherits neither (§7A rule 2)
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_quote" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_quote"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE "user_credential_token" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_credential_token"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Phase 3 narrows agent_quote for agent sessions. Until an agent can log in at
-- all, tenant isolation is the entire boundary and only staff are behind it.
GRANT SELECT, INSERT, UPDATE ON TABLE "agent_quote" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "agent_quote_id_seq" TO ff_app;

-- UPDATE is granted because consuming a token means setting used_at. DELETE
-- never is: a spent token stays as evidence that a link was used, and by whom.
GRANT SELECT, INSERT, UPDATE ON TABLE "user_credential_token" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "user_credential_token_id_seq" TO ff_app;

-- ---------------------------------------------------------------------------
-- 5. Audit
-- ---------------------------------------------------------------------------
-- The Phase 0 DO block ran once, over the tables that existed then. These two
-- are new, so they are attached by hand — and the coverage test in audit.test.ts
-- is what makes forgetting this a failing build rather than a silent gap.
CREATE TRIGGER "agent_quote_audit" AFTER INSERT OR UPDATE ON "agent_quote"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "user_credential_token_audit" AFTER INSERT OR UPDATE ON "user_credential_token"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
