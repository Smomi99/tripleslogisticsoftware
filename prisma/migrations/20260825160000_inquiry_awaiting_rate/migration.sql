-- §5.1's awaiting-rate flag.
--
-- "not found → queue an email to the Price Team role … status stays OPEN, flag
-- the inquiry as awaiting-rate". A status would have been the obvious home, but
-- the client is explicit that the status stays OPEN — an outbound inquiry with
-- no rate yet is still an ordinary open inquiry to the salesman who raised it.
-- What the flag adds is the pricing team's view of it: this one is waiting on
-- us, and somebody has already been asked.
--
-- §4.2 does not list the column, but §5.1 states it in words, so it is the
-- client's field rather than an invented one.
ALTER TABLE "inquiry" ADD COLUMN "awaiting_rate" BOOLEAN NOT NULL DEFAULT false;

-- The pricing team's worklist: every open inquiry still waiting on a rate.
CREATE INDEX "inquiry_awaiting_rate_idx"
  ON "inquiry" ("tenant_id")
  WHERE "awaiting_rate" = true AND "deleted_at" IS NULL;
