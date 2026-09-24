-- Two fields the client asked for on Add Agent.
--
-- Neither is in CLAUDE.md §6, which is why they are recorded here rather than
-- assumed: the client asked for them directly on 2026-09-24.
--
--   delivery_agent_details  free text, entered under the address.
--   note                    free text about the agent, last on the form.
--
-- Both nullable, so every row already in production satisfies them the moment
-- this runs. Nothing is rewritten and nothing is dropped.
ALTER TABLE "agent" ADD COLUMN "delivery_agent_details" TEXT;
ALTER TABLE "agent" ADD COLUMN "note" TEXT;
