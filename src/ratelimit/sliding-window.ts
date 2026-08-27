import { ApiError, type ErrorCode } from '../errors.js';

/**
 * Fixed-capacity sliding window.
 *
 * A sliding window rather than a token bucket, deliberately. A bucket refills
 * continuously and therefore permits close to a 2x burst across a window
 * boundary — N requests at the end of one window and N more at the start of the
 * next. A sliding window makes "no more than N in *any* 60 seconds" literally
 * true, which is what every limit in this service actually needs to guarantee.
 */
export class SlidingWindowLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {
    if (limit < 1) throw new Error('SlidingWindowLimiter limit must be at least 1');
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }

  /** Consumes a slot if one is free. Returns the wait in seconds otherwise. */
  tryAcquire(): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = Date.now();
    this.prune(now);

    if (this.timestamps.length >= this.limit) {
      const oldest = this.timestamps[0]!;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }

    this.timestamps.push(now);
    return { ok: true };
  }

  /** Consumes a slot, or throws a typed error carrying the exact wait. */
  acquire(code: ErrorCode, message: (retryAfterSeconds: number) => string): void {
    const result = this.tryAcquire();
    if (result.ok) return;
    throw new ApiError(code, message(result.retryAfterSeconds), {
      retryAfterSeconds: result.retryAfterSeconds,
      details: { limitPerMinute: this.limit },
    });
  }

  /** Returns a slot that was reserved but never actually spent. */
  refund(): void {
    this.timestamps.pop();
  }

  status(): { limitPerMinute: number; usedInWindow: number; remaining: number; resetInSeconds: number } {
    const now = Date.now();
    this.prune(now);
    const oldest = this.timestamps[0];
    return {
      limitPerMinute: this.limit,
      usedInWindow: this.timestamps.length,
      remaining: Math.max(0, this.limit - this.timestamps.length),
      resetInSeconds: oldest ? Math.max(0, Math.ceil((oldest + this.windowMs - now) / 1000)) : 0,
    };
  }
}

/**
 * Per-key sliding windows, with lazy eviction so idle keys do not accumulate.
 * Used for the per-client limit, where the key is an API key or client address.
 */
export class KeyedSlidingWindowLimiter {
  private readonly windows = new Map<string, SlidingWindowLimiter>();
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  private evictStale(now: number): void {
    if (this.windows.size <= this.maxKeys) return;
    for (const [key, seen] of this.lastSeen) {
      if (now - seen > this.windowMs * 2) {
        this.windows.delete(key);
        this.lastSeen.delete(key);
      }
    }
  }

  tryAcquire(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = Date.now();
    this.evictStale(now);
    this.lastSeen.set(key, now);

    let window = this.windows.get(key);
    if (!window) {
      window = new SlidingWindowLimiter(this.limit, this.windowMs);
      this.windows.set(key, window);
    }
    return window.tryAcquire();
  }

  status(key: string) {
    return (this.windows.get(key) ?? new SlidingWindowLimiter(this.limit, this.windowMs)).status();
  }

  get activeKeys(): number {
    return this.windows.size;
  }

  get limitPerMinute(): number {
    return this.limit;
  }
}
