import { z } from 'zod';

/**
 * Freight Certificate — the client's sample of 2026-10-18 ("Ref No :
 * TSL-2021-201", "FREIGHT CERTIFICATE").
 *
 * A letter for the shipper, usually for their bank, certifying what the freight
 * and local charges on one shipment came to. Made from an issued freight debit
 * invoice, one per invoice. Decided with the client on 2026-10-18:
 *
 *   - it is saved, with its own number, and can be opened and printed again
 *   - Invoice No, Exp No and LC/TT/Sales Contract No are typed on it (the
 *     product records them nowhere else); everything else starts from the
 *     booking and stays editable
 *   - the figure is the invoice total in US dollars, worked out by the server
 *   - sea and air both; air reads Air Freight, Air Waybill and Airport
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.');

/** A box left empty is not stated — stored as null, never as ''. */
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .nullish()
    .transform((v) => (v === '' || v === undefined ? null : v));

const optionalDate = z
  .union([isoDate, z.literal('')])
  .nullish()
  .transform((v) => (v === '' || v === undefined ? null : v));

/** What the operator writes. The dollar figure and rate are the server's. */
export const freightCertificateSaveSchema = z.object({
  certificateDate: isoDate,
  shipperText: z
    .string()
    .trim()
    .min(1, 'Enter the shipper or exporter name and address.')
    .max(2000, 'Keep the name and address under 2,000 characters.'),
  packages: optionalText(200, 'Keep Cartons/Bales under 200 characters.'),
  commodity: optionalText(1000, 'Keep the commodity under 1,000 characters.'),
  commercialInvoiceNo: optionalText(100, 'Keep the invoice number under 100 characters.'),
  commercialInvoiceDate: optionalDate,
  expNo: optionalText(100, 'Keep the EXP number under 100 characters.'),
  expDate: optionalDate,
  blNo: optionalText(64, 'Keep the number under 64 characters.'),
  lcNo: optionalText(200, 'Keep the LC/TT/Sales Contract No under 200 characters.'),
  portOfLoading: optionalText(500, 'Keep the port under 500 characters.'),
  portOfDelivery: optionalText(500, 'Keep the port under 500 characters.'),
});
export type FreightCertificateSaveInput = z.input<typeof freightCertificateSaveSchema>;
export type FreightCertificateSaveData = z.output<typeof freightCertificateSaveSchema>;

/** The written part of a certificate, as stored and as the form holds it. */
export type FreightCertificateFields = FreightCertificateSaveData;

/** The labels that differ between a sea and an air shipment. */
export function freightCertificateLabels(isAir: boolean): {
  charges: string;
  blNo: string;
  portOfLoading: string;
  portOfDelivery: string;
} {
  return isAir
    ? {
        charges: 'Air Freight & Local Charges',
        blNo: 'Air Waybill No',
        portOfLoading: 'Airport of loading',
        portOfDelivery: 'Airport of destination',
      }
    : {
        charges: 'Ocean Freight & Local Charges',
        blNo: 'Bill of Lading no',
        portOfLoading: 'Port of loading',
        portOfDelivery: 'Port of delivery',
      };
}

/** The dollar figure, as stored on a certificate or as saving one would record it. */
export interface FreightCertificateFigureDto {
  /** "Figure USD". */
  amount: string;
  /** "In word". */
  amountInWords: string;
  /** "1 USD = n BDT": base units per dollar. */
  conversionRate: string;
  baseCurrencyCode: string;
}

export interface FreightCertificateDto extends FreightCertificateFigureDto {
  id: string;
  /** "Ref No". */
  code: string;
  fields: FreightCertificateFields;
  updatedAt: string;
}

/** What the Freight Certificate screen opens on. */
export interface FreightCertificateViewDto {
  debitInvoiceId: string;
  debitInvoiceCode: string;
  bookingCode: string;
  customerName: string;
  isAir: boolean;
  /** Null until one is made. */
  certificate: FreightCertificateDto | null;
  /** The form's starting values: the certificate's own, or what the booking says. */
  fields: FreightCertificateFields;
  /** The certificate's stored figure, or what making one now would record. */
  figure: FreightCertificateFigureDto;
  /** Null while it can be made or changed; otherwise why not. */
  lockedReason: string | null;
  /** There is a certificate, and its invoice still stands. */
  printable: boolean;
}
