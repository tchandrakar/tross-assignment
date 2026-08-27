import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityPool } from '../src/identity/pool.js';
import { ApiError } from '../src/errors.js';
import type { AppConfig } from '../src/config.js';

const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    identities: [],
    proxyUrls: [],
    proxyStickyTemplate: '',
    ...overrides,
  }) as AppConfig;

const identity = (label: string, liAt = `cookie-${label}-aaaaaaaaaa`) => ({
  label,
  liAt,
  jsessionId: 'ajax:1234567890123456789',
});

describe('IdentityPool', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('throws a typed error when nothing is configured', () => {
    const pool = new IdentityPool(baseConfig());
    expect(() => pool.acquire()).toThrow(ApiError);
    expect(() => pool.acquire()).toThrow(/No LinkedIn identity is configured/);
  });

  it('strips quotes from JSESSIONID to build the csrf token', () => {
    const pool = new IdentityPool(baseConfig({ identities: [{ ...identity('a'), jsessionId: '"ajax:99"' }] }));
    expect(pool.acquire().csrfToken).toBe('ajax:99');
  });

  it('rotates least-recently-used', () => {
    const pool = new IdentityPool(baseConfig({ identities: [identity('a'), identity('b')] }));
    expect(pool.acquire().label).toBe('a');
    expect(pool.acquire().label).toBe('b');
    expect(pool.acquire().label).toBe('a');
  });

  it('cools down a blocked identity and skips it', () => {
    const pool = new IdentityPool(baseConfig({ identities: [identity('a'), identity('b')] }));
    const a = pool.acquire();
    pool.reportFailure(a, true);

    expect(pool.acquire().label).toBe('b');
    expect(pool.acquire().label).toBe('b');
  });

  it('does not cool down on a non-block failure', () => {
    const pool = new IdentityPool(baseConfig({ identities: [identity('a')] }));
    pool.reportFailure(pool.acquire(), false);
    expect(() => pool.acquire()).not.toThrow();
  });

  it('backs off exponentially and eventually quarantines', () => {
    const pool = new IdentityPool(baseConfig({ identities: [identity('a')] }));
    for (let i = 0; i < 5; i += 1) {
      const id = pool.identitiesForTest?.[0];
      void id;
      try {
        pool.reportFailure(pool.acquire(), true);
      } catch {
        // acquire throws once cooling down; drive the state directly instead
        break;
      }
      vi.advanceTimersByTime(60 * 60_000);
    }
    expect(pool.health()[0]?.state).toBe('quarantined');
    expect(() => pool.acquire()).toThrow(/quarantined/);
  });

  it('recovers after the cooldown expires', () => {
    const pool = new IdentityPool(baseConfig({ identities: [identity('a')] }));
    pool.reportFailure(pool.acquire(), true);
    expect(() => pool.acquire()).toThrow(/cooling down/);

    vi.advanceTimersByTime(90_000);
    expect(() => pool.acquire()).not.toThrow();
  });

  it('clears failure state on success', () => {
    const pool = new IdentityPool(baseConfig({ identities: [identity('a'), identity('b')] }));
    const a = pool.acquire();
    pool.reportFailure(a, true);
    pool.reportSuccess(a);
    expect(pool.health()[0]).toMatchObject({ consecutiveFailures: 0, state: 'available' });
  });

  it('assigns proxies round-robin and never leaks credentials in health output', () => {
    const pool = new IdentityPool(
      baseConfig({
        identities: [identity('a'), identity('b')],
        proxyUrls: ['http://user:secret@p1.example.com:8000', 'http://user:secret@p2.example.com:8000'],
      }),
    );
    const proxies = pool.health().map((h) => h.proxy);
    expect(proxies).toEqual(['http://p1.example.com:8000', 'http://p2.example.com:8000']);
    expect(JSON.stringify(pool.health())).not.toContain('secret');
  });

  it('pins one sticky proxy session per identity, stable across construction', () => {
    const config = baseConfig({
      identities: [identity('a'), identity('b')],
      proxyStickyTemplate: 'http://user-session-{session}:pass@gw.example.com:7000',
    });
    const first = new IdentityPool(config).health().map((h) => h.proxy);
    const second = new IdentityPool(config).health().map((h) => h.proxy);
    expect(first).toEqual(second);
  });

  it('prefers an identity-specific proxy over the pool', () => {
    const pool = new IdentityPool(
      baseConfig({
        identities: [{ ...identity('a'), proxy: 'http://u:p@dedicated.example.com:9000' }],
        proxyUrls: ['http://u:p@shared.example.com:8000'],
      }),
    );
    expect(pool.health()[0]?.proxy).toBe('http://dedicated.example.com:9000');
  });

  it('releases quarantined identities on demand', () => {
    const pool = new IdentityPool(baseConfig({ identities: [identity('a')] }));
    const a = pool.acquire();
    for (let i = 0; i < 5; i += 1) pool.reportFailure(a, true);
    expect(pool.health()[0]?.state).toBe('quarantined');

    expect(pool.release()).toBe(1);
    expect(pool.health()[0]?.state).toBe('available');
  });
});
