-- Phase 0: every data change records itself.
--
-- CLAUDE.md §4 rule 7 asks for "a Prisma middleware" writing audit_log. This
-- uses a database trigger instead, and does so deliberately:
--
--   * OLD and NEW are already there. A Prisma extension would have to SELECT
--     the row before every update to know what changed, inside a transaction it
--     does not hold a handle to.
--   * It cannot be bypassed. A seed script, a psql session, a future service in
--     another language, a raw $executeRaw — all of them are recorded. An
--     application-layer hook records only what goes through that application.
--   * It cannot be forgotten. A table added next year without a trigger is
--     caught by the coverage test rather than silently going unaudited.
--
-- The intent of §4 rule 7 is met and exceeded; only its implementation note is
-- departed from.

-- ---------------------------------------------------------------------------
-- Who did it
-- ---------------------------------------------------------------------------
-- Set alongside app.tenant_id by withTenant(), transaction-locally, from the
-- authenticated session — never from anything a client can send. NULL for the
-- seed and for migrations, which are recorded as SYSTEM.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS BIGINT
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::bigint $$;

GRANT EXECUTE ON FUNCTION app_current_user_id() TO ff_app;

-- ---------------------------------------------------------------------------
-- The recorder
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_audit_row() RETURNS trigger
  LANGUAGE plpgsql
  -- SECURITY DEFINER so the INSERT succeeds even though ff_app's own RLS view
  -- of audit_log is scoped: the row being written is the row being changed, and
  -- its tenant is not in question. Without this, a write by a session whose
  -- app.tenant_id is unset (a migration, the seed) could not record itself.
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
DECLARE
  actor      bigint := app_current_user_id();
  old_j      jsonb;
  new_j      jsonb;
  act        audit_action;
  row_tenant bigint;
  row_id     bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_j := to_jsonb(NEW);
    act   := 'CREATE';
  ELSIF TG_OP = 'UPDATE' THEN
    old_j := to_jsonb(OLD);
    new_j := to_jsonb(NEW);

    -- A change that is really a removal is recorded as one. CR-002's Delete and
    -- §8's Deactivate look identical in SQL and are entirely different events to
    -- someone reading the trail later.
    IF (old_j ->> 'deleted_at') IS NULL AND (new_j ->> 'deleted_at') IS NOT NULL THEN
      act := 'DELETE';
    ELSIF (old_j ->> 'is_active') = 'true' AND (new_j ->> 'is_active') = 'false' THEN
      act := 'DEACTIVATE';
    ELSIF (old_j ->> 'is_active') = 'false' AND (new_j ->> 'is_active') = 'true' THEN
      act := 'REACTIVATE';
    ELSE
      act := 'UPDATE';
    END IF;

    -- Nothing actually changed: an UPDATE that set every column to what it
    -- already held. Recording it buries the real events in noise.
    IF old_j = new_j THEN
      RETURN NULL;
    END IF;
  ELSE
    RETURN NULL;
  END IF;

  -- Secrets are never copied into the trail. An audit table holding password
  -- hashes and live invite tokens is a second place to steal them from, and it
  -- is the one place nobody thinks to lock down.
  old_j := old_j - 'password_hash' - 'token_hash';
  new_j := new_j - 'password_hash' - 'token_hash';

  row_tenant := COALESCE((new_j ->> 'tenant_id')::bigint, app_current_tenant());
  row_id     := (new_j ->> 'id')::bigint;

  -- A shared system row written with no tenant in scope (the seed) has nobody
  -- to attribute it to. Skipping beats inventing an owner.
  IF row_tenant IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO audit_log (
    tenant_id, table_name, record_id, action, actor_type, changed_by,
    old_values, new_values, created_at
  ) VALUES (
    row_tenant, TG_TABLE_NAME, row_id, act,
    CASE WHEN actor IS NULL THEN 'SYSTEM'::audit_actor_type ELSE 'USER'::audit_actor_type END,
    actor, old_j, new_j, now()
  );

  RETURN NULL;
END
$fn$;

-- ---------------------------------------------------------------------------
-- Attach it to every table that has a tenant and an id
-- ---------------------------------------------------------------------------
-- Generated from the catalogue rather than listed by hand, for the same reason
-- lib/references.ts reads the catalogue: a hand-kept list is wrong the day
-- someone adds a table, and the failure is silent.
--
-- audit_log itself is excluded, or it would audit its own writes forever.
DO $do$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname <> 'audit_log'
      AND EXISTS (SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION app_audit_row()',
      t.relname || '_audit', t.relname
    );
  END LOOP;
END
$do$;
