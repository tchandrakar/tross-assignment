import { chromium, type Locator, type Page } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
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
 * Deliberately headed and deliberately supervised:
 *   - LinkedIn challenges automated logins with CAPTCHA, email OTP and device
 *     verification. A human needs to be present to clear them, and a headless
 *     login is far more likely to be challenged in the first place.
 *   - Credentials are read from the environment and typed into LinkedIn's own
 *     login form. They are never logged, never written to disk, never sent
 *     anywhere but LinkedIn.
 *
 * Run once per identity; re-run only if the session is lost.
 */

/**
 * Selectors, in priority order.
 *
 * LinkedIn's current login page has **no stable ids or name attributes** — the
 * element ids are React-generated (`«Rsvvriejj35659j6»`) and change per render,
 * and the inputs carry no `name`. The only durable handles are the
 * `autocomplete` values, which are fixed by the HTML spec and by password
 * managers depending on them. The older `#username` / `input[name=session_key]`
 * selectors are kept last as a fallback for the legacy page, which LinkedIn
 * still serves in some regions.
 *
 * The page also renders the form twice (a responsive variant), so every lookup
 * takes the first *visible* match rather than assuming uniqueness.
 */
const EMAIL_SELECTORS = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  '#username',
  'input[name="session_key"]',
];

const PASSWORD_SELECTORS = [
  'input[autocomplete="current-password"]',
  'input[type="password"]',
  '#password',
  'input[name="session_password"]',
];

const CHALLENGE_MARKERS = ['/checkpoint/', '/challenge', 'captcha'];

async function firstVisible(page: Page, selectors: string[], what: string, timeoutMs = 30_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(`${selector}:visible`).first();
      if (await locator.count() > 0) return locator;
    }
    await sleep(400);
  }

  throw new Error(
    `Could not find the ${what} field on LinkedIn's login page. ` +
      `Tried: ${selectors.join(', ')}. LinkedIn has probably changed the page again — ` +
      'a screenshot has been saved next to the session directory.',
  );
}

/** Types like a person: variable per-keystroke delay, not a paste. */
async function typeLikeHuman(locator: Locator, value: string): Promise<void> {
  await locator.click();
  await sleep(200 + Math.random() * 300);
  for (const char of value) {
    await locator.pressSequentially(char, { delay: 45 + Math.random() * 95 });
  }
  await sleep(250 + Math.random() * 400);
}

/** Small idle movements — a real page gets pointer events before a submit. */
async function idleMouse(page: Page): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.move(300 + Math.random() * 600, 200 + Math.random() * 400, {
      steps: 8 + Math.floor(Math.random() * 10),
    });
    await sleep(120 + Math.random() * 260);
  }
}

/**
 * The submit control is `<button type="button">Sign in</button>` — not a submit
 * button — and it sits alongside "Sign in with Apple" / "Sign in with Google",
 * so the name match has to be exact or we click the wrong provider.
 */
async function clickSignIn(page: Page): Promise<void> {
  const exact = page.getByRole('button', { name: /^\s*sign in\s*$/i }).filter({ visible: true }).first();
  if (await exact.count() > 0) {
    await exact.click();
    return;
  }

  const submit = page.locator('button[type="submit"]:visible').first();
  if (await submit.count() > 0) {
    await submit.click();
    return;
  }

  // Last resort: submitting from the password field works on both page variants.
  await page.keyboard.press('Enter');
}

/** Confirms auth against the API — DOM class names change constantly, this does not. */
async function whoAmI(page: Page): Promise<{ status: number; firstName: string | null }> {
  const result = await page.evaluate(async () => {
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

  return { status: result.status, firstName: /"firstName":"([^"]*)"/.exec(result.body)?.[1] ?? null };
}

export async function runLogin(): Promise<void> {
  const config = getConfig();

  if (!config.loginEmail || !config.loginPassword) {
    throw new Error(
      'LI_EMAIL and LI_PASSWORD must be set in .env to run the login helper.\n' +
        "They are used only here, only to fill LinkedIn's own login form, and are never stored.",
    );
  }

  const label = config.identityLabel;
  const identityId = label.replace(/[^a-zA-Z0-9._-]/g, '_');
  const store = new FileSessionStore(config.sessionStateDir);
  await mkdir(config.sessionStateDir, { recursive: true });
  const shotPath = `${config.sessionStateDir}/login-failure.png`;

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
    await sleep(1_500);

    // An existing browser session may already be valid.
    if (!page.url().includes('/login') && !page.url().includes('/uas/')) {
      const existing = await whoAmI(page);
      if (existing.status === 200) {
        await store.save(identityId, (await context.storageState()) as never);
        console.log(`✓ already signed in as ${existing.firstName ?? '(unknown)'} — session saved.`);
        return;
      }
    }

    await idleMouse(page);

    console.log('→ locating the login form…');
    const email = await firstVisible(page, EMAIL_SELECTORS, 'email');
    const password = await firstVisible(page, PASSWORD_SELECTORS, 'password');

    console.log('→ filling credentials (not logged, not stored)…');
    await typeLikeHuman(email, config.loginEmail);
    await typeLikeHuman(password, config.loginPassword);
    await idleMouse(page);

    console.log('→ submitting…');
    await clickSignIn(page);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await sleep(5_000);

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
      await sleep(3_000);
    }

    const me = await whoAmI(page);
    if (me.status !== 200) {
      await page.screenshot({ path: shotPath, fullPage: false }).catch(() => undefined);
      throw new Error(
        `Login did not complete: /voyager/api/me returned ${me.status}. ` +
          `Current URL: ${page.url()}. Screenshot: ${shotPath}`,
      );
    }

    await store.save(identityId, (await context.storageState()) as never);

    console.log('');
    console.log(`✓ logged in as ${me.firstName ?? '(unknown)'}`);
    console.log(`✓ session saved for identity "${label}" → ${config.sessionStateDir}/${identityId}.json`);
    console.log('');
    console.log('  That file is a live session — gitignored, mode 0600. Do not commit or share it.');
    console.log('  You can now remove LI_PASSWORD from .env; the server never reads it.');
    console.log('  Start the API with: npm run dev');
  } catch (error) {
    await page.screenshot({ path: shotPath, fullPage: false }).catch(() => undefined);
    throw error;
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
