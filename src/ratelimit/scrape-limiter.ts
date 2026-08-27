import { SlidingWindowLimiter } from './sliding-window.js';

/**
 * Hard ceiling on *live* LinkedIn fetches, process-wide.
 *
 * This is not a per-caller quota — it protects the LinkedIn account whose
 * session the service uses. Cache hits deliberately do not consume budget,
 * because they never touch LinkedIn, and charging them would throttle traffic
 * that carries none of the risk.
 *
 * A single-process limiter is only correct while the service runs one instance;
 * the deployment pins that for exactly this reason (see README §Rate limiting).
 */
export class ScrapeLimiter {
  private readonly window: SlidingWindowLimiter;

  constructor(limit: number) {
    this.window = new SlidingWindowLimiter(limit);
    this.limit = limit;
  }

  readonly limit: number;

  acquire(): void {
    this.window.acquire(
      'SCRAPE_THROTTLED',
      () =>
        `Live scrape budget exhausted: at most ${this.limit} new profiles are fetched from LinkedIn per minute. ` +
        'Already-scraped profiles are still served instantly from cache.',
    );
  }

  /** Returns the slot if the scrape never actually reached LinkedIn. */
  refund(): void {
    this.window.refund();
  }

  status() {
    return this.window.status();
  }
}
