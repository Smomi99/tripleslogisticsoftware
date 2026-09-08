-- A workspace declares its own base currency.
--
-- Client request, 2026-09-08. Every rate in the product means "units of the
-- base per 1 unit of this currency", and until now the base was BDT by
-- convention alone: it was whichever row someone had set to 1.0000. Nothing
-- declared it, so a forwarder outside Bangladesh had no way to say otherwise.
--
-- tenant.currency_id already existed for exactly this, commented "Base currency
-- for display", and was NULL everywhere and read by nothing. This connects it.

-- 1. Rate precision. -------------------------------------------------------
--
-- The reason this has to happen in the same migration: once the base can be
-- anything, rates can be small. In a BDT workspace every rate is large — USD is
-- 120 BDT — and four decimals are plenty. Flip the base to USD and BDT becomes
-- 0.00833 dollars, which four decimals round to 0.0083: a 0.4% error on every
-- converted figure, silently, forever.
--
-- Ten decimals, not eight. Decimal places are absolute and exchange rates are
-- relative: at eight places a rate of 0.0000186 — a weak currency against a
-- strong base — keeps three significant figures, which is not a rate. Ten keeps
-- five even there, and 0.0083333333 for taka-in-dollars round-trips to within
-- 1e-11. Eight integer digits remain, and no currency pair on earth needs more
-- than six. The money columns themselves are untouched at 4dp.
ALTER TABLE "currency" ALTER COLUMN "conversion" TYPE NUMERIC(18,10);
ALTER TABLE "currency_rate_history" ALTER COLUMN "rate" TYPE NUMERIC(18,10);
ALTER TABLE "quotation" ALTER COLUMN "conversion_rate" TYPE NUMERIC(18,10);

-- quotation_line.conversion_rate carries a generated column, and Postgres will
-- not alter a type another column is generated from. Drop it, widen, put it
-- back exactly as it was — the expression is unchanged and every existing row
-- recomputes to the same figure, because widening a scale cannot lose a value.
ALTER TABLE "quotation_line" DROP COLUMN "bill_amount_local";
ALTER TABLE "quotation_line" ALTER COLUMN "conversion_rate" TYPE NUMERIC(18,10);
ALTER TABLE "quotation_line"
  ADD COLUMN "bill_amount_local" NUMERIC(18,4)
  GENERATED ALWAYS AS ((quantity * selling_price) * conversion_rate) STORED;

-- 2. Declare the base for every workspace that already exists. --------------
--
-- The evidence, not the flag. "conversion = 1" looks like it identifies the
-- base, and does not: the demo workspace has BOTH BDT and USD sitting at 1,
-- which is precisely the ambiguity that comes of never declaring one.
--
-- What a workspace actually bills in is not in doubt — it is the currency its
-- quotations name as local_currency_id, and the commonest one wins. Only when a
-- workspace has issued no quotation at all does this fall back to a rate of 1,
-- and then to the lowest id, so the result is deterministic either way.
--
-- A guess, and the Currency screen is where it gets corrected. Any workspace
-- upgrading should check it once.
UPDATE "tenant" t
   SET "currency_id" = COALESCE(
     (
       SELECT q.local_currency_id
         FROM "quotation" q
        WHERE q.tenant_id = t.id AND q.deleted_at IS NULL
        GROUP BY q.local_currency_id
        ORDER BY count(*) DESC, q.local_currency_id
        LIMIT 1
     ),
     (
       SELECT c.id
         FROM "currency" c
        WHERE (c.tenant_id = t.id OR c.tenant_id IS NULL)
          AND c.deleted_at IS NULL
          AND c.conversion = 1
        ORDER BY (c.tenant_id IS NULL), c.id
        LIMIT 1
     )
   )
 WHERE t."currency_id" IS NULL;

COMMENT ON COLUMN "tenant"."currency_id" IS
  'The workspace base currency. Every rate is units of this per 1 unit of the other currency, and this currency''s own rate is always exactly 1.';

COMMENT ON COLUMN "currency"."conversion" IS
  'System default rate, in the SYSTEM base (the shared row whose conversion is 1). Only a valid fallback for a workspace whose base is that same currency — otherwise the workspace needs its own rate in currency_rate_history.';
