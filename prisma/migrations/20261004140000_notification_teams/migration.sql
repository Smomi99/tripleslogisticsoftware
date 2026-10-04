-- ===========================================================================
-- NOTIFICATION TEAMS — docs/DESIGN-UPDATE-2026-10-04.md §7
-- ===========================================================================
--
-- The client's Notification sheet gives each of five teams (Price, CS & Doc,
-- Ops, Accounts, Sales) its own sender, reply-to and signature.
--
--   notification_team_setting       one row per team per workspace
--   notification_setting.send_as_team
--                                   whether the workspace's mail server may
--                                   send as those addresses; off by default
--   email_log.from_address/from_name
--                                   the From a message went with, recorded
--                                   like Reply-To and BCC already are
--
-- Additive and defaulted: every existing row satisfies it, and every
-- existing message keeps going out exactly as before until a team is filled
-- in. app_claim_email_batch is recreated with the two new columns, as
-- 20260929100000_email_reply_to did for Reply-To.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "notification_team" AS ENUM ('PRICE', 'CS_DOC', 'OPS', 'ACCOUNTS', 'SALES');

-- AlterTable
ALTER TABLE "email_log" ADD COLUMN     "from_address" VARCHAR(320),
ADD COLUMN     "from_name" VARCHAR(200);

-- AlterTable
ALTER TABLE "notification_setting" ADD COLUMN     "send_as_team" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "notification_team_setting" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "team" "notification_team" NOT NULL,
    "sender_email" VARCHAR(320),
    "reply_to" VARCHAR(320),
    "signature" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_team_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_team_setting_tenant_id_idx" ON "notification_team_setting"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_team_setting_tenant_id_team_key" ON "notification_team_setting"("tenant_id", "team");

-- CreateIndex
CREATE UNIQUE INDEX "notification_team_setting_tenant_id_id_key" ON "notification_team_setting"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "notification_team_setting" ADD CONSTRAINT "notification_team_setting_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_team_setting" ADD CONSTRAINT "notification_team_setting_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_team_setting" ADD CONSTRAINT "notification_team_setting_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A blank field is NULL, never ''.
ALTER TABLE "notification_team_setting" ADD CONSTRAINT "notification_team_setting_not_blank"
  CHECK (
    ("sender_email" IS NULL OR length(btrim("sender_email")) > 0)
    AND ("reply_to" IS NULL OR length(btrim("reply_to")) > 0)
    AND ("signature" IS NULL OR length(btrim("signature")) > 0)
  );

-- ------------------------------------------------------------------ tenancy
ALTER TABLE "notification_team_setting" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_team_setting"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

GRANT SELECT, INSERT, UPDATE ON TABLE "notification_team_setting" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "notification_team_setting_id_seq" TO ff_app;

CREATE TRIGGER "notification_team_setting_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "notification_team_setting"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- ------------------------------------------------------------ the worker
-- The return type is an explicit TABLE(...), so the new columns reach the
-- worker only through a recreated function. The body is unchanged apart from
-- from_address and from_name in the signature and in RETURNING.

DROP FUNCTION IF EXISTS app_claim_email_batch(integer, interval);

CREATE FUNCTION app_claim_email_batch(batch_size integer, stale_after interval)
  RETURNS TABLE (
    id bigint,
    tenant_id bigint,
    template_key character varying,
    to_addresses text[],
    cc_addresses text[],
    bcc_addresses text[],
    reply_to_addresses text[],
    from_address character varying,
    from_name character varying,
    subject text,
    body_text text,
    body_html text,
    attachments jsonb,
    attempts integer,
    max_attempts integer
  )
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path TO 'public'
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
            e."bcc_addresses", e."reply_to_addresses", e."from_address", e."from_name",
            e."subject", e."body_text", e."body_html",
            e."attachments", e."attempts", e."max_attempts";
$$;

GRANT EXECUTE ON FUNCTION app_claim_email_batch(integer, interval) TO ff_app;
