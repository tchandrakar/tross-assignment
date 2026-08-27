import { z } from 'zod';

/**
 * Environment parsing. Everything secret arrives here and nowhere else —
 * no credential is ever read directly from `process.env` outside this module.
 */

const identitySchema = z.object({
  label: z.string().min(1).default('default'),
  liAt: z.string().min(10),
  jsessionId: z.string().min(3),
  proxy: z.string().url().optional(),
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

  PROXY_URLS: z.string().default(''),
  PROXY_STICKY_TEMPLATE: z.string().default(''),

  GCS_BUCKET: z.string().default(''),
  GCS_PREFIX: z.string().default('profiles/'),
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(604800),

  SCRAPE_RATE_PER_MINUTE: z.coerce.number().int().positive().max(60).default(5),
  ENABLE_BROWSER_FALLBACK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

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

  if (env.LI_AT && env.LI_JSESSIONID) {
    return [{ label: 'default', liAt: env.LI_AT, jsessionId: env.LI_JSESSIONID }];
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

    proxyUrls: splitList(env.PROXY_URLS),
    proxyStickyTemplate: env.PROXY_STICKY_TEMPLATE.trim(),

    gcsBucket: env.GCS_BUCKET.trim(),
    gcsPrefix: env.GCS_PREFIX,
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,

    scrapeRatePerMinute: env.SCRAPE_RATE_PER_MINUTE,
    enableBrowserFallback: env.ENABLE_BROWSER_FALLBACK,
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
