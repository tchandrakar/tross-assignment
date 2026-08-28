import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../../errors.js';
import type { Identity } from '../../identity/pool.js';
import type { SessionStore } from '../../session/store.js';
import { NullSessionStore } from '../../session/store.js';
import { CookieJar } from './cookie-jar.js';
import { LinkedinHttpClient, type LinkedinResponse } from './client.js';
import { login, submitChallenge, type LoginOutcome } from './login.js';

/**
 * Owns one authenticated LinkedIn session per identity, over plain HTTP.
 *
 * Responsibilities, in the order they matter:
 *
 * 1. **Follow token rotation.** Every response's `Set-Cookie` is absorbed and,
 *    when the session token changes, persisted. Not doing this is what kills
 *    HTTP sessions (see cookie-jar.ts).
 * 2. **Establish a session when there is none** — from stored cookies, from a
 *    seed cookie header, or by signing in.
 * 3. **Keep it warm.** A periodic lightweight call keeps the stored session
 *    recent, so it is less likely to be stale when finally needed. Signing in
 *    is the most challenge-prone thing this service does, so the goal is to do
 *    it once.
 */

/** How often an idle session is refreshed. */
const KEEPALIVE_INTERVAL_MS = 8 * 60_000;

/** Consecutive failed sign-ins before the service stops trying. */
const MAX_LOGIN_FAILURES = 3;

/** How long sign-in stays suspended after tripping the breaker. */
const LOGIN_BLOCK_MS = 30 * 60_000;

/** How long an unanswered challenge is held before being discarded. */
const CHALLENGE_TTL_MS = 45 * 60_000;

interface LiveSession {
  client: LinkedinHttpClient;
  openedAt: number;
  lastTouchedAt: number;
  keepAlive: NodeJS.Timeout;
}

interface PendingChallenge {
  client: LinkedinHttpClient;
  url: string;
  fields: Record<string, string>;
  openedAt: number;
  reaper: NodeJS.Timeout;
}

export interface SessionStats {
  identity: string;
  open: boolean;
  ageSeconds: number;
  idleSeconds: number;
  cookies: number;
}

export class HttpSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly opening = new Map<string, Promise<LiveSession>>();
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly loginFailures = new Map<string, { count: number; lastError: string; blockedUntil: number }>();
  private closed = false;

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly store: SessionStore = new NullSessionStore(),
    private readonly credentials: { email: string; password: string } | null = null,
    /**
     * Whether this instance may sign in by itself. Off in production: a
     * datacenter sign-in is challenged nearly every time, and repeated
     * challenged sign-ins are what gets an account restricted.
     */
    private readonly allowAutoLogin = false,
  ) {}

  // ─── Requests ──────────────────────────────────────────────────────────────

  /**
   * Performs an authenticated Voyager call, establishing the session first if
   * needed and persisting any rotated cookies afterwards.
   */
  async fetchVoyager(identity: Identity, path: string, referer?: string): Promise<LinkedinResponse> {
    const session = await this.session(identity);

    const response = await session.client.request({
      path: path.startsWith('/voyager') ? path : `/voyager/api${path}`,
      kind: 'api',
      ...(referer ? { referer } : {}),
    });

    session.lastTouchedAt = Date.now();

    // Persist before interpreting the status: even a rejected call may have
    // rotated the token, and losing the new value turns one failure into a
    // dead session.
    if (response.rotated.length > 0) await this.persist(identity, session.client.jar);

    this.assertUsable(response, identity, path);
    return response;
  }

  private assertUsable(response: LinkedinResponse, identity: Identity, path: string): void {
    const { status } = response;

    if (response.sessionCleared) {
      throw new ApiError(
        'AUTH_FAILED',
        `LinkedIn invalidated the session for identity "${identity.label}". ` +
          'This is what a replayed or expired session token looks like to LinkedIn.',
        { details: { identity: identity.label, sessionCleared: true } },
      );
    }

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
      throw new ApiError('AUTH_FAILED', `LinkedIn rejected the session for identity "${identity.label}".`, {
        details: { status },
      });
    }

    if (status >= 300 && status < 400) {
      const location = String(response.headers.location ?? '');
      throw new ApiError('AUTH_FAILED', `Redirected to "${location}" — the session is not authenticated.`, {
        details: { status, location },
      });
    }

    if (status >= 500) {
      throw new ApiError('UPSTREAM_BLOCKED', `LinkedIn returned a server error (${status}) for ${path}.`, {
        details: { status },
      });
    }
  }

  // ─── Session lifecycle ─────────────────────────────────────────────────────

  private async session(identity: Identity): Promise<LiveSession> {
    const live = this.sessions.get(identity.id);
    if (live) {
      live.lastTouchedAt = Date.now();
      return live;
    }

    const inFlight = this.opening.get(identity.id);
    if (inFlight) return inFlight;

    const opening = this.open(identity).finally(() => this.opening.delete(identity.id));
    this.opening.set(identity.id, opening);
    return opening;
  }

  private async open(identity: Identity): Promise<LiveSession> {
    const jar = await this.resolveJar(identity);
    const client = new LinkedinHttpClient(jar, identity.proxyUrl);

    const live: LiveSession = {
      client,
      openedAt: Date.now(),
      lastTouchedAt: Date.now(),
      keepAlive: setInterval(() => void this.touch(identity), KEEPALIVE_INTERVAL_MS),
    };
    live.keepAlive.unref?.();

    this.sessions.set(identity.id, live);
    await this.persist(identity, jar);
    this.logger.info({ identity: identity.label, cookies: jar.size }, 'HTTP session established');
    return live;
  }

  /**
   * Produces an authenticated jar, in order of preference: stored session,
   * configured seed cookies, then signing in.
   */
  private async resolveJar(identity: Identity): Promise<CookieJar> {
    const stored = await this.store.load(identity.id).catch(() => null);
    const fromStore = stored ? CookieJar.fromJSON(stored) : null;

    if (fromStore?.isAuthenticated()) {
      const verified = await this.verify(identity, fromStore);
      if (verified) {
        this.logger.debug({ identity: identity.label }, 'restored session from the store');
        return fromStore;
      }
      this.logger.warn({ identity: identity.label }, 'stored session is no longer valid');
      await this.store.clear(identity.id).catch(() => undefined);
    }

    if (identity.liAt) {
      const seed = new CookieJar({ ...identity.cookies, li_at: identity.liAt, JSESSIONID: identity.jsessionId });
      if (await this.verify(identity, seed)) {
        this.logger.info({ identity: identity.label }, 'seeded session from configured cookies');
        return seed;
      }
      this.logger.warn({ identity: identity.label }, 'configured cookie seed is not valid');
    }

    return this.signIn(identity);
  }

  /** Confirms a jar is authenticated by asking the API, not by inspecting cookies. */
  private async verify(identity: Identity, jar: CookieJar): Promise<boolean> {
    const client = new LinkedinHttpClient(jar, identity.proxyUrl);
    try {
      const response = await client.request({ path: '/voyager/api/me', kind: 'api' });
      return response.status === 200 && !response.sessionCleared;
    } catch {
      return false;
    } finally {
      await client.close();
    }
  }

  // ─── Sign-in ───────────────────────────────────────────────────────────────

  private async signIn(identity: Identity): Promise<CookieJar> {
    if (!this.allowAutoLogin) {
      throw new ApiError(
        'AUTH_FAILED',
        `Identity "${identity.label}" has no valid session, and automatic sign-in is disabled. ` +
          'Establish a session with `npm run login` from a trusted network and upload it, ' +
          'or set ALLOW_AUTO_LOGIN=true to let this instance sign in itself.',
        { details: { identity: identity.label, needsHuman: true, autoLoginDisabled: true } },
      );
    }

    if (!this.credentials) {
      throw new ApiError(
        'AUTH_FAILED',
        `Identity "${identity.label}" has no stored session, no cookie seed and no credentials. ` +
          'Set LI_EMAIL and LI_PASSWORD, or supply LI_COOKIES.',
        { details: { identity: identity.label, needsHuman: true } },
      );
    }

    const failures = this.loginFailures.get(identity.id);
    if (failures && failures.count >= MAX_LOGIN_FAILURES && Date.now() < failures.blockedUntil) {
      const minutes = Math.ceil((failures.blockedUntil - Date.now()) / 60_000);
      throw new ApiError(
        'AUTH_FAILED',
        `Sign-in for identity "${identity.label}" is suspended after ${failures.count} consecutive failures ` +
          `(last: ${failures.lastError}). Retrying a rejected credential risks locking the account. Retrying in ~${minutes}m.`,
        { details: { identity: identity.label, needsHuman: true } },
      );
    }

    const jar = new CookieJar();
    const client = new LinkedinHttpClient(jar, identity.proxyUrl);

    let outcome: LoginOutcome;
    try {
      outcome = await login(client, this.credentials, (m) => this.logger.debug({ identity: identity.label }, m));
    } catch (error) {
      await client.close();
      this.recordLoginFailure(identity, error);
      throw error;
    }

    if (outcome.status === 'challenge') {
      // The challenge's hidden fields are bound to this jar, so the client is
      // held rather than closed — discarding it and signing in again would only
      // produce another challenge.
      this.registerChallenge(identity, client, outcome.challengeUrl!, outcome.challengeFields ?? {});
      throw new ApiError(
        'AUTH_FAILED',
        `LinkedIn issued a verification challenge for identity "${identity.label}". ` +
          'Submit the emailed code to POST /v1/admin/session/challenge with {"code":"123456"}.',
        { details: { identity: identity.label, awaitingCode: true, needsHuman: true } },
      );
    }

    this.loginFailures.delete(identity.id);
    await client.close();
    return jar;
  }

  private recordLoginFailure(identity: Identity, error: unknown): void {
    const message = (error as Error).message ?? String(error);
    const rejected = error instanceof ApiError && Boolean(error.details?.credentialsRejected);

    const previous = this.loginFailures.get(identity.id)?.count ?? 0;
    this.loginFailures.set(identity.id, {
      // A rejected credential is terminal: retrying cannot succeed, and each
      // attempt moves the account towards a lockout.
      count: rejected ? MAX_LOGIN_FAILURES : previous + 1,
      lastError: message.slice(0, 200),
      blockedUntil: Date.now() + LOGIN_BLOCK_MS,
    });
  }

  // ─── Challenges ────────────────────────────────────────────────────────────

  private registerChallenge(identity: Identity, client: LinkedinHttpClient, url: string, fields: Record<string, string>): void {
    void this.discardChallenge(identity.id);

    const reaper = setTimeout(() => void this.discardChallenge(identity.id), CHALLENGE_TTL_MS);
    reaper.unref?.();

    this.challenges.set(identity.id, { client, url, fields, openedAt: Date.now(), reaper });
    this.logger.warn({ identity: identity.label, url }, 'verification challenge pending — awaiting a code');
  }

  private async discardChallenge(identityId: string): Promise<void> {
    const pending = this.challenges.get(identityId);
    if (!pending) return;
    this.challenges.delete(identityId);
    clearTimeout(pending.reaper);
    await pending.client.close();
  }

  async submitChallengeCode(code: string, identityId?: string): Promise<{ identity: string; cookies: number }> {
    const id = identityId ?? [...this.challenges.keys()][0];
    const pending = id ? this.challenges.get(id) : undefined;

    if (!id || !pending) {
      throw new ApiError('AUTH_FAILED', 'There is no verification challenge awaiting a code.', {
        details: { pending: [...this.challenges.keys()] },
      });
    }

    await submitChallenge(
      pending.client,
      { challengeUrl: pending.url, challengeFields: pending.fields },
      code,
      (m) => this.logger.debug({ identity: id }, m),
    );

    const jar = pending.client.jar;
    await this.store.save(id, jar.toJSON() as never);
    this.loginFailures.delete(id);

    this.challenges.delete(id);
    clearTimeout(pending.reaper);
    await pending.client.close();
    await this.dispose(id);

    this.logger.info({ identity: id, cookies: jar.size }, 'verification challenge cleared');
    return { identity: id, cookies: jar.size };
  }

  // ─── Keepalive and persistence ─────────────────────────────────────────────

  private async touch(identity: Identity): Promise<void> {
    const live = this.sessions.get(identity.id);
    if (!live || this.closed) return;
    if (Date.now() - live.lastTouchedAt < KEEPALIVE_INTERVAL_MS) return;

    try {
      const response = await live.client.request({ path: '/voyager/api/me', kind: 'api' });
      live.lastTouchedAt = Date.now();
      if (response.rotated.length > 0) await this.persist(identity, live.client.jar);

      if (response.status === 401 || response.sessionCleared) {
        this.logger.warn({ identity: identity.label }, 'keepalive found the session invalid; dropping it');
        await this.invalidate(identity);
      }
    } catch (error) {
      this.logger.debug({ err: error, identity: identity.label }, 'keepalive failed (non-fatal)');
    }
  }

  private async persist(identity: Identity, jar: CookieJar): Promise<void> {
    try {
      await this.store.save(identity.id, jar.toJSON() as never);
    } catch (error) {
      this.logger.error({ err: error, identity: identity.label }, 'failed to persist session cookies');
    }
  }

  // ─── Teardown and introspection ────────────────────────────────────────────

  async invalidate(identity: Identity): Promise<void> {
    await this.dispose(identity.id);
    await this.store.clear(identity.id).catch(() => undefined);
    this.logger.warn({ identity: identity.label }, 'cleared session after authentication failure');
  }

  async dispose(identityId: string): Promise<void> {
    const live = this.sessions.get(identityId);
    if (!live) return;
    this.sessions.delete(identityId);
    clearInterval(live.keepAlive);
    await live.client.close();
  }

  async resetLoginBreaker(): Promise<{ cleared: string[] }> {
    const targets = [...new Set([...this.loginFailures.keys(), ...this.sessions.keys(), ...this.challenges.keys()])];
    for (const id of targets) {
      this.loginFailures.delete(id);
      await this.discardChallenge(id);
      await this.dispose(id);
    }
    this.logger.info({ identities: targets }, 'sign-in breaker reset; sessions dropped');
    return { cleared: targets };
  }

  loginHealth(): Array<{ identity: string; consecutiveFailures: number; suspended: boolean; lastError: string }> {
    const now = Date.now();
    return [...this.loginFailures.entries()].map(([identity, f]) => ({
      identity,
      consecutiveFailures: f.count,
      suspended: f.count >= MAX_LOGIN_FAILURES && now < f.blockedUntil,
      lastError: f.lastError,
    }));
  }

  challengeState(): Array<{ identity: string; kind: string; url: string; waitingSeconds: number }> {
    const now = Date.now();
    return [...this.challenges.entries()].map(([identity, c]) => ({
      identity,
      kind: 'code',
      url: c.url,
      waitingSeconds: Math.floor((now - c.openedAt) / 1000),
    }));
  }

  stats(): SessionStats[] {
    const now = Date.now();
    return [...this.sessions.entries()].map(([identity, live]) => ({
      identity,
      open: true,
      ageSeconds: Math.floor((now - live.openedAt) / 1000),
      idleSeconds: Math.floor((now - live.lastTouchedAt) / 1000),
      cookies: live.client.jar.size,
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.challenges.keys()]) await this.discardChallenge(id);
    for (const id of [...this.sessions.keys()]) await this.dispose(id);
  }
}
