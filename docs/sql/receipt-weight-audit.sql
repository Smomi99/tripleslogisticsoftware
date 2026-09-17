-- --------------------------------------------------------------------------
-- Receipts whose weight does not agree with their own carton count.
--
-- Raised 2026-09-14 from booking BKG-2026-000006: 200 cartons booked at
-- 5,500 kg, 180 received, and 5,500 kg entered as the received weight. The
-- VOLUME scaled correctly to 29.70 CBM because it is generated from the
-- cartons; the WEIGHT did not, so the same goods went from 27.5 kg a carton
-- to 30.56 without anything else on the record changing.
--
-- Either reading is possible and they have different consequences:
--
--   - the goods really were heavier than booked, and the gross weight on
--     every downstream document is right;
--   - or the booked figure was copied into the received field without being
--     adjusted for the cartons that did not arrive, and a container is about
--     to be declared ~550 kg heavy.
--
-- A VGM is a legal declaration, so this is worth a person looking at each
-- row rather than a rule guessing.
--
-- This is READ ONLY. It changes nothing.
-- --------------------------------------------------------------------------

WITH lines AS (
  SELECT
    rl.id                         AS receipt_line_id,
    r.code                        AS receipt_no,
    s.code                        AS booking_no,
    p.po_no,
    l.item_code,
    l.ctn_qty                     AS booked_ctn,
    l.gross_weight_kg             AS booked_gross_kg,
    l.gross_weight_per_carton     AS booked_kg_per_ctn,
    rl.received_ctn_qty           AS received_ctn,
    rl.received_gross_weight_kg   AS received_gross_kg,
    rl.received_volume_cbm,
    l.id                          AS cargo_line_id
  FROM cargo_receipt_line rl
  JOIN cargo_receipt r      ON r.id = rl.cargo_receipt_id
  JOIN shipment_cargo_line l ON l.id = rl.shipment_cargo_line_id
  JOIN shipment_po p        ON p.id = l.shipment_po_id
  JOIN shipment s           ON s.id = l.shipment_id
  WHERE rl.deleted_at IS NULL
    AND r.deleted_at IS NULL
    AND l.deleted_at IS NULL
    AND rl.line_status = 'ACCEPTED'
    AND rl.received_gross_weight_kg IS NOT NULL
    AND l.gross_weight_per_carton IS NOT NULL
    AND rl.received_ctn_qty > 0
)
SELECT
  booking_no,
  receipt_no,
  po_no,
  item_code,
  booked_ctn,
  received_ctn,
  booked_gross_kg,
  received_gross_kg,
  ROUND(booked_kg_per_ctn, 4)                          AS booked_kg_per_ctn,
  ROUND(received_gross_kg / received_ctn, 4)           AS received_kg_per_ctn,
  -- What the received weight would be if the cartons weighed what was booked.
  ROUND(booked_kg_per_ctn * received_ctn, 3)           AS weight_if_it_scaled,
  ROUND(received_gross_kg - booked_kg_per_ctn * received_ctn, 3) AS difference_kg,
  -- The tell: the received weight is EXACTLY the booked total while fewer
  -- cartons arrived. That is a figure carried across, not one weighed.
  (received_ctn <> booked_ctn AND received_gross_kg = booked_gross_kg)
                                                        AS looks_copied,
  -- Has it already reached a container plan, and is that plan final?
  (SELECT string_agg(DISTINCT c.code || ' (' || c.status || ')', ', ')
     FROM clp_line cl
     JOIN clp c ON c.id = cl.clp_id
    WHERE cl.shipment_cargo_line_id = lines.cargo_line_id
      AND cl.deleted_at IS NULL
      AND c.deleted_at IS NULL
      AND c.status <> 'CANCELLED')                      AS on_plans
FROM lines
-- More than 1% out, or exactly the booked total on a short delivery.
WHERE (received_ctn <> booked_ctn AND received_gross_kg = booked_gross_kg)
   OR ABS(received_gross_kg - booked_kg_per_ctn * received_ctn)
      > GREATEST(booked_kg_per_ctn * received_ctn * 0.01, 0.5)
ORDER BY booking_no, po_no;
