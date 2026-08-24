-- §4.4 — the quotation, and the priced lines the customer actually reads.
--
-- This is the first record in the product that leaves the building and binds
-- the company for its validity period. §2.2 is the rule that shapes it: every
-- name and number on quotation_line is stored, not joined, so renaming a cost
-- head or letting a rate expire tomorrow cannot rewrite a document issued
-- today. The foreign keys stay beside the snapshots so the rows remain
-- reportable — the snapshot alone cannot answer "what did we quote for Ocean
-- Freight last quarter".
--
-- Staff-only throughout. Agents reach nothing here: an agent who could read a
-- quotation would learn the customer's identity and our margin in one query,
-- which is the whole of what §2.1 rule 2 exists to prevent.

CREATE TYPE "quotation_status" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');
CREATE TYPE "quotation_line_group" AS ENUM ('STANDARD', 'ADDITIONAL');
CREATE TYPE "quotation_line_source" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "transit_type" AS ENUM ('DIRECT', 'INDIRECT');
CREATE TYPE "recipient_kind" AS ENUM ('TO', 'CC');
CREATE TYPE "recipient_source" AS ENUM ('CUSTOMER', 'MANUAL');

-- rate_local_charge gains the composite target quotation_line needs to
-- reference one without leaving the tenant (§4 rule 10).
CREATE UNIQUE INDEX "rate_local_charge_tenant_id_id_key" ON "rate_local_charge" ("tenant_id", "id");

-- ---------------------------------------------------------------- quotation
CREATE TABLE "quotation" (
  "tenant_id"             BIGINT NOT NULL,
  "id"                    BIGSERIAL PRIMARY KEY,
  "code"                  VARCHAR(32) NOT NULL,
  "series_year"           INTEGER NOT NULL,
  "revision_no"           INTEGER NOT NULL DEFAULT 1,
  "inquiry_id"            BIGINT NOT NULL,
  "quotation_date"        DATE NOT NULL,
  "validity_date"         DATE,
  "customer_id"           BIGINT NOT NULL,
  "shipment_type"         "shipment_type" NOT NULL,
  "movement_type"         "movement_type" NOT NULL,
  "pol_id"                BIGINT NOT NULL,
  "pod_id"                BIGINT NOT NULL,
  "goods_type_id"         BIGINT,
  "place_of_receipt"      TEXT,
  "loading_type"          "loading_type",
  "tos_id"                BIGINT,
  "mode_id"               BIGINT,
  "carrier_id"            BIGINT NOT NULL,
  "first_vessel_id"       BIGINT,
  "transit_type"          "transit_type",
  "etd"                   DATE,
  "eta"                   DATE,
  "local_currency_id"     BIGINT NOT NULL,
  "conversion_rate"       NUMERIC(18,4) NOT NULL,
  "source_agent_quote_id" BIGINT,
  "total_amount_usd"      NUMERIC(18,4),
  "total_amount_local"    NUMERIC(18,4),
  "amount_in_words"       TEXT,
  "status"                "quotation_status" NOT NULL DEFAULT 'DRAFT',
  "sent_at"               TIMESTAMPTZ(6),
  "sent_by"               BIGINT,
  "is_active"             BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL,
  "created_by"            BIGINT,
  "updated_by"            BIGINT,
  "deleted_at"            TIMESTAMPTZ(6),

  -- A quotation whose validity ends before it starts is a typo, not an offer.
  CONSTRAINT "quotation_validity_ck"
    CHECK ("validity_date" IS NULL OR "validity_date" >= "quotation_date"),
  -- §5.4: the frozen rate has to be a real conversion. Zero would silently
  -- bill every line at nothing.
  CONSTRAINT "quotation_conversion_rate_ck" CHECK ("conversion_rate" > 0),
  CONSTRAINT "quotation_revision_no_ck" CHECK ("revision_no" >= 1)
);

ALTER TABLE "quotation" ADD CONSTRAINT "quotation_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_inquiry_id_fkey"
  FOREIGN KEY ("tenant_id", "inquiry_id") REFERENCES "inquiry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_customer_id_fkey"
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customer"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_source_agent_quote_id_fkey"
  FOREIGN KEY ("tenant_id", "source_agent_quote_id") REFERENCES "agent_quote"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_sent_by_fkey"
  FOREIGN KEY ("sent_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Port, goods type, TOS, mode, carrier, vessel and currency are system-capable
-- (§7A rule 7): a shared row carries tenant_id NULL, so a composite FK cannot
-- express the relationship. The trigger is the same-tenant guard instead.
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_pol_id_fkey"
  FOREIGN KEY ("pol_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_pol_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pol_id');
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_pod_id_fkey"
  FOREIGN KEY ("pod_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_pod_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'pod_id');
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_goods_type_id_fkey"
  FOREIGN KEY ("goods_type_id") REFERENCES "goods_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_goods_type_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('goods_type', 'goods_type_id');
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_tos_id_fkey"
  FOREIGN KEY ("tos_id") REFERENCES "tos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_tos_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('tos', 'tos_id');
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_mode_id_fkey"
  FOREIGN KEY ("mode_id") REFERENCES "mode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_mode_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('mode', 'mode_id');
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_carrier_id_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_carrier_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_first_vessel_id_fkey"
  FOREIGN KEY ("first_vessel_id") REFERENCES "vessel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_first_vessel_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('vessel', 'first_vessel_id');
ALTER TABLE "quotation" ADD CONSTRAINT "quotation_local_currency_id_fkey"
  FOREIGN KEY ("local_currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_local_currency_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'local_currency_id');

CREATE UNIQUE INDEX "quotation_tenant_id_id_key" ON "quotation" ("tenant_id", "id");
-- The number plus its issue. Revision 2 of QTN-2026-000001 shares the number,
-- which is exactly why code alone is not unique (§5.3 rule 8).
CREATE UNIQUE INDEX "quotation_tenant_id_code_revision_no_key"
  ON "quotation" ("tenant_id", "code", "revision_no");
-- ...and only one issue of a number may be live at a time. A superseded
-- revision is kept forever; two current ones would be two different offers
-- claiming to be the same document.
CREATE UNIQUE INDEX "quotation_live_revision_key"
  ON "quotation" ("tenant_id", "code")
  WHERE "deleted_at" IS NULL AND "status" <> 'SUPERSEDED';
CREATE INDEX "quotation_tenant_id_idx" ON "quotation" ("tenant_id");
CREATE INDEX "quotation_inquiry_id_idx" ON "quotation" ("inquiry_id");
CREATE INDEX "quotation_customer_id_idx" ON "quotation" ("customer_id");
CREATE INDEX "quotation_carrier_id_idx" ON "quotation" ("carrier_id");
CREATE INDEX "quotation_status_idx" ON "quotation" ("status");
-- §6.7's Search box runs over the two numbers on the row.
CREATE INDEX "quotation_code_trgm_idx" ON "quotation" USING GIN (
  to_tsvector('simple', "code")
);

-- ----------------------------------------------------------- quotation_line
CREATE TABLE "quotation_line" (
  "tenant_id"                    BIGINT NOT NULL,
  "id"                           BIGSERIAL PRIMARY KEY,
  "quotation_id"                 BIGINT NOT NULL,
  "line_group"                   "quotation_line_group" NOT NULL DEFAULT 'STANDARD',
  "sort_order"                   INTEGER NOT NULL DEFAULT 0,
  "cost_head_id"                 BIGINT NOT NULL,
  "cost_head_name"               VARCHAR(200) NOT NULL,
  "container_size_id"            BIGINT,
  "container_size_name"          VARCHAR(100),
  "cost_unit_id"                 BIGINT,
  "unit_name"                    VARCHAR(100),
  "quantity"                     NUMERIC(18,3) NOT NULL,
  "selling_price"                NUMERIC(18,4) NOT NULL,
  "currency_id"                  BIGINT NOT NULL,
  "currency_code"                VARCHAR(10) NOT NULL,
  -- §4 rule 4, and the client's own arithmetic: Total Amount ($) = Qty x
  -- Selling Price. Computed by Postgres so no caller can disagree with it.
  "total_amount"                 NUMERIC(18,4)
    GENERATED ALWAYS AS ("quantity" * "selling_price") STORED,
  "conversion_rate"              NUMERIC(18,4) NOT NULL,
  -- Bill Amount = Total x Booking Rate. Verified against the client's sample:
  -- 2 x 5252 = 10504, and 10504 x 129 = 1,355,016.
  "bill_amount_local"            NUMERIC(18,4)
    GENERATED ALWAYS AS ("quantity" * "selling_price" * "conversion_rate") STORED,
  "source"                       "quotation_line_source" NOT NULL DEFAULT 'MANUAL',
  "price_source_rate_line_id"    BIGINT,
  "price_source_local_charge_id" BIGINT,
  "remarks"                      TEXT,
  "is_active"                    BOOLEAN NOT NULL DEFAULT true,
  "created_at"                   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                   TIMESTAMPTZ(6) NOT NULL,
  "created_by"                   BIGINT,
  "updated_by"                   BIGINT,
  "deleted_at"                   TIMESTAMPTZ(6),

  CONSTRAINT "quotation_line_quantity_ck" CHECK ("quantity" > 0),
  CONSTRAINT "quotation_line_selling_price_ck" CHECK ("selling_price" >= 0),
  CONSTRAINT "quotation_line_conversion_rate_ck" CHECK ("conversion_rate" > 0),
  -- A line came from the price table or from somebody's keyboard, and if it
  -- came from the price table it says which half of it. Both at once would be
  -- two different provenances for one number.
  CONSTRAINT "quotation_line_price_source_ck" CHECK (
    NOT ("price_source_rate_line_id" IS NOT NULL AND "price_source_local_charge_id" IS NOT NULL)
  ),
  -- §6.5 marks hand-typed prices so the pricing team can see what nobody held a
  -- rate for. That marking is only trustworthy if AUTO really means pulled.
  CONSTRAINT "quotation_line_auto_has_source_ck" CHECK (
    "source" <> 'AUTO'
    OR "price_source_rate_line_id" IS NOT NULL
    OR "price_source_local_charge_id" IS NOT NULL
  )
);

ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_quotation_id_fkey"
  FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_cost_head_id_fkey"
  FOREIGN KEY ("tenant_id", "cost_head_id") REFERENCES "cost_head"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_price_source_rate_line_id_fkey"
  FOREIGN KEY ("tenant_id", "price_source_rate_line_id") REFERENCES "freight_rate_line"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_price_source_local_charge_id_fkey"
  FOREIGN KEY ("tenant_id", "price_source_local_charge_id") REFERENCES "rate_local_charge"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_container_size_id_fkey"
  FOREIGN KEY ("container_size_id") REFERENCES "container_size"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_line_container_size_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation_line"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_size', 'container_size_id');
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_cost_unit_id_fkey"
  FOREIGN KEY ("cost_unit_id") REFERENCES "cost_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_line_cost_unit_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation_line"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('cost_unit', 'cost_unit_id');
ALTER TABLE "quotation_line" ADD CONSTRAINT "quotation_line_currency_id_fkey"
  FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "quotation_line_currency_id_tenant_guard" BEFORE INSERT OR UPDATE ON "quotation_line"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');

CREATE UNIQUE INDEX "quotation_line_tenant_id_id_key" ON "quotation_line" ("tenant_id", "id");
CREATE INDEX "quotation_line_tenant_id_idx" ON "quotation_line" ("tenant_id");
CREATE INDEX "quotation_line_quotation_id_idx" ON "quotation_line" ("quotation_id");
CREATE INDEX "quotation_line_cost_head_id_idx" ON "quotation_line" ("cost_head_id");
CREATE INDEX "quotation_line_container_size_id_idx" ON "quotation_line" ("container_size_id");
CREATE INDEX "quotation_line_currency_id_idx" ON "quotation_line" ("currency_id");

-- ------------------------------------------------------ quotation_commodity
CREATE TABLE "quotation_commodity" (
  "tenant_id"         BIGINT NOT NULL,
  "id"                BIGSERIAL PRIMARY KEY,
  "quotation_id"      BIGINT NOT NULL,
  "commodity_item_id" BIGINT NOT NULL,
  "commodity_name"    VARCHAR(200) NOT NULL,
  "hs_code"           VARCHAR(50),
  "is_active"         BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE "quotation_commodity" ADD CONSTRAINT "quotation_commodity_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_commodity" ADD CONSTRAINT "quotation_commodity_quotation_id_fkey"
  FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_commodity" ADD CONSTRAINT "quotation_commodity_commodity_item_id_fkey"
  FOREIGN KEY ("tenant_id", "commodity_item_id") REFERENCES "commodity_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "quotation_commodity_tenant_id_id_key" ON "quotation_commodity" ("tenant_id", "id");
CREATE UNIQUE INDEX "quotation_commodity_unique_key"
  ON "quotation_commodity" ("tenant_id", "quotation_id", "commodity_item_id");
CREATE INDEX "quotation_commodity_tenant_id_idx" ON "quotation_commodity" ("tenant_id");
CREATE INDEX "quotation_commodity_quotation_id_idx" ON "quotation_commodity" ("quotation_id");

-- ------------------------------------------------------ quotation_recipient
CREATE TABLE "quotation_recipient" (
  "tenant_id"    BIGINT NOT NULL,
  "id"           BIGSERIAL PRIMARY KEY,
  "quotation_id" BIGINT NOT NULL,
  "email"        VARCHAR(320) NOT NULL,
  "kind"         "recipient_kind" NOT NULL DEFAULT 'TO',
  "source"       "recipient_source" NOT NULL DEFAULT 'CUSTOMER',
  "is_active"    BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"   BIGINT
);

ALTER TABLE "quotation_recipient" ADD CONSTRAINT "quotation_recipient_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_recipient" ADD CONSTRAINT "quotation_recipient_quotation_id_fkey"
  FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_recipient" ADD CONSTRAINT "quotation_recipient_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "quotation_recipient_tenant_id_id_key" ON "quotation_recipient" ("tenant_id", "id");
CREATE UNIQUE INDEX "quotation_recipient_unique_key"
  ON "quotation_recipient" ("tenant_id", "quotation_id", "email", "kind");
CREATE INDEX "quotation_recipient_tenant_id_idx" ON "quotation_recipient" ("tenant_id");
CREATE INDEX "quotation_recipient_quotation_id_idx" ON "quotation_recipient" ("quotation_id");

-- ------------------------------------------------------- quotation_followup
CREATE TABLE "quotation_followup" (
  "tenant_id"          BIGINT NOT NULL,
  "id"                 BIGSERIAL PRIMARY KEY,
  "quotation_id"       BIGINT NOT NULL,
  "followup_date"      DATE NOT NULL,
  "contact_mode"       "contact_mode" NOT NULL,
  "contact_person"     VARCHAR(200),
  "notes"              TEXT,
  "next_followup_date" DATE,
  "is_active"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL,
  "created_by"         BIGINT,
  "updated_by"         BIGINT,
  "deleted_at"         TIMESTAMPTZ(6)
);

ALTER TABLE "quotation_followup" ADD CONSTRAINT "quotation_followup_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_followup" ADD CONSTRAINT "quotation_followup_quotation_id_fkey"
  FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_followup" ADD CONSTRAINT "quotation_followup_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotation_followup" ADD CONSTRAINT "quotation_followup_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "quotation_followup_tenant_id_id_key" ON "quotation_followup" ("tenant_id", "id");
CREATE INDEX "quotation_followup_tenant_id_idx" ON "quotation_followup" ("tenant_id");
CREATE INDEX "quotation_followup_quotation_id_idx" ON "quotation_followup" ("quotation_id");

-- ------------------------------------------------------------------ tenancy
-- Staff-only, every one of them: `app_current_agent() IS NULL` is what keeps an
-- agent out. An agent who could read a quotation would see the customer's name
-- and our margin in a single row.
ALTER TABLE "quotation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quotation"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "quotation_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quotation_line"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "quotation_commodity" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quotation_commodity"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "quotation_recipient" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quotation_recipient"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "quotation_followup" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "quotation_followup"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

-- The Phase 2 ALTER DEFAULT PRIVILEGES already granted SELECT, INSERT and
-- UPDATE on every table created since, so these add nothing and are here for
-- the reader. What does bite is DELETE: §4 rule 3 is soft delete only, and no
-- grant of it exists anywhere.
GRANT SELECT, INSERT, UPDATE ON TABLE "quotation" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "quotation_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "quotation_line" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "quotation_line_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "quotation_commodity" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "quotation_commodity_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "quotation_recipient" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "quotation_recipient_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "quotation_followup" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "quotation_followup_id_seq" TO ff_app;
