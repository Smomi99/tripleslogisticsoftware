-- Cancel quotation (client, 2026-10-29): a quotation withdrawn with a reason,
-- so its inquiry can be quoted again (MODULE_INQUIRY_QUOTATION §5.3 rule 10).
--
-- On its own, because Postgres will not let a transaction use an enum value it
-- just added, and 20261029100100_quotation_cancel's CHECK names it.
ALTER TYPE "quotation_status" ADD VALUE IF NOT EXISTS 'CANCELLED' AFTER 'SUPERSEDED';
