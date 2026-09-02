-- MODULE_BOOKING_CARGO.md §5.5 rule 5 — the short shipment.
--
-- "A privileged user may close the remaining balance with a reason, setting
-- SHORT_CLOSED. The balance stays visible on the record — never delete it. This
-- is what accounts and the customer will argue about later, and the trail is
-- the answer."
--
-- So the balance is not written off anywhere: it stays derivable from booked
-- minus received for as long as the record exists, and these three columns
-- record only that somebody decided to stop waiting for it, when, and why.
--
-- §9 Q11, answered by the client on 2026-09-02: the shortfall is recorded and
-- what happens to the money is decided later. No credit flag and no price is
-- stored here — the figures Accounts would need are already derivable, and
-- inventing a money field before the Accounts module exists would be guessing
-- at its shape.
--
-- Shaped like the cancellation columns for the same reason they were: an event
-- on the booking records who, when, and why.

ALTER TABLE "shipment" ADD COLUMN "short_closed_at"    TIMESTAMPTZ(6);
ALTER TABLE "shipment" ADD COLUMN "short_closed_by"    BIGINT;
ALTER TABLE "shipment" ADD COLUMN "short_close_reason" TEXT;

ALTER TABLE "shipment" ADD CONSTRAINT "shipment_short_closed_by_fkey"
  FOREIGN KEY ("short_closed_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- §5.5 rule 5's "with a reason", at the database as well as in the service.
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_short_close_ck" CHECK (
  "status" <> 'SHORT_CLOSED'
  OR ("short_closed_at" IS NOT NULL
      AND "short_closed_by" IS NOT NULL
      AND "short_close_reason" IS NOT NULL
      AND btrim("short_close_reason") <> '')
);

CREATE INDEX "shipment_short_closed_by_idx" ON "shipment" ("short_closed_by");
