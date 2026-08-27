import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { timingSafeEqual } from 'node:crypto';

import { getConfig, type AppConfig } from './config.js';
import { ApiError, isApiError } from './errors.js';
import { createCache } from './cache/index.js';
import { IdentityPool } from './identity/pool.js';
import { ProfileScraper } from './linkedin/scraper.js';
import { ScrapeLimiter } from './ratelimit/scrape-limiter.js';
import { ProfileService } from './service/profile-service.js';
import { BrowserFallback } from './fallback/browser.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerHealthRoutes } from './routes/health.js';
import { buildOpenApiDocument } from './openapi.js';

export interface BuiltServer {
  app: FastifyInstance;
  config: AppConfig;
  shutdown: () => Promise<void>;
}

export async function buildServer(config: AppConfig = getConfig()): Promise<BuiltServer> {
  const startedAt = Date.now();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Cloud Run's log explorer keys off `severity`, not pino's numeric level.
      formatters: { level: (label) => ({ severity: label.toUpperCase(), level: label }) },
      redact: {
        paths: ['req.headers.cookie', 'req.headers["x-api-key"]', 'req.headers.authorization'],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
    disableRequestLogging: false,
    bodyLimit: 64 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] });

  // Per-caller throttle. Distinct from the LinkedIn scrape ceiling: this one
  // protects the service, that one protects the LinkedIn account.
  await app.register(rateLimit, {
    max: 60,
    timeWindow: '1 minute',
    allowList: (request) => request.url === '/healthz',
  });

  const pool = new IdentityPool(config);
  const cache = createCache(config);
  const limiter = new ScrapeLimiter(config.scrapeRatePerMinute);

  const browserFallback = config.enableBrowserFallback ? new BrowserFallback(pool, app.log) : null;
  const scraper = new ProfileScraper(
    pool,
    app.log,
    browserFallback ? (publicId) => browserFallback.scrape(publicId) : null,
  );
  const service = new ProfileService(scraper, cache, limiter, config, app.log);

  registerApiKeyAuth(app, config);
  registerErrorHandler(app);

  await app.register(swagger, {
    mode: 'static',
    specification: { document: buildOpenApiDocument(process.env.PUBLIC_BASE_URL || `http://localhost:${config.port}`) as never },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });

  registerHealthRoutes(app, { pool, cache, limiter, startedAt });
  registerProfileRoutes(app, service);

  if (pool.size === 0) {
    app.log.warn(
      'No LinkedIn identity configured — every scrape will fail with NO_IDENTITY_AVAILABLE. ' +
        'Set LINKEDIN_IDENTITIES or LI_AT + LI_JSESSIONID.',
    );
  }

  return {
    app,
    config,
    shutdown: async () => {
      await browserFallback?.close();
      await app.close();
    },
  };
}

/**
 * Optional API-key gate. Public endpoints (health, docs) stay open so the
 * deployment is verifiable without a key.
 */
function registerApiKeyAuth(app: FastifyInstance, config: AppConfig): void {
  if (config.apiKeys.length === 0) return;

  const PUBLIC_PREFIXES = ['/health', '/healthz', '/docs', '/documentation'];

  app.addHook('onRequest', async (request) => {
    if (PUBLIC_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;
    if (request.method === 'OPTIONS') return;

    const provided = request.headers['x-api-key'];
    const key = Array.isArray(provided) ? provided[0] : provided;

    if (!key || !config.apiKeys.some((valid) => constantTimeEqual(valid, key))) {
      throw new ApiError('UNAUTHORIZED', 'A valid x-api-key header is required.');
    }
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which itself leaks length —
  // hashing to a fixed width avoids both problems.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}. See /docs.` },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (isApiError(error)) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(error.retryAfterSeconds));
      }
      // Expected upstream conditions are warnings; they're not our bugs.
      const log = error.statusCode >= 500 ? request.log.error : request.log.warn;
      log.call(request.log, { err: error, code: error.code }, 'request failed');
      return reply.status(error.statusCode).send(error.toJSON());
    }

    // @fastify/rate-limit surfaces its own 429.
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests to this API. Slow down and retry.' },
      });
    }

    if ((error as { statusCode?: number }).statusCode === 400) {
      return reply.status(400).send({
        success: false,
        error: { code: 'INVALID_URL', message: (error as Error).message },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      success: false,
      error: { code: 'INTERNAL', message: 'An unexpected error occurred.' },
    });
  });
}
