-- CR-005: bookings that share an EFR share one Shipment Advise and one BL.
--
-- The client, 2026-10-02: when the same EFR No is found on several bookings of
-- one quotation, those bookings get a single shipment advise and a single BL.
-- Until now an advise belonged to exactly one booking (MODULE_DOCUMENTATION
-- §3.1). This lets one advise cover a set of bookings, and keeps every rule
-- that held for one booking true for the set:
--
--   shipment_advise_booking   NEW — the bookings an advise covers. The booking
--                             the advise was made from stays on
--                             shipment_advise.shipment_id and has a row here too.
--   shipment_advise_line      + shipment_id, so each PO line is held to one of
--                             the advise's bookings by composite foreign keys.
--   bl_draft                  its advise key now includes shipment_id, so a BL
--                             draft hangs off the advise's own booking and stays
--                             one live draft per advise.
--   shipment_po,              + UNIQUE (tenant_id, id, shipment_id) — the targets
--   shipment_cargo_line         of the advise line's composite keys.
--   shipment_advise           + UNIQUE (tenant_id, id, shipment_id), the target
--                             of bl_draft's.
--
-- Nothing is dropped except three foreign keys, each replaced in this file by a
-- stricter one over the same columns plus shipment_id. Every existing advise
-- is backfilled as covering exactly its own booking, which is what it did.

-- ------------------------------------------------------------- preconditions
-- The new keys assume what the old code always did: an advise's lines are its
-- own booking's cargo, and a BL draft sits on its advise's booking. Checked
-- before anything changes, so a database that disagrees stops here with the
-- count rather than half migrated.
DO $$
DECLARE
  stray_lines  bigint;
  stray_drafts bigint;
BEGIN
  SELECT count(*) INTO stray_lines
    FROM "shipment_advise_line" l
    JOIN "shipment_advise" a     ON a.tenant_id = l.tenant_id AND a.id = l.advise_id
    JOIN "shipment_po" p         ON p.tenant_id = l.tenant_id AND p.id = l.shipment_po_id
    JOIN "shipment_cargo_line" c ON c.tenant_id = l.tenant_id AND c.id = l.shipment_cargo_line_id
   WHERE p.shipment_id <> a.shipment_id OR c.shipment_id <> a.shipment_id;
  IF stray_lines > 0 THEN
    RAISE EXCEPTION 'CR-005: % shipment_advise_line rows carry another booking''s PO or cargo line; fix them before migrating', stray_lines;
  END IF;

  SELECT count(*) INTO stray_drafts
    FROM "bl_draft" d
    JOIN "shipment_advise" a ON a.tenant_id = d.tenant_id AND a.id = d.advise_id
   WHERE d.shipment_id <> a.shipment_id;
  IF stray_drafts > 0 THEN
    RAISE EXCEPTION 'CR-005: % bl_draft rows sit on a booking other than their advise''s; fix them before migrating', stray_drafts;
  END IF;
END $$;

-- ------------------------------------------------- the keys being replaced
ALTER TABLE "bl_draft" DROP CONSTRAINT "bl_draft_tenant_id_advise_id_fkey";
ALTER TABLE "shipment_advise_line" DROP CONSTRAINT "shipment_advise_line_tenant_id_shipment_cargo_line_id_fkey";
ALTER TABLE "shipment_advise_line" DROP CONSTRAINT "shipment_advise_line_tenant_id_shipment_po_id_fkey";

-- ----------------------------------------------- shipment_advise_booking
CREATE TABLE "shipment_advise_booking" (
    "tenant_id" BIGINT NOT NULL,
    "id" BIGSERIAL NOT NULL,
    "advise_id" BIGINT NOT NULL,
    "shipment_id" BIGINT NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" BIGINT,
    "updated_by" BIGINT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "shipment_advise_booking_pkey" PRIMARY KEY ("id")
);

-- Every existing advise covered exactly its own booking. A cancelled or
-- deleted one has already let its booking go, so its row is released.
INSERT INTO "shipment_advise_booking"
  ("tenant_id", "advise_id", "shipment_id", "released_at",
   "created_at", "updated_at", "created_by", "updated_by")
SELECT a.tenant_id, a.id, a.shipment_id,
       CASE WHEN a.status = 'CANCELLED' OR a.deleted_at IS NOT NULL
            THEN COALESCE(a.cancelled_at, a.deleted_at, a.updated_at) END,
       a.created_at, a.updated_at, a.created_by, a.updated_by
  FROM "shipment_advise" a;

-- ------------------------------------------- shipment_advise_line.shipment_id
-- Added nullable, filled from the line's PO, then made NOT NULL.
ALTER TABLE "shipment_advise_line" ADD COLUMN "shipment_id" BIGINT;
UPDATE "shipment_advise_line" l
   SET "shipment_id" = p."shipment_id"
  FROM "shipment_po" p
 WHERE p."tenant_id" = l."tenant_id" AND p."id" = l."shipment_po_id";
ALTER TABLE "shipment_advise_line" ALTER COLUMN "shipment_id" SET NOT NULL;

-- ------------------------------------------------------------------ indexes
CREATE INDEX "shipment_advise_booking_tenant_id_idx" ON "shipment_advise_booking"("tenant_id");
CREATE INDEX "shipment_advise_booking_advise_id_idx" ON "shipment_advise_booking"("advise_id");
CREATE INDEX "shipment_advise_booking_shipment_id_idx" ON "shipment_advise_booking"("shipment_id");
CREATE UNIQUE INDEX "shipment_advise_booking_tenant_id_advise_id_shipment_id_key" ON "shipment_advise_booking"("tenant_id", "advise_id", "shipment_id");
CREATE UNIQUE INDEX "shipment_advise_booking_tenant_id_id_key" ON "shipment_advise_booking"("tenant_id", "id");
CREATE UNIQUE INDEX "shipment_advise_tenant_id_id_shipment_id_key" ON "shipment_advise"("tenant_id", "id", "shipment_id");
CREATE INDEX "shipment_advise_line_shipment_id_idx" ON "shipment_advise_line"("shipment_id");
CREATE UNIQUE INDEX "shipment_cargo_line_tenant_id_id_shipment_id_key" ON "shipment_cargo_line"("tenant_id", "id", "shipment_id");
CREATE UNIQUE INDEX "shipment_po_tenant_id_id_shipment_id_key" ON "shipment_po"("tenant_id", "id", "shipment_id");

-- One live advise per booking, whichever booking of the group it is. Partial,
-- like shipment_advise_tenant_id_shipment_id_live_key beside it, so a
-- cancelled advise does not hold its bookings forever. That older index stays:
-- it is still true, and now says the narrower thing that a booking leads at
-- most one live advise.
CREATE UNIQUE INDEX "shipment_advise_booking_tenant_id_shipment_id_live_key"
  ON "shipment_advise_booking" ("tenant_id", "shipment_id")
  WHERE "released_at" IS NULL AND "deleted_at" IS NULL;

-- ------------------------------------------------------------- foreign keys
ALTER TABLE "shipment_advise_booking" ADD CONSTRAINT "shipment_advise_booking_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_advise_booking" ADD CONSTRAINT "shipment_advise_booking_tenant_id_advise_id_fkey" FOREIGN KEY ("tenant_id", "advise_id") REFERENCES "shipment_advise"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_advise_booking" ADD CONSTRAINT "shipment_advise_booking_tenant_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_advise_booking" ADD CONSTRAINT "shipment_advise_booking_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_advise_booking" ADD CONSTRAINT "shipment_advise_booking_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A line's booking must be one of its advise's, and its PO and cargo line must
-- be that booking's.
ALTER TABLE "shipment_advise_line" ADD CONSTRAINT "shipment_advise_line_tenant_id_advise_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "advise_id", "shipment_id") REFERENCES "shipment_advise_booking"("tenant_id", "advise_id", "shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_advise_line" ADD CONSTRAINT "shipment_advise_line_tenant_id_shipment_po_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "shipment_po_id", "shipment_id") REFERENCES "shipment_po"("tenant_id", "id", "shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shipment_advise_line" ADD CONSTRAINT "shipment_advise_line_tenant_id_shipment_cargo_line_id_ship_fkey" FOREIGN KEY ("tenant_id", "shipment_cargo_line_id", "shipment_id") REFERENCES "shipment_cargo_line"("tenant_id", "id", "shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A BL draft sits on the booking its advise was made from. With the live
-- index bl_draft_tenant_id_shipment_id_live_key, that makes one live draft
-- per advise, however many bookings the advise covers.
ALTER TABLE "bl_draft" ADD CONSTRAINT "bl_draft_tenant_id_advise_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "advise_id", "shipment_id") REFERENCES "shipment_advise"("tenant_id", "id", "shipment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------- who may share one
-- Only the bookings of one quotation, for one customer, may share an advise —
-- and only while it is a draft. The customer half is the one that matters most:
-- the customer portal shows an advise to the customer of the booking it was
-- made from, so an advise holding another customer's booking would show that
-- customer's POs to the wrong company. The draft half is MODULE_DOCUMENTATION
-- §5 rule 3: a sent advise is immutable, so adding a booking means cancelling
-- and reissuing it. The EFR itself is checked by the API, not here: it lives on
-- the cargo receipts and can be corrected after the fact.
CREATE OR REPLACE FUNCTION app_assert_advise_booking_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  advise_status    text;
  lead_quotation   bigint;
  lead_customer    bigint;
  member_quotation bigint;
  member_customer  bigint;
BEGIN
  SELECT a.status::text, s.quotation_id, s.customer_id
    INTO advise_status, lead_quotation, lead_customer
    FROM shipment_advise a
    JOIN shipment s ON s.tenant_id = a.tenant_id AND s.id = a.shipment_id
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.advise_id;

  SELECT quotation_id, customer_id INTO member_quotation, member_customer
    FROM shipment
   WHERE tenant_id = NEW.tenant_id AND id = NEW.shipment_id;

  IF advise_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'advise % is %; bookings are added only while it is a draft', NEW.advise_id, coalesce(advise_status, 'not found')
      USING ERRCODE = 'check_violation';
  END IF;
  IF member_quotation IS DISTINCT FROM lead_quotation THEN
    RAISE EXCEPTION 'booking % is on another quotation than advise %', NEW.shipment_id, NEW.advise_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF member_customer IS DISTINCT FROM lead_customer THEN
    RAISE EXCEPTION 'booking % belongs to another customer than advise %', NEW.shipment_id, NEW.advise_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

GRANT EXECUTE ON FUNCTION app_assert_advise_booking_group() TO ff_app;

CREATE TRIGGER shipment_advise_booking_group_guard
  BEFORE INSERT OR UPDATE OF advise_id, shipment_id ON shipment_advise_booking
  FOR EACH ROW EXECUTE FUNCTION app_assert_advise_booking_group();

-- Cancelling an advise frees every booking it covered, in the same statement.
-- A trigger rather than route code because the live index depends on it: a
-- cancel path that forgot would leave bookings that can never be advised again.
CREATE OR REPLACE FUNCTION app_release_advise_bookings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE shipment_advise_booking
     SET released_at = coalesce(NEW.cancelled_at, NEW.deleted_at, now()),
         updated_at  = now(),
         updated_by  = NEW.updated_by
   WHERE tenant_id = NEW.tenant_id
     AND advise_id = NEW.id
     AND released_at IS NULL;
  RETURN NULL;
END $$;

GRANT EXECUTE ON FUNCTION app_release_advise_bookings() TO ff_app;

CREATE TRIGGER shipment_advise_release_bookings
  AFTER UPDATE OF status, deleted_at ON shipment_advise
  FOR EACH ROW
  WHEN ((NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED')
     OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION app_release_advise_bookings();

-- ------------------------------------------------------------------ tenancy
-- The single-comparison form (20260917090000) for staff, plus the customer's
-- read of their own bookings' rows — the same shape as customer_read on
-- shipment_advise (20260920110000), keyed on the booking, so a customer can
-- find the one advise and BL that cover any booking of theirs.
ALTER TABLE "shipment_advise_booking" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shipment_advise_booking"
  USING (tenant_id = app_staff_tenant())
  WITH CHECK (tenant_id = app_staff_tenant());

CREATE POLICY customer_read ON "shipment_advise_booking" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_customer() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "shipment" s
       WHERE s.id = "shipment_advise_booking".shipment_id
         AND s.tenant_id = "shipment_advise_booking".tenant_id
    )
  );

GRANT SELECT, INSERT, UPDATE ON TABLE "shipment_advise_booking" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "shipment_advise_booking_id_seq" TO ff_app;

-- §4 rule 7. After the backfill, so the migration's own rows are not logged as
-- if somebody had typed them.
CREATE TRIGGER "shipment_advise_booking_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "shipment_advise_booking"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
