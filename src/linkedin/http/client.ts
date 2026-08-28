import { Client, ProxyAgent, type Dispatcher } from 'undici';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { CookieJar } from './cookie-jar.js';

/**
 * HTTP client shaped to look like Chrome.
 *
 * LinkedIn fingerprints considerably more than the User-Agent string. Three
 * layers matter, and a default Node client gets all three wrong:
 *
 * 1. **TLS (JA3).** The cipher suite list, their order, and the supported
 *    elliptic curves form a fingerprint. Node's defaults differ from Chrome's,
 *    so the handshake alone identifies the client as not-a-browser.
 * 2. **Protocol.** Chrome negotiates HTTP/2. An HTTP/1.1-only client talking to
 *    a host that offers h2 is itself a signal.
 * 3. **Header order.** Browsers emit headers in a stable, characteristic order.
 *    `undici` preserves insertion order, so the order declared here is the order
 *    on the wire.
 *
 * None of this defeats a determined detector, but together they remove the
 * cheap, obvious tells — and combined with honouring cookie rotation
 * (see cookie-jar.ts) it is what makes a browser-free client viable.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Chrome's TLS 1.3 + 1.2 cipher preference, in Chrome's order. */
const CHROME_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

/** Chrome's curve preference, X25519 first. */
const CHROME_CURVES = 'X25519:P-256:P-384';

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

export type RequestKind = 'navigate' | 'form' | 'api';

export interface LinkedinResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Cookie names whose value LinkedIn changed on this response. */
  rotated: string[];
  /** True when LinkedIn actively cleared the session. */
  sessionCleared: boolean;
}

export interface LinkedinRequest {
  path: string;
  method?: 'GET' | 'POST';
  kind?: RequestKind;
  headers?: Record<string, string>;
  body?: string;
  referer?: string;
  timeoutMs?: number;
}

export class LinkedinHttpClient {
  private client: Client | null = null;

  constructor(
    readonly jar: CookieJar,
    private readonly proxyUrl?: string,
  ) {}

  private dispatcher(): Client {
    if (this.client) return this.client;

    const options = {
      // Chrome speaks h2 to LinkedIn; an h1-only client stands out.
      allowH2: true,
      connect: {
        ciphers: CHROME_CIPHERS,
        ecdhCurve: CHROME_CURVES,
        minVersion: 'TLSv1.2' as const,
        // Chrome advertises both; the ALPN list is part of the fingerprint.
        ALPNProtocols: ['h2', 'http/1.1'],
      },
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
    };

    this.client = this.proxyUrl
      ? (new ProxyAgent({ uri: this.proxyUrl, ...options }) as unknown as Client)
      : new Client(LINKEDIN_ORIGIN, options);

    return this.client;
  }

  /**
   * Header sets per request kind, in Chrome's emission order.
   *
   * `sec-fetch-*` in particular must be consistent with what the request
   * actually is — a document navigation and an XHR carry different values, and
   * a mismatch is trivially detectable.
   */
  private buildHeaders(kind: RequestKind, extra: Record<string, string>, referer?: string): Record<string, string> {
    const cookie = this.jar.header();

    const common: Record<string, string> = {
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'user-agent': UA,
    };

    if (kind === 'api') {
      return {
        accept: 'application/vnd.linkedin.normalized+json+2.1',
        'accept-language': 'en-US,en;q=0.9',
        'csrf-token': this.jar.csrfToken(),
        ...common,
        // Selects Rest.li's compact encoding. Omit it and array/URN parameters
        // are interpreted differently, yielding empty results rather than errors.
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang': 'en_US',
        origin: LINKEDIN_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        referer: referer ?? `${LINKEDIN_ORIGIN}/feed/`,
        'accept-encoding': 'gzip, deflate, br',
        ...(cookie ? { cookie } : {}),
        ...extra,
      };
    }

    const navigation: Record<string, string> = {
      ...common,
      'upgrade-insecure-requests': '1',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'sec-fetch-site': kind === 'form' ? 'same-origin' : 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      'sec-fetch-dest': 'document',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
      ...(referer ? { referer } : {}),
      ...(kind === 'form' ? { origin: LINKEDIN_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(cookie ? { cookie } : {}),
      ...extra,
    };

    return navigation;
  }

  async request({
    path,
    method = 'GET',
    kind = 'api',
    headers = {},
    body,
    referer,
    timeoutMs = 30_000,
  }: LinkedinRequest): Promise<LinkedinResponse> {
    const response = await this.dispatcher().request({
      path,
      method,
      headers: this.buildHeaders(kind, headers, referer),
      ...(body ? { body } : {}),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      // Redirects are surfaced, not followed: a 302 to the auth wall is
      // information we act on, and following it would hide the reason.
      maxRedirections: 0,
      ...(this.proxyUrl ? { origin: LINKEDIN_ORIGIN } : {}),
    } as never);

    // undici does not decompress for us. Dropping `accept-encoding` would avoid
    // the problem but would also make the client look less like a browser, so
    // advertise the encodings Chrome does and decode them here. Getting this
    // wrong is quiet rather than loud: the body arrives as bytes, every parser
    // silently matches nothing, and it reads like LinkedIn changed its markup.
    const raw = Buffer.from(await response.body.arrayBuffer());
    const text = decode(raw, String(response.headers['content-encoding'] ?? ''));
    const setCookie = response.headers['set-cookie'] as string | string[] | undefined;

    return {
      status: response.statusCode,
      headers: response.headers as Record<string, string | string[] | undefined>,
      body: text,
      rotated: this.jar.absorb(setCookie),
      sessionCleared: CookieJar.isSessionCleared(setCookie),
    };
  }

  async close(): Promise<void> {
    await (this.client as unknown as Dispatcher | null)?.close().catch(() => undefined);
    this.client = null;
  }
}

function decode(body: Buffer, encoding: string): string {
  if (body.length === 0) return '';

  try {
    switch (encoding.trim().toLowerCase()) {
      case 'gzip':
        return gunzipSync(body).toString('utf8');
      case 'br':
        return brotliDecompressSync(body).toString('utf8');
      case 'deflate':
        return inflateSync(body).toString('utf8');
      default:
        return body.toString('utf8');
    }
  } catch {
    // A malformed or unexpectedly-encoded body should degrade to whatever it
    // decodes as, not take down the request.
    return body.toString('utf8');
  }
}

export { UA as CHROME_USER_AGENT };
