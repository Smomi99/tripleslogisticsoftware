import { HttpError } from './http-error';

/**
 * Express 5 types a route param as string | string[] — a repeated `:id` yields
 * an array. Anything that is not a single run of digits is rejected rather than
 * coerced, so no malformed value reaches BigInt().
 */
export function parseId(raw: string | string[] | undefined, label = 'record'): bigint {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw HttpError.badRequest(`Invalid ${label} id.`);
  }
  return BigInt(raw);
}

/** Same, for an id arriving in a request body as a string. */
export function parseRefId(raw: string, label: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw HttpError.badRequest(`Choose a ${label}.`);
  }
  return BigInt(raw);
}
