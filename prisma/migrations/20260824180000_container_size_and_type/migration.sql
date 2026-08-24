-- Container SIZE and container TYPE become two different things.
--
-- `container_type` has always held 20STD, 40STD, 40HC and 45FT. Those are
-- sizes. The physical type of the box — Dry, Reefer, Flat Rack, Open Top — is a
-- separate axis: a 40HC can be Dry or Reefer, and the price differs enormously.
-- The module spec (§4.1) names the confusion and asks for both.
--
-- So the existing table is renamed to what it actually holds, and the freed
-- name goes to the new one. The alternative — leaving the size table misnamed
-- and calling the new one something else — costs nothing today and confuses
-- every reader of this schema for as long as the product exists.
--
-- Nothing is dropped and no row moves. Every id, every foreign key and every
-- rate that depends on a size survives this migration untouched; only names
-- change. The 12 rate tiers and 7 inquiry volumes pointing at sizes keep
-- pointing at exactly the same rows.

-- ---------------------------------------------------------------------------
-- 1. The table, and everything named after it
-- ---------------------------------------------------------------------------
-- RENAME TO moves the table but leaves its constraints, indexes, sequence and
-- triggers carrying the old name. Postgres does not mind; a person reading
-- `container_size_pkey` where it says `container_type_pkey` does.
ALTER TABLE "container_type" RENAME TO "container_size";

ALTER SEQUENCE "container_type_id_seq" RENAME TO "container_size_id_seq";

ALTER TABLE "container_size" RENAME CONSTRAINT "container_type_pkey" TO "container_size_pkey";
ALTER TABLE "container_size" RENAME CONSTRAINT "container_type_tenant_id_fkey" TO "container_size_tenant_id_fkey";
ALTER TABLE "container_size" RENAME CONSTRAINT "container_type_created_by_fkey" TO "container_size_created_by_fkey";
ALTER TABLE "container_size" RENAME CONSTRAINT "container_type_updated_by_fkey" TO "container_size_updated_by_fkey";

ALTER INDEX "container_type_code_system_key" RENAME TO "container_size_code_system_key";
ALTER INDEX "container_type_tenant_id_code_key" RENAME TO "container_size_tenant_id_code_key";
ALTER INDEX "container_type_tenant_id_id_key" RENAME TO "container_size_tenant_id_id_key";
ALTER INDEX "container_type_tenant_id_idx" RENAME TO "container_size_tenant_id_idx";

-- audit.test.ts asserts a trigger named `<table>_audit` on every tenant table,
-- so this rename is load-bearing rather than cosmetic.
ALTER TRIGGER "container_type_audit" ON "container_size" RENAME TO "container_size_audit";

-- ---------------------------------------------------------------------------
-- 2. The four children that point at a size
-- ---------------------------------------------------------------------------
-- rate_tier, rate_local_charge, inquiry_volume and agent_quote_line all carry
-- `container_type_id` meaning a size. inquiry_volume is about to gain a real
-- container_type_id, so the rename is not optional there — the two would
-- collide.
ALTER TABLE "rate_tier" RENAME COLUMN "container_type_id" TO "container_size_id";
ALTER TABLE "rate_tier" RENAME CONSTRAINT "rate_tier_container_type_id_fkey" TO "rate_tier_container_size_id_fkey";

ALTER TABLE "rate_local_charge" RENAME COLUMN "container_type_id" TO "container_size_id";
ALTER TABLE "rate_local_charge" RENAME CONSTRAINT "rate_local_charge_container_type_id_fkey" TO "rate_local_charge_container_size_id_fkey";
ALTER INDEX "rate_local_charge_container_type_id_idx" RENAME TO "rate_local_charge_container_size_id_idx";

ALTER TABLE "inquiry_volume" RENAME COLUMN "container_type_id" TO "container_size_id";
ALTER TABLE "inquiry_volume" RENAME CONSTRAINT "inquiry_volume_container_type_id_fkey" TO "inquiry_volume_container_size_id_fkey";
-- The free-text note beside it describes the size, not the box type: it is what
-- an operator types when the shipment does not fit a standard row.
ALTER TABLE "inquiry_volume" RENAME COLUMN "container_type_note" TO "container_size_note";

ALTER TABLE "agent_quote_line" RENAME COLUMN "container_type_id" TO "container_size_id";
ALTER TABLE "agent_quote_line" RENAME CONSTRAINT "agent_quote_line_container_type_id_fkey" TO "agent_quote_line_container_size_id_fkey";
ALTER INDEX "agent_quote_line_container_type_id_idx" RENAME TO "agent_quote_line_container_size_id_idx";

-- The same-tenant guards are dropped and recreated rather than renamed: their
-- arguments name the parent table and column, and ALTER TRIGGER … RENAME
-- changes the label without touching what it was created with. A renamed
-- trigger still asserting against a table called `container_type` would fail
-- closed on the first insert — and only in production, where the new
-- container_type exists and holds entirely different rows.
DROP TRIGGER "rate_local_charge_container_type_id_tenant_guard" ON "rate_local_charge";
CREATE TRIGGER "rate_local_charge_container_size_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "rate_local_charge"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_size', 'container_size_id');

DROP TRIGGER "inquiry_volume_container_type_id_tenant_guard" ON "inquiry_volume";
CREATE TRIGGER "inquiry_volume_container_size_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "inquiry_volume"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_size', 'container_size_id');

DROP TRIGGER "agent_quote_line_container_type_id_tenant_guard" ON "agent_quote_line";
CREATE TRIGGER "agent_quote_line_container_size_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "agent_quote_line"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_size', 'container_size_id');

-- rate_tier carries no tenant_id of its own and never had a guard.

-- ---------------------------------------------------------------------------
-- 3. The new container_type — the physical box
-- ---------------------------------------------------------------------------
-- System-capable (§7A rule 7): Dry and Reefer mean the same thing to every
-- forwarder on earth, so the rows are shared and a tenant may add its own.
CREATE TABLE "container_type" (
  "tenant_id"  BIGINT,
  "id"         BIGSERIAL NOT NULL,
  "code"       VARCHAR(32) NOT NULL,
  "name"       VARCHAR(200) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" BIGINT,
  "updated_by" BIGINT,
  "deleted_at" TIMESTAMPTZ(6),
  CONSTRAINT "container_type_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "container_type" ADD CONSTRAINT "container_type_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "container_type" ADD CONSTRAINT "container_type_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "container_type" ADD CONSTRAINT "container_type_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "container_type_tenant_id_id_key" ON "container_type" ("tenant_id", "id");
CREATE UNIQUE INDEX "container_type_tenant_id_code_key" ON "container_type" ("tenant_id", "code");
-- A tenant cannot mint a second "DRY" beside the shared one; the partial index
-- is how the system rows claim their codes, since NULL never equals NULL in a
-- plain unique.
CREATE UNIQUE INDEX "container_type_code_system_key"
  ON "container_type" ("code") WHERE "tenant_id" IS NULL;
CREATE INDEX "container_type_tenant_id_idx" ON "container_type" ("tenant_id");

ALTER TABLE "container_type" ENABLE ROW LEVEL SECURITY;
-- System-capable shape: a shared row (tenant_id NULL) is visible to everyone.
CREATE POLICY tenant_isolation ON "container_type"
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);
-- Agents read it for the same reason they read container_size: the required
-- load on an inquiry is unreadable without it, and a box type is not
-- commercial information.
CREATE POLICY agent_read ON "container_type" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NOT NULL);

GRANT SELECT, INSERT, UPDATE ON TABLE "container_type" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "container_type_id_seq" TO ff_app;

CREATE TRIGGER "container_type_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "container_type"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- The four the client listed. Shared rows, so every tenant gets them.
INSERT INTO "container_type" ("tenant_id", "code", "name", "sort_order") VALUES
  (NULL, 'DRY',       'Dry',        1),
  (NULL, 'FLATRACK',  'Flat Rack',  2),
  (NULL, 'OPENTOP',   'Open Top',   3),
  (NULL, 'REEFER',    'Reefer',     4);

-- ---------------------------------------------------------------------------
-- 4. An inquiry line says which box, and of what type
-- ---------------------------------------------------------------------------
-- §4.2's `inquiry_container._Type`. Nullable: an LCL or air line has no
-- container to have a type.
ALTER TABLE "inquiry_volume" ADD COLUMN "container_type_id" BIGINT;
ALTER TABLE "inquiry_volume" ADD CONSTRAINT "inquiry_volume_container_type_id_fkey"
  FOREIGN KEY ("container_type_id") REFERENCES "container_type"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inquiry_volume_container_type_id_idx" ON "inquiry_volume" ("container_type_id");
CREATE TRIGGER "inquiry_volume_container_type_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "inquiry_volume"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_type', 'container_type_id');

-- ---------------------------------------------------------------------------
-- 5. Goods type — the client's list replaces ours
-- ---------------------------------------------------------------------------
-- Textile, Non-Textile, DG. The previous seed guessed at General Cargo,
-- Project, Personal Effects and Reefer; the client has now said what they
-- actually sort cargo by, and it is the garment trade.
--
-- Deactivated, never deleted (§4 rule 3). Eight freight rates point at the old
-- values and must keep rendering what they were priced against — a rate that
-- silently changed its goods type would be a different rate.
--
-- Reefer leaves this list on purpose: it is a container type, and now has a row
-- in the table above.
UPDATE "goods_type"
   SET "is_active" = false, "updated_at" = CURRENT_TIMESTAMP
 WHERE "tenant_id" IS NULL
   AND "code" IN ('GENERAL', 'REEFER', 'PERSONAL', 'PROJECT');

-- updated_at is supplied by hand: Prisma applies @updatedAt in the client, so
-- the column carries NOT NULL with no database default and a raw INSERT has to
-- fill it itself.
INSERT INTO "goods_type" ("tenant_id", "code", "name", "updated_at") VALUES
  (NULL, 'TEXTILE',     'Textile',      CURRENT_TIMESTAMP),
  (NULL, 'NONTEXTILE',  'Non-Textile',  CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- DG already exists and stays active; only its name is tightened to the
-- client's own word for it.
UPDATE "goods_type"
   SET "name" = 'DG', "updated_at" = CURRENT_TIMESTAMP
 WHERE "tenant_id" IS NULL AND "code" = 'DG';

-- ---------------------------------------------------------------------------
-- 6. The permission follows the screen
-- ---------------------------------------------------------------------------
-- SETTING.CONTAINER_TYPE guarded the screen that edits sizes, so the key moves
-- with it. Updating the rows rather than seeding new ones is what keeps the six
-- role_permission grants pointing at something: a fresh key would leave every
-- role that could edit sizes silently unable to, and the old rows orphaned.
--
-- The name SETTING.CONTAINER_TYPE becomes free for the screen that edits Dry
-- and Reefer, which arrives with the inquiry form that needs it.
UPDATE "permission"
   SET "feature" = 'SETTING.CONTAINER_SIZE',
       "key" = 'SETTING.CONTAINER_SIZE.' || "action"
 WHERE "feature" = 'SETTING.CONTAINER_TYPE';

-- ---------------------------------------------------------------------------
-- 7. The agent's view of a volume line
-- ---------------------------------------------------------------------------
-- RENAME COLUMN rewrites a dependent view's internal reference but keeps its
-- OUTPUT column name, so agent_inquiry_volume_v went on publishing
-- `container_type_id` while the table beneath it had moved on. Silent, and only
-- visible as a 500 the first time an agent opened the screen.
--
-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW cannot
-- rename a column.
--
-- security_invoker stays load-bearing. Without it the view runs with its
-- owner's privileges — the table owner, who bypasses RLS — and hands every
-- agent every inquiry in the workspace.
DROP VIEW "agent_inquiry_volume_v";

CREATE VIEW "agent_inquiry_volume_v" WITH (security_invoker = true) AS
  SELECT
    v.id,
    v.tenant_id,
    v.inquiry_id,
    v.volume_kind,
    v.container_size_id,
    v.container_size_note,
    -- New, and deliberately visible: whether the box is Dry or Reefer changes
    -- the price more than most things on the line, so an agent asked to quote
    -- it has to be told.
    v.container_type_id,
    v.quantity,
    v.cbm,
    v.weight_kg
  FROM "inquiry_volume" v
  WHERE v.deleted_at IS NULL
    AND v.tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "inquiry" i
      WHERE i.id = v.inquiry_id
        AND i.tenant_id = v.tenant_id
        AND EXISTS (
          SELECT 1 FROM "inquiry_party" ip
          WHERE ip.inquiry_id = i.id
            AND ip.tenant_id = i.tenant_id
            AND ip.agent_id = app_current_agent()
        )
    );

-- target_price is still absent, which is the whole reason this view exists.
GRANT SELECT ON "agent_inquiry_volume_v" TO ff_app;
-- And the REVOKE that GRANT does not imply. ALTER DEFAULT PRIVILEGES covers
-- views as well as tables, so a freshly created view arrives writable; the
-- 20260823150000 migration made these two read-only and dropping one threw that
-- away. Second time this trap has been sprung in this schema, after audit_log.
REVOKE INSERT, UPDATE, DELETE ON "agent_inquiry_volume_v" FROM ff_app;
