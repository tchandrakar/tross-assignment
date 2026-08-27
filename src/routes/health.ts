import type { FastifyInstance } from 'fastify';
import type { ProfileCache } from '../cache/index.js';
import type { IdentityPool } from '../identity/pool.js';
import type { ScrapeLimiter } from '../ratelimit/scrape-limiter.js';

/**
 * Health is deliberately unauthenticated but leaks nothing sensitive: identity
 * labels and proxy hostnames only, never cookies or proxy credentials.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { pool: IdentityPool; cache: ProfileCache; limiter: ScrapeLimiter; startedAt: number },
): void {
  app.get('/health', async () => {
    const identities = deps.pool.health();
    const cacheHealthy = await deps.cache.healthy();
    const anyIdentityUsable = identities.some((i) => i.state === 'available');

    return {
      status: anyIdentityUsable && cacheHealthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      cache: { kind: deps.cache.kind, healthy: cacheHealthy },
      scrapeBudget: deps.limiter.status(),
      identities,
    };
  });

  // Liveness only — never touches a dependency, so Cloud Run won't cycle the
  // container just because LinkedIn is rate-limiting us.
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/', async (_request, reply) => reply.redirect('/docs', 302));
}
