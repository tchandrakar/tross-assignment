import { describe, expect, it } from 'vitest';
import { parseCookieHeader } from '../src/config.js';
import { buildCookieHeader, buildHeaders } from '../src/linkedin/voyager-client.js';
import { IdentityPool } from '../src/identity/pool.js';
import type { AppConfig } from '../src/config.js';

const config = (identities: AppConfig['identities']): AppConfig =>
  ({ identities, proxyUrls: [], proxyStickyTemplate: '' }) as AppConfig;

describe('parseCookieHeader', () => {
  it('parses a raw document.cookie string', () => {
    expect(parseCookieHeader('bcookie="v=2&abc"; lidc="b=OB1"; li_gc=MTs=')).toEqual({
      bcookie: '"v=2&abc"',
      lidc: '"b=OB1"',
      li_gc: 'MTs=',
    });
  });

  it('tolerates whitespace, trailing separators and valueless fragments', () => {
    expect(parseCookieHeader('  a=1 ;; b = 2 ;garbage; ')).toEqual({ a: '1', b: '2' });
  });

  it('keeps values that themselves contain "="', () => {
    expect(parseCookieHeader('li_gc=MTsyMTsxNzY=')).toEqual({ li_gc: 'MTsyMTsxNzY=' });
  });
});

describe('buildCookieHeader', () => {
  const identity = (cookies?: Record<string, string>) =>
    new IdentityPool(
      config([{ label: 'a', liAt: 'session-aaaaaaaaaa', jsessionId: '"ajax:99"', ...(cookies ? { cookies } : {}) }]),
    ).acquire();

  it('sends li_at and a quoted JSESSIONID when there is no jar', () => {
    expect(buildCookieHeader(identity())).toBe('li_at=session-aaaaaaaaaa; JSESSIONID="ajax:99"');
  });

  it('includes the supporting browser cookies', () => {
    const header = buildCookieHeader(identity({ bcookie: '"v=2&abc"', lidc: '"b=OB1"' }));
    expect(header).toContain('bcookie="v=2&abc"');
    expect(header).toContain('lidc="b=OB1"');
    expect(header).toContain('li_at=session-aaaaaaaaaa');
  });

  it('never lets a stale jar entry shadow the configured credentials', () => {
    const header = buildCookieHeader(identity({ li_at: 'STALE', JSESSIONID: '"ajax:STALE"' }));
    expect(header).toContain('li_at=session-aaaaaaaaaa');
    expect(header).not.toContain('STALE');
  });

  it('is what buildHeaders puts on the wire', () => {
    expect(buildHeaders(identity({ bcookie: '"v=2"' })).cookie).toContain('bcookie="v=2"');
  });
});

describe('config identity resolution', () => {
  it('extracts li_at and JSESSIONID from a pasted cookie header', async () => {
    const { resetConfig, getConfig } = await import('../src/config.js');
    const previous = { ...process.env };
    process.env.LI_AT = '';
    process.env.LI_JSESSIONID = '';
    process.env.LI_COOKIES = 'bcookie="v=2&x"; li_at=AQEDpasted12345; JSESSIONID="ajax:777"; lidc="b=OB1"';

    resetConfig();
    const identities = getConfig().identities;

    expect(identities).toHaveLength(1);
    expect(identities[0]?.liAt).toBe('AQEDpasted12345');
    expect(identities[0]?.jsessionId).toBe('"ajax:777"');
    expect(identities[0]?.cookies?.bcookie).toBe('"v=2&x"');

    process.env = previous;
    resetConfig();
  });
});
