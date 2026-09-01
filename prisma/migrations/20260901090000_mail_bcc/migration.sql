-- A standing BCC on every outgoing message.
--
-- Asked for by the client on 2026-09-01, for two reasons they gave together:
-- so somebody can see that a message actually left, and so the pricing team is
-- copied on every rate request and can follow the carrier or agent up without
-- being told to.
--
-- Two columns and a function signature:
--
--   notification_setting.bcc_addresses  the standing list, per workspace. Here
--                                       rather than in an env var because it is
--                                       a company's own address book, and the
--                                       next workspace on this server has a
--                                       different one.
--   email_log.bcc_addresses             who it actually went to. The outbox is
--                                       the record of what was sent, and a
--                                       blind copy that is invisible in the
--                                       record is no evidence of anything.
--
-- Additive, and nullable/defaulted throughout: every row already in production
-- satisfies this the moment it runs.
ALTER TABLE "notification_setting" ADD COLUMN "bcc_addresses" TEXT;
ALTER TABLE "email_log" ADD COLUMN "bcc_addresses" TEXT[] NOT NULL DEFAULT '{}';

-- The worker reads its batch through this SECURITY DEFINER function — it has no
-- session, so row level security hides every row from it, correctly. It now has
-- to hand back the blind copies too.
--
-- Dropped and recreated rather than replaced: CREATE OR REPLACE cannot change a
-- function's return type. Both statements are in this migration's transaction,
-- so there is no moment where the function is missing; a claim attempted during
-- it blocks and then succeeds, and a claim that did fail would simply retry on
-- the next tick.
DROP FUNCTION IF EXISTS app_claim_email_batch(INT, INTERVAL);

CREATE FUNCTION app_claim_email_batch(batch_size INT, stale_after INTERVAL)
RETURNS TABLE (
  id BIGINT,
  tenant_id BIGINT,
  template_key VARCHAR(64),
  to_addresses TEXT[],
  cc_addresses TEXT[],
  bcc_addresses TEXT[],
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
            e."bcc_addresses", e."subject", e."body_text", e."body_html",
            e."attempts", e."max_attempts";
$$;

-- The grants go with the function, which the DROP took away.
REVOKE ALL ON FUNCTION app_claim_email_batch(INT, INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_email_batch(INT, INTERVAL) TO ff_app;
