import { freightCertificateLabels } from '@ff/shared';
import PDFDocument from 'pdfkit';

/**
 * The Freight Certificate — laid out as the client's sample of 2026-10-18
 * draws it: Ref No and DT across the top, the title, one sentence, a ruled
 * table of the shipment, then the closing lines and "For and on behalf of".
 *
 * The sample carries no letterhead: it is printed on the company's own pad,
 * so the top of the page is left for it. Every word that names the shipment
 * arrives as data; this file supplies only the frame and the sample's fixed
 * wording.
 */

export interface FreightCertificatePdfInput {
  companyName: string;
  refNo: string;
  /** YYYY-MM-DD; printed DD.MM.YYYY as the sample does. */
  certificateDate: string;
  isAir: boolean;
  shipperText: string;
  packages: string | null;
  commodity: string | null;
  commercialInvoiceNo: string | null;
  commercialInvoiceDate: string | null;
  expNo: string | null;
  expDate: string | null;
  blNo: string | null;
  lcNo: string | null;
  portOfLoading: string | null;
  portOfDelivery: string | null;
  /** US dollars, as stored ("1234.5000"). */
  amount: string;
  amountInWords: string;
  /** Base units per dollar; null when the base IS the dollar and there is nothing to convert. */
  conversionRate: string | null;
  baseCurrencyCode: string;
}

const INK = '#000000';
const RULE = '#BFBFBF';
const STRIPE = '#F2F2F2';

/** "2026-10-18" → "18.10.2026". */
function dotted(date: string | null): string {
  if (date === null || date === '') return '';
  const [y, m, d] = date.split('-');
  return `${d}.${m}.${y}`;
}

/** "1234.5000" → "1,234.50". */
function dollars(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value;
}

/** "84.9500000000" → "84.95": a rate reads as typed, not padded to ten places. */
function rateText(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

export function renderFreightCertificatePdf(input: FreightCertificatePdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const labels = freightCertificateLabels(input.isAir);

    // ------------------------------------------------- Ref No · DT (the pad's header sits above)
    let y = 96;
    doc.font('Times-Bold').fontSize(11).fillColor(INK);
    doc.text(`Ref No : ${input.refNo}`, left, y, { width: width / 2, lineBreak: false });
    doc.text(`DT: ${dotted(input.certificateDate)}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });

    y += 62;
    doc.font('Times-Bold').fontSize(12).text('FREIGHT CERTIFICATE', left, y, { width, align: 'center', underline: true });

    y = doc.y + 18;
    doc.font('Times-Roman').fontSize(11).text(
      'This is to certify that this freight certificate is applicable for below shipment.',
      left,
      y,
      { width },
    );

    // ------------------------------------------------------------- the table
    y = doc.y + 22;
    const labelWidth = 200;
    const pad = 6;
    const valueLeft = left + labelWidth;
    const valueWidth = width - labelWidth;
    // The two dated rows split the value cell: number · "Date:" · date.
    const dateLabelWidth = 50;
    const dateWidth = 90;
    const numberWidth = valueWidth - dateLabelWidth - dateWidth;

    type Row =
      | { label: string; bold?: boolean; value: string }
      | { label: string; bold?: boolean; number: string; date: string };

    const rows: Row[] = [
      { label: 'Shipper / Exporter Name: and Address', value: input.shipperText },
      { label: 'Cartons/Bales :', value: input.packages ?? '' },
      { label: 'Commodity :', value: input.commodity ?? '' },
      { label: 'Invoice No :', bold: true, number: input.commercialInvoiceNo ?? '', date: dotted(input.commercialInvoiceDate) },
      { label: 'Exp No :', number: input.expNo ?? '', date: dotted(input.expDate) },
      { label: `${labels.blNo} :`, value: input.blNo ?? '' },
      { label: 'LC/TT/Sales Contract No:', value: input.lcNo ?? '' },
      { label: `${labels.portOfLoading}:`, value: input.portOfLoading ?? '' },
      { label: `${labels.portOfDelivery}:`, value: input.portOfDelivery ?? '' },
      {
        label: `${labels.charges}:`,
        value: `Figure USD : ${dollars(input.amount)}\nIn word  : ${input.amountInWords}`,
      },
    ];

    const labelFont = (bold: boolean | undefined) => doc.font(bold === true ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    const valueFont = () => doc.font('Times-Roman').fontSize(11);

    rows.forEach((row, index) => {
      labelFont(row.bold);
      const labelHeight = doc.heightOfString(row.label, { width: labelWidth - pad * 2, align: 'right' });
      valueFont();
      const valueHeight =
        'value' in row
          ? doc.heightOfString(row.value === '' ? ' ' : row.value, { width: valueWidth - pad * 2 })
          : doc.heightOfString(row.number === '' ? ' ' : row.number, { width: numberWidth - pad * 2 });
      const height = Math.max(labelHeight, valueHeight, 14) + pad * 2;

      if (y + height > doc.page.height - doc.page.margins.bottom - 120) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      // The sample's grey band on every other row.
      if (index % 2 === 1) doc.rect(left, y, width, height).fillColor(STRIPE).fill();
      doc.lineWidth(0.75).strokeColor(RULE);
      doc.rect(left, y, width, height).stroke();
      doc.moveTo(valueLeft, y).lineTo(valueLeft, y + height).stroke();

      labelFont(row.bold);
      doc.fillColor(INK).text(row.label, left + pad, y + pad, { width: labelWidth - pad * 2, align: 'right' });

      valueFont();
      if ('value' in row) {
        doc.text(row.value, valueLeft + pad, y + pad, { width: valueWidth - pad * 2 });
      } else {
        const dateLabelLeft = valueLeft + numberWidth;
        const dateLeft = dateLabelLeft + dateLabelWidth;
        doc.moveTo(dateLabelLeft, y).lineTo(dateLabelLeft, y + height).stroke();
        doc.moveTo(dateLeft, y).lineTo(dateLeft, y + height).stroke();
        doc.text(row.number, valueLeft + pad, y + pad, { width: numberWidth - pad * 2 });
        doc.text('Date:', dateLabelLeft + pad, y + pad, { width: dateLabelWidth - pad * 2, lineBreak: false });
        doc.text(row.date, dateLeft + pad, y + pad, { width: dateWidth - pad * 2, lineBreak: false });
      }
      y += height;
    });

    // ------------------------------------------------------------ the close
    y += 34;
    doc.font('Times-Roman').fontSize(11).fillColor(INK);
    doc.text('This certificate has been issued without any prejudice.', left, y, { width });
    if (input.conversionRate !== null) {
      y = doc.y + 16;
      doc.text(`Conversion Rate : 1 USD = ${rateText(input.conversionRate)} ${input.baseCurrencyCode}`, left, y, { width });
    }

    y = doc.y + 56;
    doc.font('Times-Bold').text('For and on behalf of', left, y, { width });
    // Room for the wet-ink signature and the seal.
    y = doc.y + 52;
    doc.text(input.companyName.toUpperCase(), left, y, { width });

    doc.end();
  });
}
