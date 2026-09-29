-- ===========================================================================
-- Reply-To on an outgoing message
-- ===========================================================================
--
-- CRM → Customer → Email prices (2026-09-29). Every letter leaves from the one
-- sending account, and the client wants customers' replies to land with the
-- Price team instead. Reply-To is the standard way to say that without
-- pretending to send from a mailbox the SMTP account cannot sign for.
--
-- email_log.reply_to_addresses records it, for the same reason the blind
-- copies are recorded: the outbox is the evidence of what was sent, and where
-- a reply would go is part of what was sent.
--
-- Additive and defaulted: every row already in production satisfies it the
-- moment it runs, and every existing message keeps replying to the sender.
-- ===========================================================================

ALTER TABLE "email_log" ADD COLUMN "reply_to_addresses" TEXT[] NOT NULL DEFAULT '{}';

-- app_claim_email_batch declares an explicit TABLE(...) return type, so the
-- new column does not reach the worker on its own. CREATE OR REPLACE cannot
-- widen a return type, so this drops and recreates. The body is unchanged
-- apart from the one extra column in the signature and in RETURNING.

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
            e."bcc_addresses", e."reply_to_addresses", e."subject", e."body_text", e."body_html",
            e."attachments", e."attempts", e."max_attempts";
$$;

GRANT EXECUTE ON FUNCTION app_claim_email_batch(integer, interval) TO ff_app;
