-- --------------------------------------------------------------------------
-- CR-002 migration validation. Run BEFORE and AFTER 20260915100000.
--
-- Every figure here must be IDENTICAL across the two runs except
-- `clp_booking rows`, which goes from 0 to one row per existing plan.
--
-- The point is narrow and worth stating: this migration must not alter a
-- single finalised plan. Its printed document has been signed on a warehouse
-- floor and the row behind it is the only record of what that paper said.
--
-- READ ONLY.
-- --------------------------------------------------------------------------

\echo '--- 1. plans by status (must not change) ---'
SELECT status, count(*) AS plans FROM clp GROUP BY status ORDER BY status;

\echo '--- 2. finalised plans, figure by figure (must not change) ---'
SELECT
  code, clp_seq, container_no, seal_no,
  total_ctn_qty, total_pcs_qty,
  total_net_weight_kg, total_gross_weight_kg, total_volume_cbm,
  volume_utilisation, weight_utilisation,
  finalised_at IS NOT NULL AS is_finalised
FROM clp
WHERE status = 'FINAL'
ORDER BY code;

\echo '--- 3. a checksum over every plan (must not change) ---'
SELECT
  count(*)                              AS plans,
  COALESCE(sum(total_ctn_qty), 0)       AS ctn,
  COALESCE(sum(total_volume_cbm), 0)    AS cbm,
  COALESCE(sum(total_gross_weight_kg),0) AS gross_kg,
  md5(string_agg(
        code || '|' || status || '|' || COALESCE(container_no,'') || '|' ||
        COALESCE(total_volume_cbm::text,'') || '|' ||
        COALESCE(total_gross_weight_kg::text,''), ',' ORDER BY id)) AS fingerprint
FROM clp;

\echo '--- 4. allocation lines (must not change) ---'
SELECT
  count(*)                          AS lines,
  COALESCE(sum(ctn_qty), 0)         AS ctn,
  COALESCE(sum(volume_cbm), 0)      AS cbm,
  md5(string_agg(
        id::text || '|' || ctn_qty::text || '|' ||
        COALESCE(volume_cbm::text,'') || '|' ||
        COALESCE(gross_weight_kg::text,''), ',' ORDER BY id)) AS fingerprint
FROM clp_line
WHERE deleted_at IS NULL;

\echo '--- 5. audit history depth (must only grow, never shrink) ---'
SELECT table_name, count(*) AS entries
FROM audit_log
WHERE table_name IN ('clp','clp_line','clp_booking')
GROUP BY table_name ORDER BY table_name;

\echo '--- 6. clp_booking: 0 before, one per plan after ---'
SELECT
  (SELECT count(*) FROM clp WHERE shipment_id IS NOT NULL) AS plans_with_a_booking,
  (SELECT count(*) FROM clp_booking)                        AS clp_booking_rows,
  (SELECT count(*) FROM clp_booking cb
     JOIN clp c ON c.id = cb.clp_id AND c.shipment_id = cb.shipment_id) AS rows_matching_their_plan;

\echo '--- 7. nothing orphaned, nothing cross-tenant ---'
SELECT
  (SELECT count(*) FROM clp_booking cb LEFT JOIN clp c ON c.id = cb.clp_id
     WHERE c.id IS NULL)                                  AS orphaned_bookings,
  (SELECT count(*) FROM clp_booking cb JOIN clp c ON c.id = cb.clp_id
     WHERE c.tenant_id <> cb.tenant_id)                   AS tenant_mismatches,
  (SELECT count(*) FROM clp_booking cb JOIN shipment s ON s.id = cb.shipment_id
     WHERE s.tenant_id <> cb.tenant_id)                   AS shipment_tenant_mismatches;

\echo '--- 8. LCL billing basis follows the rule ---'
SELECT billing_basis, count(*) AS lines,
       count(*) FILTER (WHERE received_volume_cbm IS NOT NULL) AS with_measurement
FROM cargo_receipt_line
WHERE deleted_at IS NULL
GROUP BY billing_basis ORDER BY billing_basis;
