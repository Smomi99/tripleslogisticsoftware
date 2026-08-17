-- CR-001 step 1. Ranking moves off the port and onto the lane.
--
-- The two position columns cannot be carried forward: a rank recorded against a
-- port has no POD to attach it to, and CR-001 §2 forbids guessing one. The four
-- rows that held ranks are dumped to
-- docs/migration-backups/CR-001-carrier_service_port_positions.csv so the client
-- can re-enter them as pairs once carrier_port_pair exists.

-- country is now derived from the port, not typed (CR-001 §2). Three of the four
-- existing rows carry a hand-typed country that disagrees with their port —
-- Changi filed under Bangladesh, Aarhus under Bangladesh. Correct them to the
-- port's own country so the column means what the screen will now claim it does.
UPDATE "carrier_service_port" s
   SET "country" = p."country"
  FROM "port" p
 WHERE p."id" = s."port_id"
   AND s."country" IS DISTINCT FROM p."country";

-- AlterTable
ALTER TABLE "carrier_service_port" DROP COLUMN "low_price_position",
DROP COLUMN "service_position";
