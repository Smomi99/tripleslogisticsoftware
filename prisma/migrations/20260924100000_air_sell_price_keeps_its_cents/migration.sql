-- ===========================================================================
-- An air sell price keeps its cents
-- ===========================================================================
--
-- 20260912090000 rounded every sell price to a whole number (client,
-- 2026-09-12: "round figure, no decimal needed"). Right for sea, which is
-- priced per container or per CBM. Wrong for air, which is priced per KG:
-- 2.35 bought plus 0.30 margin was stored, listed and quoted as 3 — thirty-five
-- cents a kilo nobody decided on. From 2026-09-24 an air sell price rounds to
-- two places. Sea is unchanged.
--
-- The rounding needs the rate's mode, and the mode lives on freight_rate. A
-- generated column cannot read another table, so sell_price stops being
-- GENERATED and a BEFORE trigger computes it instead, from the parent's mode.
--
-- MODULE_PURCHASE_SALES.md §4 rule 4 survives intact: nobody writes this
-- column. An INSERT that supplies it, or an UPDATE that changes it, is refused
-- with the same SQLSTATE a generated column raises (428C9). Every other write
-- has it recomputed.
-- ===========================================================================

-- Values stay where they are; only the expression goes.
ALTER TABLE "freight_rate_line" ALTER COLUMN "sell_price" DROP EXPRESSION;

-- SECURITY DEFINER so the parent's mode is read whatever the session can see.
-- It reads one column of the row's own parent, which the composite foreign key
-- already holds to the same tenant.
CREATE OR REPLACE FUNCTION app_rate_line_sell_price() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
DECLARE
  line_mode rate_mode;
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.sell_price IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.sell_price IS DISTINCT FROM OLD.sell_price) THEN
    RAISE EXCEPTION 'sell_price is computed by the database and cannot be written'
      USING ERRCODE = '428C9';
  END IF;

  SELECT r.mode INTO line_mode FROM freight_rate r WHERE r.id = NEW.rate_id;

  NEW.sell_price := ROUND(
    CASE WHEN NEW.profit_type = 'FLAT'
         THEN NEW.buy_price + NEW.profit_value
         ELSE NEW.buy_price * (1 + NEW.profit_value / 100)
    END,
    CASE WHEN line_mode = 'AIR' THEN 2 ELSE 0 END
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER "freight_rate_line_sell_price"
  BEFORE INSERT OR UPDATE ON "freight_rate_line"
  FOR EACH ROW EXECUTE FUNCTION app_rate_line_sell_price();

-- ---------------------------------------------------------------------------
-- Air lines already on file
-- ---------------------------------------------------------------------------
-- Recomputed from the buy price and margin they were rounded from, so this
-- only puts the cents back. A touch rather than an expression: the trigger is
-- the one place the rule is written down. The audit trigger records each line
-- whose price actually moves.
--
-- A price list, not an issued document: a quotation snapshots its own price
-- when a line is pulled (§2.2), so nothing already quoted or sent changes.
UPDATE "freight_rate_line" l
   SET "buy_price" = l."buy_price"
  FROM "freight_rate" r
 WHERE r."id" = l."rate_id"
   AND r."mode" = 'AIR';
