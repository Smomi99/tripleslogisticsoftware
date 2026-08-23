import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The isolation tests share one database; running them in parallel would
    // let one suite's seed data appear in another's assertions.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // The suite must not deliver mail. A developer pointing .env at the local
      // Mailpit catcher would otherwise get twenty test messages on every run,
      // which buries the one they were trying to read — and a developer with
      // real SMTP credentials in .env would email actual agents from a test.
      //
      // An unset host is a supported state, not a broken one: lib/mailer.ts
      // turns every send into a logged no-op, which is what the notification
      // tests already assert against. The two suites that need to read a
      // message body mock ../lib/mailer directly and are unaffected.
      SMTP_HOST: '',
    },
  },
});
