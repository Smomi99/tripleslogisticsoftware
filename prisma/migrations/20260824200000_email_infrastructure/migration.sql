-- Email becomes infrastructure rather than a side effect (module spec §2.3).
--
-- Mail already goes out — an inquiry notifies its agents, a quote notifies the
-- price team — but it goes out inside the request that caused it, with no
-- record kept and no second attempt. Three things are wrong with that, and the
-- quotation PDF in Phase J makes all three serious:
--
--   * a slow SMTP server delays Save & Send, and a hung one times it out
--   * a transient failure loses the message permanently
--   * nobody can answer "did the customer actually get it?"
--
-- So: every message becomes a row first and a send second. The row IS the
-- queue — the columns the spec asks for (status, attempts, error, sent_at) are
-- a queue row already — which is why this uses Postgres rather than adding
-- Redis and BullMQ to a deployment two people maintain. FOR UPDATE SKIP LOCKED
-- is a well-worn pattern at a volume of a few messages per inquiry.

CREATE TYPE "email_status" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- ---------------------------------------------------------------------------
-- 1. email_template — what a message says
-- ---------------------------------------------------------------------------
-- System-capable (§7A rule 7). The defaults are shipped with tenant_id NULL and
-- every workspace gets them; a tenant that wants its own wording writes a row
-- with the same key and its own tenant_id, which wins. That is how the spec's
-- "stored as editable tenant text, not hardcoded" is met without every tenant
-- starting from a blank page.
CREATE TABLE "email_template" (
  "tenant_id"  BIGINT,
  "id"         BIGSERIAL NOT NULL,
  "code"       VARCHAR(32) NOT NULL,
  -- What the code asks for: INQUIRY_AGENT_RFQ, INQUIRY_PRICE_TEAM, …
  "key"        VARCHAR(64) NOT NULL,
  "name"       VARCHAR(200) NOT NULL,
  "subject"    TEXT NOT NULL,
  -- Text is required and HTML is not. Every message has to be readable on the
  -- mail clients agents in Chattogram actually use, and a text part is the only
  -- thing that is universally true. HTML rides along when there is one.
  "body_text"  TEXT NOT NULL,
  "body_html"  TEXT,
  -- The placeholders this template accepts, for the editor screen to list and
  -- for a test to assert against. Documentation with teeth.
  "variables"  JSONB NOT NULL DEFAULT '[]'::jsonb,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" BIGINT,
  "updated_by" BIGINT,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "email_template_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "email_template" ADD CONSTRAINT "email_template_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_template" ADD CONSTRAINT "email_template_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_template" ADD CONSTRAINT "email_template_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "email_template_tenant_id_id_key" ON "email_template" ("tenant_id", "id");
CREATE UNIQUE INDEX "email_template_tenant_id_code_key" ON "email_template" ("tenant_id", "code");
-- One live template per key per workspace, and one system default per key.
CREATE UNIQUE INDEX "email_template_tenant_key_live"
  ON "email_template" ("tenant_id", "key") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "email_template_system_key_live"
  ON "email_template" ("key") WHERE "tenant_id" IS NULL AND "deleted_at" IS NULL;
CREATE INDEX "email_template_tenant_id_idx" ON "email_template" ("tenant_id");

-- ---------------------------------------------------------------------------
-- 2. email_log — what was actually sent, and the queue it waited in
-- ---------------------------------------------------------------------------
-- No `code` column, following audit_log: this is a record of events, addressed
-- by what it relates to rather than by a business reference anybody types.
CREATE TABLE "email_log" (
  "tenant_id"       BIGINT NOT NULL,
  "id"              BIGSERIAL NOT NULL,
  "template_key"    VARCHAR(64) NOT NULL,
  "to_addresses"    TEXT[] NOT NULL,
  "cc_addresses"    TEXT[] NOT NULL DEFAULT '{}',
  -- Rendered at queue time, not send time. What went out must be exactly what
  -- the record shows, even if somebody edits the template an hour later.
  "subject"         TEXT NOT NULL,
  "body_text"       TEXT NOT NULL,
  "body_html"       TEXT,
  -- What this message is about, so a screen can show "3 emails" on an inquiry.
  -- Deliberately not a foreign key: it points at whichever table the message
  -- concerns, and a message about a deleted draft should not block the delete.
  "related_type"    VARCHAR(64),
  "related_id"      BIGINT,
  "status"          "email_status" NOT NULL DEFAULT 'QUEUED',
  "error"           TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "max_attempts"    INTEGER NOT NULL DEFAULT 5,
  -- Backoff. A message is invisible to the worker until this passes.
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Held while a worker has it in flight. A lock older than the stale window is
  -- reclaimed, so a worker killed mid-send loses the message for minutes rather
  -- than for ever.
  "locked_at"       TIMESTAMPTZ(6),
  "sent_at"         TIMESTAMPTZ(6),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"      BIGINT,
  "updated_by"      BIGINT,
  "deleted_at"      TIMESTAMPTZ(6),
  CONSTRAINT "email_log_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_log_has_recipients" CHECK (array_length("to_addresses", 1) > 0),
  CONSTRAINT "email_log_attempts_sane" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts" + 1),
  -- A message cannot claim to have been sent without a time, or carry one
  -- without having been.
  CONSTRAINT "email_log_sent_has_time"
    CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL))
);

ALTER TABLE "email_log" ADD CONSTRAINT "email_log_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "email_log_tenant_id_id_key" ON "email_log" ("tenant_id", "id");
CREATE INDEX "email_log_tenant_id_idx" ON "email_log" ("tenant_id");
-- The worker's own index: the only query it runs.
CREATE INDEX "email_log_pending_idx"
  ON "email_log" ("next_attempt_at")
  WHERE "status" = 'QUEUED' AND "deleted_at" IS NULL;
-- "What was sent about this inquiry?"
CREATE INDEX "email_log_related_idx" ON "email_log" ("tenant_id", "related_type", "related_id");

-- ---------------------------------------------------------------------------
-- 3. RLS and grants
-- ---------------------------------------------------------------------------
ALTER TABLE "email_template" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_template"
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "email_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "email_log"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

-- No agent policy on either. An agent receives mail; they have no business
-- reading the workspace's outbox, which names customers and carries prices.

GRANT SELECT, INSERT, UPDATE ON TABLE "email_template" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "email_template_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "email_log" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "email_log_id_seq" TO ff_app;
-- UPDATE is kept here on purpose, unlike audit_log: the worker has to record
-- what happened to a message it has already queued. DELETE was never granted by
-- the default privileges, and is not granted now — a message that went to a
-- customer is not something the application gets to un-send.

CREATE TRIGGER "email_template_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "email_template"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "email_log_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "email_log"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- ---------------------------------------------------------------------------
-- 4. Claiming work, across every tenant at once
-- ---------------------------------------------------------------------------
-- The worker runs on a timer, not on a request. It has no session, so
-- app_current_tenant() is NULL for it and row level security hides every row in
-- every workspace — correctly, since that is exactly what it is there to do.
--
-- SECURITY DEFINER is the narrow way through, and the same one app_resolve_tenant
-- already uses to find a workspace before anyone is authenticated. This function
-- does one thing: take the next few messages that are due, mark them in flight,
-- and hand them back. It cannot read a message it is not claiming, cannot alter
-- a body, and cannot be asked for a particular tenant's mail.
--
-- FOR UPDATE SKIP LOCKED is what makes two API containers safe to run at once:
-- each takes rows the other has not.
CREATE OR REPLACE FUNCTION app_claim_email_batch(batch_size INT, stale_after INTERVAL)
RETURNS TABLE (
  id BIGINT,
  tenant_id BIGINT,
  template_key VARCHAR(64),
  to_addresses TEXT[],
  cc_addresses TEXT[],
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attempts INT,
  max_attempts INT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE "email_log" e
     SET "locked_at" = now(),
         "attempts" = e."attempts" + 1,
         "updated_at" = now()
   WHERE e."id" IN (
     SELECT c."id"
       FROM "email_log" c
      WHERE c."status" = 'QUEUED'
        AND c."deleted_at" IS NULL
        AND c."next_attempt_at" <= now()
        AND (c."locked_at" IS NULL OR c."locked_at" < now() - stale_after)
      ORDER BY c."id"
        FOR UPDATE SKIP LOCKED
      LIMIT batch_size
   )
  RETURNING e."id", e."tenant_id", e."template_key", e."to_addresses", e."cc_addresses",
            e."subject", e."body_text", e."body_html", e."attempts", e."max_attempts";
$$;

REVOKE ALL ON FUNCTION app_claim_email_batch(INT, INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_email_batch(INT, INTERVAL) TO ff_app;
