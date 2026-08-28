import type { FastifyInstance } from 'fastify';
import type { ProfileCache } from '../cache/index.js';
import type { IdentityPool } from '../identity/pool.js';
import type { ScrapeLimiter } from '../ratelimit/scrape-limiter.js';
import type { HttpSessionManager } from '../linkedin/http/session.js';
import { ApiError } from '../errors.js';
import type { KeyedSlidingWindowLimiter, SlidingWindowLimiter } from '../ratelimit/sliding-window.js';

/**
 * Health is deliberately unauthenticated but leaks nothing sensitive: identity
 * labels and proxy hostnames only, never cookies or proxy credentials.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  deps: {
    pool: IdentityPool;
    cache: ProfileCache;
    limiter: ScrapeLimiter;
    globalLimiter: SlidingWindowLimiter;
    clientLimiter: KeyedSlidingWindowLimiter;
    startedAt: number;
    sessions: HttpSessionManager;
  },
): void {
  app.get('/health', async () => {
    const identities = deps.pool.health();
    const cacheHealthy = await deps.cache.healthy();
    const anyIdentityUsable = identities.some((i) => i.state === 'available');

    const budget = deps.limiter.status();
    const global = deps.globalLimiter.status();

    return {
      status: anyIdentityUsable && cacheHealthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      // Promoted to the top level: "how many scrapes do I have left right now"
      // is the question this endpoint is most often asked.
      requestsRemaining: budget.remaining,
      rateLimits: {
        // New profiles fetched from LinkedIn. Cache hits do not consume this.
        scrapesPerMinute: budget,
        // Every request, service-wide.
        requestsPerMinute: global,
        // Per caller, applied before the service-wide limit.
        perClientPerMinute: { limitPerMinute: deps.clientLimiter.limitPerMinute, activeClients: deps.clientLimiter.activeKeys },
      },
      scrapeBudget: budget,
      cache: { kind: deps.cache.kind, healthy: cacheHealthy },
      // A session that is open and recently touched is one that will not need
      // to log in again — which is the whole point of keeping it warm.
      sessions: deps.sessions.stats(),
      // Non-empty means automatic login is failing and may need operator action.
      loginHealth: deps.sessions.loginHealth(),
      // Non-empty means LinkedIn is waiting on a verification code. Submit it
      // to POST /v1/admin/session/challenge to finish authenticating.
      pendingChallenges: deps.sessions.challengeState(),
      identities,
    };
  });

  // Liveness only — never touches a dependency, so Cloud Run won't cycle the
  // container just because LinkedIn is rate-limiting us.
  app.get('/healthz', async () => ({ status: 'ok' }));

  /**
   * Clears the automatic-login circuit breaker and drops live sessions, so a
   * corrected credential takes effect on the very next request rather than
   * after a timeout or a redeploy. Protected by the API key when one is set.
   */
  app.post('/v1/admin/session/reset', async () => {
    const { cleared } = await deps.sessions.resetLoginBreaker();
    // Same reasoning as the challenge endpoint: a reset is an operator saying
    // "the cause is fixed", so accumulated backoff should not outlive it.
    const released = deps.pool.release();
    return { success: true as const, cleared, identitiesReleased: released };
  });

  /**
   * Submits a verification code for a pending challenge. This is what makes
   * unattended authentication completable: LinkedIn challenges a login from an
   * unfamiliar device, the browser is held open awaiting the code, and this
   * endpoint delivers it without anyone needing access to the browser itself.
   */
  app.post<{ Body: { code?: string; identity?: string } }>('/v1/admin/session/challenge', async (request) => {
    const code = (request.body?.code ?? '').trim();
    if (!/^[0-9]{4,8}$/.test(code)) {
      throw new ApiError('INVALID_URL', 'Body must be {"code":"123456"} — a 4 to 8 digit verification code.');
    }

    const result = await deps.sessions.submitChallengeCode(code, request.body?.identity);

    // Release identity cooldowns too. The backoff was accumulated by the very
    // failures this challenge has just resolved; leaving it in place would keep
    // the service unavailable after a successful recovery.
    const released = deps.pool.release();

    return { success: true as const, ...result, identitiesReleased: released };
  });

  app.get('/', async (_request, reply) => reply.redirect('/docs', 302));
}
