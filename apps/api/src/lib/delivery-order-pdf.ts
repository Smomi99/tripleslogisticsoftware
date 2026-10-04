import PDFDocument from 'pdfkit';

/**
 * The delivery order letter — docs/DESIGN-UPDATE-2026-10-04.md §4.2.
 *
 * Laid out as the `DO issue` sheet draws it: DATE, then the TO block, then
 * SUBJECT, the operator's own words, and CONTAINER NO. Every word of the
 * letterhead and of the letter arrives as data; the sheet supplies only the
 * frame, so nothing here says what a delivery order should say.
 */

export interface DeliveryOrderPdfInput {
  companyName: string;
  companyAddress: string | null;
  doNo: string;
  issueDate: string;
  addressee: string;
  subject: string;
  body: string | null;
  bookingNo: string;
  hblNo: string | null;
  containers: { containerNo: string | null; size: string | null; sealNo: string | null }[];
}

const HULL = '#10243A';
const STEEL = '#6B7A88';
const LINE = '#DDE3E3';

export function renderDeliveryOrderPdf(input: DeliveryOrderPdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // ---------------------------------------------------------- letterhead
    doc.font('Helvetica-Bold').fontSize(15).fillColor(HULL).text(input.companyName, left, 48, { width: width - 180 });
    if (input.companyAddress !== null && input.companyAddress !== '') {
      doc.font('Helvetica').fontSize(8).fillColor(STEEL).text(input.companyAddress, { width: width - 180 });
    }
    doc.font('Helvetica').fontSize(6.5).fillColor(STEEL).text('DO NO', right - 170, 48, { width: 170, align: 'right' });
    doc.font('Courier-Bold').fontSize(12).fillColor(HULL).text(input.doNo, right - 170, 58, { width: 170, align: 'right' });

    let y = Math.max(doc.y, 96) + 12;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
    y += 18;

    doc.font('Helvetica-Bold').fontSize(13).fillColor(HULL).text('DELIVERY ORDER', left, y, { width });
    y = doc.y + 14;

    // B14 "DATE"
    doc.font('Helvetica').fontSize(10).fillColor(HULL).text(`DATE : ${input.issueDate}`, left, y, { width });
    y = doc.y + 14;

    // B15–B18 "TO …"
    doc.font('Helvetica').fontSize(10).text('TO', left, y, { width });
    doc.font('Helvetica-Bold').text(input.addressee, { width });
    y = doc.y + 14;

    // B20 "SUBJECT :"
    doc.font('Helvetica-Bold').fontSize(10).text(`SUBJECT : ${input.subject}`, left, y, { width });
    y = doc.y + 6;
    const refs = [`Booking ${input.bookingNo}`, input.hblNo === null ? null : `HBL ${input.hblNo}`]
      .filter((v): v is string => v !== null)
      .join('  ·  ');
    doc.font('Helvetica').fontSize(8).fillColor(STEEL).text(refs, left, y, { width });
    y = doc.y + 12;

    if (input.body !== null && input.body !== '') {
      doc.font('Helvetica').fontSize(10).fillColor(HULL).text(input.body, left, y, { width, lineGap: 2 });
      y = doc.y + 16;
    }

    // B30 "CONTAINER NO"
    doc.font('Helvetica-Bold').fontSize(9).fillColor(HULL).text('CONTAINER NO', left, y, { width });
    y = doc.y + 4;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 6;
    const col = { no: left, size: left + 180, seal: left + 280 };
    doc.font('Helvetica').fontSize(6.5).fillColor(STEEL);
    doc.text('CONTAINER', col.no, y, { width: 170, lineBreak: false });
    doc.text('SIZE', col.size, y, { width: 90, lineBreak: false });
    doc.text('SEAL', col.seal, y, { width: 160, lineBreak: false });
    y += 12;
    if (input.containers.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(STEEL).text('No containers on the load plan.', col.no, y, { width });
      y = doc.y + 6;
    }
    for (const c of input.containers) {
      if (y > doc.page.height - doc.page.margins.bottom - 60) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.font('Courier-Bold').fontSize(10).fillColor(HULL).text(c.containerNo ?? '—', col.no, y, { width: 170, lineBreak: false });
      doc.font('Helvetica').fontSize(9).text(c.size ?? '—', col.size, y, { width: 90, lineBreak: false });
      doc.font('Courier').fontSize(9).text(c.sealNo ?? '—', col.seal, y, { width: 160, lineBreak: false });
      y += 15;
    }

    // Signed for the workspace; the signature itself is wet ink.
    y = Math.max(y + 40, doc.y + 40);
    if (y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage();
      y = doc.page.margins.top + 40;
    }
    doc.moveTo(left, y).lineTo(left + 180, y).strokeColor(STEEL).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(STEEL).text(`For ${input.companyName}`, left, y + 4, { width: 240 });

    doc.end();
  });
}
