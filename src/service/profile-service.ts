import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { CACHE_SCHEMA_VERSION, isFresh, type ProfileCache } from '../cache/index.js';
import type { ProfileScraper } from '../linkedin/scraper.js';
import type { ScrapeLimiter } from '../ratelimit/scrape-limiter.js';
import type { Profile, ProfileMeta } from '../schema/profile.js';

export interface GetProfileOptions {
  publicId: string;
  profileUrl: string;
  /** Bypass the cache and force a live scrape (still subject to the rate limit). */
  refresh?: boolean;
}

export interface GetProfileResult {
  data: Profile;
  meta: ProfileMeta;
}

/**
 * Cache-first read path.
 *
 *   cache hit (fresh)  → served immediately, no LinkedIn traffic, no rate-limit spend
 *   cache miss / stale → one live scrape, result written back to the blob store
 *
 * Concurrent requests for the same profile are collapsed into a single scrape
 * (see `inflight`): without that, ten simultaneous requests for one profile
 * would burn ten of the five-per-minute slots on identical work.
 */
export class ProfileService {
  private readonly inflight = new Map<string, Promise<GetProfileResult>>();

  constructor(
    private readonly scraper: ProfileScraper,
    private readonly cache: ProfileCache,
    private readonly limiter: ScrapeLimiter,
    private readonly config: AppConfig,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async getProfile(options: GetProfileOptions): Promise<GetProfileResult> {
    const startedAt = Date.now();
    const { publicId, refresh = false } = options;

    if (!refresh && this.config.cacheEnabled) {
      const cached = await this.readCache(publicId);
      if (cached) {
        return {
          data: cached.profile,
          meta: {
            cached: true,
            source: cached.source,
            scrapedAt: cached.scrapedAt,
            ageSeconds: cached.ageSeconds,
            durationMs: Date.now() - startedAt,
            missingSections: cached.missingSections,
          },
        };
      }
    }

    const existing = this.inflight.get(publicId);
    if (existing) {
      this.logger.debug({ publicId }, 'joining in-flight scrape');
      return existing;
    }

    const promise = this.scrapeAndStore(publicId, startedAt).finally(() => {
      this.inflight.delete(publicId);
    });
    this.inflight.set(publicId, promise);
    return promise;
  }

  private async readCache(publicId: string) {
    try {
      const entry = await this.cache.get(publicId);
      if (!entry) return null;
      if (!isFresh(entry, this.config.cacheTtlSeconds)) {
        this.logger.debug({ publicId, ageSeconds: entry.ageSeconds }, 'cache entry stale, re-scraping');
        return null;
      }
      return entry;
    } catch (error) {
      // A broken cache must degrade to a live scrape, never fail the request.
      this.logger.error({ err: error, publicId }, 'cache read failed; falling through to live scrape');
      return null;
    }
  }

  private async scrapeAndStore(publicId: string, startedAt: number): Promise<GetProfileResult> {
    // Reserve a slot *before* any network work so the ceiling is real.
    this.limiter.acquire();

    let result;
    try {
      result = await this.scraper.scrape(publicId);
    } catch (error) {
      // A request LinkedIn never served shouldn't consume scrape budget.
      if (error instanceof ApiError && error.code === 'NO_IDENTITY_AVAILABLE') {
        this.limiter.refund();
      }
      throw error;
    }

    const scrapedAt = new Date().toISOString();

    if (!this.config.cacheEnabled) {
      return {
        data: result.profile,
        meta: {
          cached: false,
          source: result.source,
          scrapedAt,
          ageSeconds: 0,
          durationMs: Date.now() - startedAt,
          missingSections: result.missingSections,
        },
      };
    }

    try {
      await this.cache.set({
        schemaVersion: CACHE_SCHEMA_VERSION,
        publicId,
        scrapedAt,
        source: result.source,
        missingSections: result.missingSections,
        profile: result.profile,
      });
    } catch (error) {
      this.logger.error({ err: error, publicId }, 'cache write failed; response still served');
    }

    return {
      data: result.profile,
      meta: {
        cached: false,
        source: result.source,
        scrapedAt,
        ageSeconds: 0,
        durationMs: Date.now() - startedAt,
        missingSections: result.missingSections,
      },
    };
  }

  async invalidate(publicId: string): Promise<boolean> {
    return this.cache.delete(publicId);
  }
}
