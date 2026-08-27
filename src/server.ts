import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { timingSafeEqual } from 'node:crypto';

import { getConfig, type AppConfig } from './config.js';
import { ApiError, isApiError } from './errors.js';
import { createCache } from './cache/index.js';
import { IdentityPool } from './identity/pool.js';
import { ProfileScraper } from './linkedin/scraper.js';
import { ScrapeLimiter } from './ratelimit/scrape-limiter.js';
import { KeyedSlidingWindowLimiter, SlidingWindowLimiter } from './ratelimit/sliding-window.js';
import { ProfileService } from './service/profile-service.js';
import { BrowserSession } from './browser/session.js';
import { FileSessionStore, GcsSessionStore, type SessionStore } from './browser/session-store.js';
import { Storage } from '@google-cloud/storage';
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


  const pool = new IdentityPool(config);
  const cache = createCache(config);
  const limiter = new ScrapeLimiter(config.scrapeRatePerMinute);
  const globalLimiter = new SlidingWindowLimiter(config.globalRatePerMinute);
  const clientLimiter = new KeyedSlidingWindowLimiter(config.clientRatePerMinute);

  // Persisted browser state is what lets us follow LinkedIn's li_at rotation
  // instead of replaying a stale token — see browser/session-store.ts.
  const sessionStore: SessionStore = config.gcsBucket
    ? new GcsSessionStore(new Storage(), config.gcsBucket)
    : new FileSessionStore(config.sessionStateDir);

  const credentials =
    config.loginEmail && config.loginPassword
      ? { email: config.loginEmail, password: config.loginPassword }
      : null;

  const browserSession = config.enableBrowserFallback
    ? new BrowserSession(app.log, sessionStore, credentials, config.browserProfileDir)
    : null;
  const scraper = new ProfileScraper(pool, app.log, browserSession, config.enableHttpTransport);
  const service = new ProfileService(scraper, cache, limiter, config, app.log);

  registerApiKeyAuth(app, config);
  registerRateLimits(app, { globalLimiter, clientLimiter });
  registerErrorHandler(app);

  await app.register(swagger, {
    mode: 'static',
    specification: { document: buildOpenApiDocument(process.env.PUBLIC_BASE_URL || `http://localhost:${config.port}`) as never },
  });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list' } });

  registerHealthRoutes(app, { pool, cache, limiter, globalLimiter, clientLimiter, startedAt, browserSession });
  registerProfileRoutes(app, service);

  if (!browserSession && !config.enableHttpTransport) {
    throw new Error(
      'No extraction transport is enabled: ENABLE_BROWSER_FALLBACK and ENABLE_HTTP_TRANSPORT are both false. ' +
        'Enable at least one, or the service can never fetch a profile.',
    );
  }

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
      await browserSession?.close();
      await app.close();
    },
  };
}

/**
 * Paths that must stay answerable even when the service is saturated.
 *
 * /health is included deliberately: it is the endpoint that reports remaining
 * quota, so rate-limiting it makes it unavailable exactly when a caller most
 * needs to know why they are being throttled.
 */
const UNLIMITED_PATHS = ['/healthz', '/health'];

/**
 * The two caller-facing rate limits. Both are separate from the LinkedIn scrape
 * ceiling, and the separation is the point:
 *
 *   scrape ceiling  protects the LinkedIn account   (live fetches only)
 *   global limit    protects this service            (every request)
 *   per-client      keeps one caller from taking it all
 *
 * A cached response costs LinkedIn nothing, so it counts against the caller
 * limits but never against the scrape ceiling.
 *
 * Checked per-client first: when a single caller is responsible for saturating
 * the service, they should be the one told to slow down rather than everyone.
 */
function registerRateLimits(
  app: FastifyInstance,
  limits: { globalLimiter: SlidingWindowLimiter; clientLimiter: KeyedSlidingWindowLimiter },
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (UNLIMITED_PATHS.includes(request.url.split('?')[0] ?? '')) return;
    if (request.method === 'OPTIONS') return;

    const client = clientKey(request);

    const perClient = limits.clientLimiter.tryAcquire(client);
    if (!perClient.ok) {
      reply.header('retry-after', String(perClient.retryAfterSeconds));
      throw new ApiError('RATE_LIMITED', 'Too many requests from this client. Slow down and retry.', {
        retryAfterSeconds: perClient.retryAfterSeconds,
        details: { scope: 'client' },
      });
    }

    const global = limits.globalLimiter.tryAcquire();
    if (!global.ok) {
      reply.header('retry-after', String(global.retryAfterSeconds));
      throw new ApiError('RATE_LIMITED', 'The service is at its overall request limit. Retry shortly.', {
        retryAfterSeconds: global.retryAfterSeconds,
        details: { scope: 'service' },
      });
    }
  });
}

/**
 * Identifies a caller. An API key is the strongest signal available; otherwise
 * the client address, which `trustProxy` resolves through X-Forwarded-For so
 * every caller behind the reverse proxy is not treated as one client.
 */
function clientKey(request: { headers: Record<string, unknown>; ip: string }): string {
  const provided = request.headers['x-api-key'];
  const key = Array.isArray(provided) ? provided[0] : provided;
  return typeof key === 'string' && key.length > 0 ? `key:${key.slice(0, 12)}` : `ip:${request.ip}`;
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
