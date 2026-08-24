-- Phase D — the §4.2 inquiry schema.
--
-- Five columns the client asked for and we never had, a commodity that becomes
-- many, uniqueness on the container grid, and the share tracking §5.1 needs to
-- know an RFQ actually went out.
--
-- One data-touching step, called out here so it is not a surprise: four of the
-- seven inquiries carry a commodity and an HS code on the header row, and
-- commodity is becoming a multi-select. Those four are copied into the new child
-- table before the header columns are dropped, in this transaction. Nothing is
-- lost and nothing is invented.

-- ---------------------------------------------------------------------------
-- 1. The missing header columns
-- ---------------------------------------------------------------------------
-- goods_type is how the client sorts cargo for pricing (Textile, Non-Textile,
-- DG) and §5.1 matches a lane on it. Nullable: the seven existing inquiries
-- were raised before the field existed and must not be invented for.
ALTER TABLE "inquiry" ADD COLUMN "goods_type_id" BIGINT;
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_goods_type_id_fkey"
  FOREIGN KEY ("goods_type_id") REFERENCES "goods_type"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inquiry_goods_type_id_idx" ON "inquiry" ("goods_type_id");
-- goods_type is system-capable (§7A rule 7), so the same-tenant rule is a
-- trigger rather than a composite key.
CREATE TRIGGER "inquiry_goods_type_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "inquiry"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('goods_type', 'goods_type_id');

-- §6.1 puts Weight in Kg and Target Price on the header AND on every grid row.
-- Both, deliberately: the grid says what each size weighs and what it should
-- fetch, the header says what the shipment weighs and what the customer wants
-- to pay overall. An operator filling only one of the two is the normal case.
ALTER TABLE "inquiry" ADD COLUMN "weight_kg" NUMERIC(18,3);
ALTER TABLE "inquiry" ADD COLUMN "target_price" NUMERIC(18,4);
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_weight_positive"
  CHECK ("weight_kg" IS NULL OR "weight_kg" > 0);
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_target_price_positive"
  CHECK ("target_price" IS NULL OR "target_price" > 0);

-- §5.2: when the business is won through an agent, which one. Set only on a WON
-- inquiry, and the CHECK says so rather than leaving it to the route.
ALTER TABLE "inquiry" ADD COLUMN "won_agent_id" BIGINT;
ALTER TABLE "inquiry" ADD COLUMN "won_at" TIMESTAMPTZ(6);
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_won_agent_id_fkey"
  FOREIGN KEY ("tenant_id", "won_agent_id") REFERENCES "agent"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inquiry_won_agent_id_idx" ON "inquiry" ("won_agent_id");
-- An inquiry that names a winning agent has been won. The reverse is not
-- required: business is won without an agent every time it is priced from our
-- own rates.
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_won_agent_needs_won"
  CHECK ("won_agent_id" IS NULL OR "status" = 'WON');

-- ---------------------------------------------------------------------------
-- 2. Two more places an inquiry can be
-- ---------------------------------------------------------------------------
-- §5.1 routes an inquiry the moment it is saved: an inbound one goes to agents
-- (RFQ_SENT), an outbound one with a live rate is ready to quote from (PRICED).
-- Without these the board cannot tell "waiting on an agent" from "nobody has
-- looked at it", which is the distinction the whole routing service exists to
-- draw.
ALTER TYPE "inquiry_status" ADD VALUE IF NOT EXISTS 'RFQ_SENT' AFTER 'OPEN';
ALTER TYPE "inquiry_status" ADD VALUE IF NOT EXISTS 'PRICED' AFTER 'RFQ_SENT';

-- ---------------------------------------------------------------------------
-- 3. Commodity becomes many
-- ---------------------------------------------------------------------------
-- §3: one inquiry, several commodities, each with its own HS code. The client's
-- own form pairs them — "Commodity (multi) + HS Code" — so the code belongs
-- beside the commodity rather than on the inquiry.
CREATE TABLE "inquiry_commodity" (
  "tenant_id"         BIGINT NOT NULL,
  "id"                BIGSERIAL NOT NULL,
  "inquiry_id"        BIGINT NOT NULL,
  "commodity_item_id" BIGINT NOT NULL,
  -- Prefilled from the commodity and then editable, the same rule the header
  -- column carried: a corrected commodity must not rewrite an inquiry already
  -- sent to an agent.
  "hs_code"           VARCHAR(50),
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"        BIGINT,
  "updated_by"        BIGINT,
  "deleted_at"        TIMESTAMPTZ(6),
  CONSTRAINT "inquiry_commodity_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "inquiry_commodity" ADD CONSTRAINT "inquiry_commodity_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_commodity" ADD CONSTRAINT "inquiry_commodity_inquiry_id_fkey"
  FOREIGN KEY ("tenant_id", "inquiry_id") REFERENCES "inquiry"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_commodity" ADD CONSTRAINT "inquiry_commodity_commodity_item_id_fkey"
  FOREIGN KEY ("tenant_id", "commodity_item_id") REFERENCES "commodity_item"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_commodity" ADD CONSTRAINT "inquiry_commodity_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inquiry_commodity" ADD CONSTRAINT "inquiry_commodity_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "inquiry_commodity_tenant_id_id_key" ON "inquiry_commodity" ("tenant_id", "id");
-- The same commodity twice on one inquiry is a double-click, not an intention.
CREATE UNIQUE INDEX "inquiry_commodity_once"
  ON "inquiry_commodity" ("tenant_id", "inquiry_id", "commodity_item_id")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "inquiry_commodity_tenant_id_idx" ON "inquiry_commodity" ("tenant_id");
CREATE INDEX "inquiry_commodity_inquiry_id_idx" ON "inquiry_commodity" ("inquiry_id");
CREATE INDEX "inquiry_commodity_commodity_item_id_idx" ON "inquiry_commodity" ("commodity_item_id");

ALTER TABLE "inquiry_commodity" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inquiry_commodity"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);
-- An agent asked to price a shipment has to know what is in it. Same shape as
-- inquiry_volume's opening: the inner SELECT is filtered by inquiry's own agent
-- policy, so "an inquiry they were sent" needs no restating.
CREATE POLICY agent_read ON "inquiry_commodity" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM "inquiry" i WHERE i.id = "inquiry_commodity".inquiry_id)
  );

GRANT SELECT, INSERT, UPDATE ON TABLE "inquiry_commodity" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "inquiry_commodity_id_seq" TO ff_app;

CREATE TRIGGER "inquiry_commodity_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "inquiry_commodity"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- The four inquiries that already name a commodity keep it. This is the only
-- statement in the migration that writes a business row, and it moves a value
-- rather than inventing one.
INSERT INTO "inquiry_commodity"
  ("tenant_id", "inquiry_id", "commodity_item_id", "hs_code", "updated_at", "created_by")
SELECT i."tenant_id", i."id", i."commodity_item_id", i."hs_code", CURRENT_TIMESTAMP, i."created_by"
  FROM "inquiry" i
 WHERE i."commodity_item_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. The agent view loses two columns and gains nothing
-- ---------------------------------------------------------------------------
-- agent_inquiry_v selects commodity_item_id and hs_code, so the header columns
-- cannot be dropped while it stands. Recreated without them; agents read the
-- commodities from inquiry_commodity, which the policy above opens.
--
-- remarks stays out (20260823140000) and security_invoker stays on — without it
-- the view runs as its owner, who bypasses RLS.
DROP VIEW "agent_inquiry_v";

CREATE VIEW "agent_inquiry_v" WITH (security_invoker = true) AS
  SELECT
    i.id, i.tenant_id, i.code, i.series_year, i.inquiry_date,
    i.shipment_type, i.movement_type, i.loading_type,
    i.pol_id, i.pod_id, i.place_of_receipt,
    i.goods_type_id,
    i.tos_id, i.mode_id,
    i.expected_shipment_date, i.valid_to,
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

-- Still omitted: customer_id, currency_id, salesman_id, source_id,
-- notify_emails, remarks, weight_kg, target_price, created_by, updated_by.
-- target_price is new and belongs on that list for the same reason as the one
-- on inquiry_volume — it is what the customer will pay, not what the agent
-- should charge.
GRANT SELECT ON "agent_inquiry_v" TO ff_app;
-- ALTER DEFAULT PRIVILEGES covers views, so a new one arrives writable.
REVOKE INSERT, UPDATE, DELETE ON "agent_inquiry_v" FROM ff_app;

ALTER TABLE "inquiry" DROP COLUMN "commodity_item_id";
ALTER TABLE "inquiry" DROP COLUMN "hs_code";

-- ---------------------------------------------------------------------------
-- 5. The container grid gets the uniqueness the client drew
-- ---------------------------------------------------------------------------
-- §4.2's inquiry_container is UNIQUE per size. inquiry_volume is that table
-- under an older name — it already normalizes the client's wide sheet into
-- rows, and it covers the LCL and air lines that "container" would not — but it
-- never stopped two rows claiming the same size. Verified clean before adding.
CREATE UNIQUE INDEX "inquiry_volume_once_per_size"
  ON "inquiry_volume" ("tenant_id", "inquiry_id", "volume_kind", "container_size_id")
  WHERE "deleted_at" IS NULL AND "container_size_id" IS NOT NULL;
-- LCL and air have no size, so they get one row each instead.
CREATE UNIQUE INDEX "inquiry_volume_once_per_kind"
  ON "inquiry_volume" ("tenant_id", "inquiry_id", "volume_kind")
  WHERE "deleted_at" IS NULL AND "container_size_id" IS NULL;

-- ---------------------------------------------------------------------------
-- 6. Knowing the RFQ actually went out
-- ---------------------------------------------------------------------------
-- §4.2 asks for inquiry_agent_share. inquiry_party is already that table: it
-- records who an inquiry was shared with, and it covers carriers too — which
-- §6.1 requires ("Share to Agent / Carrier") and an agent-only share table
-- could not express. Rather than a second answer to "who was this sent to",
-- the tracking §5.1 needs is added here.
ALTER TABLE "inquiry_party" ADD COLUMN "notified_at" TIMESTAMPTZ(6);
ALTER TABLE "inquiry_party" ADD COLUMN "email_log_id" BIGINT;
ALTER TABLE "inquiry_party" ADD CONSTRAINT "inquiry_party_email_log_id_fkey"
  FOREIGN KEY ("tenant_id", "email_log_id") REFERENCES "email_log"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "inquiry_party_email_log_id_idx" ON "inquiry_party" ("email_log_id");

CREATE TYPE "inquiry_share_status" AS ENUM ('SHARED', 'VIEWED', 'QUOTED', 'WON', 'LOST');
ALTER TABLE "inquiry_party" ADD COLUMN "status" "inquiry_share_status" NOT NULL DEFAULT 'SHARED';
CREATE INDEX "inquiry_party_status_idx" ON "inquiry_party" ("tenant_id", "status");
