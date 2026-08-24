-- TOS and Mode exchange names.
--
-- The module spec (§3) makes TOS the Incoterms. The database already holds the
-- Incoterms — under `mode` — and holds the CY/CY family under `tos`. The values
-- are right and the labels are wrong, so this migration renames and moves
-- nothing: no UPDATE runs against any business table, every row keeps its id,
-- and every foreign key keeps pointing at the row it already pointed at.
--
-- The three inquiries carrying a TOS value carry CFS/CY, CFS/CFS and CY/CFS.
-- Those are Mode values under the new definitions, and after this they are
-- filed as such — which is what the operator picked, under the name the client
-- now uses for it.

-- ---------------------------------------------------------------------------
-- Pass 1 — park the CY/CY table out of the way
-- ---------------------------------------------------------------------------
ALTER TABLE "tos" RENAME TO "swap_tmp";
ALTER SEQUENCE "tos_id_seq" RENAME TO "swap_tmp_id_seq";
ALTER TABLE "swap_tmp" RENAME CONSTRAINT "tos_pkey"            TO "swap_tmp_pkey";
ALTER TABLE "swap_tmp" RENAME CONSTRAINT "tos_tenant_id_fkey"  TO "swap_tmp_tenant_id_fkey";
ALTER TABLE "swap_tmp" RENAME CONSTRAINT "tos_created_by_fkey" TO "swap_tmp_created_by_fkey";
ALTER TABLE "swap_tmp" RENAME CONSTRAINT "tos_updated_by_fkey" TO "swap_tmp_updated_by_fkey";
ALTER INDEX "tos_code_system_key"    RENAME TO "swap_tmp_code_system_key";
ALTER INDEX "tos_tenant_id_code_key" RENAME TO "swap_tmp_tenant_id_code_key";
ALTER INDEX "tos_tenant_id_idx"      RENAME TO "swap_tmp_tenant_id_idx";
-- audit.test.ts asserts a trigger named <table>_audit on every tenant table,
-- so these renames are load-bearing rather than cosmetic.
ALTER TRIGGER "tos_audit" ON "swap_tmp" RENAME TO "swap_tmp_audit";

-- ---------------------------------------------------------------------------
-- Pass 2 — the Incoterms become TOS
-- ---------------------------------------------------------------------------
ALTER TABLE "mode" RENAME TO "tos";
ALTER SEQUENCE "mode_id_seq" RENAME TO "tos_id_seq";
ALTER TABLE "tos" RENAME CONSTRAINT "mode_pkey"            TO "tos_pkey";
ALTER TABLE "tos" RENAME CONSTRAINT "mode_tenant_id_fkey"  TO "tos_tenant_id_fkey";
ALTER TABLE "tos" RENAME CONSTRAINT "mode_created_by_fkey" TO "tos_created_by_fkey";
ALTER TABLE "tos" RENAME CONSTRAINT "mode_updated_by_fkey" TO "tos_updated_by_fkey";
ALTER INDEX "mode_code_system_key"    RENAME TO "tos_code_system_key";
ALTER INDEX "mode_tenant_id_code_key" RENAME TO "tos_tenant_id_code_key";
ALTER INDEX "mode_tenant_id_idx"      RENAME TO "tos_tenant_id_idx";
ALTER TRIGGER "mode_audit" ON "tos" RENAME TO "tos_audit";

-- ---------------------------------------------------------------------------
-- Pass 3 — the CY/CY family becomes Mode
-- ---------------------------------------------------------------------------
ALTER TABLE "swap_tmp" RENAME TO "mode";
ALTER SEQUENCE "swap_tmp_id_seq" RENAME TO "mode_id_seq";
ALTER TABLE "mode" RENAME CONSTRAINT "swap_tmp_pkey"            TO "mode_pkey";
ALTER TABLE "mode" RENAME CONSTRAINT "swap_tmp_tenant_id_fkey"  TO "mode_tenant_id_fkey";
ALTER TABLE "mode" RENAME CONSTRAINT "swap_tmp_created_by_fkey" TO "mode_created_by_fkey";
ALTER TABLE "mode" RENAME CONSTRAINT "swap_tmp_updated_by_fkey" TO "mode_updated_by_fkey";
ALTER INDEX "swap_tmp_code_system_key"    RENAME TO "mode_code_system_key";
ALTER INDEX "swap_tmp_tenant_id_code_key" RENAME TO "mode_tenant_id_code_key";
ALTER INDEX "swap_tmp_tenant_id_idx"      RENAME TO "mode_tenant_id_idx";
ALTER TRIGGER "swap_tmp_audit" ON "mode" RENAME TO "mode_audit";

-- ---------------------------------------------------------------------------
-- Pass 4 — the two inquiry columns exchange names with them
-- ---------------------------------------------------------------------------
-- The foreign keys are NOT dropped. Postgres resolves them by object identity,
-- so each one already points at the table it should; only the labels move.
ALTER TABLE "inquiry" RENAME COLUMN "tos_id" TO "swap_tmp_id";
ALTER TABLE "inquiry" RENAME CONSTRAINT "inquiry_tos_id_fkey" TO "inquiry_swap_tmp_id_fkey";

ALTER TABLE "inquiry" RENAME COLUMN "mode_id" TO "tos_id";
ALTER TABLE "inquiry" RENAME CONSTRAINT "inquiry_mode_id_fkey" TO "inquiry_tos_id_fkey";

ALTER TABLE "inquiry" RENAME COLUMN "swap_tmp_id" TO "mode_id";
ALTER TABLE "inquiry" RENAME CONSTRAINT "inquiry_swap_tmp_id_fkey" TO "inquiry_mode_id_fkey";

-- The same-tenant guards are dropped and recreated rather than renamed: their
-- arguments name the parent table and column, and ALTER TRIGGER … RENAME
-- changes the label without touching what the trigger was created with. A
-- renamed guard would assert against the wrong list and fail closed on the
-- first save.
DROP TRIGGER "inquiry_tos_id_tenant_guard" ON "inquiry";
DROP TRIGGER "inquiry_mode_id_tenant_guard" ON "inquiry";
CREATE TRIGGER "inquiry_tos_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "inquiry"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('tos', 'tos_id');
CREATE TRIGGER "inquiry_mode_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "inquiry"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('mode', 'mode_id');

-- ---------------------------------------------------------------------------
-- Pass 5 — the agent view
-- ---------------------------------------------------------------------------
-- agent_inquiry_v selects both columns. RENAME COLUMN rewrites a dependent
-- view's internal reference but keeps its OUTPUT column name, so the view would
-- go on publishing the old names against the new meanings — silent, and visible
-- only as a wrong label on an agent's screen. This is the third time that trap
-- has been sprung in this schema; see the note in 20260824180000.
--
-- security_invoker stays load-bearing: without it the view runs as its owner,
-- who bypasses RLS, and hands every agent every inquiry in the workspace.
DROP VIEW "agent_inquiry_v";

CREATE VIEW "agent_inquiry_v" WITH (security_invoker = true) AS
  SELECT
    i.id, i.tenant_id, i.code, i.series_year, i.inquiry_date,
    i.shipment_type, i.movement_type, i.loading_type,
    i.pol_id, i.pod_id, i.place_of_receipt,
    i.commodity_item_id, i.hs_code,
    i.tos_id, i.mode_id,
    i.expected_shipment_date, i.valid_to,
    -- remarks is NOT here. 20260823140000 took it out: it is free text the
    -- forwarder's own staff type, and it was the one field through which a
    -- customer's name could still reach an agent. Recreating this view from the
    -- Phase 3 definition would quietly put it back, which is what
    -- agent-rls.test.ts caught.
    i.status, i.created_at
  FROM "inquiry" i
  WHERE i.deleted_at IS NULL
    AND i.tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "inquiry_party" ip
      WHERE ip.inquiry_id = i.id
        AND ip.tenant_id = i.tenant_id
        AND ip.agent_id = app_current_agent()
    );

-- Omitted on purpose, unchanged from before: customer_id, currency_id,
-- salesman_id, source_id, notify_emails, created_by, updated_by.
GRANT SELECT ON "agent_inquiry_v" TO ff_app;
-- ALTER DEFAULT PRIVILEGES covers views, so a freshly created view arrives
-- writable and the read-only REVOKE from 20260823150000 has to be restated.
REVOKE INSERT, UPDATE, DELETE ON "agent_inquiry_v" FROM ff_app;
