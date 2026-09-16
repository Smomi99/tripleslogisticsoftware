import zlib from 'node:zlib';

/**
 * Pull the readable text out of a pdfkit buffer.
 *
 * A test-support utility, kept out of the test files because three of them
 * now need it and three copies of a decoder is three chances to decode
 * differently. Nothing in the running application imports this.
 *
 */
/**
 * Pull the readable text out of a pdfkit buffer.
 *
 * Two things make this less obvious than it sounds. The content streams are
 * Flate-compressed, so the words are not in the file as ASCII. And pdfkit
 * writes text as HEX runs inside a kerned TJ array — "CONTAINER LOAD PLAN"
 * ships as `[<434f4e54> 90 <41494e4552204c4f> 50 <414420504c414e>] TJ`, three
 * runs with kerning numbers between them.
 *
 * So: inflate, then decode each hex run, joining the runs WITHIN one TJ array
 * (that is one word broken by kerning) and separating different TJ operators
 * with a newline (those are different pieces of text, and running them
 * together would manufacture matches that are not on the page).
 */
export function extractPdfText(pdf: Buffer): string {
  const pieces: string[] = [];
  let index = 0;

  while (index < pdf.length) {
    const start = pdf.indexOf('stream', index);
    if (start === -1) break;
    let from = start + 'stream'.length;
    if (pdf[from] === 0x0d) from += 1;
    if (pdf[from] === 0x0a) from += 1;
    const end = pdf.indexOf('endstream', from);
    if (end === -1) break;

    let body: string;
    try {
      body = zlib.inflateSync(pdf.subarray(from, end)).toString('latin1');
    } catch {
      body = pdf.subarray(from, end).toString('latin1');
    }

    // Each text-showing operator, with its operand array.
    for (const op of body.matchAll(/\[([^\]]*)\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
      if (op[1] !== undefined) {
        // A kerned array: concatenate its hex and literal runs.
        let run = '';
        for (const part of op[1].matchAll(/<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\)/g)) {
          run += part[1] !== undefined ? fromHex(part[1]) : unescapePdf(part[2] ?? '');
        }
        pieces.push(run);
      } else if (op[2] !== undefined) {
        pieces.push(fromHex(op[2]));
      } else if (op[3] !== undefined) {
        pieces.push(unescapePdf(op[3]));
      }
    }
    index = end + 1;
  }

  return pieces.join(String.fromCharCode(10));
}

/*
  WinAnsi is not Latin-1 in the 0x80-0x9F range: pdfkit writes an em dash as
  the single byte 0x97, which decodes to a control character if you treat the
  bytes as latin1. Without this map the extractor silently loses every piece
  of punctuation the document actually renders correctly.
*/
const WIN_ANSI_HIGH: Readonly<Record<number, string>> = {
  0x80: "\u20ac",
  0x85: "\u2026",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201c",
  0x94: "\u201d",
  0x96: "\u2013",
  0x97: "\u2014",
};

function fromHex(hex: string): string {
  const even = hex.length % 2 === 0 ? hex : `${hex}0`;
  let out = "";
  for (let i = 0; i < even.length; i += 2) {
    const code = Number.parseInt(even.slice(i, i + 2), 16);
    out += WIN_ANSI_HIGH[code] ?? String.fromCharCode(code);
  }
  return out;
}

function unescapePdf(literal: string): string {
  return literal.replace(/\\([()\\])/g, '$1');
}

