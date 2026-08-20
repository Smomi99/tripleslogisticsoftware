-- Settings → Modes, plus Loading Type and per-size pricing on an inquiry.
--
-- From the client's own wireframe for the New Inquiry screen:
--   TOS · Mode · Loading Type (FCL, LCL) when the shipment is Sea, and a
--   Required-container grid whose columns are the container sizes and whose
--   rows are quantity, container type, weight and target price.
--
-- "Modes" is the client's name for the screen. The values they gave are the
-- eleven Incoterms 2020 rules, which is a different question from `tos`
-- (CY/CFS/Door handover) and from shipment_type (Sea/Air).

-- ---------------------------------------------------------------------------
-- 1. The lookup, on the same system-capable shape as tos and inquiry_source
-- ---------------------------------------------------------------------------
CREATE TABLE "mode" (
  "tenant_id"  BIGINT,
  "id"         BIGSERIAL NOT NULL,
  "code"       VARCHAR(32) NOT NULL,
  "name"       VARCHAR(200) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" BIGINT,
  "updated_by" BIGINT,
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "mode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mode_tenant_id_code_key" ON "mode" ("tenant_id", "code");
CREATE INDEX "mode_tenant_id_idx" ON "mode" ("tenant_id");
-- UNIQUE(tenant_id, code) does not constrain shared rows: Postgres treats every
-- NULL as distinct, so any number of them could share a code (§4 rule 9).
CREATE UNIQUE INDEX "mode_code_system_key" ON "mode" ("code") WHERE "tenant_id" IS NULL;

ALTER TABLE "mode" ADD CONSTRAINT "mode_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mode" ADD CONSTRAINT "mode_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mode" ADD CONSTRAINT "mode_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New tables do not inherit policies; without this the table is readable across
-- tenants the moment the API touches it (§7A rule 2).
ALTER TABLE "mode" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "mode"
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON TABLE "mode" TO ff_app;

-- ---------------------------------------------------------------------------
-- 2. Inquiry: the Mode and Loading Type the wireframe asks for
-- ---------------------------------------------------------------------------
CREATE TYPE "loading_type" AS ENUM ('FCL', 'LCL');

ALTER TABLE "inquiry" ADD COLUMN "mode_id" BIGINT;
ALTER TABLE "inquiry" ADD COLUMN "loading_type" "loading_type";

ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_mode_id_fkey"
  FOREIGN KEY ("mode_id") REFERENCES "mode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inquiry_mode_id_idx" ON "inquiry" ("mode_id");

-- §4 rule 10's guard: mode is system-capable, so the trigger allows a NULL
-- tenant_id parent and rejects one belonging to another workspace.
CREATE TRIGGER inquiry_mode_id_tenant_guard
  BEFORE INSERT OR UPDATE OF "mode_id" ON "inquiry"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('mode', 'mode_id');

-- Backfill: every existing Sea inquiry is FCL or LCL depending on what its
-- volume rows actually say. Air inquiries keep NULL, where the question does
-- not arise. An inquiry with no volume rows also keeps NULL rather than being
-- guessed at.
UPDATE "inquiry" i SET "loading_type" = 'FCL'
 WHERE i."shipment_type" = 'SEA'
   AND EXISTS (SELECT 1 FROM "inquiry_volume" v
                WHERE v."inquiry_id" = i."id" AND v."volume_kind" = 'FCL'
                  AND v."deleted_at" IS NULL);

UPDATE "inquiry" i SET "loading_type" = 'LCL'
 WHERE i."shipment_type" = 'SEA'
   AND i."loading_type" IS NULL
   AND EXISTS (SELECT 1 FROM "inquiry_volume" v
                WHERE v."inquiry_id" = i."id" AND v."volume_kind" = 'LCL'
                  AND v."deleted_at" IS NULL);

-- ---------------------------------------------------------------------------
-- 3. Per-size pricing, and the free-text container note
-- ---------------------------------------------------------------------------
ALTER TABLE "inquiry_volume" ADD COLUMN "target_price" DECIMAL(18,4);
ALTER TABLE "inquiry_volume" ADD COLUMN "container_type_note" VARCHAR(200);

-- The client chose "per size only", so the inquiry-level target price moves
-- into the grid and the column goes. Copy it onto every live volume row of the
-- inquiry first: one figure quoted for the whole inquiry is the best available
-- reading of what it meant per size, and losing it silently would be worse.
UPDATE "inquiry_volume" v
   SET "target_price" = i."target_price"
  FROM "inquiry" i
 WHERE v."inquiry_id" = i."id"
   AND v."deleted_at" IS NULL
   AND i."target_price" IS NOT NULL;

ALTER TABLE "inquiry" DROP COLUMN "target_price";
