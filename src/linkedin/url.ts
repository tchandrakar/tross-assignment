import { ApiError } from '../errors.js';

/**
 * LinkedIn profile URLs come in a lot of shapes. All of these must resolve to
 * the same public identifier ("vanity name"):
 *
 *   https://www.linkedin.com/in/john-doe-123/
 *   https://linkedin.com/in/john-doe-123
 *   https://in.linkedin.com/in/john-doe-123?originalSubdomain=in
 *   http://www.linkedin.com/in/john-doe-123/en
 *   linkedin.com/in/john-doe-123
 *   john-doe-123                              (bare vanity name)
 *
 * Non-profile LinkedIn URLs (/company/, /school/, /pub/dir/) are rejected
 * rather than silently mis-parsed.
 */

/** Subpaths LinkedIn appends to a profile URL that are not part of the vanity name. */
const PROFILE_SUBPATHS = new Set([
  'detail', 'details', 'recent-activity', 'overlay', 'edit', 'en', 'es', 'fr',
  'de', 'pt', 'zh', 'ja', 'ko', 'it', 'nl', 'ru', 'tr', 'ar', 'id', 'th',
]);

const VANITY_RE = /^[A-Za-z0-9\-_%À-ɏЀ-ӿ一-鿿]{2,120}$/;

export interface ParsedProfileUrl {
  /** The public identifier LinkedIn keys the profile on, lower-cased. */
  publicId: string;
  /** Canonical URL we echo back in the response. */
  canonicalUrl: string;
}

export function parseProfileUrl(input: string): ParsedProfileUrl {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new ApiError('INVALID_URL', 'A LinkedIn profile URL is required.');
  }

  // Bare vanity name, e.g. "john-doe-123"
  if (!raw.includes('/') && !raw.includes('.')) {
    return finalise(raw);
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ApiError('INVALID_URL', `Not a parseable URL: ${truncate(raw)}`);
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
    throw new ApiError('INVALID_URL', `Expected a linkedin.com URL, got host "${host}".`);
  }

  const segments = url.pathname.split('/').filter(Boolean).map(decodeSafe);

  const inIndex = segments.findIndex((s) => s.toLowerCase() === 'in');
  if (inIndex === -1) {
    const kind = segments[0]?.toLowerCase();
    if (kind === 'company' || kind === 'school' || kind === 'showcase') {
      throw new ApiError('INVALID_URL', `This is a ${kind} URL, not a member profile. Only /in/ URLs are supported.`);
    }
    if (kind === 'pub' || segments[0]?.toLowerCase() === 'profile') {
      throw new ApiError('INVALID_URL', 'Legacy /pub/ and /profile/ URLs are not supported. Use the /in/<name> form.');
    }
    throw new ApiError('INVALID_URL', 'URL does not contain an /in/<name> profile path.');
  }

  const candidate = segments[inIndex + 1];
  if (!candidate || PROFILE_SUBPATHS.has(candidate.toLowerCase())) {
    throw new ApiError('INVALID_URL', 'URL is missing the profile identifier after /in/.');
  }

  return finalise(candidate);
}

function finalise(candidate: string): ParsedProfileUrl {
  const publicId = decodeSafe(candidate).replace(/\/+$/, '').toLowerCase();
  if (!VANITY_RE.test(publicId)) {
    throw new ApiError('INVALID_URL', `"${truncate(publicId)}" is not a valid LinkedIn profile identifier.`);
  }
  return { publicId, canonicalUrl: `https://www.linkedin.com/in/${publicId}/` };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const truncate = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
