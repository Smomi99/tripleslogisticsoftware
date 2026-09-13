-- --------------------------------------------------------------------------
-- Which load plans carry figures from the short-shipment bug?
--
-- Fixed 2026-09-14. Before the fix, a cargo line whose RECEIVED quantity
-- differed from its BOOKED quantity handed the completing allocation
-- "booked total - already used" — so the volume, weight and pieces of the
-- cartons that never arrived landed on the last container of the split.
--
-- Reported case: 200 cartons booked at 33.00 CBM, 180 received, split
-- 169 + 11. The second container was given 5.1150 CBM for 11 cartons that
-- measure 1.8150.
--
-- This is READ ONLY. It changes nothing; it tells you what to look at.
-- Run it against production before deciding what to correct.
-- --------------------------------------------------------------------------

WITH received AS (
  SELECT
    rl.shipment_cargo_line_id AS cargo_line_id,
    SUM(rl.received_ctn_qty)  AS received_ctn,
    -- NULL if any receipt for the line left the cartons unmeasured, which is
    -- how the service treats it too.
    CASE WHEN bool_and(rl.received_volume_cbm IS NOT NULL)
         THEN SUM(rl.received_volume_cbm) END AS received_cbm
  FROM cargo_receipt_line rl
  JOIN cargo_receipt r ON r.id = rl.cargo_receipt_id
  WHERE rl.deleted_at IS NULL
    AND rl.line_status = 'ACCEPTED'
    AND r.status = 'CONFIRMED'
    AND r.deleted_at IS NULL
  GROUP BY rl.shipment_cargo_line_id
),
lines AS (
  SELECT
    l.id              AS cargo_line_id,
    l.tenant_id,
    l.shipment_id,
    p.po_no,
    l.item_code,
    l.ctn_qty         AS booked_ctn,
    l.volume_cbm      AS booked_cbm,
    l.cbm_per_carton,
    rc.received_ctn,
    rc.received_cbm
  FROM shipment_cargo_line l
  JOIN shipment_po p ON p.id = l.shipment_po_id
  JOIN received rc ON rc.cargo_line_id = l.id
  WHERE l.deleted_at IS NULL
    -- The bug only bites when what arrived is not what was ordered.
    AND rc.received_ctn <> l.ctn_qty
),
allocated AS (
  SELECT
    cl.shipment_cargo_line_id AS cargo_line_id,
    SUM(cl.ctn_qty)           AS allocated_ctn,
    SUM(cl.volume_cbm)        AS allocated_cbm
  FROM clp_line cl
  JOIN clp c ON c.id = cl.clp_id
  WHERE cl.deleted_at IS NULL
    AND c.deleted_at IS NULL
    AND c.status <> 'CANCELLED'
  GROUP BY cl.shipment_cargo_line_id
)
SELECT
  ln.tenant_id,
  s.code                         AS booking_no,
  ln.po_no,
  ln.item_code,
  ln.booked_ctn,
  ln.received_ctn,
  a.allocated_ctn,
  ln.booked_cbm,
  -- What the plan should add up to now.
  COALESCE(ln.received_cbm, ln.cbm_per_carton * ln.received_ctn) AS correct_cbm,
  a.allocated_cbm                AS currently_on_plans,
  a.allocated_cbm
    - COALESCE(ln.received_cbm, ln.cbm_per_carton * ln.received_ctn) AS overstated_by,
  -- Which plans hold this line, and whether they are already final.
  (SELECT string_agg(c2.code || ' (' || c2.status || ')', ', ' ORDER BY c2.clp_seq)
     FROM clp_line cl2
     JOIN clp c2 ON c2.id = cl2.clp_id
    WHERE cl2.shipment_cargo_line_id = ln.cargo_line_id
      AND cl2.deleted_at IS NULL
      AND c2.deleted_at IS NULL
      AND c2.status <> 'CANCELLED') AS plans
FROM lines ln
JOIN allocated a ON a.cargo_line_id = ln.cargo_line_id
JOIN shipment s  ON s.id = ln.shipment_id
-- Only rows where the line is fully allocated can have taken a remainder.
WHERE a.allocated_ctn = ln.received_ctn
  AND ABS(
        a.allocated_cbm
        - COALESCE(ln.received_cbm, ln.cbm_per_carton * ln.received_ctn)
      ) > 0.0001
ORDER BY ln.tenant_id, s.code, ln.po_no;
