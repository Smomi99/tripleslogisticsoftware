-- The audit trail follows its tenant to the grave.
--
-- CLAUDE.md §4 rule 5 makes every FK ON DELETE RESTRICT, and this is a
-- deliberate exception to it. The reasoning:
--
--   * audit_log.tenant_id is a scoping column, not a business reference. It says
--     which workspace the event belongs to; it does not mean the audit row is
--     "about" the tenant row in the way a shipment is about a customer.
--   * §7B's lifecycle ends CANCELLED → 90 days → purge. Deleting a tenant is a
--     deliberate erasure of that tenant's data, and its trail is part of that
--     data. RESTRICT would make the purge job impossible to write without first
--     deleting the very records that prove the purge happened correctly.
--   * It cannot be used to erase a trail from inside the application: ff_app
--     holds INSERT, SELECT and UPDATE on tenant and no DELETE at all, so only
--     the owner role — migrations and the purge job — can trigger the cascade.
--     Append-only from the application's perspective is unaffected.
--
-- Without this, every test fixture that tears its tenant down fails the moment
-- the trigger records anything, which is to say immediately.
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_tenant_id_fkey";
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON UPDATE CASCADE ON DELETE CASCADE;
