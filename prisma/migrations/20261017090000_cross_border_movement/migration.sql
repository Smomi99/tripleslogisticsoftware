-- ===========================================================================
-- SALES — Cross Border as a Type of Movement
-- docs/MODULE_INQUIRY_QUOTATION.md §5.1
-- ===========================================================================
--
-- The client asked for a third movement on the New Inquiry form. A Cross
-- Border inquiry is priced by agents, as an Inbound one is: it is shared with
-- the agents tagged with the "Cross Border" expert area, in any country.
--
--   movement_type   + CROSS_BORDER
--
-- Affects inquiry, quotation and tariff, the three tables on this enum. No
-- existing row changes; a tariff stays INBOUND or OUTBOUND (the API refuses
-- anything else).

ALTER TYPE "movement_type" ADD VALUE 'CROSS_BORDER';
