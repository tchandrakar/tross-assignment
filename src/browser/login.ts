import { chromium, type Page } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { getConfig } from '../config.js';
import { FileSessionStore } from './session-store.js';

/**
 * Interactive login helper. Run by a human, never by the server.
 *
 *   npm run login
 *
 * Reads LI_EMAIL / LI_PASSWORD from the local .env, drives a **visible**
 * browser, and writes the resulting session to the session store. The API then
 * consumes that state and follows LinkedIn's token rotation from there — see
 * browser/session-store.ts for why that matters.
 *
 * Deliberately headed and deliberately manual:
 *   - LinkedIn challenges automated logins with CAPTCHA, email OTP and device
 *     verification. A human needs to be present to clear them, and a headless
 *     login is far more likely to be challenged in the first place.
 *   - Credentials are read from the environment and typed into the real login
 *     form. They are never logged, never written to disk, and never leave the
 *     machine this runs on.
 *
 * Run it once per identity. Re-run only if the session is lost.
 */

/** Types like a person: variable per-keystroke delay, not a paste. */
async function typeLikeHuman(page: Page, selector: string, value: string): Promise<void> {
  await page.click(selector);
  await sleep(200 + Math.random() * 300);
  for (const char of value) {
    await page.keyboard.type(char, { delay: 45 + Math.random() * 95 });
  }
  await sleep(250 + Math.random() * 400);
}

/** Small idle movements — a real page gets pointer events before a submit. */
async function idleMouse(page: Page): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.move(300 + Math.random() * 600, 200 + Math.random() * 400, { steps: 8 + Math.floor(Math.random() * 10) });
    await sleep(120 + Math.random() * 260);
  }
}

const CHALLENGE_MARKERS = ['/checkpoint/', '/challenge', 'captcha'];

export async function runLogin(): Promise<void> {
  const config = getConfig();

  if (!config.loginEmail || !config.loginPassword) {
    throw new Error(
      'LI_EMAIL and LI_PASSWORD must be set in .env to run the login helper.\n' +
        'They are used only here, only to fill LinkedIn\'s own login form, and are never stored.',
    );
  }

  const label = config.identityLabel;
  const identityId = label.replace(/[^a-zA-Z0-9._-]/g, '_');
  const store = new FileSessionStore(config.sessionStateDir);

  // Headed on purpose: you may need to clear a CAPTCHA or type an emailed code.
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    slowMo: 40,
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });

  const page = await context.newPage();

  try {
    console.log('→ opening LinkedIn login…');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await idleMouse(page);

    console.log('→ filling credentials (not logged, not stored)…');
    await typeLikeHuman(page, '#username', config.loginEmail);
    await typeLikeHuman(page, '#password', config.loginPassword);
    await idleMouse(page);

    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => undefined),
      page.click('button[type="submit"]'),
    ]);

    await sleep(4_000);

    if (CHALLENGE_MARKERS.some((marker) => page.url().includes(marker))) {
      console.log('');
      console.log('⚠  LinkedIn presented a verification challenge.');
      console.log('   Complete it in the browser window that just opened —');
      console.log('   CAPTCHA, emailed code, or device confirmation.');
      console.log('   Waiting up to 5 minutes…');
      console.log('');

      await page.waitForURL((url) => !CHALLENGE_MARKERS.some((m) => url.toString().includes(m)), {
        timeout: 300_000,
      });
    }

    // Confirm authentication against the API rather than by guessing at the DOM,
    // whose class names change constantly.
    const me = await page.evaluate(async () => {
      const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/)?.[1] ?? '').replace(/"/g, '');
      const response = await fetch('/voyager/api/me', {
        credentials: 'include',
        headers: {
          accept: 'application/vnd.linkedin.normalized+json+2.1',
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
        },
      });
      return { status: response.status, body: await response.text() };
    });

    if (me.status !== 200) {
      throw new Error(
        `Login did not complete: /voyager/api/me returned ${me.status}. Current URL: ${page.url()}`,
      );
    }

    const who = /"firstName":"([^"]*)"/.exec(me.body)?.[1] ?? '(unknown)';
    const state = await context.storageState();
    await store.save(identityId, state as never);

    console.log('');
    console.log(`✓ logged in as ${who}`);
    console.log(`✓ session saved for identity "${label}" → ${config.sessionStateDir}/${identityId}.json`);
    console.log('');
    console.log('  That file is a live session — it is gitignored and mode 0600. Do not commit or share it.');
    console.log('  You can now remove LI_PASSWORD from .env; the server never reads it.');
    console.log('  Start the API with: npm run dev');
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
