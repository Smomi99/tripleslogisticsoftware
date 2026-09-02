import { SHIPMENT_STATUS_LABEL, type ShipmentActivityDto, type ShipmentStatus } from '@ff/shared';

import type { TenantDb } from './tenant-client';

/**
 * §6.3's Activities tab — the audit trail of a shipment file, read as sentences.
 *
 * Nothing here writes anything. `app_audit_row()` has been recording every
 * change since the tables existed; this reads that trail back and describes it,
 * because "UPDATE, old_values {...}, new_values {...}" is a developer's view of
 * a booking and the operations team needs "Status: Booking received → Vessel
 * proposed".
 *
 * The describing lives on the server rather than the screen for one reason: the
 * JSONB columns hold raw row snapshots, and shipping those to a browser would
 * put every column of every version of the record — including ones a user may
 * not be allowed to see — into a network response nobody filtered.
 */

/** The tables whose changes belong on this shipment's file. */
const CHILD_TABLES = [
  'shipment_po',
  'shipment_cargo_line',
  'shipment_commodity',
  'shipment_schedule',
  'shipment_schedule_leg',
] as const;

interface AuditRow {
  id: bigint;
  table_name: string;
  action: string;
  created_at: Date;
  actor_name: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

const str = (row: Record<string, unknown> | null, key: string): string | null => {
  const value = row?.[key];
  return value === null || value === undefined ? null : String(value);
};

/** `Booking received → Vessel proposed`, or null when the status held still. */
function statusChange(row: AuditRow): string | null {
  const before = str(row.old_values, 'status');
  const after = str(row.new_values, 'status');
  if (before === null || after === null || before === after) return null;
  const label = (s: string): string =>
    SHIPMENT_STATUS_LABEL[s as ShipmentStatus] ?? s.toLowerCase().replace(/_/g, ' ');
  return `${label(before)} → ${label(after)}`;
}

/**
 * One audit row, as a sentence and an optional before/after.
 *
 * Falls back to a plain description rather than hiding a row it does not
 * recognise: a trail with silent gaps is worse than one with a dull line in it.
 */
function describe(row: AuditRow): { summary: string; detail: string | null } {
  const created = row.action === 'CREATE';
  const removed = row.action === 'DELETE';

  switch (row.table_name) {
    case 'shipment': {
      if (created) return { summary: 'Booking created', detail: null };
      if (removed) return { summary: 'Booking deleted', detail: null };

      const moved = statusChange(row);
      if (moved !== null) {
        /*
         * Whichever reason the new status carries. §5.1's cancellation and
         * §5.5 rule 5's short close each have their own column, and the trail
         * is where both are read from — §5.5 says of the short close in as many
         * words that "the trail is the answer".
         */
        const reason =
          str(row.new_values, 'cancel_reason') ?? str(row.new_values, 'short_close_reason');
        return { summary: `Status changed`, detail: reason === null ? moved : `${moved} — ${reason}` };
      }
      const submitted =
        str(row.old_values, 'submitted_at') === null && str(row.new_values, 'submitted_at') !== null;
      if (submitted) return { summary: 'Booking submitted', detail: null };
      return { summary: 'Booking details edited', detail: null };
    }

    case 'shipment_po': {
      const poNo = str(row.new_values, 'po_no') ?? str(row.old_values, 'po_no') ?? '—';
      if (created) return { summary: `PO ${poNo} added`, detail: null };
      if (removed) return { summary: `PO ${poNo} removed`, detail: null };

      const before = str(row.old_values, 'approval_status');
      const after = str(row.new_values, 'approval_status');
      if (before !== after && after !== null) {
        const comments = str(row.new_values, 'rejection_comments');
        return {
          summary: `PO ${poNo} ${after.toLowerCase()}`,
          detail: comments,
        };
      }
      return { summary: `PO ${poNo} edited`, detail: null };
    }

    case 'shipment_cargo_line': {
      const item = str(row.new_values, 'item_code') ?? str(row.old_values, 'item_code') ?? '—';
      const sku = str(row.new_values, 'sku') ?? str(row.old_values, 'sku');
      const name = sku === null ? item : `${item} / ${sku}`;
      if (created) return { summary: `Cargo line ${name} added`, detail: null };
      if (removed) return { summary: `Cargo line ${name} removed`, detail: null };
      return { summary: `Cargo line ${name} edited`, detail: null };
    }

    case 'shipment_commodity':
      return {
        summary: created ? 'Commodity added' : removed ? 'Commodity removed' : 'Commodity edited',
        detail: null,
      };

    case 'shipment_schedule': {
      const version = str(row.new_values, 'version_no') ?? str(row.old_values, 'version_no') ?? '?';
      if (created) return { summary: `Schedule v${version} proposed`, detail: null };
      if (removed) return { summary: `Schedule v${version} removed`, detail: null };

      const before = str(row.old_values, 'status');
      const after = str(row.new_values, 'status');
      if (before !== after && after !== null) {
        return {
          summary: `Schedule v${version} ${after.toLowerCase()}`,
          detail: str(row.new_values, 'rejection_comments'),
        };
      }
      return { summary: `Schedule v${version} edited`, detail: null };
    }

    case 'shipment_schedule_leg': {
      const legNo = str(row.new_values, 'leg_no') ?? str(row.old_values, 'leg_no') ?? '?';
      return {
        summary: created
          ? `Schedule leg ${legNo} added`
          : removed
            ? `Schedule leg ${legNo} removed`
            : `Schedule leg ${legNo} edited`,
        detail: null,
      };
    }

    default:
      return { summary: `${row.table_name} ${row.action.toLowerCase()}`, detail: null };
  }
}

/**
 * The file's whole history, newest first.
 *
 * Child ids are gathered first because the trail is keyed by (table, record) —
 * a cargo line's audit row knows nothing about the shipment it belonged to, and
 * looking them up is cheaper than denormalising a shipment_id onto audit_log
 * for one screen.
 */
export async function shipmentActivities(
  db: TenantDb,
  shipmentId: bigint,
  limit = 200,
): Promise<ShipmentActivityDto[]> {
  const [pos, lines, commodities, schedules] = await Promise.all([
    db.shipmentPo.findMany({ where: { shipmentId }, select: { id: true } }),
    db.shipmentCargoLine.findMany({ where: { shipmentId }, select: { id: true } }),
    db.shipmentCommodity.findMany({ where: { shipmentId }, select: { id: true } }),
    db.shipmentSchedule.findMany({ where: { shipmentId }, select: { id: true } }),
  ]);
  const legs =
    schedules.length === 0
      ? []
      : await db.shipmentScheduleLeg.findMany({
          where: { scheduleId: { in: schedules.map((s) => s.id) } },
          select: { id: true },
        });

  const idsByTable: Record<(typeof CHILD_TABLES)[number], bigint[]> = {
    shipment_po: pos.map((r) => r.id),
    shipment_cargo_line: lines.map((r) => r.id),
    shipment_commodity: commodities.map((r) => r.id),
    shipment_schedule: schedules.map((r) => r.id),
    shipment_schedule_leg: legs.map((r) => r.id),
  };

  // One flat list of (table, record) pairs, as two parallel arrays — a single
  // query beats six, and the (tenant_id, table_name, record_id) index covers it.
  const tables: string[] = ['shipment'];
  const records: bigint[] = [shipmentId];
  for (const table of CHILD_TABLES) {
    for (const id of idsByTable[table]) {
      tables.push(table);
      records.push(id);
    }
  }

  const rows = await db.$queryRaw<AuditRow[]>`
    SELECT a.id, a.table_name, a.action::text AS action, a.created_at,
           u.username AS actor_name,
           a.old_values, a.new_values
      FROM audit_log a
      LEFT JOIN "user" u ON u.id = a.changed_by
     WHERE (a.table_name, a.record_id) IN (
             SELECT * FROM unnest(${tables}::text[], ${records}::bigint[])
           )
     ORDER BY a.id DESC
     LIMIT ${limit}
  `;

  return rows.map((row) => {
    const { summary, detail } = describe(row);
    return {
      id: row.id.toString(),
      at: row.created_at.toISOString(),
      actorName: row.actor_name,
      summary,
      detail,
    };
  });
}
