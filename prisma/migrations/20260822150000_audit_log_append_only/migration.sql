-- Phase 0 of the agent portal: make audit_log usable and append-only.
--
-- The table has existed since Phase 1 and has never been written to. Before it
-- carries anything an investigation would rely on, three things have to change.

-- ---------------------------------------------------------------------------
-- 1. Append-only from the application's point of view
-- ---------------------------------------------------------------------------
-- An audit trail the application can rewrite is not an audit trail. The blanket
-- grant in the Phase 2 RLS migration gave ff_app UPDATE on every table, this one
-- included. DELETE was never granted; UPDATE is withdrawn here.
--
-- ff_app keeps INSERT (to record) and SELECT (so a workspace can read its own
-- history). Nothing the API can do rewrites or removes a recorded event.
REVOKE UPDATE ON TABLE "audit_log" FROM ff_app;

-- Future tables must not silently regain it through ALTER DEFAULT PRIVILEGES.
-- (The default grant is re-stated per table in each migration, so this is a
-- note rather than a mechanism; the test in audit.test.ts is the guard.)

-- ---------------------------------------------------------------------------
-- 2. Events that are not about a row
-- ---------------------------------------------------------------------------
-- A failed login for a username that does not exist has no record to point at.
-- Recording it is the whole point — that is what credential stuffing looks like.
ALTER TABLE "audit_log" ALTER COLUMN "record_id" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Actions beyond data changes
-- ---------------------------------------------------------------------------
-- The enum was written for create/update/deactivate. An audit trail that has to
-- answer "who saw this" and "who tried to sign in" needs more verbs.
--
-- Added in their own migration because a value added by ALTER TYPE cannot be
-- USED in the same transaction that adds it, and Prisma runs each migration
-- file in one. The triggers that use them are the next migration.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'DELETE';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'LOGIN_SUCCESS';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'LOGIN_FAILURE';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'LOGOUT';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'VIEW';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'INVITE_ISSUED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'INVITE_ACCEPTED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_COMPLETED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'QUOTE_SUBMITTED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'QUOTE_AMENDED';
