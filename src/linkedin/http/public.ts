import { CookieJar } from './cookie-jar.js';
import { LinkedinHttpClient } from './client.js';
import { ApiError } from '../../errors.js';

/**
 * Fetches a public profile page with no session.
 *
 * Used only by the unauthenticated fallback. A fresh, empty cookie jar is used
 * on purpose: sending an authenticated session here would be pointless (the
 * page is public) and would spend a real session on a request that does not
 * need one.
 */
export async function fetchPublicProfile(publicId: string): Promise<string> {
  const client = new LinkedinHttpClient(new CookieJar());

  try {
    const response = await client.request({
      path: `/in/${encodeURIComponent(publicId)}`,
      kind: 'navigate',
      timeoutMs: 30_000,
    });

    if (response.status === 404) {
      throw new ApiError('PROFILE_NOT_FOUND', 'LinkedIn has no profile at that identifier.');
    }

    if (response.status === 999 || response.status === 429) {
      throw new ApiError('UPSTREAM_BLOCKED', `LinkedIn returned ${response.status} for the public page.`, {
        details: { status: response.status },
      });
    }

    // A redirect to the auth wall means this profile is not publicly visible —
    // a real answer, not a failure to reach it.
    const location = String(response.headers.location ?? '');
    if (location.includes('/authwall') || location.includes('signup')) {
      throw new ApiError('PROFILE_PRIVATE', 'This profile is not visible without signing in.', {
        details: { location },
      });
    }

    if (response.status !== 200) {
      throw new ApiError('UPSTREAM_BLOCKED', `The public page returned ${response.status}.`, {
        details: { status: response.status },
      });
    }

    return response.body;
  } finally {
    await client.close();
  }
}
