import type { FastifyInstance } from 'fastify';
import type { ProfileCache } from '../cache/index.js';
import type { IdentityPool } from '../identity/pool.js';
import type { ScrapeLimiter } from '../ratelimit/scrape-limiter.js';
import type { BrowserSession } from '../browser/session.js';
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
    browserSession: BrowserSession | null;
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
      browserSessions: deps.browserSession?.stats() ?? [],
      // Non-empty means automatic login is failing and may need operator action.
      loginHealth: deps.browserSession?.loginHealth() ?? [],
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
    if (!deps.browserSession) {
      return { success: true as const, cleared: [], note: 'browser transport is disabled' };
    }
    const { cleared } = await deps.browserSession.resetLoginBreaker();
    return { success: true as const, cleared };
  });

  app.get('/', async (_request, reply) => reply.redirect('/docs', 302));
}
