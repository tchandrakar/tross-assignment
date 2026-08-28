import { describe, expect, it } from 'vitest';
import { CookieJar } from '../src/linkedin/http/cookie-jar.js';

describe('CookieJar.absorb', () => {
  it('stores cookies from Set-Cookie and reports them as changed', () => {
    const jar = new CookieJar();
    const changed = jar.absorb([
      'li_at=AQEDxyz; Path=/; Domain=.www.linkedin.com; HttpOnly; Secure',
      'JSESSIONID="ajax:123"; Path=/; Secure',
    ]);
    expect(changed.sort()).toEqual(['JSESSIONID', 'li_at']);
    expect(jar.get('li_at')).toBe('AQEDxyz');
    expect(jar.get('JSESSIONID')).toBe('"ajax:123"');
  });

  it('reports a rotated session token as changed — the signal the whole design turns on', () => {
    // LinkedIn rotates li_at on use. Missing this is what makes a client replay
    // a superseded token, which reads as a stolen cookie.
    const jar = new CookieJar({ li_at: 'OLD' });
    expect(jar.absorb(['li_at=NEW; Path=/'])).toEqual(['li_at']);
    expect(jar.get('li_at')).toBe('NEW');
  });

  it('does not report an unchanged cookie as rotated', () => {
    const jar = new CookieJar({ li_at: 'SAME' });
    expect(jar.absorb(['li_at=SAME; Path=/'])).toEqual([]);
  });

  it('treats the "delete me" sentinel as removal, not a value', () => {
    const jar = new CookieJar({ li_at: 'AQED', bcookie: 'v=2' });
    jar.absorb(['li_at=delete me; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0']);
    expect(jar.has('li_at')).toBe(false);
    expect(jar.has('bcookie')).toBe(true);
  });

  it('treats a past Expires as removal', () => {
    const jar = new CookieJar({ lidc: 'b=OB1' });
    jar.absorb(['lidc=whatever; Expires=Thu, 01-Jan-1970 00:00:00 GMT']);
    expect(jar.has('lidc')).toBe(false);
  });

  it('treats Max-Age=0 as removal', () => {
    const jar = new CookieJar({ liap: 'true' });
    jar.absorb(['liap=true; Max-Age=0']);
    expect(jar.has('liap')).toBe(false);
  });

  it('tolerates a single Set-Cookie string as well as an array', () => {
    const jar = new CookieJar();
    jar.absorb('li_at=solo; Path=/');
    expect(jar.get('li_at')).toBe('solo');
  });

  it('ignores an absent header', () => {
    const jar = new CookieJar({ a: '1' });
    expect(jar.absorb(undefined)).toEqual([]);
    expect(jar.size).toBe(1);
  });

  it('keeps values that themselves contain "="', () => {
    const jar = new CookieJar();
    jar.absorb(['li_gc=MTsyMTsxNzY=; Path=/']);
    expect(jar.get('li_gc')).toBe('MTsyMTsxNzY=');
  });
});

describe('CookieJar.isSessionCleared', () => {
  it('detects LinkedIn actively invalidating the session', () => {
    expect(CookieJar.isSessionCleared([
      'li_at=delete me; Expires=Thu, 01-Jan-1970 00:00:00 GMT; Max-Age=0',
      'liap=delete me; Max-Age=0',
    ])).toBe(true);
  });

  it('does not fire on an ordinary rotation', () => {
    expect(CookieJar.isSessionCleared(['li_at=AQEDnew; Path=/'])).toBe(false);
  });

  it('does not fire on an absent header', () => {
    expect(CookieJar.isSessionCleared(undefined)).toBe(false);
  });
});

describe('CookieJar request shaping', () => {
  it('builds the Cookie header', () => {
    const jar = new CookieJar({ li_at: 'AQED', JSESSIONID: '"ajax:99"' });
    expect(jar.header()).toBe('li_at=AQED; JSESSIONID="ajax:99"');
  });

  it('returns undefined for an empty jar rather than an empty header', () => {
    expect(new CookieJar().header()).toBeUndefined();
  });

  it('derives the CSRF token from JSESSIONID with quotes stripped', () => {
    // Not derived from the value — it IS the value. Sent quoted, it 403s.
    expect(new CookieJar({ JSESSIONID: '"ajax:1234567890"' }).csrfToken()).toBe('ajax:1234567890');
  });

  it('reads the CSRF token from the live jar, so a rotated token stays correct', () => {
    const jar = new CookieJar({ JSESSIONID: '"ajax:old"' });
    jar.absorb(['JSESSIONID="ajax:new"; Path=/']);
    expect(jar.csrfToken()).toBe('ajax:new');
  });

  it('reports authentication only when both session cookies are present', () => {
    expect(new CookieJar({ li_at: 'x' }).isAuthenticated()).toBe(false);
    expect(new CookieJar({ JSESSIONID: 'y' }).isAuthenticated()).toBe(false);
    expect(new CookieJar({ li_at: 'x', JSESSIONID: 'y' }).isAuthenticated()).toBe(true);
  });
});

describe('CookieJar persistence', () => {
  it('round-trips through JSON', () => {
    const jar = new CookieJar({ li_at: 'AQED', JSESSIONID: '"ajax:1"' });
    const restored = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())));
    expect(restored?.get('li_at')).toBe('AQED');
    expect(restored?.isAuthenticated()).toBe(true);
  });

  it('rejects an empty jar, so a caller re-establishes instead of sending nothing', () => {
    expect(CookieJar.fromJSON({ cookies: {}, updatedAt: '' })).toBeNull();
  });

  it('rejects malformed input rather than throwing', () => {
    expect(CookieJar.fromJSON(null)).toBeNull();
    expect(CookieJar.fromJSON('nope')).toBeNull();
    expect(CookieJar.fromJSON({ nothing: true })).toBeNull();
  });

  it('parses a cookie header copied from a browser', () => {
    const jar = CookieJar.fromHeader('bcookie="v=2&abc"; li_at=AQED; JSESSIONID="ajax:7"; lidc="b=OB1"');
    expect(jar.names().sort()).toEqual(['JSESSIONID', 'bcookie', 'li_at', 'lidc']);
    expect(jar.isAuthenticated()).toBe(true);
  });
});
