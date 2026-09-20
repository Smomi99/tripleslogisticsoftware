-- ===========================================================================
-- The outbox worker reads the attachment list too
-- ===========================================================================
--
-- app_claim_email_batch declares an explicit TABLE(...) return type, so the
-- column added by 20260920130000 does not reach the worker on its own — and a
-- letter whose attachment silently never travels is the worst kind of bug,
-- because the outbox says it sent.
--
-- CREATE OR REPLACE cannot widen a return type, so this drops and recreates.
-- The body is unchanged apart from the one extra column in RETURNING.
-- ===========================================================================

DROP FUNCTION IF EXISTS app_claim_email_batch(integer, interval);

CREATE FUNCTION app_claim_email_batch(batch_size integer, stale_after interval)
  RETURNS TABLE (
    id bigint,
    tenant_id bigint,
    template_key character varying,
    to_addresses text[],
    cc_addresses text[],
    bcc_addresses text[],
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
            e."bcc_addresses", e."subject", e."body_text", e."body_html",
            e."attachments", e."attempts", e."max_attempts";
$$;

GRANT EXECUTE ON FUNCTION app_claim_email_batch(integer, interval) TO ff_app;
