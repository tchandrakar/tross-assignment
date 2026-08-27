import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
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

export interface LoginOptions {
  email: string;
  password: string;
  /**
   * Headed, with a long pause for a human to clear a CAPTCHA or type an emailed
   * code. False on a server, where nobody is watching — there, a challenge is a
   * hard failure rather than something to wait on.
   */
  interactive: boolean;
  /** Where a failure screenshot is written. */
  screenshotPath?: string;
  proxy?: { server: string; username?: string; password?: string };
  timezoneId?: string;
  log?: (message: string) => void;
}

export interface LoginSuccess {
  status: 'success';
  firstName: string | null;
  state: unknown;
}

/**
 * LinkedIn issued a verification challenge and the browser has been left open
 * so it can be completed. The caller owns these handles and must eventually
 * call `completeChallenge` or `abandonChallenge` — otherwise the browser leaks.
 */
export interface LoginChallenge {
  status: 'challenge';
  challengeUrl: string;
  /** What the page is asking for, as far as we can tell. */
  kind: 'code' | 'captcha' | 'unknown';
  handle: ChallengeHandle;
}

export interface ChallengeHandle {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  openedAt: number;
}

export type LoginResult = LoginSuccess | LoginChallenge;

/**
 * Performs the login and returns the resulting storage state. Shared by the
 * interactive CLI and the server's automatic bootstrap, so there is one login
 * implementation rather than two that can drift.
 */
export async function performLogin(options: LoginOptions): Promise<LoginResult> {
  const { email, password, interactive } = options;
  const log = options.log ?? (() => {});
  const shotPath = options.screenshotPath;

  const browser = await chromium.launch({
    headless: !interactive,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
    ...(interactive ? { slowMo: 40 } : {}),
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: options.timezoneId || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    ...(options.proxy ? { proxy: options.proxy } : {}),
  });

  const page = await context.newPage();
  // When a challenge is handed back, the caller owns the browser — the finally
  // block must not close it out from under them.
  let challengeIssued = false;

  try {
    log('opening LinkedIn login');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(1_500);

    // An existing browser session may already be valid.
    if (!page.url().includes('/login') && !page.url().includes('/uas/')) {
      const existing = await whoAmI(page);
      if (existing.status === 200) {
        log(`already signed in as ${existing.firstName ?? '(unknown)'}`);
        return { status: 'success', firstName: existing.firstName, state: await context.storageState() };
      }
    }

    await idleMouse(page);

    log('locating the login form');
    const emailField = await firstVisible(page, EMAIL_SELECTORS, 'email');
    const passwordField = await firstVisible(page, PASSWORD_SELECTORS, 'password');

    log('filling credentials (never logged, never stored)');
    await typeLikeHuman(emailField, email);
    await typeLikeHuman(passwordField, password);
    await idleMouse(page);

    log('submitting');
    await clickSignIn(page);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await sleep(5_000);

    if (CHALLENGE_MARKERS.some((marker) => page.url().includes(marker))) {
      if (!interactive) {
        // Nobody is at the browser, but the challenge is still answerable: keep
        // the context alive and hand it back so a code can be submitted through
        // the API. Closing here would discard the only session that can
        // complete it, forcing a fresh login and a fresh challenge.
        const kind = await classifyChallenge(page);
        if (shotPath) await page.screenshot({ path: shotPath }).catch(() => undefined);
        log(`verification challenge (${kind}) at ${page.url()}`);
        challengeIssued = true;
        return { status: 'challenge', challengeUrl: page.url(), kind, handle: { browser, context, page, openedAt: Date.now() } };
      }

      log('');
      log('LinkedIn presented a verification challenge.');
      log('Complete it in the browser window that just opened —');
      log('CAPTCHA, emailed code, or device confirmation. Waiting up to 5 minutes…');
      log('');

      await page.waitForURL((url) => !CHALLENGE_MARKERS.some((m) => url.toString().includes(m)), {
        timeout: 300_000,
      });
      await sleep(3_000);
    }

    const me = await whoAmI(page);
    if (me.status !== 200) {
      if (shotPath) await page.screenshot({ path: shotPath, fullPage: false }).catch(() => undefined);
      throw new Error(
        `Login did not complete: /voyager/api/me returned ${me.status}. Current URL: ${page.url()}` +
          (shotPath ? `. Screenshot: ${shotPath}` : ''),
      );
    }

    log(`logged in as ${me.firstName ?? '(unknown)'}`);
    return { status: 'success', firstName: me.firstName, state: await context.storageState() };
  } catch (error) {
    if (shotPath) await page.screenshot({ path: shotPath, fullPage: false }).catch(() => undefined);
    throw error;
  } finally {
    if (!challengeIssued) {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }
}

/** Inputs LinkedIn uses for a one-time verification code, in priority order. */
const CODE_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name="pin"]',
  '#input__email_verification_pin',
  'input[inputmode="numeric"]',
  'input[type="tel"]',
  'input[type="text"]:not([type="hidden"])',
];

async function classifyChallenge(page: Page): Promise<'code' | 'captcha' | 'unknown'> {
  try {
    const text = await page.evaluate(() => (document.body.innerText || '').slice(0, 2000));
    if (/verification code|enter the code|we sent|check your email|two-step/i.test(text)) return 'code';
    if (/captcha|puzzle|verify you.?re human|security check/i.test(text)) return 'captcha';
  } catch {
    // Fall through to unknown.
  }
  return 'unknown';
}

/**
 * Submits a verification code into an open challenge and finishes the login.
 *
 * Returns the storage state on success. Leaves the handle open on failure so a
 * mistyped code can be retried without restarting the whole login — LinkedIn
 * allows several attempts, but a fresh login would issue a fresh challenge.
 */
export async function completeChallenge(
  handle: ChallengeHandle,
  code: string,
): Promise<{ firstName: string | null; state: unknown }> {
  const { page } = handle;

  let field: Locator | null = null;
  for (const selector of CODE_SELECTORS) {
    const locator = page.locator(`${selector}:visible`).first();
    if ((await locator.count()) > 0) { field = locator; break; }
  }
  if (!field) {
    throw new Error(
      `No verification-code input found on ${page.url()}. The challenge is probably a CAPTCHA, which cannot be answered through the API.`,
    );
  }

  await field.click();
  await field.fill('');
  for (const char of code.trim()) {
    await field.pressSequentially(char, { delay: 60 + Math.random() * 90 });
  }
  await sleep(400);

  const submit = page.getByRole('button', { name: /submit|verify|continue|next/i }).filter({ visible: true }).first();
  if ((await submit.count()) > 0) {
    await submit.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await sleep(4_000);

  if (CHALLENGE_MARKERS.some((marker) => page.url().includes(marker))) {
    const text = await page.evaluate(() => (document.body.innerText || '').slice(0, 400)).catch(() => '');
    throw new Error(`Still on the challenge page after submitting the code. LinkedIn says: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  const me = await whoAmI(page);
  if (me.status !== 200) {
    throw new Error(`Challenge submitted but the session is still not authenticated (me returned ${me.status}).`);
  }

  return { firstName: me.firstName, state: await handle.context.storageState() };
}

/** Releases a challenge's browser without completing it. */
export async function abandonChallenge(handle: ChallengeHandle): Promise<void> {
  await handle.context.close().catch(() => undefined);
  await handle.browser.close().catch(() => undefined);
}

/** Distinguishes "needs a human" from "credentials are wrong". */
export class LoginChallengeError extends Error {
  override name = 'LoginChallengeError';
}

/** CLI entry point: headed, writes to the local session store. */
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

  const result = await performLogin({
    email: config.loginEmail,
    password: config.loginPassword,
    interactive: true,
    screenshotPath: `${config.sessionStateDir}/login-failure.png`,
    log: (m) => console.log(m ? `→ ${m}` : ''),
  });

  // Interactive runs wait at the challenge in the visible browser, so reaching
  // here with a challenge result should not happen — handled for completeness.
  if (result.status === 'challenge') {
    await abandonChallenge(result.handle);
    throw new Error(`Login stopped at a verification challenge: ${result.challengeUrl}`);
  }

  const { firstName, state } = result;
  await store.save(identityId, state as never);

  console.log('');
  console.log(`✓ logged in as ${firstName ?? '(unknown)'}`);
  console.log(`✓ session saved for identity "${label}" → ${config.sessionStateDir}/${identityId}.json`);
  console.log('');
  console.log('  That file is a live session — gitignored, mode 0600. Do not commit or share it.');
  console.log('  Start the API with: npm run dev');
}
