import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @ff/shared ships TypeScript source, not a build artifact, so Next compiles
  // it alongside the app. This keeps the shared Zod schemas single-source.
  transpilePackages: ['@ff/shared'],
  typedRoutes: true,

  /**
   * Serves the API under the web app's own origin.
   *
   * The refresh token is an httpOnly `SameSite=Lax` cookie (§2), and Lax means
   * the browser withholds it from cross-site requests — so a web app on one
   * host talking to an API on another would sign in successfully and then fail
   * to refresh fifteen minutes later, silently. Proxying keeps every request
   * first-party, which also makes CORS irrelevant.
   *
   * Unset in development, where the API is addressed directly on :4000 through
   * NEXT_PUBLIC_API_URL and both sides are localhost anyway.
   */
  async rewrites() {
    const apiOrigin = process.env.API_ORIGIN;
    if (apiOrigin === undefined || apiOrigin === '') return [];
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
