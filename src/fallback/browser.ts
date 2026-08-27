import type { Browser, BrowserContext } from 'playwright';
import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../errors.js';
import type { Identity, IdentityPool } from '../identity/pool.js';
import { publicProfileUrl } from '../linkedin/endpoints.js';
import { normalize } from '../linkedin/normalize.js';
import { parseProfileView } from '../linkedin/parse/profile-view.js';
import { profileSchema } from '../schema/profile.js';
import type { ScrapeResult } from '../linkedin/scraper.js';
import { isObject, pick, str } from '../linkedin/parse/common.js';

/**
 * Headless-browser fallback.
 *
 * The trick here is that we don't scrape the DOM. LinkedIn server-renders its
 * Voyager responses into the page as inline `<code id="bpr-guid-…">` blobs —
 * the same normalized JSON the API returns — which the SPA hydrates from. So
 * the browser is used purely to *obtain* those payloads with a real TLS
 * fingerprint and JS execution, and then the exact same parsers run over them.
 *
 * That matters for maintenance: there is one parsing implementation, not two,
 * so a LinkedIn schema change can't leave the fallback silently wrong.
 *
 * Chromium is expensive (~300 MB RSS, ~2 s cold start), so the browser is
 * launched lazily on first use and a single instance is shared.
 */
export class BrowserFallback {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  constructor(
    private readonly pool: IdentityPool,
    private readonly logger: FastifyBaseLogger,
  ) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    this.launching ??= (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      this.browser = browser;
      this.launching = null;
      return browser;
    })();

    return this.launching;
  }

  async scrape(publicId: string): Promise<ScrapeResult> {
    const identity = this.pool.acquire();
    const browser = await this.getBrowser();

    let context: BrowserContext | null = null;
    try {
      context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        timezoneId: 'UTC',
        ...(identity.proxyUrl ? { proxy: toPlaywrightProxy(identity.proxyUrl) } : {}),
      });

      await context.addCookies(buildCookies(identity));

      const page = await context.newPage();
      // Images and fonts are ~80% of the bytes and none of the data.
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        return type === 'image' || type === 'font' || type === 'media'
          ? route.abort()
          : route.continue();
      });

      const payloads: unknown[] = [];

      // Capture Voyager XHRs the page makes on its own — these carry the
      // sections that aren't server-rendered.
      page.on('response', (response) => {
        const url = response.url();
        if (!url.includes('/voyager/api/')) return;
        response
          .json()
          .then((body) => payloads.push(body))
          .catch(() => undefined);
      });

      const response = await page.goto(publicProfileUrl(publicId), {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });

      const status = response?.status() ?? 0;
      if (status === 404) throw new ApiError('PROFILE_NOT_FOUND', 'LinkedIn has no profile at that identifier.');
      if (status === 999 || status === 429) {
        this.pool.reportFailure(identity, true);
        throw new ApiError('UPSTREAM_BLOCKED', `LinkedIn returned ${status} to the headless browser.`);
      }

      if (page.url().includes('/authwall') || page.url().includes('/login')) {
        this.pool.reportFailure(identity, true);
        throw new ApiError('AUTH_FAILED', 'LinkedIn redirected to the auth wall — the session cookie is not valid.');
      }

      // Give the SPA a moment to fire its section XHRs.
      await page.waitForTimeout(2_500);

      // Pull the server-rendered payloads out of the document.
      const inline = await page.evaluate(() =>
        Array.from(document.querySelectorAll('code[id^="bpr-guid-"]'))
          .map((node) => node.textContent ?? '')
          .filter((text) => text.includes('"data"') || text.includes('"included"')),
      );

      for (const text of inline) {
        try {
          payloads.push(JSON.parse(text));
        } catch {
          // Some blobs are HTML-escaped fragments, not JSON. Skip them.
        }
      }

      const result = this.parsePayloads(publicId, payloads);
      this.pool.reportSuccess(identity);
      return result;
    } catch (error) {
      if (!(error instanceof ApiError)) this.pool.reportFailure(identity, false);
      throw error;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  /**
   * Finds the payload that actually contains a profile and runs the shared
   * parser over it. Payloads arrive in arbitrary order and most are unrelated
   * (nav, ads, messaging), so we score rather than assume.
   */
  private parsePayloads(publicId: string, payloads: unknown[]): ScrapeResult {
    let best: { score: number; result: ScrapeResult } | null = null;

    for (const payload of payloads) {
      let data: unknown;
      try {
        data = normalize(payload).data;
      } catch {
        continue;
      }
      if (!isObject(data)) continue;

      const candidate = looksLikeProfileView(data) ? data : findProfileView(payload);
      if (!candidate) continue;

      try {
        const { profile, missingSections } = parseProfileView(candidate);
        const parsed = profileSchema.parse({
          ...profile,
          publicId,
          profileUrl: publicProfileUrl(publicId),
        });

        const score =
          (parsed.fullName ? 4 : 0) +
          parsed.experience.length +
          parsed.education.length +
          parsed.skills.length;

        if (!best || score > best.score) {
          best = { score, result: { profile: parsed, source: 'browser', missingSections } };
        }
      } catch {
        continue;
      }
    }

    if (!best || best.score === 0) {
      throw new ApiError('PARSE_FAILED', 'The rendered page contained no recognisable profile payload.', {
        details: { publicId, payloadsInspected: payloads.length },
      });
    }

    this.logger.debug({ publicId, score: best.score }, 'browser fallback selected best payload');
    return best.result;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}

function looksLikeProfileView(data: unknown): boolean {
  return isObject(data) && ('positionView' in data || 'educationView' in data || 'profile' in data);
}

/** Some blobs nest the profileView one level down under `data`. */
function findProfileView(payload: unknown): unknown | null {
  const direct = pick(payload, 'data', 'data.data');
  if (looksLikeProfileView(direct)) return direct;
  if (looksLikeProfileView(payload)) return payload;
  return null;
}

function buildCookies(identity: Identity) {
  return [
    { name: 'li_at', value: identity.liAt, domain: '.linkedin.com', path: '/', httpOnly: true, secure: true },
    { name: 'JSESSIONID', value: `"${identity.csrfToken}"`, domain: '.linkedin.com', path: '/', secure: true },
  ];
}

/** Playwright wants proxy credentials split out of the URL. */
function toPlaywrightProxy(proxyUrl: string) {
  const url = new URL(proxyUrl);
  const server = `${url.protocol}//${url.host}`;
  return {
    server,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export { str };
