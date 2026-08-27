import { describe, expect, it, vi } from 'vitest';
import { ProfileService } from '../src/service/profile-service.js';
import { MemoryProfileCache } from '../src/cache/memory.js';
import { ScrapeLimiter } from '../src/ratelimit/scrape-limiter.js';
import { ApiError } from '../src/errors.js';
import { profileSchema } from '../src/schema/profile.js';
import type { AppConfig } from '../src/config.js';
import type { ProfileScraper } from '../src/linkedin/scraper.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const config = { cacheTtlSeconds: 3600, cacheEnabled: true } as AppConfig;

const makeProfile = (publicId: string) =>
  profileSchema.parse({
    publicId,
    profileUrl: `https://www.linkedin.com/in/${publicId}/`,
    fullName: 'Ada Lovelace',
  });

function fakeScraper(impl: (publicId: string) => Promise<unknown>): ProfileScraper {
  return { scrape: vi.fn(impl) } as unknown as ProfileScraper;
}

const ok = (publicId: string) => ({
  profile: makeProfile(publicId),
  source: 'voyager-profile-view' as const,
  missingSections: [],
});

describe('ProfileService', () => {
  it('scrapes on a cache miss and serves the second request from cache', async () => {
    const scraper = fakeScraper(async (id) => ok(id));
    const cache = new MemoryProfileCache();
    const service = new ProfileService(scraper, cache, new ScrapeLimiter(5), config, logger);

    const first = await service.getProfile({ publicId: 'ada', profileUrl: 'x' });
    expect(first.meta.cached).toBe(false);
    expect(first.meta.source).toBe('voyager-profile-view');

    const second = await service.getProfile({ publicId: 'ada', profileUrl: 'x' });
    expect(second.meta.cached).toBe(true);
    expect(second.data.fullName).toBe('Ada Lovelace');
    expect(scraper.scrape).toHaveBeenCalledTimes(1);
  });

  it('does not spend scrape budget on cache hits', async () => {
    const scraper = fakeScraper(async (id) => ok(id));
    const limiter = new ScrapeLimiter(1);
    const service = new ProfileService(scraper, new MemoryProfileCache(), limiter, config, logger);

    await service.getProfile({ publicId: 'ada', profileUrl: 'x' });
    expect(limiter.status().remaining).toBe(0);

    // Budget is exhausted, yet a cached profile still resolves.
    await expect(service.getProfile({ publicId: 'ada', profileUrl: 'x' })).resolves.toMatchObject({
      meta: { cached: true },
    });
  });

  it('enforces the scrape ceiling on distinct profiles', async () => {
    const scraper = fakeScraper(async (id) => ok(id));
    const service = new ProfileService(scraper, new MemoryProfileCache(), new ScrapeLimiter(2), config, logger);

    await service.getProfile({ publicId: 'a', profileUrl: 'x' });
    await service.getProfile({ publicId: 'b', profileUrl: 'x' });

    await expect(service.getProfile({ publicId: 'c', profileUrl: 'x' })).rejects.toThrow(ApiError);
    await expect(service.getProfile({ publicId: 'c', profileUrl: 'x' })).rejects.toMatchObject({
      code: 'SCRAPE_THROTTLED',
    });
  });

  it('collapses concurrent requests for the same profile into one scrape', async () => {
    let resolve: (v: unknown) => void = () => {};
    const gate = new Promise((r) => { resolve = r; });

    const scraper = fakeScraper(async (id) => { await gate; return ok(id); });
    const service = new ProfileService(scraper, new MemoryProfileCache(), new ScrapeLimiter(5), config, logger);

    const inflight = Promise.all([
      service.getProfile({ publicId: 'ada', profileUrl: 'x' }),
      service.getProfile({ publicId: 'ada', profileUrl: 'x' }),
      service.getProfile({ publicId: 'ada', profileUrl: 'x' }),
    ]);

    resolve(null);
    const results = await inflight;

    expect(scraper.scrape).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.data.fullName === 'Ada Lovelace')).toBe(true);
  });

  it('re-scrapes when the cached copy is older than the TTL', async () => {
    const scraper = fakeScraper(async (id) => ok(id));
    const cache = new MemoryProfileCache();
    const service = new ProfileService(scraper, cache, new ScrapeLimiter(5), { ...config, cacheTtlSeconds: 60 } as AppConfig, logger);

    await service.getProfile({ publicId: 'ada', profileUrl: 'x' });
    // Age the stored blob past the TTL.
    const stored = await cache.get('ada');
    await cache.set({ ...stored!, scrapedAt: new Date(Date.now() - 120_000).toISOString() });

    const refreshed = await service.getProfile({ publicId: 'ada', profileUrl: 'x' });
    expect(refreshed.meta.cached).toBe(false);
    expect(scraper.scrape).toHaveBeenCalledTimes(2);
  });

  it('honours refresh=true by bypassing a fresh cache entry', async () => {
    const scraper = fakeScraper(async (id) => ok(id));
    const service = new ProfileService(scraper, new MemoryProfileCache(), new ScrapeLimiter(5), config, logger);

    await service.getProfile({ publicId: 'ada', profileUrl: 'x' });
    const forced = await service.getProfile({ publicId: 'ada', profileUrl: 'x', refresh: true });

    expect(forced.meta.cached).toBe(false);
    expect(scraper.scrape).toHaveBeenCalledTimes(2);
  });

  it('falls through to a live scrape when the cache read throws', async () => {
    const scraper = fakeScraper(async (id) => ok(id));
    const brokenCache = {
      kind: 'gcs' as const,
      get: vi.fn().mockRejectedValue(new Error('bucket unreachable')),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      healthy: vi.fn(),
    };
    const service = new ProfileService(scraper, brokenCache, new ScrapeLimiter(5), config, logger);

    await expect(service.getProfile({ publicId: 'ada', profileUrl: 'x' })).resolves.toMatchObject({
      meta: { cached: false },
    });
  });

  it('still serves the response when the cache write fails', async () => {
    const scraper = fakeScraper(async (id) => ok(id));
    const brokenCache = {
      kind: 'gcs' as const,
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('write denied')),
      delete: vi.fn(),
      healthy: vi.fn(),
    };
    const service = new ProfileService(scraper, brokenCache, new ScrapeLimiter(5), config, logger);

    await expect(service.getProfile({ publicId: 'ada', profileUrl: 'x' })).resolves.toMatchObject({
      data: { fullName: 'Ada Lovelace' },
    });
  });

  it('refunds scrape budget when no identity was available to spend it', async () => {
    const scraper = fakeScraper(async () => {
      throw new ApiError('NO_IDENTITY_AVAILABLE', 'all cooling down');
    });
    const limiter = new ScrapeLimiter(1);
    const service = new ProfileService(scraper, new MemoryProfileCache(), limiter, config, logger);

    await expect(service.getProfile({ publicId: 'ada', profileUrl: 'x' })).rejects.toThrow(ApiError);
    expect(limiter.status().remaining).toBe(1);
  });

  it('bypasses the cache entirely when caching is disabled', async () => {
    const scraper = fakeScraper(async (id) => ok(id));
    const cache = new MemoryProfileCache();
    const service = new ProfileService(
      scraper,
      cache,
      new ScrapeLimiter(5),
      { ...config, cacheEnabled: false } as AppConfig,
      logger,
    );

    await service.getProfile({ publicId: 'ada', profileUrl: 'x' });
    const second = await service.getProfile({ publicId: 'ada', profileUrl: 'x' });

    expect(second.meta.cached).toBe(false);
    expect(scraper.scrape).toHaveBeenCalledTimes(2);
    // Nothing was written, so a later cache-enabled read cannot find a stale copy.
    expect(await cache.get('ada')).toBeNull();
  });
});
