-- Agent quotations become a priced breakdown, not a single number.
--
-- The client's wireframe replaces "type one price" with what a forwarder
-- actually receives from an agent: one or more ALTERNATIVE offers, each a table
-- of charge lines (carrier, cost head, container size, unit, qty, unit price,
-- currency, total) under its own routing — transit time, via, POD free days,
-- validity, ETD, ETA, remarks.
--
-- Two offers is what the sheet draws; nothing here caps it at two. An agent who
-- can route via Singapore or Colombo sends both and lets the forwarder choose,
-- which is why the routing footer is per option rather than per quote.
--
-- agent_quote.amount was built nullable for exactly this, with a note saying a
-- line-based quote would carry its figures on a child table and leave it null.
-- This is that change. The CHECK that made it mandatory is dropped here; the
-- column stays, so the quotes already submitted keep their value and keep
-- rendering.

-- ---------------------------------------------------------------------------
-- 1. The outcome the agent is finally told
-- ---------------------------------------------------------------------------
-- ACCEPTED/DECLINED said "we are using your rate". The client wants the agent
-- to see the commercial result instead: won, or lost and why. Renaming rather
-- than adding keeps one outcome per quote — there is no state where a quote is
-- both accepted and lost, which is the confusion two parallel enums would buy.
--
-- RENAME VALUE rewrites the label, not the rows: every existing quote keeps the
-- status it had.
ALTER TYPE "agent_quote_status" RENAME VALUE 'ACCEPTED' TO 'WON';
ALTER TYPE "agent_quote_status" RENAME VALUE 'DECLINED' TO 'LOST';

-- A quote with options carries no headline amount — with two offers in possibly
-- different currencies there is no single honest number to put there.
ALTER TABLE "agent_quote" DROP CONSTRAINT "agent_quote_amount_required";

-- ---------------------------------------------------------------------------
-- 2. agent_quote_option — one alternative offer
-- ---------------------------------------------------------------------------
-- No `code` column. §4 rule 2 asks for one on every table, but the line tables
-- this sits beside — inquiry_volume, rate_local_charge, freight_rate_line —
-- have never carried one: they are addressed through their parent and a
-- per-tenant sequence per line table buys nothing. Same choice here, stated so
-- it reads as a decision rather than an omission.
CREATE TABLE "agent_quote_option" (
  "tenant_id"     BIGINT NOT NULL,
  "id"            BIGSERIAL NOT NULL,
  "quote_id"      BIGINT NOT NULL,
  -- 1, 2, 3… as shown to both sides. Stable, so "option 2" in a comment still
  -- means option 2 after the agent revises the quote.
  "position"      SMALLINT NOT NULL,
  "carrier_id"    BIGINT,
  -- T/T in the sheet.
  "transit_days"  INTEGER,
  -- Via. Free text, not a port FK: a real routing is "Singapore" or
  -- "Colombo, Port Klang", and the sheet gives an open cell with no dropdown.
  "via"           VARCHAR(200),
  "pod_free_days" INTEGER,
  -- Validity: how long THIS offer stands. Distinct from inquiry.valid_to,
  -- which is the forwarder's deadline for receiving it.
  "valid_until"   DATE,
  "etd"           DATE,
  "eta"           DATE,
  "remarks"       TEXT,
  "is_active"     BOOLEAN NOT NULL DEFAULT true,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"    BIGINT,
  "updated_by"    BIGINT,
  "deleted_at"    TIMESTAMPTZ(6),
  CONSTRAINT "agent_quote_option_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_quote_option_position_positive" CHECK ("position" > 0),
  CONSTRAINT "agent_quote_option_transit_sane" CHECK ("transit_days" IS NULL OR "transit_days" >= 0),
  CONSTRAINT "agent_quote_option_free_days_sane" CHECK ("pod_free_days" IS NULL OR "pod_free_days" >= 0),
  -- A ship cannot arrive before it leaves. Cheap to state, and the pair is
  -- typed by hand into two adjacent cells.
  CONSTRAINT "agent_quote_option_eta_after_etd" CHECK ("etd" IS NULL OR "eta" IS NULL OR "eta" >= "etd")
);

ALTER TABLE "agent_quote_option" ADD CONSTRAINT "agent_quote_option_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote_option" ADD CONSTRAINT "agent_quote_option_quote_id_fkey"
  FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "agent_quote"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote_option" ADD CONSTRAINT "agent_quote_option_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote_option" ADD CONSTRAINT "agent_quote_option_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- carrier is system-capable (§7A rule 7): a shared row has tenant_id NULL, so a
-- composite FK cannot express it. The trigger is the same-tenant guard instead.
ALTER TABLE "agent_quote_option" ADD CONSTRAINT "agent_quote_option_carrier_id_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "agent_quote_option_carrier_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "agent_quote_option"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');

CREATE UNIQUE INDEX "agent_quote_option_tenant_id_id_key" ON "agent_quote_option" ("tenant_id", "id");
-- Position is unique within a live quote, so two rows cannot both call
-- themselves option 1.
CREATE UNIQUE INDEX "agent_quote_option_position_key"
  ON "agent_quote_option" ("tenant_id", "quote_id", "position")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "agent_quote_option_tenant_id_idx" ON "agent_quote_option" ("tenant_id");
CREATE INDEX "agent_quote_option_quote_id_idx" ON "agent_quote_option" ("quote_id");
CREATE INDEX "agent_quote_option_carrier_id_idx" ON "agent_quote_option" ("carrier_id");

-- ---------------------------------------------------------------------------
-- 3. agent_quote_line — one charge row inside an option
-- ---------------------------------------------------------------------------
-- The sheet's columns, one for one. Carrier repeats per line because that is
-- how it is drawn: a co-loaded option can carry one line on one carrier and the
-- rest on another, and forcing a single carrier per option would make that
-- unrecordable.
CREATE TABLE "agent_quote_line" (
  "tenant_id"         BIGINT NOT NULL,
  "id"                BIGSERIAL NOT NULL,
  "option_id"         BIGINT NOT NULL,
  "position"          SMALLINT NOT NULL,
  "carrier_id"        BIGINT,
  "cost_head_id"      BIGINT NOT NULL,
  -- Container Size in the sheet. Null on a line charged by weight or per
  -- document, which is why air quotes work at all.
  "container_type_id" BIGINT,
  -- Unit: Container, HBL, HAWB, CBM, KG, M.Ton… (§5 cost_unit).
  "cost_unit_id"      BIGINT,
  "quantity"          NUMERIC(18,3) NOT NULL,
  "unit_price"        NUMERIC(18,4) NOT NULL,
  "currency_id"       BIGINT NOT NULL,
  -- Total Amount is derived, never typed. A stored generated column means the
  -- arithmetic cannot drift from the two numbers it came from, whatever writes
  -- the row — API, migration, or a hand-run UPDATE at 2am.
  "total_amount"      NUMERIC(18,4) GENERATED ALWAYS AS ("quantity" * "unit_price") STORED,
  "remarks"           TEXT,
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by"        BIGINT,
  "updated_by"        BIGINT,
  "deleted_at"        TIMESTAMPTZ(6),
  CONSTRAINT "agent_quote_line_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_quote_line_position_positive" CHECK ("position" > 0),
  -- A zero-quantity line is a line somebody forgot to fill in; a negative one
  -- is a discount nobody has specified a meaning for.
  CONSTRAINT "agent_quote_line_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "agent_quote_line_unit_price_not_negative" CHECK ("unit_price" >= 0)
);

ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_option_id_fkey"
  FOREIGN KEY ("tenant_id", "option_id") REFERENCES "agent_quote_option"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- cost_head is tenant-owned, so the same-tenant rule is expressible as a key.
ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_cost_head_id_fkey"
  FOREIGN KEY ("tenant_id", "cost_head_id") REFERENCES "cost_head"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The three system-capable parents, each guarded by trigger for the reason
-- given above.
ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_carrier_id_fkey"
  FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "agent_quote_line_carrier_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "agent_quote_line"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('carrier', 'carrier_id');

ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_container_type_id_fkey"
  FOREIGN KEY ("container_type_id") REFERENCES "container_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "agent_quote_line_container_type_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "agent_quote_line"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('container_type', 'container_type_id');

ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_cost_unit_id_fkey"
  FOREIGN KEY ("cost_unit_id") REFERENCES "cost_unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "agent_quote_line_cost_unit_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "agent_quote_line"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('cost_unit', 'cost_unit_id');

ALTER TABLE "agent_quote_line" ADD CONSTRAINT "agent_quote_line_currency_id_fkey"
  FOREIGN KEY ("currency_id") REFERENCES "currency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER "agent_quote_line_currency_id_tenant_guard"
  BEFORE INSERT OR UPDATE ON "agent_quote_line"
  FOR EACH ROW EXECUTE FUNCTION app_assert_parent_tenant('currency', 'currency_id');

CREATE UNIQUE INDEX "agent_quote_line_tenant_id_id_key" ON "agent_quote_line" ("tenant_id", "id");
CREATE UNIQUE INDEX "agent_quote_line_position_key"
  ON "agent_quote_line" ("tenant_id", "option_id", "position")
  WHERE "deleted_at" IS NULL;
CREATE INDEX "agent_quote_line_tenant_id_idx" ON "agent_quote_line" ("tenant_id");
CREATE INDEX "agent_quote_line_option_id_idx" ON "agent_quote_line" ("option_id");
CREATE INDEX "agent_quote_line_cost_head_id_idx" ON "agent_quote_line" ("cost_head_id");
CREATE INDEX "agent_quote_line_carrier_id_idx" ON "agent_quote_line" ("carrier_id");
CREATE INDEX "agent_quote_line_container_type_id_idx" ON "agent_quote_line" ("container_type_id");
CREATE INDEX "agent_quote_line_cost_unit_id_idx" ON "agent_quote_line" ("cost_unit_id");
CREATE INDEX "agent_quote_line_currency_id_idx" ON "agent_quote_line" ("currency_id");

-- ---------------------------------------------------------------------------
-- 4. agent_quote_comment — the Status thread
-- ---------------------------------------------------------------------------
-- "all the comments will appear here … finally when we won or lost then
-- appear". Both sides write: the forwarder asks for a better 40HC rate, the
-- agent answers, and the exchange stays beside the quote instead of in
-- somebody's mailbox.
--
-- Append-only, and enforced by privilege rather than by hope — ff_app is
-- granted SELECT and INSERT and nothing else, the same treatment audit_log
-- gets. You cannot edit or withdraw what you have already said to a
-- counterparty, which is the property that makes the thread worth citing.
--
-- There is no internal-note flag. The client wrote "all the comments", so every
-- comment on a quote is visible to the agent who owns it. A private staff note
-- is a feature nobody has asked for, and shipping it half-built is how a
-- comment meant for a colleague ends up in front of the supplier.
CREATE TABLE "agent_quote_comment" (
  "tenant_id"  BIGINT NOT NULL,
  "id"         BIGSERIAL NOT NULL,
  "quote_id"   BIGINT NOT NULL,
  "author_id"  BIGINT NOT NULL,
  "body"       TEXT NOT NULL,
  -- Set when the comment is the one that announced the outcome, so the thread
  -- can render it as the result rather than as another remark.
  "outcome"    "agent_quote_status",
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_quote_comment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_quote_comment_body_not_blank" CHECK (btrim("body") <> ''),
  -- Only a terminal state can be announced. A comment tagged SUBMITTED would
  -- render as an outcome that has not happened.
  CONSTRAINT "agent_quote_comment_outcome_terminal"
    CHECK ("outcome" IS NULL OR "outcome" IN ('WON', 'LOST'))
);

ALTER TABLE "agent_quote_comment" ADD CONSTRAINT "agent_quote_comment_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote_comment" ADD CONSTRAINT "agent_quote_comment_quote_id_fkey"
  FOREIGN KEY ("tenant_id", "quote_id") REFERENCES "agent_quote"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_quote_comment" ADD CONSTRAINT "agent_quote_comment_author_id_fkey"
  FOREIGN KEY ("tenant_id", "author_id") REFERENCES "user"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "agent_quote_comment_tenant_id_id_key" ON "agent_quote_comment" ("tenant_id", "id");
CREATE INDEX "agent_quote_comment_tenant_id_idx" ON "agent_quote_comment" ("tenant_id");
CREATE INDEX "agent_quote_comment_quote_id_idx" ON "agent_quote_comment" ("quote_id", "created_at");
CREATE INDEX "agent_quote_comment_author_id_idx" ON "agent_quote_comment" ("author_id");

-- ---------------------------------------------------------------------------
-- 5. RLS and grants — a new table inherits neither (§7A rule 2)
-- ---------------------------------------------------------------------------
-- Staff baseline. The `app_current_agent() IS NULL` conjunct is what the Phase 3
-- migration added to every policy in the catalogue: it makes tenant_isolation
-- staff-only, so an agent reaches these tables through the explicit agent
-- policies below and through nothing else.
ALTER TABLE "agent_quote_option" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_quote_option"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "agent_quote_line" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_quote_line"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

ALTER TABLE "agent_quote_comment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_quote_comment"
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NULL)
  WITH CHECK (tenant_id = app_current_tenant() AND app_current_agent() IS NULL);

-- The agent side. Children inherit the parent's rule through an EXISTS that is
-- itself filtered by the parent's policy, exactly as inquiry_volume does — one
-- predicate to get right instead of one per table. agent_quote's own agent_rw
-- policy already restricts that inner SELECT to the caller's own quotes, so
-- "their own" needs no restating here.
CREATE POLICY agent_rw ON "agent_quote_option" FOR ALL
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM "agent_quote" q WHERE q.id = "agent_quote_option".quote_id)
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM "agent_quote" q WHERE q.id = "agent_quote_option".quote_id)
  );

CREATE POLICY agent_rw ON "agent_quote_line" FOR ALL
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM "agent_quote_option" o WHERE o.id = "agent_quote_line".option_id)
  )
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM "agent_quote_option" o WHERE o.id = "agent_quote_line".option_id)
  );

-- Read the whole thread, add to it, and that is all. There is no UPDATE policy
-- and no UPDATE grant, so the append-only rule holds for agents twice over.
CREATE POLICY agent_read ON "agent_quote_comment" FOR SELECT
  USING (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM "agent_quote" q WHERE q.id = "agent_quote_comment".quote_id)
  );
CREATE POLICY agent_write ON "agent_quote_comment" FOR INSERT
  WITH CHECK (
    tenant_id = app_current_tenant()
    AND app_current_agent() IS NOT NULL
    AND EXISTS (SELECT 1 FROM "agent_quote" q WHERE q.id = "agent_quote_comment".quote_id)
  );

GRANT SELECT, INSERT, UPDATE ON TABLE "agent_quote_option" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "agent_quote_option_id_seq" TO ff_app;
GRANT SELECT, INSERT, UPDATE ON TABLE "agent_quote_line" TO ff_app;
GRANT USAGE, SELECT ON SEQUENCE "agent_quote_line_id_seq" TO ff_app;
-- Append-only, and the REVOKE is the part that does the work. Naming only
-- SELECT and INSERT in a GRANT withholds nothing: the Phase 2 RLS migration
-- left ALTER DEFAULT PRIVILEGES granting SELECT, INSERT and UPDATE on every
-- table created afterwards, so this table arrives writable and has to be made
-- otherwise. audit_log needed the same correction for the same reason.
GRANT SELECT, INSERT ON TABLE "agent_quote_comment" TO ff_app;
REVOKE UPDATE ON TABLE "agent_quote_comment" FROM ff_app;
GRANT USAGE, SELECT ON SEQUENCE "agent_quote_comment_id_seq" TO ff_app;

-- ---------------------------------------------------------------------------
-- 6. Three more tables an agent may read
-- ---------------------------------------------------------------------------
-- A deliberate widening, and worth naming as one: the Phase 3 migration listed
-- `carrier` among the tables NOT opened to agents. The wireframe puts a Carrier
-- dropdown in the agent's own hands, so that decision is revisited here rather
-- than worked around.
--
-- What these three actually expose: the names of shipping lines and airlines,
-- the forwarder's charge labels ("Ocean Freight", "THC", "Doc Fee"), and units
-- like Container and CBM. Trade vocabulary, not commercial information — an
-- agent quoting you already knows what a THC is. Nothing priced is reachable:
-- freight_rate, rate_local_charge, inquiry_rate and customer all remain closed,
-- and cost_head carries no amount of its own.
--
-- SELECT only, and read through the same tenant-or-system predicate the other
-- reference tables use.
CREATE POLICY agent_read ON "carrier" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NOT NULL);
CREATE POLICY agent_read ON "cost_unit" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NOT NULL);
-- cost_head is tenant-owned, not system-capable.
CREATE POLICY agent_read ON "cost_head" FOR SELECT
  USING (tenant_id = app_current_tenant() AND app_current_agent() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 7. Audit
-- ---------------------------------------------------------------------------
-- §4 rule 7. The Phase 0 DO block ran over the tables that existed then, so new
-- ones are attached by hand; audit.test.ts asserts every tenant table has one,
-- which is why all three are here and not two — an append-only table still gets
-- its trigger, because the rule that catches the table somebody forgot only
-- works if it has no exceptions to argue about.
CREATE TRIGGER "agent_quote_option_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "agent_quote_option"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "agent_quote_line_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "agent_quote_line"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
CREATE TRIGGER "agent_quote_comment_audit"
  AFTER INSERT OR UPDATE OR DELETE ON "agent_quote_comment"
  FOR EACH ROW EXECUTE FUNCTION app_audit_row();
