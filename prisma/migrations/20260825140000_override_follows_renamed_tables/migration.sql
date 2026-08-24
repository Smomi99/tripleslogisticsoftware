-- tenant_master_override rows follow the tables that were renamed under them.
--
-- A bug I introduced, found in Phase D and repaired here.
--
-- §7A rule 7 lets a tenant deactivate a shared master row for itself, and
-- tenant_master_override records that as (table_name, record_id). The key is the
-- table's NAME. Two migrations then renamed tables without touching it:
--
--   20260824180000  container_type -> container_size, and a NEW container_type
--   20260825090000  tos <-> mode
--
-- So every override written before those points at the right id in the wrong
-- table. In the demo workspace that meant somebody's decision to switch off the
-- 45FT container SIZE was silently switching off the Reefer container TYPE
-- instead — a row they had never seen, hidden from a dropdown they needed. The
-- tos row is the same story: "CFS/CFS is on" became "FOB is on".
--
-- Both statements are safe to run because no override can have been written
-- against the new meanings yet: the new container_type table was created by the
-- same migration that freed the name, and the settings screens for these lists
-- have not been used since. Every existing row predates the rename by
-- construction.
--
-- This is a data correction, and the smallest one that restores the intent:
-- each row keeps its record_id and its is_active, and only the table it names
-- moves back to the table it was always about.

-- 45FT and its kind: written when container_type held the sizes.
UPDATE "tenant_master_override"
   SET "table_name" = 'container_size', "updated_at" = CURRENT_TIMESTAMP
 WHERE "table_name" = 'container_type';

-- CY/CFS and its kind: written when tos held the CY/CY family.
UPDATE "tenant_master_override"
   SET "table_name" = 'mode', "updated_at" = CURRENT_TIMESTAMP
 WHERE "table_name" = 'tos';
