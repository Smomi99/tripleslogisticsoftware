import { z } from 'zod';

import { listQuerySchema } from './api';
import { type MovementType, SHIPMENT_TYPES, type ShipmentType } from './inquiry';
import { MILESTONE_SORT_FIELDS, type MilestoneRow } from './milestone';

/**
 * Documentation → Copy Doc upload (docs/DESIGN-UPDATE-2026-10-28.md §3). The
 * sheet `Copy doc upload`, titled "Shipping Documens upload": a booking row
 * for sea and air, inbound and outbound, and `Upload Doc` opening nine papers,
 * each "browse and upload" — and two more the client added on 2026-10-28.
 */

/** C16–C24, in the sheet's order, then the client's two additions (2026-10-28). */
export const COPY_DOCUMENT_KINDS = [
  'HOUSE_BL',
  'MASTER_BL',
  'CO',
  'COMMERCIAL_INVOICE',
  'PACKING_LIST',
  'GSP',
  'EXP',
  'IGM',
  'DELIVERY_ORDER',
  'CNF_CERTIFICATE',
  'ENCASHMENT_CERTIFICATE',
] as const;
export type CopyDocumentKind = (typeof COPY_DOCUMENT_KINDS)[number];

const LABEL: Record<CopyDocumentKind, string> = {
  HOUSE_BL: 'House bill of lading',
  MASTER_BL: 'Master bill of lading',
  CO: 'Certificate of origin (CO)',
  COMMERCIAL_INVOICE: 'Commercial invoice',
  PACKING_LIST: 'Packing list',
  GSP: 'GSP certificate',
  EXP: 'EXP form',
  IGM: 'IGM',
  DELIVERY_ORDER: 'Delivery order',
  CNF_CERTIFICATE: 'C&F certificate',
  ENCASHMENT_CERTIFICATE: 'Encashment certificate',
};

/** On air the bills are air waybills. */
export function copyDocumentLabel(kind: CopyDocumentKind, shipmentType: ShipmentType): string {
  if (shipmentType === 'AIR' && kind === 'HOUSE_BL') return 'House air waybill (HAWB)';
  if (shipmentType === 'AIR' && kind === 'MASTER_BL') return 'Master air waybill (MAWB)';
  return LABEL[kind];
}

export const COPY_DOC_DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const;

/** The sheet lists both modes and both directions in one list; these narrow it. */
export const copyDocListQuerySchema = listQuerySchema.extend({
  shipmentType: z.enum(SHIPMENT_TYPES).optional(),
  movementType: z.enum(COPY_DOC_DIRECTIONS).optional(),
  sortBy: z.enum(MILESTONE_SORT_FIELDS).optional(),
});

export const copyDocumentKindSchema = z.object({
  kind: z.enum(COPY_DOCUMENT_KINDS, { message: 'Choose which document this is.' }),
});

/**
 * Where a document on file came from. UPLOAD is a copy uploaded here; SYSTEM is
 * the paper the system already holds, shown until a copy is uploaded.
 */
export type CopyDocumentSource = 'UPLOAD' | 'SYSTEM';

export interface CopyDocumentDto {
  kind: CopyDocumentKind;
  label: string;
  /** Null when nothing is on file. */
  source: CopyDocumentSource | null;
  fileName: string | null;
  /** Where a SYSTEM document comes from, or what to do when there is none. */
  note: string | null;
  uploadedAt: string | null;
  uploadedByName: string | null;
}

export interface CopyDocRow extends MilestoneRow {
  /** F6 "Importer". */
  importerName: string | null;
  /** G6 "Commodity". */
  commodity: string | null;
  /** L6 "House BL No": the advise's, or IGM Update's HBL No on an inbound booking without one. */
  houseBlNo: string | null;
  /** M6 "MBL No". */
  mblNo: string | null;
  movementType: MovementType;
  /** How many of the papers are on file, uploaded or held by the system. */
  onFile: number;
}

export interface CopyDocDetailDto {
  shipmentId: string;
  bookingCode: string;
  shipmentType: ShipmentType;
  documents: CopyDocumentDto[];
}
