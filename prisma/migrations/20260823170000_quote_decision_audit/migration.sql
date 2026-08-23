-- Two more audit actions: the forwarder's answer to an agent's quote.
--
-- The trigger already records the UPDATE with both sides, so the row change is
-- captured either way. These name the DECISION rather than the mechanism — a
-- trail read six months later should say "declined by Rahim on the 14th", not
-- "status went from SUBMITTED to DECLINED", even though the two are the same
-- event.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'QUOTE_ACCEPTED';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'QUOTE_DECLINED';
