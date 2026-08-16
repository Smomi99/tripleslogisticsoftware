import { z } from 'zod';

/**
 * The API response envelope from CLAUDE.md §9.
 * Every endpoint returns this shape — success and failure alike.
 */
export interface ApiMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiError {
  /** Stable machine-readable code, e.g. VALIDATION_ERROR, FORBIDDEN. */
  code: string;
  /** Human-readable message, safe to show the user. */
  message: string;
  /** Field-level validation errors, keyed by form field path. */
  fields?: Record<string, string[]>;
}

export interface ApiSuccess<TData> {
  success: true;
  data: TData;
  meta?: ApiMeta;
}

export interface ApiFailure {
  success: false;
  error: ApiError;
}

export type ApiResponse<TData> = ApiSuccess<TData> | ApiFailure;

/**
 * Query parameters every list endpoint supports (CLAUDE.md §9).
 * Values arrive as strings on the wire, so each one is coerced.
 *
 * `sortBy` is deliberately left as a plain string here — each entity narrows it
 * to its own sortable column set, so an unknown column can never reach Prisma.
 */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

/** Default page size for every list screen (CLAUDE.md §8). */
export const DEFAULT_PAGE_SIZE = 25;

export function buildMeta(page: number, limit: number, total: number): ApiMeta {
  return {
    page,
    limit,
    total,
    totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
  };
}
