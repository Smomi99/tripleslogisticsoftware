import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // @ff/shared ships TypeScript source, not a build artifact, so Next compiles
  // it alongside the app. This keeps the shared Zod schemas single-source.
  transpilePackages: ['@ff/shared'],
  typedRoutes: true,

  /**
   * Deliberately NOT `output: 'standalone'`.
   *
   * Standalone traces which files each route reached for and copies only those.
   * Against pnpm's layout it under-traces: the image it produced carried 3 of
   * @swc/helpers' 438 files and died on startup with MODULE_NOT_FOUND — after
   * building and running perfectly on a developer machine, where the full
   * node_modules is still on disk. Patching it means naming each missing
   * package in outputFileTracingIncludes and waiting to discover the next one.
   *
   * apps/web/Dockerfile runs `next start` against a real production install
   * instead. That is a couple of hundred megabytes larger and uses the same
   * module resolution `pnpm dev` exercises every day.
   */

  /**
   * Serves the API under the web app's own origin.
   *
   * The refresh token is an httpOnly `SameSite=Lax` cookie (§2), and Lax means
   * the browser withholds it from cross-site requests — so a web app on one
   * host talking to an API on another would sign in successfully and then fail
   * to refresh fifteen minutes later, silently. Proxying keeps every request
   * first-party, which also makes CORS irrelevant.
   *
   * Unset on the VPS, where Caddy path-routes /api to the API container, and
   * in development, where NEXT_PUBLIC_API_URL addresses the API directly.
   */
  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN;
    if (apiOrigin === undefined || apiOrigin === '') return [];
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
