import type { RequestHandler } from 'express';
import multer from 'multer';

import { MAX_UPLOAD_BYTES } from '../lib/storage';

/**
 * Single-file upload, held in memory.
 *
 * Memory storage rather than multer's disk storage: the file must not touch
 * the filesystem until the storage layer has derived a safe key for it, since
 * multer's disk driver would otherwise write a caller-supplied filename.
 *
 * The size limit is enforced here as well as in the storage layer — multer
 * aborts the stream, so an oversized upload never gets fully buffered.
 */
// Annotated explicitly: multer's inferred return type references @types/express
// internals that cannot be named from here, which trips TS2742.
export const uploadSingle: RequestHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
}).single('file');
