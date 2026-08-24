-- Narrowing the field is a decision somebody made about somebody else's price,
-- so the trail records it as its own event rather than as a generic UPDATE.
-- "Who took this agent off the shortlist, and when" is precisely the question
-- audit_log exists to answer.
--
-- Separate from 20260826090000 because that one added the enum value these
-- describe, and Postgres will not let a transaction use a value it just added.
ALTER TYPE "audit_action" ADD VALUE 'QUOTE_SHORTLISTED' AFTER 'QUOTE_AMENDED';
ALTER TYPE "audit_action" ADD VALUE 'QUOTE_UNSHORTLISTED' AFTER 'QUOTE_SHORTLISTED';
