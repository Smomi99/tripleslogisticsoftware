-- Two fields the client asked for on Add Customer.
--
-- Neither is in CLAUDE.md §6, which is why they are recorded here rather than
-- assumed: the client asked for them directly on 2026-08-29.
--
--   notes        free text about the account — the things a salesman knows and
--                nowhere else on the form has room for.
--   salesman_id  who owns the relationship. The inquiry already carries a
--                salesman; the customer did not, so "whose account is this?"
--                had no answer until one of their inquiries was opened.
--
-- Both nullable, so every row already in production satisfies them the moment
-- this runs. Nothing is rewritten and nothing is dropped.
ALTER TABLE "customer" ADD COLUMN "notes" TEXT;
ALTER TABLE "customer" ADD COLUMN "salesman_id" BIGINT;

-- §4 rule 10: the salesman is an employee of this same workspace, so the key is
-- composite rather than a bare reference to employee(id).
ALTER TABLE "customer" ADD CONSTRAINT "customer_salesman_id_fkey"
  FOREIGN KEY ("tenant_id", "salesman_id") REFERENCES "employee"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "customer_salesman_id_idx" ON "customer" ("salesman_id");
