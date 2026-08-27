import { z } from 'zod';

/**
 * Environment parsing. Everything secret arrives here and nowhere else —
 * no credential is ever read directly from `process.env` outside this module.
 */

const identitySchema = z.object({
  label: z.string().min(1).default('default'),
  /**
   * Cookie seed. Optional: an identity whose session was established by
   * `npm run login` carries no seed at all — its state lives in the session
   * store, which is authoritative once present.
   */
  liAt: z.string().default(''),
  jsessionId: z.string().default(''),
  proxy: z.string().url().optional(),
  /**
   * Supporting cookies from the same browser session (bcookie, bscookie, lidc,
   * li_gc, lang, …). LinkedIn cross-checks these against li_at: a bare session
   * cookie with no browser-identity cookies alongside it reads as a replayed
   * stolen cookie, and the session gets invalidated server-side — observed in
   * testing as a 302 carrying `set-cookie: li_at=delete me`.
   */
  cookies: z.record(z.string()).optional(),
});

export type IdentityConfig = z.infer<typeof identitySchema>;

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_KEYS: z.string().default(''),

  LINKEDIN_IDENTITIES: z.string().default(''),
  LI_AT: z.string().default(''),
  LI_JSESSIONID: z.string().default(''),
  LI_COOKIES: z.string().default(''),
  /**
   * Credentials for the interactive login helper (`npm run login`) ONLY. The
   * server never reads these — it consumes the session state the helper writes.
   * Kept here so the helper validates them the same way as everything else.
   */
  LI_EMAIL: z.string().default(''),
  LI_PASSWORD: z.string().default(''),
  IDENTITY_LABEL: z.string().default('primary'),

  PROXY_URLS: z.string().default(''),
  PROXY_STICKY_TEMPLATE: z.string().default(''),

  GCS_BUCKET: z.string().default(''),
  GCS_PREFIX: z.string().default('profiles/'),
  SESSION_STATE_DIR: z.string().default('.sessions'),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(604800),

  SCRAPE_RATE_PER_MINUTE: z.coerce.number().int().positive().max(60).default(5),
  ENABLE_BROWSER_FALLBACK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Raw-HTTP Voyager calls. Off by default: an HTTP client is trivially
   * distinguishable from Chrome (TLS/JA3 signature, header ordering, no JS),
   * and in testing LinkedIn responded by invalidating the session server-side
   * within a handful of requests. The browser transport makes the identical
   * API calls without that cost. Enable only to demonstrate the raw path, or
   * where session lifetime does not matter.
   */
  ENABLE_HTTP_TRANSPORT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** Accepts a raw `document.cookie` string: "a=1; b=2; c=3". */
export function parseCookieHeader(raw: string): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}

function parseIdentities(env: z.infer<typeof envSchema>): IdentityConfig[] {
  if (env.LINKEDIN_IDENTITIES.trim()) {
    let raw: unknown;
    try {
      raw = JSON.parse(env.LINKEDIN_IDENTITIES);
    } catch {
      throw new Error('LINKEDIN_IDENTITIES is not valid JSON. Expected an array of identity objects.');
    }
    const parsed = z.array(identitySchema).min(1).safeParse(raw);
    if (!parsed.success) {
      throw new Error(`LINKEDIN_IDENTITIES is malformed: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  }

  // Single-identity shorthand. LI_COOKIES accepts a whole `cookie:` header
  // copied straight out of DevTools, so the operator can paste one string
  // rather than picking two values out of it by hand — and pasting the full
  // header is also what makes the session survive (see buildCookieHeader).
  const jar = env.LI_COOKIES.trim() ? parseCookieHeader(env.LI_COOKIES) : {};
  const liAt = env.LI_AT.trim() || jar.li_at || '';
  const jsessionId = env.LI_JSESSIONID.trim() || jar.JSESSIONID || '';

  if (liAt && jsessionId) {
    return [
      {
        label: env.IDENTITY_LABEL,
        liAt,
        jsessionId,
        ...(Object.keys(jar).length > 0 ? { cookies: jar } : {}),
      },
    ];
  }

  // Credential-based setup: no cookie seed at all. The identity exists so the
  // pool can hand it out; its session comes from the store, populated by the
  // interactive login helper.
  if (env.LI_EMAIL.trim()) {
    return [{ label: env.IDENTITY_LABEL, liAt: '', jsessionId: '', cookies: jar }];
  }

  return [];
}

function buildConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  const env = parsed.data;

  const splitList = (s: string) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

  return {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    logLevel: env.LOG_LEVEL,

    apiKeys: splitList(env.API_KEYS),

    identities: parseIdentities(env),
    loginEmail: env.LI_EMAIL.trim(),
    loginPassword: env.LI_PASSWORD,
    identityLabel: env.IDENTITY_LABEL,

    proxyUrls: splitList(env.PROXY_URLS),
    proxyStickyTemplate: env.PROXY_STICKY_TEMPLATE.trim(),

    gcsBucket: env.GCS_BUCKET.trim(),
    gcsPrefix: env.GCS_PREFIX,
    sessionStateDir: env.SESSION_STATE_DIR,
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,

    scrapeRatePerMinute: env.SCRAPE_RATE_PER_MINUTE,
    enableBrowserFallback: env.ENABLE_BROWSER_FALLBACK,
    enableHttpTransport: env.ENABLE_HTTP_TRANSPORT,
  } as const;
}

export type AppConfig = ReturnType<typeof buildConfig>;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= buildConfig();
  return cached;
}

/** Test seam — drops the memoised config so a new env can be parsed. */
export function resetConfig(): void {
  cached = undefined;
}
