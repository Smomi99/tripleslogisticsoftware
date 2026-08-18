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
  // Third-party runtime deps stay external and are installed in production.
  skipNodeModulesBundle: true,
  // ...but @ff/shared is a workspace package, and pnpm symlinks it INTO
  // node_modules, so skipNodeModulesBundle would externalise it too. It ships
  // TypeScript source with extensionless relative imports, which Node cannot
  // load: the built server died at startup on `packages/shared/src/api`.
  // Bundle it in, which is what the line above always intended.
  noExternal: [/^@ff\//],
});
