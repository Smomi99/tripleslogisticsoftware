/**
 * The one error type route code throws. The error handler turns it into the
 * CLAUDE.md §9 envelope; anything else becomes a 500 with no internal detail.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string[]> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  static badRequest(message: string, fields?: Record<string, string[]>): HttpError {
    return new HttpError(400, 'BAD_REQUEST', message, fields);
  }

  static unauthorized(message = 'Sign in to continue.'): HttpError {
    return new HttpError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'You do not have permission to do this.'): HttpError {
    return new HttpError(403, 'FORBIDDEN', message);
  }

  static notFound(message = 'Not found.'): HttpError {
    return new HttpError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, 'CONFLICT', message);
  }
}
