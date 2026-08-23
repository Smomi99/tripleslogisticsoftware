import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { env, STORAGE_ROOT } from '../config/env';
import { HttpError } from './http-error';
import { s3Get, s3Put, s3Remove } from './s3';

/**
 * File storage (CLAUDE.md §2: local disk in dev, S3-compatible in prod, and
 * ONLY the key/path stored in the database).
 *
 * The interface is deliberately narrow and driver-shaped so the S3 driver can
 * be added without touching a single feature route — the same reasoning §7B
 * applies to payment gateways.
 *
 * Keys are `<tenantId>/<entity>/<uuid><ext>`. The tenant prefix is not
 * decoration: it means a key cannot be read across a tenant boundary even if a
 * row somehow leaked one, because the download path re-derives the prefix from
 * the session and refuses a mismatch.
 */

export interface StoredFile {
  /** What goes in the database column. Never a filesystem path. */
  key: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * §2 keeps uploads out of the repo; the path is configurable per environment.
 *
 * Resolved at boot in config/env so a misconfigured path fails on start rather
 * than on the first upload of the day.
 */
function localRoot(): string {
  if (STORAGE_ROOT === null) {
    throw new HttpError(500, 'STORAGE_UNAVAILABLE', 'Local file storage is not configured.');
  }
  return STORAGE_ROOT;
}

/** Agreements and contracts only — this is not a general file share. */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

export function assertUploadAllowed(mimeType: string, sizeBytes: number): void {
  if (!ALLOWED_MIME.has(mimeType)) {
    throw HttpError.badRequest('Upload a PDF, Word document, JPG or PNG.');
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw HttpError.badRequest('That file is larger than 10 MB.');
  }
}

/**
 * Reduces a caller-supplied filename to something safe to put in a key.
 *
 * A raw upload name is the classic path-traversal and double-extension vector,
 * so only letters, digits, dot, underscore and hyphen survive, and the result
 * is truncated. The real extension still comes from the declared MIME type.
 */
function safeDisplayName(originalName: string): string {
  const base = path.basename(originalName).replace(/\.[^.]*$/, '');
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 60);
  return cleaned === '' ? 'file' : cleaned;
}

/**
 * Recovers the display name from a key.
 *
 * §6 gives agent and employee a single `*_file` column, with nowhere to record
 * the original filename — and inventing a column would breach §10 rule 2. So
 * the sanitised name rides inside the key after a `__` separator, which keeps
 * the database exactly as specified while still showing the operator something
 * better than a UUID.
 */
export function displayNameFromKey(key: string): string {
  const fileName = key.split('/').pop() ?? key;
  const separator = fileName.indexOf('__');
  return separator === -1 ? fileName : fileName.slice(separator + 2);
}

/**
 * Writes a file and returns its key.
 *
 * The stored name is a UUID plus a sanitised display name, with an extension
 * derived from the declared MIME type rather than the uploaded filename.
 */
export async function putFile(
  tenantId: bigint,
  entity: string,
  file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
): Promise<StoredFile> {
  assertUploadAllowed(file.mimetype, file.size);

  const extension = EXTENSION_BY_MIME[file.mimetype] ?? '';
  const key = `${tenantId}/${entity}/${randomUUID()}__${safeDisplayName(file.originalname)}${extension}`;

  if (env.STORAGE_DRIVER === 'local') {
    const destination = path.join(localRoot(), key);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.buffer);
  } else {
    await s3Put(key, file.buffer, file.mimetype);
  }

  return {
    key,
    originalName: path.basename(file.originalname).slice(0, 255),
    sizeBytes: file.size,
    mimeType: file.mimetype,
  };
}

/**
 * Resolves a key to something readable, refusing anything outside the caller's
 * own tenant prefix. Two independent checks: the key must start with the
 * session's tenant id, and the resolved path must stay inside the storage root.
 */
export async function openFile(
  tenantId: bigint,
  key: string,
): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number }> {
  if (!key.startsWith(`${tenantId}/`)) {
    throw HttpError.notFound('File not found.');
  }

  if (env.STORAGE_DRIVER !== 'local') {
    // The tenant-prefix check above still applies: it is the same guarantee,
    // enforced on the key rather than on a resolved filesystem path.
    return s3Get(key);
  }

  const root = localRoot();
  const resolved = path.resolve(root, key);
  // Belt and braces against a key containing ../ despite the prefix check.
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw HttpError.notFound('File not found.');
  }

  try {
    const info = await stat(resolved);
    return { stream: createReadStream(resolved), sizeBytes: info.size };
  } catch {
    throw HttpError.notFound('File not found.');
  }
}

/**
 * Best-effort removal — a missing file is not an error worth surfacing.
 *
 * Takes the tenant for the same reason openFile does. Deleting is the more
 * dangerous of the two: reading another workspace's object leaks it, deleting
 * one destroys it, and there is no undo in a bucket. Today every caller passes
 * a key it read from a row inside its own tenant scope, so the check should
 * never fire — which is exactly when a guard is cheap and worth having.
 */
export async function removeFile(tenantId: bigint, key: string): Promise<void> {
  if (!key.startsWith(`${tenantId}/`)) return;

  if (env.STORAGE_DRIVER !== 'local') {
    await s3Remove(key);
    return;
  }

  const root = localRoot();
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return;

  try {
    await unlink(resolved);
  } catch {
    // Already gone.
  }
}
