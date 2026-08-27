import type { BrowserContext, Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../errors.js';
import type { Identity } from '../identity/pool.js';
import type { SessionStore, StorageState } from './session-store.js';
import { NullSessionStore } from './session-store.js';
import { abandonChallenge, completeChallenge, performLogin, type ChallengeHandle } from './login.js';

/**
 * A long-lived, logged-in Chromium session per identity.
 *
 * Two ideas do the heavy lifting here.
 *
 * **1. Voyager calls are issued from inside a real browser page.** LinkedIn
 * fingerprints far more than headers: a raw HTTP client has a different
 * TLS/JA3 signature, different header ordering, and no JS execution. In
 * testing, a bare client authenticated fine and then had its session
 * invalidated server-side within a handful of requests. Issuing the *same*
 * API calls via `fetch()` from an authenticated page means the request carries
 * Chrome's real fingerprint, header ordering and cookie jar — because it
 * genuinely is Chrome making a same-origin request. It remains API
 * reverse-engineering; only the transport changed.
 *
 * **2. The browser stays open, and its profile persists on disk.** Chromium is
 * launched with `launchPersistentContext`, so cookies, localStorage, IndexedDB
 * and device state survive restarts — the same signals LinkedIn's device
 * recognition uses. The context is never torn down between requests and a
 * keepalive keeps it fresh.
 *
 * That second point is a security measure, not an optimisation. Logging in is
 * by far the most CAPTCHA-prone action available to this service, so the
 * design goal is to log in **once** and never again. Everything else — profile
 * persistence, storage-state sync, the keepalive — exists to avoid a second
 * login.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * How often an idle session pings LinkedIn.
 *
 * `li_at` rotates on use, so a periodic touch keeps the stored session recent.
 * A session left untouched for days is far likelier to be expired when finally
 * needed — and expiry means a fresh automated login, which is exactly what we
 * are trying never to do.
 */
const KEEPALIVE_INTERVAL_MS = 8 * 60_000;

/** Consecutive automatic-login failures before the service stops trying. */
const MAX_LOGIN_FAILURES = 3;

/** How long automatic login stays suspended after tripping the breaker. */
const LOGIN_BLOCK_MS = 30 * 60_000;

/** How long an unanswered challenge holds its browser open before being reaped. */
const CHALLENGE_TTL_MS = 20 * 60_000;

/**
 * Runs in the page. Confirms the session against the API rather than the DOM —
 * LinkedIn serves a guest-rendered page to an unauthenticated navigation while
 * `fetch()` from the same origin still authenticates, so the DOM genuinely
 * cannot tell you whether you are logged in.
 */
const meProbe = async (): Promise<number> => {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/)?.[1] ?? '').replace(/"/g, '');
  const response = await fetch('/voyager/api/me', {
    credentials: 'include',
    headers: {
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'csrf-token': csrf,
      'x-restli-protocol-version': '2.0.0',
    },
  });
  return response.status;
};

/** Landing page for establishing a session when the caller has no target. */
const DEFAULT_LANDING = 'https://www.linkedin.com/mynetwork/';

interface LiveSession {
  context: BrowserContext;
  page: Page;
  openedAt: number;
  lastTouchedAt: number;
  keepAlive: NodeJS.Timeout;
}

export interface InPageResponse {
  status: number;
  url: string;
  body: unknown;
  bodyText: string;
}

export interface SessionStats {
  identity: string;
  open: boolean;
  ageSeconds: number;
  idleSeconds: number;
}

export class BrowserSession {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly opening = new Map<string, Promise<LiveSession>>();
  private readonly logins = new Map<string, Promise<StorageState>>();
  /**
   * Circuit breaker on automatic login.
   *
   * Repeated failed logins are how an account gets locked, and the most common
   * cause of failure is a credential that is simply wrong — retrying that can
   * only make things worse. After a small number of consecutive failures the
   * service stops trying and reports what a human needs to do.
   */
  private readonly loginFailures = new Map<string, { count: number; lastError: string; blockedUntil: number }>();

  /**
   * Challenges LinkedIn has issued and that are waiting on a verification code.
   *
   * The browser stays open while a challenge is pending, because the challenge
   * is bound to that browser session — closing it and logging in again would
   * simply produce a new challenge. A TTL reaps handles nobody answers, so an
   * unanswered challenge cannot leak a Chromium process indefinitely.
   */
  private readonly pendingChallenges = new Map<string, { handle: ChallengeHandle; url: string; kind: string; reaper: NodeJS.Timeout }>();
  private closed = false;

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly store: SessionStore = new NullSessionStore(),
    private readonly credentials: { email: string; password: string } | null = null,
    /** Root for per-identity Chromium profile directories. */
    private readonly profileRoot = '.sessions/profiles',
  ) {}

  // ─── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Returns the identity's live page, opening the browser if this is the first
   * call. Deduplicated: a burst of requests against a cold service must not
   * each launch their own Chromium.
   */
  private async session(identity: Identity, landingUrl = DEFAULT_LANDING): Promise<LiveSession> {
    const live = this.sessions.get(identity.id);
    if (live && !live.page.isClosed()) {
      live.lastTouchedAt = Date.now();
      return live;
    }

    const inFlight = this.opening.get(identity.id);
    if (inFlight) return inFlight;

    const opening = this.open(identity, landingUrl).finally(() => this.opening.delete(identity.id));
    this.opening.set(identity.id, opening);
    return opening;
  }

  private async open(identity: Identity, landingUrl: string): Promise<LiveSession> {
    const { chromium } = await import('playwright');
    const profileDir = `${this.profileRoot}/${identity.id}`;
    await mkdir(profileDir, { recursive: true });

    const timezone = identity.cookies.timezone;

    // A persistent profile keeps the browser's whole identity — cookies,
    // localStorage, IndexedDB, device state — across restarts, which is what
    // lets LinkedIn recognise this as a device it has already seen.
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      // A mismatch against the account's own timezone cookie is an
      // inconsistency a real browser never produces.
      timezoneId: isValidTimezone(timezone ?? '') ? timezone : 'UTC',
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // Removes the navigator.webdriver tell without a stealth plugin.
        '--disable-blink-features=AutomationControlled',
      ],
      ...(identity.proxyUrl ? { proxy: toPlaywrightProxy(identity.proxyUrl) } : {}),
    });

    try {
      await this.seed(identity, context);

      const page = context.pages()[0] ?? (await context.newPage());
      // Images and fonts are most of the bytes and none of the data.
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        return type === 'image' || type === 'font' || type === 'media' ? route.abort() : route.continue();
      });

      await this.navigate(identity, page, landingUrl);
      await this.assertAuthenticated(identity, page, context);

      const live: LiveSession = {
        context,
        page,
        openedAt: Date.now(),
        lastTouchedAt: Date.now(),
        keepAlive: setInterval(() => {
          void this.touch(identity);
        }, KEEPALIVE_INTERVAL_MS),
      };
      // Never let the keepalive hold the process open on shutdown.
      live.keepAlive.unref?.();

      this.sessions.set(identity.id, live);
      await this.persist(identity, context);
      this.logger.info({ identity: identity.label, profileDir }, 'browser session open and authenticated');
      return live;
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Populates a *new* profile. Order matters: an existing profile directory is
   * already authoritative, so nothing is injected over it.
   */
  private async seed(identity: Identity, context: BrowserContext): Promise<void> {
    const existing = await context.cookies('https://www.linkedin.com').catch(() => []);
    if (existing.some((c) => c.name === 'li_at')) {
      this.logger.debug({ identity: identity.label }, 'persistent profile already carries a session');
      return;
    }

    const stored = await this.store.load(identity.id).catch(() => null);
    if (stored?.cookies?.length) {
      await context.addCookies(stored.cookies as never);
      this.logger.info({ identity: identity.label }, 'seeded profile from stored session state');
      return;
    }

    if (identity.liAt) {
      await context.addCookies(toPlaywrightCookies(identity));
      this.logger.info({ identity: identity.label }, 'seeded profile from configured cookie jar');
      return;
    }

    const state = await this.autoLogin(identity);
    await context.addCookies(state.cookies as never);
  }

  private async navigate(identity: Identity, page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      // LinkedIn answers an unauthenticated navigation with a 302 back to the
      // same URL that also clears the auth cookies; with no valid session the
      // browser follows it forever.
      if (String((error as Error).message).includes('ERR_TOO_MANY_REDIRECTS')) {
        throw new ApiError(
          'AUTH_FAILED',
          `LinkedIn put identity "${identity.label}" into a cookie-clearing redirect loop — the session is not valid.`,
          { details: { url, identity: identity.label } },
        );
      }
      throw new ApiError('UPSTREAM_BLOCKED', `Browser navigation failed: ${(error as Error).message}`, { cause: error });
    }
  }

  /**
   * Confirms the session against the API rather than the DOM. LinkedIn serves a
   * guest-rendered page to an unauthenticated navigation while `fetch()` from
   * the same origin still authenticates, so DOM inspection genuinely cannot
   * tell you whether you are logged in — `/voyager/api/me` can.
   */
  private async assertAuthenticated(identity: Identity, page: Page, context: BrowserContext): Promise<void> {
    const status = await evaluateSettled(page, meProbe, null);

    if (status === 200) return;

    // The profile is stale. Clear it and bootstrap a fresh login, once.
    this.logger.warn({ identity: identity.label, status }, 'stored session is no longer valid; re-establishing');
    await this.store.clear(identity.id).catch(() => undefined);

    const state = await this.autoLogin(identity);
    await context.clearCookies();
    await context.addCookies(state.cookies as never);
    await this.navigate(identity, page, DEFAULT_LANDING);

    const recheck = await evaluateSettled(page, meProbe, null);

    if (recheck !== 200) {
      throw new ApiError('AUTH_FAILED', `Identity "${identity.label}" could not be authenticated (me returned ${recheck}).`);
    }
  }

  /**
   * Keepalive. Touches LinkedIn and persists whatever token it rotated to.
   * Skipped while the session is actively serving requests — real traffic
   * already keeps it warm.
   */
  private async touch(identity: Identity): Promise<void> {
    const live = this.sessions.get(identity.id);
    if (!live || this.closed || live.page.isClosed()) return;
    if (Date.now() - live.lastTouchedAt < KEEPALIVE_INTERVAL_MS) return;

    try {
      const status = await evaluateSettled(live.page, meProbe, null);

      live.lastTouchedAt = Date.now();
      await this.persist(identity, live.context);
      this.logger.debug({ identity: identity.label, status }, 'session keepalive');

      if (status === 401 || status === 403) {
        this.logger.warn({ identity: identity.label, status }, 'keepalive found the session invalid; dropping it');
        await this.invalidate(identity);
      }
    } catch (error) {
      this.logger.debug({ err: error, identity: identity.label }, 'keepalive failed (non-fatal)');
    }
  }

  /** Mirrors the live profile into the session store so a rebuilt VM recovers it. */
  private async persist(identity: Identity, context: BrowserContext): Promise<void> {
    try {
      await this.store.save(identity.id, (await context.storageState()) as StorageState);
    } catch (error) {
      this.logger.error({ err: error, identity: identity.label }, 'failed to persist browser session state');
    }
  }

  // ─── Automatic login ───────────────────────────────────────────────────────

  private async autoLogin(identity: Identity): Promise<StorageState> {
    const existing = this.logins.get(identity.id);
    if (existing) {
      this.logger.debug({ identity: identity.label }, 'joining in-flight automatic login');
      return existing;
    }

    if (!this.credentials) {
      throw new ApiError(
        'AUTH_FAILED',
        `Identity "${identity.label}" has no stored session, no cookie seed, and no credentials configured. ` +
          'Set LI_EMAIL and LI_PASSWORD, or run `npm run login` and upload the session.',
      );
    }

    const failures = this.loginFailures.get(identity.id);
    if (failures && failures.count >= MAX_LOGIN_FAILURES && Date.now() < failures.blockedUntil) {
      const minutes = Math.ceil((failures.blockedUntil - Date.now()) / 60_000);
      throw new ApiError(
        'AUTH_FAILED',
        `Automatic login for identity "${identity.label}" is suspended after ${failures.count} consecutive failures ` +
          `(last: ${failures.lastError}). Retrying a rejected credential risks locking the account. ` +
          `Fix LI_EMAIL / LI_PASSWORD, or run \`npm run login\` and upload the session. Retrying in ~${minutes}m.`,
        { details: { identity: identity.label, consecutiveFailures: failures.count, needsHuman: true } },
      );
    }

    const attempt = (async () => {
      this.logger.info({ identity: identity.label }, 'no usable session — attempting automatic login');

      const result = await performLogin({
        email: this.credentials!.email,
        password: this.credentials!.password,
        interactive: false,
        timezoneId: isValidTimezone(identity.cookies.timezone ?? '') ? identity.cookies.timezone : undefined,
        ...(identity.proxyUrl ? { proxy: toPlaywrightProxy(identity.proxyUrl) } : {}),
        log: (message) => { if (message) this.logger.debug({ identity: identity.label }, message); },
      });

      if (result.status === 'challenge') {
        this.registerChallenge(identity, result.handle, result.challengeUrl, result.kind);
        throw new ApiError(
          'AUTH_FAILED',
          `LinkedIn issued a ${result.kind === 'captcha' ? 'CAPTCHA' : 'verification code'} challenge for identity "${identity.label}". ` +
            (result.kind === 'captcha'
              ? 'A CAPTCHA cannot be answered through the API — run `npm run login` and upload the session.'
              : 'The browser is held open awaiting the code. Submit it to POST /v1/admin/session/challenge with {"code":"123456"}.'),
          {
            details: {
              identity: identity.label,
              challenge: result.kind,
              awaitingCode: result.kind !== 'captcha',
              needsHuman: true,
            },
          },
        );
      }

      await this.store.save(identity.id, result.state as StorageState);
      this.loginFailures.delete(identity.id);
      this.logger.info({ identity: identity.label, account: result.firstName }, 'automatic login succeeded; session stored');
      return result.state as StorageState;
    })().finally(() => this.logins.delete(identity.id));

    this.logins.set(identity.id, attempt);

    try {
      return await attempt;
    } catch (error) {
      // A challenge means the credentials were accepted and LinkedIn wants
      // verification. Counting it as a login failure would trip the breaker and
      // block the very retry that submitting the code enables.
      if (error instanceof ApiError && error.details?.challenge) throw error;

      const message = (error as Error).message ?? String(error);
      const previous = this.loginFailures.get(identity.id)?.count ?? 0;
      const count = previous + 1;
      this.loginFailures.set(identity.id, {
        count,
        lastError: message.slice(0, 200),
        blockedUntil: Date.now() + LOGIN_BLOCK_MS,
      });
      this.logger.error(
        { identity: identity.label, consecutiveFailures: count },
        count >= MAX_LOGIN_FAILURES
          ? 'automatic login suspended after repeated failures — a human needs to intervene'
          : 'automatic login failed',
      );

      // "Wrong email or password" is terminal: no amount of retrying fixes a
      // credential that is simply incorrect, and each attempt is a step towards
      // a locked account.
      if (/wrong email or password|incorrect|couldn.t find|not the right password/i.test(message)) {
        this.loginFailures.set(identity.id, {
          count: MAX_LOGIN_FAILURES,
          lastError: 'LinkedIn rejected the credentials',
          blockedUntil: Date.now() + LOGIN_BLOCK_MS,
        });
        throw new ApiError(
          'AUTH_FAILED',
          `LinkedIn rejected the credentials for identity "${identity.label}". ` +
            'Automatic login is suspended — check LI_EMAIL / LI_PASSWORD, or run `npm run login` and upload the session.',
          { cause: error, details: { identity: identity.label, needsHuman: true, credentialsRejected: true } },
        );
      }

      throw new ApiError(
        'AUTH_FAILED',
        `Automatic login failed for identity "${identity.label}": ${(error as Error).message}`,
        { cause: error, details: { identity: identity.label } },
      );
    }
  }

  // ─── Voyager over the live page ────────────────────────────────────────────

  /**
   * Issues a Voyager API call from inside the authenticated page.
   *
   * `credentials: 'include'` lets the browser attach its own cookie jar, so we
   * never hand it cookies. The csrf-token header is still required — Voyager
   * checks it — and is read from the live jar rather than from config, so a
   * token LinkedIn rotated mid-session stays correct.
   */
  async fetchVoyager(identity: Identity, path: string, landingUrl?: string): Promise<InPageResponse> {
    const live = await this.session(identity, landingUrl);

    // Same-origin navigation keeps the page on the profile being scraped, so
    // in-page requests look like that page's own traffic.
    if (landingUrl && !live.page.url().startsWith(landingUrl)) {
      await this.navigate(identity, live.page, landingUrl);
    }

    const url = path.startsWith('http') ? path : `https://www.linkedin.com/voyager/api${path}`;

    const result = await evaluateSettled(live.page, async (target: string): Promise<InPageResponse> => {
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

    live.lastTouchedAt = Date.now();
    // Persist before asserting: even a failed call may have rotated the token,
    // and losing the new value is what turns one failure into a dead session.
    await this.persist(identity, live.context);

    this.assertUsable(result, identity, path);
    return result;
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
    // The in-page fetch follows redirects, so an auth bounce arrives as a 200
    // whose final URL is the login page rather than as a 3xx.
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
   * carries — both server-rendered blobs and the XHRs the page fires itself.
   */
  async collectRenderedPayloads(identity: Identity, publicId: string): Promise<unknown[]> {
    const profileUrl = `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
    const live = await this.session(identity, profileUrl);
    const payloads: unknown[] = [];

    const onResponse = (response: { url(): string; json(): Promise<unknown> }) => {
      if (!response.url().includes('/voyager/api/')) return;
      response.json().then((body) => payloads.push(body)).catch(() => undefined);
    };
    live.page.on('response', onResponse);

    try {
      await this.navigate(identity, live.page, profileUrl);
      await live.page.waitForTimeout(3_000);

      const inline = await evaluateSettled(
        live.page,
        () =>
          Array.from(document.querySelectorAll('code[id^="bpr-guid-"]'))
            .map((node) => node.textContent ?? '')
            .filter((text) => text.includes('"data"') || text.includes('"included"')),
        null,
      );

      for (const text of inline) {
        try {
          payloads.push(JSON.parse(text));
        } catch {
          // Some blobs are HTML-escaped fragments rather than JSON.
        }
      }

      live.lastTouchedAt = Date.now();
      return payloads;
    } finally {
      live.page.off('response', onResponse);
    }
  }

  // ─── Teardown ──────────────────────────────────────────────────────────────

  /** Discards a session whose credentials LinkedIn has rejected. */
  async invalidate(identity: Identity): Promise<void> {
    await this.dispose(identity.id);
    await this.store.clear(identity.id).catch(() => undefined);
    this.logger.warn(
      { identity: identity.label, willRelogin: this.credentials !== null },
      'cleared session state after auth failure',
    );
  }

  async dispose(identityId: string): Promise<void> {
    const live = this.sessions.get(identityId);
    if (!live) return;
    this.sessions.delete(identityId);
    clearInterval(live.keepAlive);
    await live.context.close().catch(() => undefined);
  }

  /**
   * Clears the automatic-login circuit breaker and drops any live session, so
   * the next request re-establishes from scratch.
   *
   * Exists so that fixing a credential takes effect immediately. Without it,
   * recovery would mean either waiting out the breaker or redeploying — both
   * poor answers to "the password is corrected, try again".
   */
  private registerChallenge(identity: Identity, handle: ChallengeHandle, url: string, kind: string): void {
    void this.discardChallenge(identity.id);

    const reaper = setTimeout(() => { void this.discardChallenge(identity.id); }, CHALLENGE_TTL_MS);
    reaper.unref?.();

    this.pendingChallenges.set(identity.id, { handle, url, kind, reaper });
    this.logger.warn({ identity: identity.label, kind, url }, 'verification challenge pending — awaiting a code');
  }

  private async discardChallenge(identityId: string): Promise<void> {
    const pending = this.pendingChallenges.get(identityId);
    if (!pending) return;
    this.pendingChallenges.delete(identityId);
    clearTimeout(pending.reaper);
    await abandonChallenge(pending.handle);
  }

  /**
   * Submits a verification code into a pending challenge. On success the
   * resulting session is stored and the service is authenticated again with no
   * further action.
   */
  async submitChallengeCode(code: string, identityId?: string): Promise<{ identity: string; account: string | null }> {
    const id = identityId ?? [...this.pendingChallenges.keys()][0];
    const pending = id ? this.pendingChallenges.get(id) : undefined;

    if (!id || !pending) {
      throw new ApiError('AUTH_FAILED', 'There is no verification challenge awaiting a code.', {
        details: { pending: [...this.pendingChallenges.keys()] },
      });
    }

    try {
      const { firstName, state } = await completeChallenge(pending.handle, code);
      await this.store.save(id, state as StorageState);
      this.loginFailures.delete(id);

      // The challenge browser has done its job; the live session is rebuilt
      // from the stored state on the next request.
      this.pendingChallenges.delete(id);
      clearTimeout(pending.reaper);
      await abandonChallenge(pending.handle);
      await this.dispose(id);

      this.logger.info({ identity: id, account: firstName }, 'verification challenge cleared; session stored');
      return { identity: id, account: firstName };
    } catch (error) {
      // Left open deliberately: LinkedIn allows several attempts, and a fresh
      // login would only issue a fresh challenge.
      throw new ApiError('AUTH_FAILED', `Verification failed: ${(error as Error).message}`, {
        cause: error,
        details: { identity: id, retryable: true },
      });
    }
  }

  /** Pending challenges, for the health endpoint. */
  challenges(): Array<{ identity: string; kind: string; url: string; waitingSeconds: number }> {
    const now = Date.now();
    return [...this.pendingChallenges.entries()].map(([identity, c]) => ({
      identity,
      kind: c.kind,
      url: c.url,
      waitingSeconds: Math.floor((now - c.handle.openedAt) / 1000),
    }));
  }

  async resetLoginBreaker(identity?: Identity): Promise<{ cleared: string[] }> {
    const targets = identity ? [identity.id] : [...new Set([...this.loginFailures.keys(), ...this.sessions.keys()])];

    for (const id of targets) {
      this.loginFailures.delete(id);
      await this.discardChallenge(id);
      await this.dispose(id);
    }

    this.logger.info({ identities: targets }, 'login circuit breaker reset; sessions dropped');
    return { cleared: targets };
  }

  /** Per-identity automatic-login failure state, for the health endpoint. */
  loginHealth(): Array<{ identity: string; consecutiveFailures: number; suspended: boolean; lastError: string }> {
    const now = Date.now();
    return [...this.loginFailures.entries()].map(([identity, f]) => ({
      identity,
      consecutiveFailures: f.count,
      suspended: f.count >= MAX_LOGIN_FAILURES && now < f.blockedUntil,
      lastError: f.lastError,
    }));
  }

  stats(): SessionStats[] {
    const now = Date.now();
    return [...this.sessions.entries()].map(([identity, live]) => ({
      identity,
      open: !live.page.isClosed(),
      ageSeconds: Math.floor((now - live.openedAt) / 1000),
      idleSeconds: Math.floor((now - live.lastTouchedAt) / 1000),
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.pendingChallenges.keys()]) await this.discardChallenge(id);
    for (const id of [...this.sessions.keys()]) await this.dispose(id);
  }
}

/**
 * `page.evaluate` throws "Execution context was destroyed" when the page
 * navigates mid-evaluation. That is routine here, not exceptional: LinkedIn
 * redirects stale vanity names to a member's current one, and its SPA performs
 * client-side navigations after load. Both destroy the execution context the
 * evaluation was scheduled in.
 *
 * So wait for the page to settle and try again rather than failing the request.
 */
async function evaluateSettled<T, A>(page: Page, fn: (arg: A) => T | Promise<T>, arg: A, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // Playwright's Unboxed<A> generic cannot see through this wrapper's own
      // type parameter; the runtime contract is unchanged.
      return (await page.evaluate(fn as never, arg as never)) as T;
    } catch (error) {
      lastError = error;
      const message = String((error as Error).message ?? '');
      const navigated =
        message.includes('Execution context was destroyed') ||
        message.includes('Target closed') ||
        message.includes('navigating and changing');
      if (!navigated) throw error;

      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(700 * (attempt + 1));
    }
  }

  throw lastError;
}

function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * LinkedIn scopes its auth cookies to `.www.linkedin.com` and its
 * browser-identity cookies to `.linkedin.com`. Confirmed off the wire, from the
 * Set-Cookie headers LinkedIn sends when invalidating a session:
 *
 *   li_at=delete me;   Domain=.www.linkedin.com
 *   li_a="delete me";  Domain=.www.linkedin.com
 *   liap=delete me;    Domain=.linkedin.com
 *
 * Putting them all on `.linkedin.com` — the obvious guess — means the browser
 * never sends li_at to www.linkedin.com, and LinkedIn's clear-and-retry 302
 * becomes an infinite redirect loop surfacing as ERR_TOO_MANY_REDIRECTS, which
 * looks nothing like the cookie-scope bug it is.
 */
const WWW_SCOPED = new Set(['li_at', 'li_a', 'JSESSIONID', 'li_rm']);

export function toPlaywrightCookies(identity: Identity) {
  const jar: Record<string, string> = { ...identity.cookies };
  jar.li_at = identity.liAt;
  jar.JSESSIONID = `"${identity.csrfToken}"`;

  return Object.entries(jar)
    .filter(([, value]) => value)
    .map(([name, value]) => ({
      name,
      value,
      domain: WWW_SCOPED.has(name) ? '.www.linkedin.com' : '.linkedin.com',
      path: '/',
      secure: true,
      httpOnly: name === 'li_at' || name === 'li_rm',
      // NOT 'None': Chromium blocks SameSite=None cookies as third-party by
      // default, which stores them but silently never sends them. Our requests
      // are same-site, so Lax is both correct and unblocked.
      sameSite: 'Lax' as const,
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
