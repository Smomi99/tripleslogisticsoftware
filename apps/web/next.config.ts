import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @ff/shared ships TypeScript source, not a build artifact, so Next compiles
  // it alongside the app. This keeps the shared Zod schemas single-source.
  transpilePackages: ['@ff/shared'],
  typedRoutes: true,
};

export default nextConfig;
