-- CR-003: customising a shared master row.
--
-- §7A rule 7 lets a workspace deactivate a shared row but never edit or delete
-- it — correct, since the row belongs to every workspace on the server. That
-- left no way to correct a name, or to set a currency conversion, which is a
-- per-company commercial figure the shared row cannot carry.
--
-- Customise copies the shared row into a tenant-owned one and hides the
-- original for that workspace. This column records the link, which is what
-- separates "I hid this" from "I replaced this" — both set is_active = false.
--
-- Deliberately NOT a foreign key: the target row lives in whichever table
-- `table_name` names, so no single reference can express it. The application
-- writes it in the same transaction as the copy.

ALTER TABLE "tenant_master_override" ADD COLUMN "replaced_by" BIGINT;

COMMENT ON COLUMN "tenant_master_override"."replaced_by" IS
  'Tenant-owned row that replaced the shared one; see CR-003. Always set with is_active = false.';
