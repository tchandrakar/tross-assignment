import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyedSlidingWindowLimiter, SlidingWindowLimiter } from '../src/ratelimit/sliding-window.js';
import { ScrapeLimiter } from '../src/ratelimit/scrape-limiter.js';
import { ApiError } from '../src/errors.js';

describe('SlidingWindowLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows exactly the configured number per window', () => {
    const limiter = new SlidingWindowLimiter(20);
    for (let i = 0; i < 20; i += 1) expect(limiter.tryAcquire().ok).toBe(true);
    expect(limiter.tryAcquire().ok).toBe(false);
  });

  it('slides rather than resetting on a fixed boundary', () => {
    const limiter = new SlidingWindowLimiter(2);
    limiter.tryAcquire();                 // t = 0
    vi.advanceTimersByTime(30_000);
    limiter.tryAcquire();                 // t = 30s
    vi.advanceTimersByTime(29_000);       // t = 59s
    expect(limiter.tryAcquire().ok).toBe(false);

    // At t=61s only the t=0 slot has aged out. A fixed window would have
    // released both and allowed a 2x burst here.
    vi.advanceTimersByTime(2_000);
    expect(limiter.tryAcquire().ok).toBe(true);
    expect(limiter.tryAcquire().ok).toBe(false);
  });

  it('reports the exact wait', () => {
    const limiter = new SlidingWindowLimiter(1);
    limiter.tryAcquire();
    vi.advanceTimersByTime(10_000);
    const result = limiter.tryAcquire();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAfterSeconds).toBe(50);
  });

  it('throws a typed error carrying retryAfterSeconds', () => {
    const limiter = new SlidingWindowLimiter(1);
    limiter.acquire('RATE_LIMITED', () => 'nope');
    try {
      limiter.acquire('RATE_LIMITED', (s) => `wait ${s}`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('RATE_LIMITED');
      expect((error as ApiError).retryAfterSeconds).toBe(60);
    }
  });

  it('refunds an unspent slot', () => {
    const limiter = new SlidingWindowLimiter(1);
    limiter.tryAcquire();
    limiter.refund();
    expect(limiter.tryAcquire().ok).toBe(true);
  });
});

describe('KeyedSlidingWindowLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('limits each caller independently', () => {
    const limiter = new KeyedSlidingWindowLimiter(10);
    for (let i = 0; i < 10; i += 1) expect(limiter.tryAcquire('ip:a').ok).toBe(true);
    expect(limiter.tryAcquire('ip:a').ok).toBe(false);
    // A second caller is unaffected by the first exhausting its budget.
    expect(limiter.tryAcquire('ip:b').ok).toBe(true);
  });

  it('tracks active callers', () => {
    const limiter = new KeyedSlidingWindowLimiter(10);
    limiter.tryAcquire('ip:a');
    limiter.tryAcquire('ip:b');
    expect(limiter.activeKeys).toBe(2);
  });

  it('evicts callers idle for more than two windows', () => {
    const limiter = new KeyedSlidingWindowLimiter(10, 60_000, 1);
    limiter.tryAcquire('ip:a');
    vi.advanceTimersByTime(3 * 60_000);
    limiter.tryAcquire('ip:b');
    limiter.tryAcquire('ip:c');
    expect(limiter.activeKeys).toBeLessThanOrEqual(2);
  });
});

describe('the three tiers are independent', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scrape ceiling is stricter than, and separate from, the request limits', () => {
    const scrapes = new ScrapeLimiter(5);
    const requests = new SlidingWindowLimiter(20);
    const perClient = new KeyedSlidingWindowLimiter(10);

    // 10 requests from one caller: all pass the caller and service limits.
    for (let i = 0; i < 10; i += 1) {
      expect(perClient.tryAcquire('ip:a').ok).toBe(true);
      expect(requests.tryAcquire().ok).toBe(true);
    }
    expect(perClient.tryAcquire('ip:a').ok).toBe(false);

    // Only 5 of those may be live scrapes; the rest must come from cache.
    for (let i = 0; i < 5; i += 1) expect(() => scrapes.acquire()).not.toThrow();
    expect(() => scrapes.acquire()).toThrow(ApiError);
    expect(() => scrapes.acquire()).toThrow(/at most 5 new profiles/);
  });

  it('service limit stops a second caller once the total is reached', () => {
    const requests = new SlidingWindowLimiter(20);
    const perClient = new KeyedSlidingWindowLimiter(10);

    for (const ip of ['ip:a', 'ip:b']) {
      for (let i = 0; i < 10; i += 1) {
        expect(perClient.tryAcquire(ip).ok).toBe(true);
        expect(requests.tryAcquire().ok).toBe(true);
      }
    }
    // A third caller is within its own budget but the service is saturated.
    expect(perClient.tryAcquire('ip:c').ok).toBe(true);
    expect(requests.tryAcquire().ok).toBe(false);
  });
});
