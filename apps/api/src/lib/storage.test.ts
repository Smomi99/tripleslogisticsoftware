import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { env, resolveS3Config, STORAGE_ROOT } from '../config/env';
import { HttpError } from './http-error';
import {
  assertUploadAllowed,
  displayNameFromKey,
  MAX_UPLOAD_BYTES,
  openFile,
  putFile,
  removeFile,
} from './storage';

/**
 * File storage: the key, the tenant boundary, and the rules about what may be
 * uploaded at all.
 *
 * Production stores these objects in Cloudflare R2. Almost nothing here is
 * R2-specific on purpose — the key is derived before any driver sees it, and
 * the tenant checks live above the driver — so the same assertions hold whether
 * the bytes land on a disk or in a bucket. The driver itself is exercised
 * end-to-end by `pnpm --filter @ff/api storage:check`, which needs a real
 * bucket and therefore cannot live in a unit test.
 */

const TENANT = 900001n;
const OTHER_TENANT = 900002n;
const written: string[] = [];

function pdf(name: string, bytes = 32) {
  const buffer = Buffer.alloc(bytes, 7);
  return { buffer, originalname: name, mimetype: 'application/pdf', size: buffer.byteLength };
}

afterAll(async () => {
  for (const key of written) await removeFile(TENANT, key);
});

describe('what may be uploaded', () => {
  it('accepts the document types a forwarder actually attaches', () => {
    for (const mime of [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]) {
      expect(() => assertUploadAllowed(mime, 1024), mime).not.toThrow();
    }
  });

  it('refuses anything else, by type rather than by extension', () => {
    // An allow-list, not a deny-list: the interesting uploads are the ones
    // nobody thought to forbid.
    for (const mime of ['application/x-msdownload', 'text/html', 'application/zip', '']) {
      expect(() => assertUploadAllowed(mime, 1024), mime).toThrow(HttpError);
    }
  });

  it('refuses a file over the limit', () => {
    expect(() => assertUploadAllowed('application/pdf', MAX_UPLOAD_BYTES + 1)).toThrow(HttpError);
    expect(() => assertUploadAllowed('application/pdf', MAX_UPLOAD_BYTES)).not.toThrow();
  });
});

describe('the object key', () => {
  it('starts with the tenant, which is what makes the boundary checkable', async () => {
    const stored = await putFile(TENANT, 'agent-agreement', pdf('Agency Agreement.pdf'));
    written.push(stored.key);

    expect(stored.key.startsWith(`${TENANT}/agent-agreement/`)).toBe(true);
    // A UUID, so two operators uploading "agreement.pdf" on the same day do not
    // collide and one does not silently overwrite the other.
    expect(stored.key).toMatch(
      /^\d+\/agent-agreement\/[0-9a-f-]{36}__Agency-Agreement\.pdf$/,
    );
    expect(stored.originalName).toBe('Agency Agreement.pdf');
  });

  it('takes the extension from the declared type, not the filename', async () => {
    // The classic double-extension trick: the caller says .pdf.exe and hopes
    // something downstream honours the last one.
    const stored = await putFile(TENANT, 'agent-agreement', pdf('invoice.pdf.exe'));
    written.push(stored.key);
    expect(stored.key.endsWith('.pdf')).toBe(true);
    expect(stored.key).not.toContain('.exe');
  });

  it('cannot be talked into traversing out of its prefix', async () => {
    const stored = await putFile(TENANT, 'agent-agreement', pdf('../../../etc/passwd'));
    written.push(stored.key);
    expect(stored.key).not.toContain('..');
    expect(stored.key.startsWith(`${TENANT}/`)).toBe(true);
  });

  it('carries the display name back out again', () => {
    expect(displayNameFromKey('7/agent-agreement/uuid__Signed-Agreement.pdf')).toBe(
      'Signed-Agreement.pdf',
    );
    // A key from before the convention, or from another writer.
    expect(displayNameFromKey('7/agent-agreement/plain.pdf')).toBe('plain.pdf');
  });
});

describe('the tenant boundary', () => {
  it('refuses to read another workspace object', async () => {
    const stored = await putFile(TENANT, 'agent-agreement', pdf('mine.pdf'));
    written.push(stored.key);

    await expect(openFile(TENANT, stored.key)).resolves.toBeDefined();
    // 404 rather than 403: confirming the object exists is itself a leak.
    await expect(openFile(OTHER_TENANT, stored.key)).rejects.toThrow(HttpError);
  });

  it('refuses to DELETE another workspace object', async () => {
    // The more dangerous of the two. Reading another workspace's file leaks it;
    // deleting one destroys it, and a bucket has no undo.
    const stored = await putFile(TENANT, 'agent-agreement', pdf('precious.pdf'));
    written.push(stored.key);

    await removeFile(OTHER_TENANT, stored.key);
    await expect(openFile(TENANT, stored.key)).resolves.toBeDefined();

    await removeFile(TENANT, stored.key);
    await expect(openFile(TENANT, stored.key)).rejects.toThrow(HttpError);
  });

  it('refuses a key that climbs out of the storage root', async () => {
    await expect(openFile(TENANT, `${TENANT}/../../../etc/passwd`)).rejects.toThrow(HttpError);
  });
});

describe('the bytes that were stored', () => {
  it('are the bytes that come back', async () => {
    const body = Buffer.from('signed, sealed, delivered', 'utf8');
    const stored = await putFile(TENANT, 'agent-agreement', {
      buffer: body,
      originalname: 'contract.pdf',
      mimetype: 'application/pdf',
      size: body.byteLength,
    });
    written.push(stored.key);

    const { stream, sizeBytes } = await openFile(TENANT, stored.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
    expect(sizeBytes).toBe(body.byteLength);
  });

  it('never puts a caller-supplied name on disk', async () => {
    // Only meaningful for the local driver, which is what dev runs.
    if (env.STORAGE_DRIVER !== 'local' || STORAGE_ROOT === null) return;
    const stored = await putFile(TENANT, 'agent-agreement', pdf('weird name (1).pdf'));
    written.push(stored.key);

    const onDisk = path.resolve(STORAGE_ROOT, stored.key);
    expect(existsSync(onDisk)).toBe(true);
    expect(path.basename(onDisk)).not.toContain(' ');
    expect((await readFile(onDisk)).byteLength).toBe(32);
  });
});

/**
 * The configuration that decides whether the bucket is usable at all.
 *
 * A half-configured store boots perfectly happily and then 500s on the first
 * agency agreement someone attaches, which may be weeks after the deploy.
 */
describe('resolveS3Config', () => {
  const complete = {
    S3_BUCKET: 'ff-erp-files',
    S3_REGION: 'auto',
    S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
    S3_FORCE_PATH_STYLE: false,
    S3_ACCESS_KEY_ID: 'key',
    S3_SECRET_ACCESS_KEY: 'secret',
  };

  it('accepts a complete R2 configuration', () => {
    const config = resolveS3Config(complete);
    expect(config.bucket).toBe('ff-erp-files');
    // R2 has one region and it is called "auto". A real AWS region here is a
    // common and confusing failure.
    expect(config.region).toBe('auto');
    expect(config.forcePathStyle).toBe(false);
  });

  it('names every missing setting at once, not just the first', () => {
    // An operator filling in a deploy should learn all of it in one go rather
    // than discovering the next blank on the next restart.
    expect(() =>
      resolveS3Config({ ...complete, S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined }),
    ).toThrow(/S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
  });

  it('refuses a bucket with no name', () => {
    expect(() => resolveS3Config({ ...complete, S3_BUCKET: undefined })).toThrow(/S3_BUCKET/);
  });

  it('allows no endpoint, which is how real AWS is addressed', () => {
    expect(resolveS3Config({ ...complete, S3_ENDPOINT: undefined }).endpoint).toBeUndefined();
  });
});
