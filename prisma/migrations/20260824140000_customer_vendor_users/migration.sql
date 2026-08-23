-- Customer and vendor logins, on the same shape as agent.
--
-- The client asked for these on Add User "as employee, nothing more": no
-- screens, no dashboard, no permissions of their own yet. The account exists
-- and links to the company; what it can reach comes later, when there is
-- something for it to reach.
--
-- The safety work is not optional even so. Until now the session gate read
-- "has an agent_id" as "is not staff", and everything else as staff — so a
-- customer login added without extending that rule would BE a staff account.

ALTER TABLE "user" ADD COLUMN "customer_id" BIGINT;
ALTER TABLE "user" ADD COLUMN "vendor_id" BIGINT;

-- §4 rule 10: both parents are tenant-owned, so the keys are composite. A user
-- in one workspace cannot be attached to another workspace's customer.
ALTER TABLE "user" ADD CONSTRAINT "user_customer_id_fkey"
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user" ADD CONSTRAINT "user_vendor_id_fkey"
  FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "vendor"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "user_customer_id_idx" ON "user" ("customer_id");
CREATE INDEX "user_vendor_id_idx" ON "user" ("vendor_id");

-- ---------------------------------------------------------------------------
-- One external link, and an external account is never staff
-- ---------------------------------------------------------------------------
-- Replaces user_agent_is_external, which knew only about agents. Two rules,
-- both unrepresentable rather than merely disallowed:
--
--   * at most ONE of the three external links is set. A login that is both a
--     customer and a vendor has no answer to "whose data is this?", and the
--     row-level security that will eventually scope these needs one answer.
--   * an external account carries no employee record and is never superadmin.
--     Superadmin bypasses §7 entirely, which is exactly why an outsider must
--     never hold it.
ALTER TABLE "user" DROP CONSTRAINT "user_agent_is_external";
ALTER TABLE "user" ADD CONSTRAINT "user_external_is_not_staff" CHECK (
  (
    (CASE WHEN "agent_id"    IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "customer_id" IS NULL THEN 0 ELSE 1 END)
  + (CASE WHEN "vendor_id"   IS NULL THEN 0 ELSE 1 END)
  ) <= 1
  AND (
    ("agent_id" IS NULL AND "customer_id" IS NULL AND "vendor_id" IS NULL)
    OR ("employee_id" IS NULL AND "is_superadmin" = false)
  )
);

-- One login per company, the same rule agents already follow. Partial, so a
-- soft-deleted account does not block its replacement.
CREATE UNIQUE INDEX "user_one_login_per_customer"
  ON "user" ("tenant_id", "customer_id")
  WHERE "customer_id" IS NOT NULL AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX "user_one_login_per_vendor"
  ON "user" ("tenant_id", "vendor_id")
  WHERE "vendor_id" IS NOT NULL AND "deleted_at" IS NULL;
