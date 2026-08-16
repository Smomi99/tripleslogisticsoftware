import { defineConfig } from 'tsup';

/**
 * Both @ff/shared and the generated Prisma client ship as TypeScript source,
 * so the production build bundles rather than transpiles file-by-file.
 * Type checking is a separate step (`pnpm typecheck`).
 */
export default defineConfig({
  entry: ['src/server.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Third-party runtime deps stay external and are installed in production;
  // workspace TypeScript sources are bundled in.
  skipNodeModulesBundle: true,
});
