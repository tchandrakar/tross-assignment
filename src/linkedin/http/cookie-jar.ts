/**
 * Cookie jar for the LinkedIn HTTP client.
 *
 * This exists because of the single most consequential thing to understand
 * about LinkedIn's session handling: **`li_at` is rotated on use.** LinkedIn
 * issues a replacement via `Set-Cookie` as you browse and invalidates the
 * previous value.
 *
 * A client that ignores `Set-Cookie` therefore replays a superseded token on
 * every request — which is exactly the signature of a stolen cookie being
 * replayed elsewhere. LinkedIn responds by invalidating the session outright:
 *
 *     set-cookie: li_at=delete me; Expires=Thu, 01-Jan-1970 00:00:00 GMT
 *
 * An earlier revision of this client sent a fixed cookie header and never read
 * responses back, and its sessions died within a handful of requests. Absorbing
 * every `Set-Cookie` is what makes a long-lived session possible.
 */

export interface SerializedJar {
  cookies: Record<string, string>;
  updatedAt: string;
}

/** Cookies LinkedIn clears by assigning this sentinel rather than expiring them. */
const DELETION_SENTINELS = new Set(['delete me', '"delete me"', '']);

export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    if (initial) for (const [name, value] of Object.entries(initial)) this.cookies.set(name, value);
  }

  /**
   * Absorbs `Set-Cookie` from a response.
   *
   * @returns names whose value changed, so a caller can notice a rotated
   * session token and persist it rather than discovering it is stale later.
   */
  absorb(header: string | string[] | undefined): string[] {
    const list = Array.isArray(header) ? header : header ? [header] : [];
    const changed: string[] = [];

    for (const raw of list) {
      const [pair = ''] = String(raw).split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;

      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;

      // An explicit clear is meaningful: it is how LinkedIn signals that it has
      // rejected the session. Recording it as a value would hide that.
      if (DELETION_SENTINELS.has(value) || isExpired(String(raw))) {
        if (this.cookies.delete(name)) changed.push(name);
        continue;
      }

      if (this.cookies.get(name) !== value) {
        this.cookies.set(name, value);
        changed.push(name);
      }
    }

    return changed;
  }

  /** True when LinkedIn actively cleared the session rather than it just being absent. */
  static isSessionCleared(header: string | string[] | undefined): boolean {
    const list = Array.isArray(header) ? header : header ? [header] : [];
    return list.some((c) => /^li_at=("?delete me"?|\s*;)/i.test(String(c).trim()));
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  get size(): number {
    return this.cookies.size;
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }

  /** The `Cookie` request header, or undefined when the jar is empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /**
   * The CSRF token Voyager requires: the `JSESSIONID` value with quotes
   * stripped. Read from the jar rather than from configuration, so a token
   * LinkedIn rotated mid-session stays correct.
   */
  csrfToken(): string {
    return (this.cookies.get('JSESSIONID') ?? '').replaceAll('"', '');
  }

  /** True once the jar holds an authenticated session. */
  isAuthenticated(): boolean {
    return this.cookies.has('li_at') && this.cookies.has('JSESSIONID');
  }

  toJSON(): SerializedJar {
    return { cookies: Object.fromEntries(this.cookies), updatedAt: new Date().toISOString() };
  }

  static fromJSON(value: unknown): CookieJar | null {
    if (typeof value !== 'object' || value === null) return null;
    const cookies = (value as SerializedJar).cookies;
    if (typeof cookies !== 'object' || cookies === null) return null;

    const entries = Object.entries(cookies).filter(
      ([name, v]) => typeof name === 'string' && typeof v === 'string',
    ) as [string, string][];

    // An empty jar is not a session. Returning one would send an
    // unauthenticated request instead of triggering a sign-in.
    if (entries.length === 0) return null;
    return new CookieJar(Object.fromEntries(entries));
  }

  /** Parses a `cookie:` header copied from a browser, for bootstrap seeding. */
  static fromHeader(raw: string): CookieJar {
    const jar = new CookieJar();
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name) jar.cookies.set(name, value);
    }
    return jar;
  }
}

/** A `Set-Cookie` whose Expires is in the past is a deletion, not a value. */
function isExpired(setCookie: string): boolean {
  const expires = /expires=([^;]+)/i.exec(setCookie)?.[1];
  if (expires) {
    const at = Date.parse(expires.trim());
    if (Number.isFinite(at) && at <= Date.now()) return true;
  }
  const maxAge = /max-age=(-?\d+)/i.exec(setCookie)?.[1];
  return maxAge !== undefined && Number(maxAge) <= 0;
}
