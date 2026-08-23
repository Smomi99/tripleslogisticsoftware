-- One more reference table for agents: mode, the Incoterm.
--
-- Phase 3 kept the agent-readable list deliberately short, and this is a
-- considered addition rather than a drift. An Incoterm decides what a freight
-- price is expected to include — quoting EXW and quoting DDP for the same lane
-- are different numbers by a wide margin — so an agent who cannot read it is
-- being asked to price blind.
--
-- It is also the public ICC list: EXW, FCA, FAS, FOB, CFR, CIF, CPT, CIP, DPU,
-- DAP, DDP. Nothing about it is the forwarder's to keep.
--
-- The alternative was to leave mode_id on agent_inquiry_v and render an id, or
-- to strip it and lose the term entirely. Both are worse.
CREATE POLICY agent_read ON "mode" FOR SELECT
  USING ((tenant_id IS NULL OR tenant_id = app_current_tenant()) AND app_current_agent() IS NOT NULL);
