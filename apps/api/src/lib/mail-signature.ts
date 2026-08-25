import { openFile } from './storage';
import type { TenantDb } from './tenant-client';

/**
 * The logos at the foot of an outgoing letter, and the HTML that carries them.
 *
 * The client's signature ends with three marks: their own, plus BAFFA and DP
 * Alliance. Those two are memberships, and a carrier's pricing desk looks for
 * them before deciding whether to answer a stranger — so they are credentials,
 * not decoration, and an email that drops them is materially weaker.
 *
 * They travel as CID inline attachments. That is not a preference:
 *
 *   a hosted URL  Outlook and Gmail block remote images by default, so the
 *                 recipient sees three broken boxes until they choose to
 *                 trust a sender they have never met.
 *   a data: URI   Gmail strips them outright and Outlook has never supported
 *                 them in mail. The image simply does not arrive.
 *   cid:          the bytes are a part of the message itself, so there is
 *                 nothing to fetch and nothing to block.
 *
 * The plain-text part is kept alongside, unchanged. A message whose HTML a
 * client cannot render still says everything it needs to.
 */

export interface SignatureLogo {
  cid: string;
  altText: string;
  heightPx: number;
  content: Buffer;
  fileName: string;
}

/**
 * Which letters carry the company's sign-off.
 *
 * An explicit list rather than "whichever body happens to contain the
 * signature text": the internal price-team alert is a note between colleagues
 * and does not want a letterhead, and deciding that by string-matching a body
 * would break the first time somebody edited their template.
 */
export const OUTWARD_TEMPLATES = new Set(['INQUIRY_AGENT_RFQ', 'INQUIRY_CARRIER_RFQ']);

/** A cid must be unique within the message and stable within it. */
const cidFor = (id: bigint): string => `sig-${id.toString()}@ff-erp`;

/** Reads a stored object into memory. Logos are kilobytes, not megabytes. */
async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Loads this workspace's logos, bytes and all.
 *
 * A logo whose file has gone missing from storage is skipped rather than
 * failing the send. The letter matters more than its letterhead, and a
 * half-signed rate request still gets a price back.
 */
export async function loadSignatureLogos(
  db: TenantDb,
  tenantId: bigint,
): Promise<SignatureLogo[]> {
  const rows = await db.mailSignatureLogo.findMany({
    where: { deletedAt: null, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, fileKey: true, altText: true, heightPx: true },
  });

  const logos: SignatureLogo[] = [];
  for (const row of rows) {
    try {
      const file = await openFile(tenantId, row.fileKey);
      logos.push({
        cid: cidFor(row.id),
        altText: row.altText,
        heightPx: row.heightPx,
        // Buffered rather than passed as a stream: a send that fails is
        // retried, and a stream can only be read once.
        content: await drain(file.stream),
        fileName: row.fileKey.split('/').pop() ?? 'logo.png',
      });
    } catch {
      // Missing from storage. Say nothing to the recipient about it.
    }
  }
  return logos;
}

/** Text destined for an HTML document, with nothing in it that can execute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The HTML alternative of a letter we already have in plain text.
 *
 * Built from the text rather than from a second template, so the two parts of
 * the message cannot say different things — the failure mode where a customer
 * and the record disagree about what was sent.
 *
 * Deliberately plain: a system font, ordinary line breaks, and the logos in a
 * row at the foot. A rate request is a letter, and dressing it as a newsletter
 * is how it ends up in a promotions tab.
 */
export function renderSignedHtml(bodyText: string, logos: SignatureLogo[]): string {
  const body = escapeHtml(bodyText)
    .split('\n')
    .map((line) => (line.trim() === '' ? '<br>' : `${line}<br>`))
    .join('\n');

  const marks =
    logos.length === 0
      ? ''
      : [
          '<div style="margin-top:16px">',
          ...logos.map(
            (logo) =>
              `<img src="cid:${logo.cid}" alt="${escapeHtml(logo.altText)}" ` +
              `height="${logo.heightPx}" ` +
              `style="height:${logo.heightPx}px;width:auto;vertical-align:middle;margin-right:14px" />`,
          ),
          '</div>',
        ].join('\n');

  return [
    '<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#10243A">',
    body,
    marks,
    '</div>',
  ]
    .filter((part) => part !== '')
    .join('\n');
}
