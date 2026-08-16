import { pino } from 'pino';

import { env, isProduction } from '../config/env';

export const logger = pino({
  level: isProduction ? 'info' : 'debug',
  // Pretty output in dev; structured JSON in production for log shipping.
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
  // Never let a credential or token reach the log stream.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.password_hash',
      '*.passwordHash',
    ],
    censor: '[redacted]',
  },
  base: { env: env.NODE_ENV },
});
