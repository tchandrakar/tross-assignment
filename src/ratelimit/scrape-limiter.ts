import { ApiError } from '../errors.js';

/**
 * Hard ceiling on *live* LinkedIn fetches, process-wide.
 *
 * This is not a per-caller quota — it is a protection on the LinkedIn account
 * whose cookie we are using. Cache hits deliberately do not consume budget,
 * because they never touch LinkedIn.
 *
 * Implemented as a sliding window rather than a token bucket: a bucket refills
 * continuously and would permit a 2× burst across a window boundary, which is
 * precisely the pattern that gets an account flagged. A sliding window makes
 * "no more than N in any 60 seconds" literally true.
 *
 * A single-instance limiter is only correct while the service runs one
 * container; the Cloud Run deployment pins max-instances to 1 for that reason
 * (see README §Rate limiting).
 */
export class ScrapeLimiter {
  private readonly timestamps: number[] = [];
  private readonly windowMs = 60_000;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error('ScrapeLimiter limit must be at least 1');
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }

  /** Consumes one slot, or throws with the exact wait in seconds. */
  acquire(): void {
    const now = Date.now();
    this.prune(now);

    if (this.timestamps.length >= this.limit) {
      const oldest = this.timestamps[0]!;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      throw new ApiError(
        'SCRAPE_THROTTLED',
        `Live scrape budget exhausted: at most ${this.limit} profiles are fetched from LinkedIn per minute. ` +
          'Already-scraped profiles are still served instantly from cache.',
        { retryAfterSeconds, details: { limitPerMinute: this.limit } },
      );
    }

    this.timestamps.push(now);
  }

  /** Returns the slot if the scrape never actually reached LinkedIn. */
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
