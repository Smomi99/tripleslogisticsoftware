-- MODULE_BOOKING_CARGO.md §4.2 — the vessel or flight schedule put to the
-- customer, and the legs it is made of.
--
-- One table for both modes, because the shape is identical: legs with a
-- sequence, an origin, a destination and timings. Direct is one leg; indirect
-- is two or three (§6.4). The mode decides which columns on a leg are filled,
-- not which table it lives in — §3's rule against forking sea and air.
--
-- §4.2's own emphasis: "A rejected schedule is never edited in place." The C/S
-- team proposes version 2; version 1 stays REJECTED with its comments, because
-- the customer must be able to see what they turned down and why. So the
-- version is a column and a superseded row is kept, not a row that gets
-- rewritten.

CREATE TYPE "schedule_status" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- ------------------------------------------------------- shipment_schedule
CREATE TABLE "shipment_schedule" (
  "tenant_id"          BIGINT NOT NULL,
  "id"                 BIGSERIAL PRIMARY KEY,
  "code"               VARCHAR(32) NOT NULL,
  "shipment_id"        BIGINT NOT NULL,
  "carrier_id"         BIGINT NOT NULL,
  "cut_off_date"       TIMESTAMPTZ(6),
  -- §9 Q4 is open: VGM is a sea-container concept and the client drew it on the
  -- Flight Booking screen too. Nullable, and the screen shows it on sea only
  -- until they answer — a column costs nothing, a wrong assumption on screen
  -- costs a conversation.
  "vgm_date"           DATE,
  "si_date"            DATE,
  "transit_type"       "transit_type" NOT NULL,
  "version_no"         INTEGER NOT NULL DEFAULT 1,
  "status"             "schedule_status" NOT NULL DEFAULT 'PROPOSED',
  "proposed_by"        BIGINT,
  "proposed_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by"         BIGINT,
  "decided_at"         TIMESTAMPTZ(6),
  "rejection_comments" TEXT,
  "is_active"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL,
  "created_by"         BIGINT,
  "updated_by"         BIGINT,
  "deleted_at"         TIMESTAMPTZ(6),

  CONSTRAINT "shipment_schedule_version_ck" CHECK ("version_no" >= 1),
  -- §6.5 makes the comment mandatory on rejection, for the same reason §5.3
  -- does on a PO: a decision the other side cannot act on is not a decision.
  CONSTRAINT "shipment_schedule_rejection_ck" CHECK (
    "status" <> 'REJECTED'
    OR ("rejection_comments" IS NOT NULL AND btrim("rejection_comments") <> '')
  ),
  -- A decision has a decider and a time, or it has neither.
  CONSTRAINT "shipment_schedule_decision_ck" CHECK (
    "status" IN ('PROPOSED', 'SUPERSEDED')
    OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
  )
);

ALTER TABLE "shipment_schedule" ADD CONSTRAINT "shipment_schedule_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_schedule" ADD CONSTRAINT "shipment_schedule_shipment_id_fkey"
  FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_schedule" ADD CONSTRAINT "shipment_schedule_proposed_by_fkey"
  FOREIGN KEY ("proposed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_schedule" ADD CONSTRAINT "shipment_schedule_decided_by_fkey"
  FOREIGN KEY ("decided_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_schedule" ADD CONSTRAINT "shipment_schedule_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_schedule" ADD CONSTRAINT "shipment_schedule_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Carrier is system-capable (§7A rule 7), so single-column plus the guard.
ALTER TABLE "shipment_schedule" ADD CONSTRAINT "shipment_schedule_carrier_id_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_schedule_carrier_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "shipment_schedule"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');

CREATE UNIQUE INDEX "shipment_schedule_tenant_id_id_key" ON "shipment_schedule" ("tenant_id", "id");
CREATE UNIQUE INDEX "shipment_schedule_version_key"
  ON "shipment_schedule" ("tenant_id", "shipment_id", "version_no") WHERE "deleted_at" IS NULL;
-- One schedule in front of the customer at a time. A superseded or rejected
-- version is kept forever; two live proposals would be two different sailings
-- both claiming to be the offer.
CREATE UNIQUE INDEX "shipment_schedule_live_key"
  ON "shipment_schedule" ("tenant_id", "shipment_id")
  WHERE "deleted_at" IS NULL AND "status" IN ('PROPOSED', 'APPROVED');
CREATE UNIQUE INDEX "shipment_schedule_tenant_id_code_key"
  ON "shipment_schedule" ("tenant_id", "code") WHERE "deleted_at" IS NULL;
CREATE INDEX "shipment_schedule_tenant_id_idx" ON "shipment_schedule" ("tenant_id");
CREATE INDEX "shipment_schedule_shipment_id_idx" ON "shipment_schedule" ("shipment_id");
CREATE INDEX "shipment_schedule_carrier_id_idx" ON "shipment_schedule" ("carrier_id");
CREATE INDEX "shipment_schedule_status_idx" ON "shipment_schedule" ("status");

-- --------------------------------------------------- shipment_schedule_leg
CREATE TABLE "shipment_schedule_leg" (
  "tenant_id"             BIGINT NOT NULL,
  "id"                    BIGSERIAL PRIMARY KEY,
  "schedule_id"           BIGINT NOT NULL,
  "leg_no"                INTEGER NOT NULL,
  -- SEA fills the first two, AIR the second two. §3: one table, one screen,
  -- mode-conditional fields.
  "vessel_id"             BIGINT,
  "voyage_no"             TEXT,
  "flight_no"             TEXT,
  "flight_time"           TEXT,
  "origin_port_id"        BIGINT NOT NULL,
  "destination_port_id"   BIGINT NOT NULL,
  "etd"                   TIMESTAMPTZ(6),
  "eta"                   TIMESTAMPTZ(6),
  "is_active"             BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMPTZ(6) NOT NULL,
  "created_by"            BIGINT,
  "updated_by"            BIGINT,
  "deleted_at"            TIMESTAMPTZ(6),

  -- §4.2's own bound. Wider than §6.4's "two or three" on purpose: the service
  -- enforces the screen's rule, and the table holds what the spec wrote.
  CONSTRAINT "shipment_schedule_leg_no_ck" CHECK ("leg_no" BETWEEN 1 AND 5),
  -- A leg that arrives before it leaves cannot happen.
  CONSTRAINT "shipment_schedule_leg_dates_ck"
    CHECK ("eta" IS NULL OR "etd" IS NULL OR "eta" >= "etd"),
  -- A leg from a port to itself is a typo, not a movement.
  CONSTRAINT "shipment_schedule_leg_ports_ck"
    CHECK ("origin_port_id" <> "destination_port_id")
);

ALTER TABLE "shipment_schedule_leg" ADD CONSTRAINT "shipment_schedule_leg_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_schedule_leg" ADD CONSTRAINT "shipment_schedule_leg_schedule_id_fkey"
  FOREIGN KEY ("tenant_id", "schedule_id") REFERENCES "shipment_schedule"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_schedule_leg" ADD CONSTRAINT "shipment_schedule_leg_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_schedule_leg" ADD CONSTRAINT "shipment_schedule_leg_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Vessel and port are system-capable: single-column keys plus the guard.
ALTER TABLE "shipment_schedule_leg" ADD CONSTRAINT "shipment_schedule_leg_vessel_id_fkey"
  FOREIGN KEY ("vessel_id") REFERENCES "vessel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_schedule_leg_vessel_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "shipment_schedule_leg"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('vessel', 'vessel_id');
ALTER TABLE "shipment_schedule_leg" ADD CONSTRAINT "shipment_schedule_leg_origin_port_id_fkey"
  FOREIGN KEY ("origin_port_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_schedule_leg_origin_port_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "shipment_schedule_leg"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'origin_port_id');
ALTER TABLE "shipment_schedule_leg" ADD CONSTRAINT "shipment_schedule_leg_destination_port_id_fkey"
  FOREIGN KEY ("destination_port_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "shipment_schedule_leg_destination_port_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "shipment_schedule_leg"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'destination_port_id');

CREATE UNIQUE INDEX "shipment_schedule_leg_tenant_id_id_key"
  ON "shipment_schedule_leg" ("tenant_id", "id");
CREATE UNIQUE INDEX "shipment_schedule_leg_no_key"
  ON "shipment_schedule_leg" ("tenant_id", "schedule_id", "leg_no") WHERE "deleted_at" IS NULL;
CREATE INDEX "shipment_schedule_leg_tenant_id_idx" ON "shipment_schedule_leg" ("tenant_id");
CREATE INDEX "shipment_schedule_leg_schedule_id_idx" ON "shipment_schedule_leg" ("schedule_id");
CREATE INDEX "shipment_schedule_leg_vessel_id_idx" ON "shipment_schedule_leg" ("vessel_id");

-- ------------------------------------------------------------------ tenancy
-- Staff-only for now, like the booking itself. §6.5's approval screen is where
-- a customer meets a schedule, and that reach lands with it.
ALTER TABLE "shipment_schedule" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipment_schedule"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "shipment_schedule_leg" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipment_schedule_leg"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

GRANT SELECT, INSERT, UPDATE ON TABLE "shipment_schedule" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "shipment_schedule_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "shipment_schedule_leg" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "shipment_schedule_leg_id_seq" TO ff_app;

-- -------------------------------------------------------------------- audit
CREATE TRIGGER "shipment_schedule_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "shipment_schedule"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "shipment_schedule_leg_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "shipment_schedule_leg"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
