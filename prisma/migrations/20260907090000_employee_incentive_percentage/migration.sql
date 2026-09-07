-- The employee's incentive rate.
--
-- Client request, 2026-09-07, from the Performance Report wireframe: "Incentive
-- accumulation of a percentage of Gross Profit. This incentive percentage pull
-- from Employee table." There was nowhere on the employee to pull it from.
--
-- A percentage rather than an amount, NUMERIC(5,2) so 7.5 and 12.25 both fit
-- and 100.00 is the ceiling. Nullable: most staff are not on incentive, and a
-- zero would claim they are on nought percent rather than not on the scheme.
--
-- Nothing computes with it yet. The gross profit it is a percentage OF comes
-- from invoice margin, and the Accounts module has no tables — no invoice, no
-- debit note, nothing. The column lands now because the client specified where
-- the rate lives, and capturing it early costs nothing while backfilling a
-- year of rates later would cost a lot.

ALTER TABLE "employee" ADD COLUMN "incentive_percentage" NUMERIC(5,2);

COMMENT ON COLUMN "employee"."incentive_percentage" IS
  'Share of gross profit paid as incentive (§ performance report). Null means not on the scheme.';
