/**
 * Drawing the letterhead, kept apart from lib/letterhead.ts so the PDF
 * renderers stay pure: they import this, never storage or the database.
 */

/**
 * Draws the letterhead's detail lines under the name and returns the y they
 * end at — `y` itself when there are none, so a layout written for a name
 * alone is unchanged for a workspace that has filled nothing in.
 *
 * Small and grey, one line each: these are for finding the company, not for
 * reading first. A line too long for the width wraps rather than running
 * under whatever sits to its right.
 */
export function drawLetterheadDetails(
  doc: PDFKit.PDFDocument,
  details: readonly string[],
  x: number,
  y: number,
  width: number,
  options: { size?: number; color?: string } = {},
): number {
  if (details.length === 0) return y;
  doc
    .font('Helvetica')
    .fontSize(options.size ?? 8)
    .fillColor(options.color ?? '#6B7A88')
    .text(details.join('\n'), x, y, { width, lineGap: 1 });
  return doc.y;
}
