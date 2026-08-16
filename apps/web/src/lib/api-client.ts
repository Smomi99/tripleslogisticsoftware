import type { ApiMeta, ApiResponse } from '@ff/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Which workspace the browser is addressing.
 *
 * In production this comes from the subdomain, resolved server-side by proxy.ts
 * and handed to the session provider. Locally there is no subdomain, so a dev
 * fallback names it — the API only trusts the X-Tenant-Slug header outside
 * production for exactly this reason.
 */
export const DEV_TENANT_SLUG = process.env.NEXT_PUBLIC_DEV_TENANT_SLUG ?? 'demo';

export class ApiError extends Error {
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
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  accessToken?: string | undefined;
  tenantSlug: string;
  signal?: AbortSignal;
}

export interface ApiResult<T> {
  data: T;
  meta: ApiMeta | undefined;
}

/**
 * Unwraps the §9 envelope, turning a failure into a typed throw.
 *
 * Returns `meta` as well as `data`, because a list screen needs the total and
 * page count that ride alongside the rows — dropping it would force a second
 * request just to render the pager.
 */
export async function apiRequestWithMeta<T>(
  path: string,
  options: RequestOptions,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {
    'X-Tenant-Slug': options.tenantSlug,
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.accessToken !== undefined) {
    headers['Authorization'] = `Bearer ${options.accessToken}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    // Carries the httpOnly refresh cookie.
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(response.status, 'NETWORK_ERROR', 'The server did not respond.');
  }

  if (!payload.success) {
    throw new ApiError(
      response.status,
      payload.error.code,
      payload.error.message,
      payload.error.fields,
    );
  }

  return { data: payload.data, meta: payload.meta };
}

/** The common case: just the payload. */
export async function apiRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const result = await apiRequestWithMeta<T>(path, options);
  return result.data;
}
