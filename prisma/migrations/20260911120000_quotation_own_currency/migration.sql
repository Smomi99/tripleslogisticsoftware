-- The quotation prints in its own currency.
--
-- Until now every quotation carried a second, converted total: the user chose
-- a "Local Currency" when raising it, its rate was frozen on, and the PDF
-- printed both "Total: USD 5,000" and "BDT 620,000" underneath. With the
-- workspace base currency in place that choice is redundant, and the client
-- does not want a second currency on the customer's document at all — the
-- conversion is now something the staff look at on screen and never send.
--
-- The columns stay. local_currency_id and conversion_rate still record what a
-- quotation was raised against, and total_amount_local is still a stored sum;
-- what changes is that nothing puts them in front of a customer.
--
-- §2.2 is why this flag exists rather than a straight change to the template:
-- a quotation that has already gone out must re-print as it was sent. Every
-- issued document keeps the two-currency layout it was issued in; everything
-- raised from here prints in one currency.
ALTER TABLE "quotation"
  ADD COLUMN "prints_converted_total" BOOLEAN NOT NULL DEFAULT false;

UPDATE "quotation" SET "prints_converted_total" = true WHERE "sent_at" IS NOT NULL;

COMMENT ON COLUMN "quotation"."prints_converted_total" IS
  'True for documents issued in the old two-currency layout. §2.2 — an issued document re-prints as it was sent.';
