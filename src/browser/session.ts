import type { Browser, BrowserContext, Page } from 'playwright';
import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../errors.js';
import type { Identity } from '../identity/pool.js';
import type { SessionStore } from './session-store.js';
import { NullSessionStore } from './session-store.js';

/**
 * A warmed, authenticated Chromium session per identity.
 *
 * Why this exists at all: LinkedIn fingerprints far more than headers. A raw
 * `undici` request has a different TLS/JA3 signature, different header
 * ordering, and no JS execution — all of which are cheap for LinkedIn to
 * detect. In testing, a bare HTTP client authenticated fine and then had its
 * session invalidated server-side within a handful of requests.
 *
 * So this class issues the *same* Voyager API calls from inside a real browser
 * page via `fetch()`. The request then carries Chrome's actual TLS fingerprint,
 * its real header ordering, the full cookie jar, and a same-origin `Origin` —
 * because it genuinely is Chrome making a same-origin request.
 *
 * It is still API reverse-engineering: the response is the same Voyager JSON,
 * parsed by the same parsers. Only the transport changed.
 *
 * Contexts are cached per identity and reused. A fresh context per request
 * would discard the warmed session and re-trigger the login checks that this
 * whole approach exists to avoid.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface CachedContext {
  context: BrowserContext;
  page: Page;
  warmedAt: number;
}

/** Re-warm a context that has been idle this long, rather than trusting it blindly. */
const WARM_TTL_MS = 10 * 60_000;

/**
 * Where to land when establishing a session. Deliberately NOT /feed/ — the feed
 * is heavy, personalised, and aggressively rate-limited (observed returning 429
 * on a first load), which made session warm-up the most fragile step in the
 * whole pipeline. Callers that know their target pass the profile URL instead,
 * so the single navigation both establishes the session and renders the page
 * whose payloads we want.
 */
const DEFAULT_LANDING = 'https://www.linkedin.com/mynetwork/';

export interface InPageResponse {
  status: number;
  url: string;
  body: unknown;
  bodyText: string;
}

export class BrowserSession {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private readonly contexts = new Map<string, CachedContext>();

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly store: SessionStore = new NullSessionStore(),
  ) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    this.launching ??= (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          // Removes the `navigator.webdriver` tell without needing a stealth plugin.
          '--disable-blink-features=AutomationControlled',
        ],
      });
      this.browser = browser;
      this.launching = null;
      return browser;
    })();

    return this.launching;
  }

  /**
   * Returns a page that has already loaded an authenticated LinkedIn document.
   * Navigating first matters: it lets LinkedIn set its own routing cookies
   * (`lidc`) and completes whatever client-side handshake the SPA performs, so
   * subsequent in-page fetches look like ordinary SPA traffic.
   */
  private async warmPage(identity: Identity, landingUrl = DEFAULT_LANDING): Promise<Page> {
    const cached = this.contexts.get(identity.id);
    if (cached && Date.now() - cached.warmedAt < WARM_TTL_MS && !cached.page.isClosed()) {
      return cached.page;
    }

    await this.dispose(identity.id);

    const browser = await this.getBrowser();
    const timezone = identity.cookies.timezone || 'UTC';

    // Prefer persisted state: it holds whatever li_at LinkedIn most recently
    // rotated to. The configured cookie jar is only a bootstrap seed.
    const persisted = await this.store.load(identity.id).catch(() => null);

    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      // Match the account's own timezone cookie — a mismatch here is exactly
      // the kind of inconsistency LinkedIn correlates against.
      timezoneId: isValidTimezone(timezone) ? timezone : 'UTC',
      ...(identity.proxyUrl ? { proxy: toPlaywrightProxy(identity.proxyUrl) } : {}),
      ...(persisted ? { storageState: persisted as never } : {}),
    });

    if (!persisted) {
      if (!identity.liAt) {
        await context.close().catch(() => undefined);
        throw new ApiError(
          'AUTH_FAILED',
          `Identity "${identity.label}" has no stored session and no cookie seed. Run \`npm run login\` to establish one.`,
          { details: { identity: identity.label } },
        );
      }
      this.logger.info({ identity: identity.label }, 'no persisted session; seeding from configured cookie jar');
      await context.addCookies(toPlaywrightCookies(identity));
    }

    const page = await context.newPage();
    // Images and fonts are most of the bytes and none of the data.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      return type === 'image' || type === 'font' || type === 'media' ? route.abort() : route.continue();
    });

    let response;
    try {
      response = await page.goto(landingUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    } catch (error) {
      await context.close().catch(() => undefined);
      // LinkedIn answers an unauthenticated navigation with a 302 back to the
      // same URL that also clears the auth cookies. With no valid session the
      // browser follows it forever.
      if (String((error as Error).message).includes('ERR_TOO_MANY_REDIRECTS')) {
        throw new ApiError(
          'AUTH_FAILED',
          `LinkedIn put identity "${identity.label}" into a cookie-clearing redirect loop. The session is not valid — it has expired, been invalidated, or the cookies are scoped to the wrong domain.`,
          { details: { landingUrl, identity: identity.label } },
        );
      }
      throw new ApiError('UPSTREAM_BLOCKED', `Browser navigation failed: ${(error as Error).message}`, { cause: error });
    }

    const landed = page.url();
    if (landed.includes('/authwall') || landed.includes('/login') || landed.includes('/checkpoint')) {
      await context.close().catch(() => undefined);
      throw new ApiError(
        'AUTH_FAILED',
        `LinkedIn bounced identity "${identity.label}" to ${landed.includes('/checkpoint') ? 'a security checkpoint' : 'the auth wall'}. The session needs a fresh login.`,
        { details: { landedOn: landed, identity: identity.label } },
      );
    }

    const status = response?.status() ?? 0;
    if (status === 999 || status === 429) {
      await context.close().catch(() => undefined);
      throw new ApiError('UPSTREAM_BLOCKED', `LinkedIn returned ${status} while warming the browser session.`);
    }

    this.contexts.set(identity.id, { context, page, warmedAt: Date.now() });
    await this.persist(identity, context);
    this.logger.debug({ identity: identity.label }, 'browser session warmed');
    return page;
  }

  /**
   * Issues a Voyager API call from inside the authenticated page.
   *
   * `credentials: 'include'` makes the browser attach the real cookie jar, so
   * we never hand cookies to the page ourselves. The csrf-token header is still
   * required — it is what Voyager checks — and is read from the live jar rather
   * than from config, so a token LinkedIn rotated mid-session stays correct.
   */
  async fetchVoyager(identity: Identity, path: string, landingUrl?: string): Promise<InPageResponse> {
    const page = await this.warmPage(identity, landingUrl);
    const url = path.startsWith('http') ? path : `https://www.linkedin.com/voyager/api${path}`;

    const result = await page.evaluate(async (target: string): Promise<InPageResponse> => {
      const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/)?.[1] ?? '').replace(/"/g, '');

      const response = await fetch(target, {
        method: 'GET',
        credentials: 'include',
        headers: {
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'en_US',
        },
      });

      const bodyText = await response.text();
      let body: unknown = null;
      try {
        body = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        body = null;
      }
      return { status: response.status, url: response.url, body, bodyText };
    }, url);

    // Persist before asserting: even a failed call may have rotated the token,
    // and losing the new value is what turns one failure into a dead session.
    const cached = this.contexts.get(identity.id);
    if (cached) await this.persist(identity, cached.context);

    this.assertUsable(result, identity, path);
    return result;
  }

  /**
   * Captures the context's current cookies so a rotated li_at survives the
   * process. Best-effort: a failure to persist must never fail a request, but
   * it does mean the next run replays a stale token, so it is logged loudly.
   */
  private async persist(identity: Identity, context: BrowserContext): Promise<void> {
    try {
      const state = await context.storageState();
      await this.store.save(identity.id, state as never);
    } catch (error) {
      this.logger.error({ err: error, identity: identity.label }, 'failed to persist browser session state');
    }
  }

  private assertUsable(result: InPageResponse, identity: Identity, path: string): void {
    const { status } = result;

    if (status === 404) throw new ApiError('PROFILE_NOT_FOUND', 'LinkedIn has no profile at that identifier.');
    if (status === 410) {
      throw new ApiError('ENDPOINT_RETIRED', `LinkedIn has retired ${path} (410 Gone).`, { details: { status, path } });
    }
    if (status === 999 || status === 429 || status === 403) {
      throw new ApiError('UPSTREAM_BLOCKED', `LinkedIn returned ${status} for identity "${identity.label}".`, {
        details: { status, identity: identity.label },
      });
    }
    if (status === 401) {
      throw new ApiError('AUTH_FAILED', `LinkedIn rejected the session for identity "${identity.label}".`);
    }
    // The in-page fetch follows redirects, so an auth bounce shows up as a
    // 200 whose final URL is the login page rather than as a 3xx.
    if (result.url.includes('/authwall') || result.url.includes('/uas/login') || result.url.includes('/checkpoint')) {
      throw new ApiError('AUTH_FAILED', 'The in-page request was redirected to login — the session is no longer valid.', {
        details: { landedOn: result.url },
      });
    }
    if (status >= 500) {
      throw new ApiError('UPSTREAM_BLOCKED', `LinkedIn returned a server error (${status}) for ${path}.`, {
        details: { status },
      });
    }
    if (result.body === null) {
      throw new ApiError('PARSE_FAILED', `LinkedIn returned a non-JSON body for ${path}.`, {
        details: { status, preview: result.bodyText.slice(0, 200) },
      });
    }
  }

  /**
   * Loads the rendered profile page and harvests every Voyager payload it
   * carries — both the server-rendered `<code id="bpr-guid-…">` blobs the SPA
   * hydrates from, and the XHRs the page fires for itself.
   */
  async collectRenderedPayloads(identity: Identity, publicId: string): Promise<unknown[]> {
    const profileUrl = `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
    const page = await this.warmPage(identity, profileUrl);
    const payloads: unknown[] = [];

    const onResponse = (response: { url(): string; json(): Promise<unknown> }) => {
      if (!response.url().includes('/voyager/api/')) return;
      response.json().then((body) => payloads.push(body)).catch(() => undefined);
    };
    page.on('response', onResponse);

    try {
      const response = await page.goto(`https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });

      const status = response?.status() ?? 0;
      if (status === 404) throw new ApiError('PROFILE_NOT_FOUND', 'LinkedIn has no profile at that identifier.');
      if (status === 999 || status === 429) {
        throw new ApiError('UPSTREAM_BLOCKED', `LinkedIn returned ${status} to the headless browser.`);
      }
      if (page.url().includes('/authwall') || page.url().includes('/login')) {
        throw new ApiError('AUTH_FAILED', 'LinkedIn redirected to the auth wall — the session is not valid.');
      }

      // Let the SPA fire its own section requests.
      await page.waitForTimeout(3_000);

      const inline = await page.evaluate(() =>
        Array.from(document.querySelectorAll('code[id^="bpr-guid-"]'))
          .map((node) => node.textContent ?? '')
          .filter((text) => text.includes('"data"') || text.includes('"included"')),
      );

      for (const text of inline) {
        try {
          payloads.push(JSON.parse(text));
        } catch {
          // Some blobs are HTML-escaped fragments rather than JSON.
        }
      }

      return payloads;
    } finally {
      page.off('response', onResponse);
    }
  }

  /**
   * Discards persisted state after an authentication failure. Keeping it would
   * make every subsequent attempt replay the same dead token; clearing it lets
   * the configured seed jar be tried again.
   */
  async invalidate(identity: Identity): Promise<void> {
    await this.dispose(identity.id);
    await this.store.clear(identity.id).catch(() => undefined);
    this.logger.warn({ identity: identity.label }, 'cleared persisted session state after auth failure');
  }

  /** Drops a poisoned context so the next call re-warms from scratch. */
  async dispose(identityId: string): Promise<void> {
    const cached = this.contexts.get(identityId);
    if (!cached) return;
    this.contexts.delete(identityId);
    await cached.context.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    for (const id of [...this.contexts.keys()]) await this.dispose(id);
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * LinkedIn scopes its auth cookies to `.www.linkedin.com` and its
 * browser-identity cookies to `.linkedin.com`. Confirmed straight off the wire —
 * the Set-Cookie headers LinkedIn sends when it invalidates a session read:
 *
 *   li_at=delete me; Domain=.www.linkedin.com
 *   li_a="delete me"; Domain=.www.linkedin.com
 *   liap=delete me;  Domain=.linkedin.com
 *
 * Putting them all on `.linkedin.com` (the obvious guess) means the browser
 * never sends li_at to www.linkedin.com, LinkedIn treats the navigation as
 * unauthenticated, and its "clear your cookies and retry" 302 becomes an
 * infinite redirect loop surfacing as ERR_TOO_MANY_REDIRECTS — which looks
 * nothing like the cookie-scope bug it actually is.
 */
const WWW_SCOPED = new Set(['li_at', 'li_a', 'JSESSIONID', 'li_rm']);

export function toPlaywrightCookies(identity: Identity) {
  const jar: Record<string, string> = { ...identity.cookies };
  jar.li_at = identity.liAt;
  jar.JSESSIONID = `"${identity.csrfToken}"`;

  return Object.entries(jar).map(([name, value]) => ({
    name,
    value,
    domain: WWW_SCOPED.has(name) ? '.www.linkedin.com' : '.linkedin.com',
    path: '/',
    secure: true,
    httpOnly: name === 'li_at' || name === 'li_rm',
    sameSite: 'None' as const,
  }));
}

/** Playwright wants proxy credentials split out of the URL. */
export function toPlaywrightProxy(proxyUrl: string) {
  const url = new URL(proxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}
