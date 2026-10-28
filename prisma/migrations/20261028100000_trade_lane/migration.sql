-- ===========================================================================
-- TRADE LANE — docs/DESIGN-UPDATE-2026-10-28.md §1 (Sales → Business Matrix)
-- ===========================================================================
--
-- Two new tables:
--
--   trade_lane        Trade lane name, its direction, and the single port
--                     (the POL of an outbound lane, the POD of an inbound one)
--   trade_lane_port   the many side: the PODs outbound, the POLs inbound
--
-- The matrix (inquiries, quotations, TEUs, revenue) is counted when it is
-- read and never stored. Nothing existing is altered. The DDL was generated
-- by `prisma migrate diff`; the integrity, tenancy, guard and audit
-- statements below it are hand-written.
-- ===========================================================================

-- CreateTable
CREATE TABLE "trade_lane" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "movement_type" "movement_type" NOT NULL,
    "port_id" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "trade_lane_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_lane_port" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "trade_lane_id" BIGINT NOT NULL,
    "port_id" BIGINT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "trade_lane_port_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trade_lane_tenant_id_idx" ON "trade_lane"("tenant_id");

-- CreateIndex
CREATE INDEX "trade_lane_tenant_id_movement_type_idx" ON "trade_lane"("tenant_id", "movement_type");

-- CreateIndex
CREATE INDEX "trade_lane_port_id_idx" ON "trade_lane"("port_id");

-- CreateIndex
CREATE UNIQUE INDEX "trade_lane_tenant_id_code_key" ON "trade_lane"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "trade_lane_tenant_id_id_key" ON "trade_lane"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "trade_lane_port_tenant_id_idx" ON "trade_lane_port"("tenant_id");

-- CreateIndex
CREATE INDEX "trade_lane_port_trade_lane_id_idx" ON "trade_lane_port"("trade_lane_id");

-- CreateIndex
CREATE INDEX "trade_lane_port_port_id_idx" ON "trade_lane_port"("port_id");

-- CreateIndex
CREATE UNIQUE INDEX "trade_lane_port_tenant_id_id_key" ON "trade_lane_port"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "trade_lane" ADD CONSTRAINT "trade_lane_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lane" ADD CONSTRAINT "trade_lane_port_id_fkey" FOREIGN KEY ("port_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lane" ADD CONSTRAINT "trade_lane_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lane" ADD CONSTRAINT "trade_lane_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lane_port" ADD CONSTRAINT "trade_lane_port_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lane_port" ADD CONSTRAINT "trade_lane_port_trade_lane_id_fkey" FOREIGN KEY ("tenant_id", "trade_lane_id") REFERENCES "trade_lane"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lane_port" ADD CONSTRAINT "trade_lane_port_port_id_fkey" FOREIGN KEY ("port_id") REFERENCES "port"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lane_port" ADD CONSTRAINT "trade_lane_port_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_lane_port" ADD CONSTRAINT "trade_lane_port_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------- integrity
-- The sheet has an OUTBOUND SHIPMENT and an INBOUND SHIPMENT section and
-- nothing else, so a Cross Border lane is refused.
ALTER TABLE "trade_lane" ADD CONSTRAINT "trade_lane_direction_ck"
  CHECK ("movement_type" IN ('OUTBOUND', 'INBOUND'));

ALTER TABLE "trade_lane" ADD CONSTRAINT "trade_lane_name_not_blank"
  CHECK (length(btrim("name")) > 0);

-- One live lane of a name per direction, whatever its case.
CREATE UNIQUE INDEX "trade_lane_name_live_key"
  ON "trade_lane"("tenant_id", "movement_type", lower(btrim("name")))
  WHERE "deleted_at" IS NULL;

-- A port is on a lane once.
CREATE UNIQUE INDEX "trade_lane_port_live_key"
  ON "trade_lane_port"("tenant_id", "trade_lane_id", "port_id")
  WHERE "deleted_at" IS NULL;

-- ------------------------------------------------------------------ tenancy
ALTER TABLE "trade_lane" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "trade_lane"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

ALTER TABLE "trade_lane_port" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "trade_lane_port"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

GRANT SELECT, INSERT, UPDATE ON TABLE "trade_lane" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "trade_lane_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "trade_lane_port" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "trade_lane_port_id_seq" TO ff_app;

-- §4 rule 7: the audit trail is a trigger, so a write from any path is caught.
CREATE TRIGGER "trade_lane_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "trade_lane"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "trade_lane_port_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "trade_lane_port"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();

-- §4 rule 10. Port is system-capable and reached by a single-column key, so
-- the constraint alone cannot say whose row it is; the guard refuses another
-- workspace's private one.
CREATE TRIGGER trade_lane_port_id_tenant_guard
  BEFORE INSERT OR UPDATE OF port_id ON trade_lane
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'port_id');
CREATE TRIGGER trade_lane_port_port_id_tenant_guard
  BEFORE INSERT OR UPDATE OF port_id ON trade_lane_port
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('port', 'port_id');
