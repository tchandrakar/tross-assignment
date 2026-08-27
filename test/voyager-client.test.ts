import { describe, expect, it, vi } from 'vitest';
import { VoyagerClient, buildHeaders, isBlockStatus, timezoneOffsetHours } from '../src/linkedin/voyager-client.js';
import { IdentityPool } from '../src/identity/pool.js';
import { ApiError } from '../src/errors.js';
import type { AppConfig } from '../src/config.js';

const config = (identities: AppConfig['identities']): AppConfig =>
  ({ identities, proxyUrls: [], proxyStickyTemplate: '' }) as AppConfig;

const identity = (label: string) => ({
  label,
  liAt: `cookie-${label}-aaaaaaaaaa`,
  jsessionId: '"ajax:1234567890123456789"',
});

describe('buildHeaders', () => {
  const pool = new IdentityPool(config([identity('a')]));
  const headers = buildHeaders(pool.acquire());

  it('sends the csrf token as the unquoted JSESSIONID', () => {
    expect(headers['csrf-token']).toBe('ajax:1234567890123456789');
  });

  it('sends both auth cookies, with JSESSIONID quoted', () => {
    expect(headers.cookie).toContain('li_at=cookie-a-aaaaaaaaaa');
    expect(headers.cookie).toContain('JSESSIONID="ajax:1234567890123456789"');
  });

  it('requests the normalized encoding and restli 2.0', () => {
    expect(headers.accept).toBe('application/vnd.linkedin.normalized+json+2.1');
    expect(headers['x-restli-protocol-version']).toBe('2.0.0');
  });

  it('sends an x-li-track payload consistent with the user agent', () => {
    const track = JSON.parse(headers['x-li-track']!);
    expect(track.osName).toBe('web');
    expect(headers['user-agent']).toContain('Chrome');
  });
});

describe('isBlockStatus', () => {
  it.each([999, 429, 403, 401])('treats %i as a block', (status) => {
    expect(isBlockStatus(status)).toBe(true);
  });

  it.each([200, 404, 500])('does not treat %i as a block', (status) => {
    expect(isBlockStatus(status)).toBe(false);
  });
});

describe('VoyagerClient.withIdentity', () => {
  it('reports NO_IDENTITY_AVAILABLE when the pool is empty', async () => {
    const client = new VoyagerClient(new IdentityPool(config([])));
    await expect(client.withIdentity(async () => 'never')).rejects.toMatchObject({
      code: 'NO_IDENTITY_AVAILABLE',
    });
  });

  it('retries a blocked call on a different identity', async () => {
    const pool = new IdentityPool(config([identity('a'), identity('b')]));
    const client = new VoyagerClient(pool);

    const seen: string[] = [];
    const result = await client.withIdentity(async (id) => {
      seen.push(id.label);
      if (seen.length === 1) throw new ApiError('UPSTREAM_BLOCKED', 'flagged');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(seen).toEqual(['a', 'b']);
  });

  it('does not retry a non-block failure', async () => {
    const pool = new IdentityPool(config([identity('a'), identity('b')]));
    const client = new VoyagerClient(pool);
    const fn = vi.fn().mockRejectedValue(new ApiError('PARSE_FAILED', 'bad json'));

    await expect(client.withIdentity(fn)).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cools down the identity that was blocked', async () => {
    const pool = new IdentityPool(config([identity('a'), identity('b')]));
    const client = new VoyagerClient(pool);

    await client
      .withIdentity(async () => { throw new ApiError('UPSTREAM_BLOCKED', 'flagged'); })
      .catch(() => undefined);

    const cooling = pool.health().filter((h) => h.state === 'cooling-down');
    expect(cooling.length).toBeGreaterThan(0);
  });
});

describe('timezoneOffsetHours', () => {
  it('resolves a half-hour offset zone', () => {
    expect(timezoneOffsetHours('Asia/Calcutta')).toBe(5.5);
  });

  it('resolves a negative offset zone', () => {
    expect(timezoneOffsetHours('America/New_York')).toBeLessThan(0);
  });

  it('returns 0 for UTC', () => {
    expect(timezoneOffsetHours('UTC')).toBe(0);
  });

  it('falls back to 0 for an unknown zone rather than throwing', () => {
    expect(timezoneOffsetHours('Not/AZone')).toBe(0);
  });
});

describe('x-li-track fidelity', () => {
  it('mirrors the account timezone cookie instead of hardcoding UTC', () => {
    const pool = new IdentityPool(
      config([{ ...identity('a'), cookies: { timezone: 'Asia/Calcutta' } }]),
    );
    const track = JSON.parse(buildHeaders(pool.acquire())['x-li-track']!);
    expect(track.timezone).toBe('Asia/Calcutta');
    expect(track.timezoneOffset).toBe(5.5);
  });

  it('defaults to UTC when the jar carries no timezone', () => {
    const track = JSON.parse(buildHeaders(new IdentityPool(config([identity('a')])).acquire())['x-li-track']!);
    expect(track.timezone).toBe('UTC');
    expect(track.timezoneOffset).toBe(0);
  });
});
