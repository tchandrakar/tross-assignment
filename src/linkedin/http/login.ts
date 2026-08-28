import { ApiError } from '../../errors.js';
import { CookieJar } from './cookie-jar.js';
import { LinkedinHttpClient } from './client.js';

/**
 * Browser-free sign-in.
 *
 * LinkedIn's modern `/login` and `/uas/login` pages are a React application
 * with no HTML form to post — the inputs carry React-generated ids and no
 * `name` attributes, so there is nothing a plain HTTP client can submit.
 *
 * `/checkpoint/lg/login` still serves the classic server-rendered form:
 *
 *     <form method="post" action="/checkpoint/lg/login-submit">
 *       <input type="hidden" name="csrfToken"      value="ajax:…">
 *       <input type="hidden" name="loginCsrfParam" value="566bf1a5-…">
 *       <input name="session_key"      type="email">
 *       <input name="session_password" type="password">
 *
 * That is the sign-in path used here. Both hidden fields are required and are
 * bound to the cookies issued alongside the form, so the GET and the POST must
 * share a jar — fetching the form and posting from a fresh jar fails.
 *
 * A successful sign-in answers `303` with `location: /feed/` and sets `li_at`.
 */

const LOGIN_FORM_PATH = '/checkpoint/lg/login';
const LOGIN_SUBMIT_PATH = '/checkpoint/lg/login-submit';

export interface LoginOutcome {
  status: 'success' | 'challenge';
  /** Present when a verification challenge was issued. */
  challengeUrl?: string;
  /** Hidden fields the challenge form requires, carried into the code submission. */
  challengeFields?: Record<string, string>;
}

/** Pulls a hidden input's value regardless of attribute order. */
export function readHiddenField(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`name="${escaped}"[^>]*?value="([^"]*)"`, 'i').exec(html)?.[1] ??
    new RegExp(`value="([^"]*)"[^>]*?name="${escaped}"`, 'i').exec(html)?.[1]
  );
}

/** All hidden inputs on a page, for carrying a challenge form forward intact. */
export function readHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tag of html.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = /name="([^"]*)"/.exec(tag[0])?.[1];
    const value = /value="([^"]*)"/.exec(tag[0])?.[1] ?? '';
    if (name) fields[name] = value;
  }
  return fields;
}

export async function login(
  client: LinkedinHttpClient,
  credentials: { email: string; password: string },
  log: (message: string) => void = () => {},
): Promise<LoginOutcome> {
  log('fetching the sign-in form');

  const form = await client.request({
    path: LOGIN_FORM_PATH,
    kind: 'navigate',
    timeoutMs: 30_000,
  });

  if (form.status !== 200) {
    throw new ApiError('AUTH_FAILED', `The sign-in form returned ${form.status}.`, {
      details: { status: form.status },
    });
  }

  const csrfToken = readHiddenField(form.body, 'csrfToken');
  const loginCsrfParam = readHiddenField(form.body, 'loginCsrfParam');

  if (!csrfToken || !loginCsrfParam) {
    // Worth stating plainly: this means LinkedIn changed the form, not that the
    // credentials are wrong, and the two need very different responses.
    throw new ApiError(
      'PARSE_FAILED',
      'The sign-in form did not contain the expected hidden fields (csrfToken, loginCsrfParam). ' +
        'LinkedIn has probably changed the page.',
      { details: { csrfToken: Boolean(csrfToken), loginCsrfParam: Boolean(loginCsrfParam) } },
    );
  }

  log('submitting credentials');

  const payload = new URLSearchParams({
    csrfToken,
    session_key: credentials.email,
    session_password: credentials.password,
    loginCsrfParam,
    session_redirect: '',
    encrypted_session_key: '',
  }).toString();

  const submitted = await client.request({
    path: LOGIN_SUBMIT_PATH,
    method: 'POST',
    kind: 'form',
    body: payload,
    referer: `https://www.linkedin.com${LOGIN_FORM_PATH}`,
    headers: { 'content-length': String(Buffer.byteLength(payload)) },
    timeoutMs: 30_000,
  });

  const location = String(submitted.headers.location ?? '');

  if (client.jar.isAuthenticated()) {
    log('signed in');
    return { status: 'success' };
  }

  // A redirect into /checkpoint/ means the credentials were accepted and
  // LinkedIn wants verification — a different situation from a rejection, and
  // recoverable by submitting a code.
  if (location.includes('/checkpoint/')) {
    log(`verification challenge at ${location}`);
    const page = await client.request({
      path: location.replace('https://www.linkedin.com', ''),
      kind: 'navigate',
      referer: `https://www.linkedin.com${LOGIN_SUBMIT_PATH}`,
    });
    return {
      status: 'challenge',
      challengeUrl: location,
      challengeFields: readHiddenFields(page.body),
    };
  }

  if (/wrong email or password|couldn.t find|incorrect/i.test(submitted.body)) {
    throw new ApiError(
      'AUTH_FAILED',
      'LinkedIn rejected the credentials. Check LI_EMAIL and LI_PASSWORD.',
      { details: { credentialsRejected: true, needsHuman: true } },
    );
  }

  if (/captcha|puzzle|verify you.?re human/i.test(submitted.body)) {
    throw new ApiError(
      'AUTH_FAILED',
      'LinkedIn presented a CAPTCHA, which cannot be answered over HTTP. ' +
        'Sign in from a browser on this network, then supply the resulting cookies via LI_COOKIES.',
      { details: { captcha: true, needsHuman: true } },
    );
  }

  throw new ApiError('AUTH_FAILED', `Sign-in did not complete (status ${submitted.status}, location "${location}").`, {
    details: { status: submitted.status, location },
  });
}

/**
 * Submits a verification code into a pending challenge.
 *
 * The challenge form's hidden fields are bound to the jar that received them,
 * so the same client must be used throughout.
 */
export async function submitChallenge(
  client: LinkedinHttpClient,
  challenge: { challengeUrl: string; challengeFields: Record<string, string> },
  code: string,
  log: (message: string) => void = () => {},
): Promise<void> {
  log('submitting verification code');

  const fields: Record<string, string> = { ...challenge.challengeFields };
  // LinkedIn has used several names for the code input across variants of this
  // page; set the ones it accepts rather than guessing one.
  for (const key of ['pin', 'challengeId', 'verifyCode']) {
    if (key === 'pin') fields[key] = code;
  }
  fields.pin = code;

  const payload = new URLSearchParams(fields).toString();
  const path = challenge.challengeUrl.replace('https://www.linkedin.com', '');

  const response = await client.request({
    path: '/checkpoint/challenge/verify',
    method: 'POST',
    kind: 'form',
    body: payload,
    referer: challenge.challengeUrl,
    headers: { 'content-length': String(Buffer.byteLength(payload)) },
    timeoutMs: 30_000,
  });

  if (client.jar.isAuthenticated()) {
    log('verification accepted');
    return;
  }

  if (/not valid|incorrect|try again/i.test(response.body)) {
    throw new ApiError('AUTH_FAILED', 'LinkedIn rejected the verification code.', {
      details: { retryable: true, path },
    });
  }

  throw new ApiError('AUTH_FAILED', `Verification did not complete (status ${response.status}).`, {
    details: { status: response.status, retryable: true },
  });
}

export { CookieJar };
