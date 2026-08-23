-- An agent account becomes an ordinary user of the workspace.
--
-- The first design gave each contact at an agent their own invited login, on a
-- separate portal. The client does not want that: one username and password per
-- agent COMPANY, shared by its contacts, created on the same Add User screen as
-- an employee, and granted a role like anyone else. Agents are simply the first
-- user type that is not staff — customer and vendor will follow the same shape.

-- ---------------------------------------------------------------------------
-- 1. An agent user may now hold a role
-- ---------------------------------------------------------------------------
-- The original CHECK forbade role_id outright, because an agent had no §7
-- permissions at all — what they could reach was decided entirely by which
-- router they hit. Now the role IS how Agent Inquiry is granted, so the ban
-- moves off role_id.
--
-- The two denials that matter are untouched, and they are the ones that make an
-- agent-who-is-also-staff unrepresentable: no employee record, and never
-- superadmin. A role can only carry the permissions someone ticked; superadmin
-- bypasses the check entirely (§7 rule 1), which is exactly why an outsider
-- must never hold it.
ALTER TABLE "user" DROP CONSTRAINT "user_agent_is_external";
ALTER TABLE "user" ADD CONSTRAINT "user_agent_is_external" CHECK (
  "agent_id" IS NULL
  OR ("employee_id" IS NULL AND "is_superadmin" = false)
);

-- ---------------------------------------------------------------------------
-- 2. One login per agent company
-- ---------------------------------------------------------------------------
-- The client's rule, and now a fact about the database rather than a promise
-- the Add User screen makes. Partial, so soft-deleted accounts do not block a
-- replacement being created for the same agent.
CREATE UNIQUE INDEX "user_one_login_per_agent"
  ON "user" ("tenant_id", "agent_id")
  WHERE "agent_id" IS NOT NULL AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 3. The invite flow is gone
-- ---------------------------------------------------------------------------
-- Nothing sets a password by emailed link any more: the superadmin types it on
-- Add User, the same as for an employee, which is the right shape for a
-- credential several people share — no single contact can own it.
--
-- Dropped rather than left dormant. A table whose only purpose is minting
-- credentials, kept alive with no code path and no test covering it, is the
-- kind of thing that gets re-enabled by accident years later.
DROP TABLE IF EXISTS "user_credential_token";
DROP TYPE IF EXISTS "credential_token_purpose";
