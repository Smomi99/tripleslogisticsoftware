-- MODULE_BOOKING_CARGO.md §5.1's cancellation, which needs somewhere to land.
--
-- §5.1's last transition reads "any -> CANCELLED (privileged, reason
-- mandatory)". §4.1's column list has no home for that reason, so this adds
-- one — the same gap §11 of CLAUDE.md is for, except the rule states the
-- requirement outright rather than implying it, so the field is the spec's and
-- not an invention.
--
-- Shaped like §4.1's own submission columns (submitted_by / submitted_at)
-- rather than a new pattern: an event on the booking records who, when and, for
-- this one, why. The audit trigger records the same actor and time
-- independently; these are here so the Overview tab can say why a booking was
-- cancelled without reading the trail.
--
-- Additive and nullable throughout: nothing existing changes, and every row
-- already in the table is valid without them.

ALTER TABLE "shipment" ADD COLUMN "cancelled_at"  TIMESTAMPTZ(6);
ALTER TABLE "shipment" ADD COLUMN "cancelled_by"  BIGINT;
ALTER TABLE "shipment" ADD COLUMN "cancel_reason" TEXT;

ALTER TABLE "shipment" ADD CONSTRAINT "shipment_cancelled_by_fkey"
  FOREIGN KEY ("cancelled_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The rule, in the database as well as in the service.
--
-- §5.1 makes the reason mandatory, and a status that could be set without one
-- would make the trail useless exactly where it is argued over. Written as an
-- implication rather than an equivalence: CANCELLED demands all three, and
-- every other status simply has nothing to say about them.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_cancellation_ck" CHECK (
  "status" <> 'CANCELLED'
  OR ("cancelled_at" IS NOT NULL
      AND "cancelled_by" IS NOT NULL
      AND "cancel_reason" IS NOT NULL
      AND btrim("cancel_reason") <> '')
);

CREATE INDEX "shipment_cancelled_by_idx" ON "shipment" ("cancelled_by");
