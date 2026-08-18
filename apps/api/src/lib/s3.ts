import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { S3_CONFIG } from '../config/env';
import { HttpError } from './http-error';

/**
 * The S3-compatible half of the §2 storage contract.
 *
 * Written against plain S3 rather than one vendor's SDK, because the free
 * option (Cloudflare R2) and the paid ones (AWS S3, Backblaze B2, MinIO) all
 * speak the same API — the same reasoning §7B applies to payment gateways.
 * Point S3_ENDPOINT at the provider and nothing else changes.
 *
 * Object keys are identical to the local driver's, so a deployment can move
 * from disk to a bucket without rewriting a single row: the database stores
 * the key, never a path or a URL (§2).
 */

let client: S3Client | null = null;

/**
 * Created on first use, then reused.
 *
 * A serverless deployment builds this once per warm instance rather than once
 * per request; a long-running one builds it once. Either way the credential
 * check already happened at boot in config/env.
 */
function s3(): S3Client {
  if (S3_CONFIG === null) {
    throw new HttpError(500, 'STORAGE_UNAVAILABLE', 'S3 storage is not configured.');
  }
  if (client === null) {
    client = new S3Client({
      region: S3_CONFIG.region,
      // R2 and MinIO need an explicit endpoint; real AWS derives it from the
      // region, so this stays undefined there.
      ...(S3_CONFIG.endpoint !== undefined ? { endpoint: S3_CONFIG.endpoint } : {}),
      credentials: {
        accessKeyId: S3_CONFIG.accessKeyId,
        secretAccessKey: S3_CONFIG.secretAccessKey,
      },
    });
  }
  return client;
}

function bucket(): string {
  if (S3_CONFIG === null) {
    throw new HttpError(500, 'STORAGE_UNAVAILABLE', 'S3 storage is not configured.');
  }
  return S3_CONFIG.bucket;
}

export async function s3Put(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function s3Get(
  key: string,
): Promise<{ stream: NodeJS.ReadableStream; sizeBytes: number }> {
  let result;
  try {
    result = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  } catch {
    // A missing object and a denied one look the same to the caller on
    // purpose: a 404 tells an attacker nothing about what exists.
    throw HttpError.notFound('File not found.');
  }

  const body = result.Body;
  if (!(body instanceof Readable)) {
    throw new HttpError(500, 'STORAGE_UNAVAILABLE', 'The file could not be read.');
  }

  return { stream: body, sizeBytes: result.ContentLength ?? 0 };
}

/** Best-effort, to match the local driver: a missing object is not an error. */
export async function s3Remove(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  } catch {
    // Already gone, or never written.
  }
}
