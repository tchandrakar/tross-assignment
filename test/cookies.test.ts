import { describe, expect, it } from 'vitest';
import { parseCookieHeader } from '../src/config.js';

describe('parseCookieHeader', () => {
  it('parses a cookie header copied from a browser', () => {
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

describe('config identity resolution', () => {
  it('extracts li_at and JSESSIONID from a pasted cookie header', async () => {
    const { resetConfig, getConfig } = await import('../src/config.js');
    const previous = { ...process.env };

    process.env.LI_AT = '';
    process.env.LI_JSESSIONID = '';
    process.env.SESSION_IDENTITIES = '';
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

  it('creates credential-free identities from SESSION_IDENTITIES', async () => {
    const { resetConfig, getConfig } = await import('../src/config.js');
    const previous = { ...process.env };

    process.env.LI_AT = '';
    process.env.LI_JSESSIONID = '';
    process.env.LI_COOKIES = '';
    process.env.LINKEDIN_IDENTITIES = '';
    process.env.SESSION_IDENTITIES = 'primary,secondary';

    resetConfig();
    const identities = getConfig().identities;

    // The deployed form: the service holds only labels. No cookie and no
    // password appear in its configuration at all.
    expect(identities.map((i) => i.label)).toEqual(['primary', 'secondary']);
    expect(identities.every((i) => i.liAt === '')).toBe(true);

    process.env = previous;
    resetConfig();
  });
});
