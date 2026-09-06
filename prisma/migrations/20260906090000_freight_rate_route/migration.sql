-- Purchase → the routing a rate is bought against.
--
-- Client request, 2026-09-06: Sea FCL, Sea LCL and Air Freight Purchase each
-- need a Route field. POL and POD already say where the cargo starts and ends;
-- none of the three said how it gets there, and on the same lane a direct
-- sailing and one transhipping through Singapore are different products at
-- different prices, quoted to the customer differently.
--
-- Free text rather than a lookup. A routing is "Direct", "via Singapore",
-- "CGP-SIN-RTM" — there is no closed set, it varies by carrier and by week, and
-- a lookup would force a buyer to create a master row before they could key in
-- a rate they are reading off an email. This is the reasoning §11 already
-- applied to exporter and importer on the booking.
--
-- Nullable, and no backfill: every rate already keyed in was entered without a
-- routing, and inventing one for them would be putting words in the buyer's
-- mouth. Null reads as "not recorded", which is the truth.

ALTER TABLE "freight_rate" ADD COLUMN "route" VARCHAR(200);

COMMENT ON COLUMN "freight_rate"."route" IS
  'How the cargo travels between POL and POD — "Direct", "via Singapore". Free text; null means not recorded.';
