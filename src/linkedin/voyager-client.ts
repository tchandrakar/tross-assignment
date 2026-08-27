import { request } from 'undici';
import type { Identity, IdentityPool } from '../identity/pool.js';
import { ApiError } from '../errors.js';
import { redactProxy } from '../identity/proxy.js';

/**
 * Thin authenticated client for LinkedIn's internal "Voyager" API — the same
 * REST/GraphQL surface linkedin.com's own SPA talks to.
 *
 * Authentication is entirely cookie-based:
 *   Cookie:     li_at=<session>; JSESSIONID="<id>"
 *   csrf-token: <id>            ← the JSESSIONID value, quotes stripped
 *
 * The remaining headers exist because Voyager rejects requests that don't look
 * like they came from the web client. `x-restli-protocol-version` changes the
 * response encoding, and the `normalized+json` Accept header is what makes
 * LinkedIn flatten the object graph into an `included[]` array (see normalize.ts).
 */

export const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * LinkedIn fingerprints this header. The values must be internally consistent
 * with the User-Agent above or the request is treated as automated.
 */
const X_LI_TRACK = JSON.stringify({
  clientVersion: '1.13.30',
  mpVersion: '1.13.30',
  osName: 'web',
  timezoneOffset: 0,
  timezone: 'UTC',
  deviceFormFactor: 'DESKTOP',
  mpName: 'voyager-web',
  displayDensity: 2,
  displayWidth: 2560,
  displayHeight: 1440,
});

export interface VoyagerResponse {
  status: number;
  body: unknown;
  raw: string;
}

export interface VoyagerRequestOptions {
  /** Path relative to VOYAGER_BASE, or an absolute https://www.linkedin.com URL. */
  path: string;
  identity: Identity;
  timeoutMs?: number;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
}

export function buildHeaders(identity: Identity, extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'application/vnd.linkedin.normalized+json+2.1',
    'accept-language': 'en-US,en;q=0.9',
    'csrf-token': identity.csrfToken,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'x-li-track': X_LI_TRACK,
    'user-agent': USER_AGENT,
    referer: 'https://www.linkedin.com/feed/',
    origin: 'https://www.linkedin.com',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    cookie: `li_at=${identity.liAt}; JSESSIONID="${identity.csrfToken}"`,
    ...extra,
  };
}

/** HTTP statuses that mean "LinkedIn pushed back", as opposed to "not found". */
export function isBlockStatus(status: number): boolean {
  return status === 999 || status === 429 || status === 403 || status === 401;
}

export class VoyagerClient {
  constructor(private readonly pool: IdentityPool) {}

  /**
   * Runs `fn` against a healthy identity, retrying on a *different* identity
   * when the current one gets blocked. Health accounting happens here so
   * callers never have to remember to report it.
   */
  async withIdentity<T>(fn: (identity: Identity) => Promise<T>): Promise<T> {
    // At least one attempt even on an empty pool, so `acquire()` runs and
    // reports the accurate NO_IDENTITY_AVAILABLE rather than a generic block.
    const attempts = Math.max(1, Math.min(this.pool.size, 3));
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const identity = this.pool.acquire();
      try {
        const result = await fn(identity);
        this.pool.reportSuccess(identity);
        return result;
      } catch (error) {
        lastError = error;
        const blocked = error instanceof ApiError && (error.code === 'UPSTREAM_BLOCKED' || error.code === 'AUTH_FAILED');
        this.pool.reportFailure(identity, blocked);
        if (!blocked) throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ApiError('UPSTREAM_BLOCKED', 'LinkedIn blocked every available identity.');
  }

  async get({ path, identity, timeoutMs = 20_000, headers = {} }: VoyagerRequestOptions): Promise<VoyagerResponse> {
    const url = path.startsWith('http') ? path : `${VOYAGER_BASE}${path}`;

    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(url, {
        method: 'GET',
        headers: buildHeaders(identity, headers),
        dispatcher: identity.dispatcher,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
    } catch (error) {
      throw new ApiError('UPSTREAM_BLOCKED', `Network error reaching LinkedIn via ${redactProxy(identity.proxyUrl)}.`, {
        cause: error,
        details: { identity: identity.label },
      });
    }

    const status = response.statusCode;
    const raw = await response.body.text();

    if (isBlockStatus(status)) {
      // 401 on a cookie-authenticated request means the cookie is dead, not
      // that the caller is unauthorised — surface that difference.
      const code = status === 401 ? 'AUTH_FAILED' : 'UPSTREAM_BLOCKED';
      throw new ApiError(
        code,
        code === 'AUTH_FAILED'
          ? `LinkedIn rejected the session cookie for identity "${identity.label}". It has expired or been invalidated.`
          : `LinkedIn returned ${status} for identity "${identity.label}" — the request was flagged as automated.`,
        { details: { status, identity: identity.label, proxy: redactProxy(identity.proxyUrl) } },
      );
    }

    if (status === 404) {
      throw new ApiError('PROFILE_NOT_FOUND', 'LinkedIn has no profile at that identifier.');
    }

    if (status >= 500) {
      throw new ApiError('UPSTREAM_BLOCKED', `LinkedIn returned a server error (${status}).`, { details: { status } });
    }

    if (status >= 300) {
      // A redirect to /authwall or /login means the session isn't authenticated.
      throw new ApiError('AUTH_FAILED', `Unexpected redirect (${status}) — the session is probably not logged in.`, {
        details: { status, location: response.headers.location },
      });
    }

    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      throw new ApiError('PARSE_FAILED', 'LinkedIn returned a non-JSON body where JSON was expected.', {
        details: { status, preview: raw.slice(0, 200) },
      });
    }

    return { status, body, raw };
  }
}
