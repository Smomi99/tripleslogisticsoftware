-- Vendor moves from Setting to CRM, and the three parties gain the opening
-- figures the accounts ledger will start from.

-- ---------------------------------------------------------------------------
-- 1. Opening balances
-- ---------------------------------------------------------------------------
-- Signed for customer and vendor: positive is owed to us. The agent keeps two
-- separate columns because that is what the client asked for, and it is the
-- right call — an agent can owe us on one account while we owe them on
-- another, and netting the two loses which is which.
ALTER TABLE "customer" ADD COLUMN "opening_balance" DECIMAL(18,4);
ALTER TABLE "customer" ADD COLUMN "opening_currency_id" BIGINT;

ALTER TABLE "vendor" ADD COLUMN "opening_balance" DECIMAL(18,4);
ALTER TABLE "vendor" ADD COLUMN "opening_currency_id" BIGINT;

ALTER TABLE "agent" ADD COLUMN "we_owe" DECIMAL(18,4);
ALTER TABLE "agent" ADD COLUMN "agent_owe" DECIMAL(18,4);
ALTER TABLE "agent" ADD COLUMN "opening_currency_id" BIGINT;

ALTER TABLE "customer" ADD CONSTRAINT "customer_opening_currency_id_fkey"
  FOREIGN KEY ("opening_currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_opening_currency_id_fkey"
  FOREIGN KEY ("opening_currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent" ADD CONSTRAINT "agent_opening_currency_id_fkey"
  FOREIGN KEY ("opening_currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "customer_opening_currency_id_idx" ON "customer" ("opening_currency_id");
CREATE INDEX "vendor_opening_currency_id_idx"   ON "vendor"   ("opening_currency_id");
CREATE INDEX "agent_opening_currency_id_idx"    ON "agent"    ("opening_currency_id");

-- §4 rule 10: currency is system-capable, so the guard permits a NULL
-- tenant_id parent and rejects one belonging to another workspace.
CREATE TRIGGER customer_opening_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF "opening_currency_id" ON "customer"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'opening_currency_id');
CREATE TRIGGER vendor_opening_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF "opening_currency_id" ON "vendor"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'opening_currency_id');
CREATE TRIGGER agent_opening_currency_id_tenant_guard
  BEFORE INSERT OR UPDATE OF "opening_currency_id" ON "agent"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'opening_currency_id');

-- A figure with no currency cannot be posted to a ledger, so the database
-- refuses the pair rather than trusting every future write path to check.
ALTER TABLE "customer" ADD CONSTRAINT "customer_opening_needs_currency"
  CHECK ("opening_balance" IS NULL OR "opening_currency_id" IS NOT NULL);
ALTER TABLE "vendor" ADD CONSTRAINT "vendor_opening_needs_currency"
  CHECK ("opening_balance" IS NULL OR "opening_currency_id" IS NOT NULL);
ALTER TABLE "agent" ADD CONSTRAINT "agent_opening_needs_currency"
  CHECK (("we_owe" IS NULL AND "agent_owe" IS NULL) OR "opening_currency_id" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2. Vendor moves to CRM
-- ---------------------------------------------------------------------------
-- Renamed IN PLACE. The seed upserts permissions by key, so writing the new key
-- without this would create fresh rows and orphan the old ones — and every
-- role_permission and user_permission grant points at permission.id. Six role
-- grants and one user grant exist on these today; recreating the rows would
-- strip them silently, which is the worst way to lose an access rule.
UPDATE "permission"
   SET "module"  = 'CRM',
       "feature" = 'CRM.VENDOR',
       "key"     = replace("key", 'SETTING.VENDOR.', 'CRM.VENDOR.')
 WHERE "feature" = 'SETTING.VENDOR';
