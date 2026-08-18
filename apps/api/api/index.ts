import { createApp } from '../src/app';

/**
 * Vercel entry point for the API.
 *
 * Vercel serves this project as serverless functions rather than as a
 * long-running process, and its Node runtime accepts an Express app directly —
 * an app IS a `(req, res)` handler. vercel.json rewrites every path here, so
 * Express still sees the original URL and its own `/api/tenant/...` mounts
 * match unchanged.
 *
 * `src/server.ts` remains the entry point for every other target (Docker, a
 * VPS, Render). Nothing about the application differs between the two; this
 * file only skips `listen`, because the platform owns the socket.
 *
 * Two consequences of running serverless, both handled elsewhere but worth
 * knowing here:
 *
 *   - The filesystem is read-only apart from /tmp, and /tmp does not survive
 *     the instance. STORAGE_DRIVER must be `s3` (see lib/s3.ts) or uploads are
 *     lost the moment the function is recycled.
 *   - Each warm instance holds its own connection pool, so the database URL
 *     should point at a pooled endpoint. Tenant scoping survives that:
 *     `set_config('app.tenant_id', …, true)` is transaction-local, so a
 *     transaction-mode pooler cannot leak it into the next request that
 *     borrows the connection (§7A rule 2).
 */
export default createApp();
