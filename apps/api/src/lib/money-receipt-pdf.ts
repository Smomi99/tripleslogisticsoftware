import PDFDocument from 'pdfkit';

/**
 * The Money Receipt — what the customer is handed for money received
 * (client, 2026-10-28: on the debit invoice, once money is received and
 * saved, a `Money receipt` button prints it).
 *
 * No sheet draws it, so it carries what a receipt conventionally does and
 * nothing the record does not hold: the letterhead, the receipt no (the
 * Income voucher's own RV no — no second numbering), the date, who paid, the
 * sum in figures and in words, how it was paid, what it settled, and the
 * signature. Laid out like the Debit Invoice it pays.
 *
 * Every figure is the one the voucher stored, never re-added here.
 */

export interface MoneyReceiptPdfInput {
  companyName: string;
  logo: Buffer | null;

  receiptNo: string;
  /** YYYY-MM-DD. */
  receiptDate: string;

  receivedFrom: string;
  address: string | null;

  /** What the payer paid, in the currency they paid it in. */
  currencyCode: string;
  amount: string;
  amountInWords: string;
  /** When that is not the workspace's base: what the books took it in at. Null otherwise. */
  baseEquivalent: { baseCurrencyCode: string; amount: string } | null;

  /** "Cash", or "Bank — Bank Asia Plc-878": where the money went in. */
  paidBy: string;
  /** "Debit Note DN-2026-000014 dated 05-Oct-2026", "Opening balance". Null when it settled nothing. */
  against: string | null;
  /** The booking the invoice is for, when it is for one. */
  bookingNo: string | null;
  description: string | null;
}

const HULL = '#10243A';
const STEEL = '#6B7A88';
const LINE = '#DDE3E3';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-05" → "05-Oct-2026", the statements' date style. */
export function receiptDay(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

/** "1234.5000" → "1,234.50". */
function figure(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value;
}

export function renderMoneyReceiptPdf(input: MoneyReceiptPdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // ---------------------------------------------------------- letterhead
    let headerX = left;
    if (input.logo !== null) {
      try {
        doc.image(input.logo, left, 36, { fit: [110, 44] });
        headerX = left + 122;
      } catch {
        // An unreadable logo is not a reason to withhold the receipt.
        headerX = left;
      }
    }
    doc.font('Helvetica-Bold').fontSize(16).fillColor(HULL).text(input.companyName, headerX, 40);

    let y = Math.max(doc.y, 84) + 10;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(HULL).text('MONEY RECEIPT', left, y, { width, align: 'center' });

    // ------------------------------------------------------ Receipt No · Date
    y = doc.y + 14;
    doc.font('Helvetica').fontSize(8).fillColor(STEEL);
    doc.text('RECEIPT NO', left, y, { width: width / 2, lineBreak: false });
    doc.text('DATE', left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
    y += 11;
    doc.font('Courier-Bold').fontSize(11).fillColor(HULL);
    doc.text(input.receiptNo, left, y, { width: width / 2, lineBreak: false });
    doc.text(receiptDay(input.receiptDate), left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
    y += 20;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(LINE).stroke();

    // ------------------------------------------------------------ the body
    const labelWidth = 150;
    const row = (label: string, value: string, mono = false): void => {
      y += 10;
      doc.font('Helvetica').fontSize(9).fillColor(STEEL).text(label, left, y, { width: labelWidth });
      doc
        .font(mono ? 'Courier' : 'Helvetica')
        .fontSize(10)
        .fillColor(HULL)
        .text(value, left + labelWidth, y, { width: width - labelWidth });
      y = Math.max(doc.y, y + 12);
    };

    row('Received with thanks from', input.receivedFrom);
    if (input.address !== null && input.address.trim() !== '') row('Address', input.address);
    row('The sum of', input.amountInWords);
    row('Paid by', input.paidBy);
    if (input.against !== null) row('Against', input.against);
    if (input.bookingNo !== null) row('Booking No', input.bookingNo, true);
    if (input.description !== null && input.description.trim() !== '') row('Description', input.description);

    // ---------------------------------------------------- the amount, boxed
    y += 18;
    const boxWidth = 220;
    const boxLeft = right - boxWidth;
    const boxHeight = input.baseEquivalent === null ? 40 : 56;
    doc.rect(boxLeft, y, boxWidth, boxHeight).lineWidth(1).strokeColor(HULL).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(STEEL).text('AMOUNT', boxLeft + 10, y + 8, { width: boxWidth - 20 });
    doc
      .font('Courier-Bold')
      .fontSize(14)
      .fillColor(HULL)
      .text(`${input.currencyCode} ${figure(input.amount)}`, boxLeft + 10, y + 19, { width: boxWidth - 20, align: 'right' });
    if (input.baseEquivalent !== null) {
      doc
        .font('Courier')
        .fontSize(9)
        .fillColor(STEEL)
        .text(`= ${input.baseEquivalent.baseCurrencyCode} ${figure(input.baseEquivalent.amount)}`, boxLeft + 10, y + 38, {
          width: boxWidth - 20,
          align: 'right',
        });
    }
    y += boxHeight;

    // ------------------------------------------------------------ the close
    y += 70;
    const signWidth = 180;
    doc.moveTo(left, y).lineTo(left + signWidth, y).lineWidth(0.75).strokeColor(HULL).stroke();
    doc.moveTo(right - signWidth, y).lineTo(right, y).stroke();
    doc.font('Helvetica').fontSize(9).fillColor(HULL);
    doc.text("Payer's signature", left, y + 6, { width: signWidth });
    doc.text(`For ${input.companyName}`, right - signWidth, y + 6, { width: signWidth, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor(STEEL).text('Authorised signature', right - signWidth, doc.y + 2, { width: signWidth, align: 'right' });

    doc.end();
  });
}
