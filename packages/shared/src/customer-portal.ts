import type { DebitInvoiceKind, DebitInvoiceStatus } from './accounts';
import type { BlDraftStatus } from './documentation';
import type { LoadingType, MovementType, ShipmentType } from './inquiry';
import type { QuotationStatus } from './quotation';
import type { ShipmentStatus, ShippingOrderStatus } from './shipment';

/**
 * The customer portal's My Shipments page (owner, 2026-11-26): one tab per
 * kind of record, each the signed-in customer's own.
 *
 * Every row here is read from a `customer_*_v` view, and each view names the
 * columns a customer may see (migration 20261126100000). A field added to one
 * of these types has to be added to its view first, which is the point: the
 * column boundary is decided in SQL, once, not in each route.
 *
 * BigInt ids cross the wire as strings; dates as ISO strings.
 */

/** The tabs, in the order the owner listed them. */
export const PORTAL_TABS = [
  'INQUIRY',
  'QUOTATION',
  'BOOKING',
  'APPROVAL',
  'SHIPPING_ORDER',
  'CARGO_RECEIPT',
  'ADVISE',
  'BL',
  'INVOICE',
] as const;
export type PortalTab = (typeof PORTAL_TABS)[number];

export const PORTAL_TAB_LABEL: Record<PortalTab, string> = {
  INQUIRY: 'Inquiry',
  QUOTATION: 'Quotation',
  BOOKING: 'Booking',
  APPROVAL: 'Awaiting approval',
  SHIPPING_ORDER: 'Shipping Order',
  CARGO_RECEIPT: 'Cargo Receipt',
  ADVISE: 'Shipment Advise',
  BL: 'BL',
  INVOICE: 'Invoice',
};

/** The permission that shows each tab. */
export const PORTAL_TAB_PERMISSION: Record<PortalTab, string> = {
  INQUIRY: 'CUSTOMER.INQUIRY.VIEW',
  QUOTATION: 'CUSTOMER.QUOTATION.VIEW',
  BOOKING: 'CUSTOMER.SHIPMENT.VIEW',
  APPROVAL: 'CUSTOMER.APPROVAL.VIEW',
  SHIPPING_ORDER: 'CUSTOMER.SHIPPING_ORDER.VIEW',
  CARGO_RECEIPT: 'CUSTOMER.CARGO_RECEIPT.VIEW',
  ADVISE: 'CUSTOMER.ADVISE.VIEW',
  BL: 'CUSTOMER.BL_DRAFT.VIEW',
  INVOICE: 'CUSTOMER.INVOICE.VIEW',
};

/**
 * An inquiry as the customer reads it. The forwarder's working states (sent to
 * agents for a price, priced from a rate) are one state from outside: the
 * view folds them into IN_PROGRESS, so they never reach the wire.
 */
export const PORTAL_INQUIRY_STATUSES = [
  'IN_PROGRESS',
  'QUOTED',
  'CONFIRMED',
  'CLOSED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type PortalInquiryStatus = (typeof PORTAL_INQUIRY_STATUSES)[number];

export const PORTAL_INQUIRY_STATUS_LABEL: Record<PortalInquiryStatus, string> = {
  IN_PROGRESS: 'In progress',
  QUOTED: 'Quoted',
  CONFIRMED: 'Confirmed',
  CLOSED: 'Closed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

/**
 * A quotation's status in the customer's words. SUPERSEDED is a revision they
 * were sent and that a later one replaced.
 */
export const PORTAL_QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  ACCEPTED: 'Accepted',
  REJECTED: 'Declined',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Replaced by a revision',
  CANCELLED: 'Withdrawn',
};

export interface PortalInquiryRow {
  id: string;
  code: string;
  inquiryDate: string;
  shipmentType: ShipmentType;
  movementType: MovementType;
  loadingType: LoadingType | null;
  polName: string;
  podName: string;
  expectedShipmentDate: string | null;
  validTo: string | null;
  status: PortalInquiryStatus;
}

export interface PortalQuotationRow {
  id: string;
  code: string;
  revisionNo: number;
  inquiryCode: string | null;
  quotationDate: string;
  validityDate: string | null;
  shipmentType: ShipmentType;
  movementType: MovementType;
  polName: string;
  podName: string;
  status: QuotationStatus;
}

/** One booking on the Booking tab — the customer's own shipment list. */
export interface PortalShipmentRow {
  id: string;
  code: string;
  shipmentType: ShipmentType;
  status: ShipmentStatus;
  exporterName: string | null;
  importerName: string | null;
  polName: string;
  podName: string;
  etd: string | null;
  eta: string | null;
}

/** A booking whose proposed sailing waits on the customer's decision. */
export interface PortalApprovalRow {
  id: string;
  code: string;
  shipmentType: ShipmentType;
  polName: string;
  podName: string;
  cutOff: string | null;
  etd: string | null;
  eta: string | null;
  /** Leg 1's voyage (sea) or flight (air). */
  voyageOrFlight: string | null;
  poCount: number;
  approvedCount: number;
  rejectedCount: number;
}

export interface PortalShippingOrderRow {
  id: string;
  code: string;
  bookingCode: string;
  shipmentType: ShipmentType;
  polName: string;
  podName: string;
  issueDate: string | null;
  /** The first vessel's name at issue (sea) or the first flight (air). */
  vesselOrFlight: string | null;
  cutOff: string | null;
  etd: string | null;
  eta: string | null;
  warehouseCfs: string | null;
  status: ShippingOrderStatus;
}

export interface PortalCargoReceiptRow {
  id: string;
  code: string;
  bookingCode: string;
  shipmentType: ShipmentType;
  receiptSeq: number;
  receiveDate: string;
  ctnQty: number;
  pcsQty: number | null;
  grossWeightKg: string | null;
  volumeCbm: string | null;
}

export interface PortalAdviseRow {
  id: string;
  code: string;
  shipmentType: ShipmentType;
  /** CR-005: one advise may cover several of the customer's bookings. */
  bookingCodes: string;
  polName: string;
  podName: string;
  etd: string | null;
  eta: string | null;
  houseBlNo: string;
  mblNo: string | null;
  status: 'SENT' | 'CANCELLED';
  sentAt: string | null;
}

/** One bill — numbered by a sent advise (MODULE_DOCUMENTATION §3.3). */
export interface PortalBillRow {
  /** The advise that numbers the bill. */
  id: string;
  /** The advise's own booking: the BL draft screen opens from it. */
  shipmentId: string;
  shipmentType: ShipmentType;
  blNo: string;
  bookingCodes: string;
  polName: string;
  podName: string;
  /** Null until somebody starts the draft. */
  draftStatus: BlDraftStatus | null;
  /** BL Print's issue (§13). A copy prints from here on. */
  issuedAt: string | null;
}

export interface PortalInvoiceRow {
  id: string;
  code: string;
  kind: DebitInvoiceKind;
  bookingCode: string | null;
  invoiceDate: string;
  currencyCode: string;
  totalAmount: string;
  status: Exclude<DebitInvoiceStatus, 'DRAFT'>;
}
