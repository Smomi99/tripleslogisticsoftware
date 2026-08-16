-- DELETE on pure join tables only (CLAUDE.md §4 rule 3, narrowed).
--
-- Phase 2 revoked DELETE from ff_app everywhere, so §4 rule 3's "never
-- hard-delete" is enforced by privilege rather than by discipline. That is
-- right for business records, and wrong for M:N join rows:
--
--   - a join row IS a selection, not a record. Deselecting an expert area has
--     no meaning other than removing the row;
--   - these tables have no is_active or deleted_at to soft-delete with, by
--     design — they carry no business identity, which is also why they have no
--     `code` (see packages/shared/src/codes.ts);
--   - rule 3's stated concern is that "deactivation must never break historical
--     FKs". Nothing references a join row, so there is no history to break.
--
-- The grant is therefore enumerated table by table rather than blanket. Any
-- table not listed here still refuses DELETE at the database.
GRANT DELETE ON TABLE agent_expert_area    TO ff_app;
GRANT DELETE ON TABLE agent_port_coverage  TO ff_app;
GRANT DELETE ON TABLE agent_network_member TO ff_app;

-- §7 needs the same for the permission matrix: unchecking a box removes the
-- grant, and role_permission / user_permission are joins of the same kind.
GRANT DELETE ON TABLE role_permission TO ff_app;
GRANT DELETE ON TABLE user_permission TO ff_app;
