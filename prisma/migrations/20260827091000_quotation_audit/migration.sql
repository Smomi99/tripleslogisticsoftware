-- §4 rule 7: one audit_log, written by a trigger on every tenant table.
--
-- Missed on 20260827090000 and caught by the coverage test rather than by me,
-- which is the point of that test — a quotation is the last record in the
-- product that should be able to change without a trail behind it.
--
-- The append-only and child tables get theirs too. The rule that catches the
-- table somebody forgot only works if it has no exceptions to argue about.
CREATE TRIGGER "quotation_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "quotation"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "quotation_line_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "quotation_line"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "quotation_commodity_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "quotation_commodity"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "quotation_recipient_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "quotation_recipient"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "quotation_followup_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "quotation_followup"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
