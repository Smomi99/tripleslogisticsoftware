-- The total names the currency the charges are actually in.
--
-- total_amount_usd is the sum of the line totals, and a line is priced in
-- whatever currency it was priced in. The name was aspirational: on a
-- quotation whose charges are in taka the column holds taka. Everything that
-- displayed it said "USD" in fixed text anyway — the screen, the PDF, the
-- email, and the amount in words — so QTN-2026-000006, four charges totalling
-- BDT 1,150, went to the customer reading "Total: USD 1,150" and "In word: US
-- Dollars One thousand one hundred and fifty only". A hundred and twenty-four
-- times the actual price, on the line of the document that exists to be the
-- arbiter when the digits are disputed.
--
-- No column changes. The currency is derived from the lines, which is where it
-- always lived; what changes is that nothing claims to know it in advance.
--
-- This clears the words that named the wrong currency. They are respelled on
-- read from the stored total — same figure in, same words out, so no amount on
-- an issued document moves (§2.2); only the currency beside it becomes true.
-- A later save writes them back properly.
UPDATE "quotation" q
   SET "amount_in_words" = NULL
 WHERE q."amount_in_words" IS NOT NULL
   AND q."amount_in_words" LIKE 'US Dollars%'
   AND EXISTS (
     SELECT 1 FROM "quotation_line" l
      WHERE l."quotation_id" = q."id" AND l."deleted_at" IS NULL
   )
   AND NOT EXISTS (
     SELECT 1 FROM "quotation_line" l
      WHERE l."quotation_id" = q."id"
        AND l."deleted_at" IS NULL
        AND l."currency_code" = 'USD'
   );
