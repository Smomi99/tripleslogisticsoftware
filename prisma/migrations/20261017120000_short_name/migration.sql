-- ===========================================================================
-- CRM / SETTING — a short name for agents, carriers and vendors
-- ===========================================================================
--
-- The client asked for a Short name beside the name on the Agent, Carrier and
-- Vendor forms (2026-10-17; not in §5/§6). The rate screens' Purchase via
-- column shows it, with the full name on hover. Optional: a party without one
-- is shown by its full name, as before.
--
--   agent     + short_name   VARCHAR(50), nullable
--   carrier   + short_name   VARCHAR(50), nullable
--   vendor    + short_name   VARCHAR(50), nullable
--
-- No existing row changes. A shared carrier (tenant_id NULL) keeps no short
-- name; a workspace sets one on its own copy, made with Customise (CR-003).

ALTER TABLE "agent" ADD COLUMN "short_name" VARCHAR(50);
ALTER TABLE "carrier" ADD COLUMN "short_name" VARCHAR(50);
ALTER TABLE "vendor" ADD COLUMN "short_name" VARCHAR(50);
