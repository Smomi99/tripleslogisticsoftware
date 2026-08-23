import { randomUUID } from 'node:crypto';

import { env, S3_CONFIG, STORAGE_ROOT } from '../config/env';
import { openFile, putFile, removeFile } from '../lib/storage';

/**
 * Proves the configured object store actually works, before anyone needs it.
 *
 *   pnpm --filter @ff/api storage:check
 *
 * A bucket is the one dependency whose failure is invisible until an operator
 * attaches a file — which, for an agency agreement, may be weeks after deploy.
 * Wrong key, wrong bucket name, a token scoped to the wrong permission, a
 * region that should have been `auto`: every one of those looks like a healthy
 * boot and a 500 much later.
 *
 * This does a full round trip through the SAME code path uploads use — put,
 * read back, compare bytes, delete — rather than a HeadBucket, because
 * HeadBucket passes with a read-only token that cannot store anything.
 *
 * Exits non-zero on failure so a deploy script can gate on it.
 */

const PROBE_TENANT = 0n;

async function main(): Promise<void> {
  const driver = env.STORAGE_DRIVER;
  process.stdout.write(`storage driver: ${driver}\n`);

  if (driver === 'local') {
    process.stdout.write(`local root:     ${STORAGE_ROOT ?? '(unresolved)'}\n`);
  } else if (S3_CONFIG !== null) {
    process.stdout.write(`bucket:         ${S3_CONFIG.bucket}\n`);
    process.stdout.write(`endpoint:       ${S3_CONFIG.endpoint ?? '(AWS default for region)'}\n`);
    process.stdout.write(`region:         ${S3_CONFIG.region}\n`);
    process.stdout.write(`path style:     ${S3_CONFIG.forcePathStyle ? 'yes' : 'no'}\n`);
    // The secret is never printed, not even partially: a truncated key in a CI
    // log is still a clue, and this output is exactly what gets pasted around.
    process.stdout.write(`credentials:    present\n`);
  }

  const body = Buffer.from(`storage probe ${randomUUID()}\n`, 'utf8');

  process.stdout.write('\nwriting a probe object… ');
  const stored = await putFile(PROBE_TENANT, 'storage-check', {
    buffer: body,
    originalname: 'storage-check.pdf',
    mimetype: 'application/pdf',
    size: body.byteLength,
  });
  process.stdout.write(`ok\n  key: ${stored.key}\n`);

  process.stdout.write('reading it back…        ');
  const { stream, sizeBytes } = await openFile(PROBE_TENANT, stored.key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const readBack = Buffer.concat(chunks);
  if (!readBack.equals(body)) {
    throw new Error(
      `the object read back does not match what was written (${readBack.byteLength} vs ${body.byteLength} bytes)`,
    );
  }
  process.stdout.write(`ok (${sizeBytes} bytes, identical)\n`);

  process.stdout.write('deleting it…            ');
  await removeFile(PROBE_TENANT, stored.key);
  process.stdout.write('ok\n');

  process.stdout.write('\nStorage is configured correctly.\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nSTORAGE CHECK FAILED\n  ${message}\n`);
  process.stderr.write(
    '\nCommon causes:\n' +
      '  • S3_BUCKET names a bucket that does not exist, or exists in another account\n' +
      '  • the R2 API token is read-only, or scoped to a different bucket\n' +
      '  • S3_ENDPOINT is missing the account id, or points at the dashboard URL\n' +
      '  • S3_REGION is set to a real AWS region; R2 wants "auto"\n',
  );
  process.exitCode = 1;
});
