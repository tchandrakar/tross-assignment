import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrapeLimiter } from '../src/ratelimit/scrape-limiter.js';
import { ApiError } from '../src/errors.js';

describe('ScrapeLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows exactly the configured number of scrapes per minute', () => {
    const limiter = new ScrapeLimiter(5);
    for (let i = 0; i < 5; i += 1) expect(() => limiter.acquire()).not.toThrow();
    expect(() => limiter.acquire()).toThrow(ApiError);
  });

  it('reports the exact wait time', () => {
    const limiter = new ScrapeLimiter(2);
    limiter.acquire();
    vi.advanceTimersByTime(10_000);
    limiter.acquire();

    try {
      limiter.acquire();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('SCRAPE_THROTTLED');
      expect((error as ApiError).retryAfterSeconds).toBe(50);
    }
  });

  it('slides rather than resetting on a fixed boundary', () => {
    const limiter = new ScrapeLimiter(2);
    limiter.acquire();                      // t = 0
    vi.advanceTimersByTime(30_000);
    limiter.acquire();                      // t = 30s
    vi.advanceTimersByTime(29_000);         // t = 59s
    expect(() => limiter.acquire()).toThrow();

    // At t=61s only the t=0 slot has aged out — a fixed window would have
    // released both and allowed a 2x burst here.
    vi.advanceTimersByTime(2_000);
    expect(() => limiter.acquire()).not.toThrow();
    expect(() => limiter.acquire()).toThrow();
  });

  it('refunds a slot that was never spent', () => {
    const limiter = new ScrapeLimiter(1);
    limiter.acquire();
    limiter.refund();
    expect(() => limiter.acquire()).not.toThrow();
  });

  it('reports status', () => {
    const limiter = new ScrapeLimiter(5);
    limiter.acquire();
    expect(limiter.status()).toMatchObject({ limitPerMinute: 5, usedInWindow: 1, remaining: 4 });
  });
});
