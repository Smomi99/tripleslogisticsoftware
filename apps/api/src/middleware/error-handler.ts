import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import type { ApiFailure } from '@ff/shared';

import { isProduction } from '../config/env';
import { HttpError } from '../lib/http-error';
import { logger } from '../lib/logger';

/** Collapse Zod issues into { fieldPath: [messages] } for inline form errors. */
function toFieldErrors(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    const existing = fields[key];
    if (existing) {
      existing.push(issue.message);
    } else {
      fields[key] = [issue.message];
    }
  }
  return fields;
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiFailure = {
    success: false,
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.path}.` },
  };
  res.status(404).json(body);
}

/**
 * Terminal error middleware. Express 5 forwards rejected async handlers here
 * automatically, so route code never needs its own try/catch.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    const body: ApiFailure = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some fields need attention.',
        fields: toFieldErrors(error),
      },
    };
    res.status(400).json(body);
    return;
  }

  if (error instanceof HttpError) {
    const body: ApiFailure = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields ? { fields: error.fields } : {}),
      },
    };
    res.status(error.status).json(body);
    return;
  }

  logger.error({ err: error }, 'Unhandled error');

  const body: ApiFailure = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      // Never leak internals to a client in production.
      message: isProduction
        ? 'Something went wrong. Please try again.'
        : error instanceof Error
          ? error.message
          : String(error),
    },
  };
  res.status(500).json(body);
}
