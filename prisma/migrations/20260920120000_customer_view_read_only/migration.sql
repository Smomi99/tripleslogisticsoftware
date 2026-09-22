-- ===========================================================================
-- The customer view is for reading, and only for reading
-- ===========================================================================
--
-- `ALTER DEFAULT PRIVILEGES` grants SELECT, INSERT and UPDATE on "TABLES",
-- which in Postgres includes views — so customer_shipment_v arrived writable
-- in 20260920110000 despite that migration granting it nothing but SELECT. A
-- GRANT cannot withhold what a default privilege already gave.
--
-- It matters here more than it looks. The view is a simple SELECT over one
-- table, which makes it auto-updatable: a write through it would reach
-- `shipment` over exactly the columns that were chosen for a customer to READ.
--
-- Caught by tenant-isolation.test.ts, which pins every view at SELECT alone.
-- 20260823150000_agent_views_read_only says the same thing about the two agent
-- views, and this is the third.
-- ===========================================================================

REVOKE INSERT, UPDATE, DELETE ON "customer_shipment_v" FROM ff_app;
