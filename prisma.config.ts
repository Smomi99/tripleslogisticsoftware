import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 reads the datasource URL from here, not from schema.prisma.
 *
 * This uses DATABASE_URL — the owner connection — because migrations must be
 * able to create tables and RLS policies. The API connects with
 * DATABASE_URL_APP instead (CLAUDE.md §7A rule 2).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
