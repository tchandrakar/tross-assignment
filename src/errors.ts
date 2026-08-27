/** Error taxonomy. Every failure the API can surface maps to exactly one of these. */
export type ErrorCode =
  | 'INVALID_URL'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_PRIVATE'
  | 'AUTH_FAILED'
  | 'ENDPOINT_RETIRED'
  | 'RATE_LIMITED'
  | 'SCRAPE_THROTTLED'
  | 'UPSTREAM_BLOCKED'
  | 'NO_IDENTITY_AVAILABLE'
  | 'PARSE_FAILED'
  | 'UNAUTHORIZED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  PROFILE_NOT_FOUND: 404,
  PROFILE_PRIVATE: 403,
  AUTH_FAILED: 502,
  ENDPOINT_RETIRED: 502,
  RATE_LIMITED: 429,
  SCRAPE_THROTTLED: 429,
  UPSTREAM_BLOCKED: 503,
  NO_IDENTITY_AVAILABLE: 503,
  PARSE_FAILED: 502,
  UNAUTHORIZED: 401,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = opts.details;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }

  toJSON() {
    return {
      success: false as const,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      },
    };
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
