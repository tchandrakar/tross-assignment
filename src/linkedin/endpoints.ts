/**
 * Voyager endpoint catalogue.
 *
 * LinkedIn's GraphQL endpoints are addressed by `queryId` — an opaque hash of
 * the persisted query document, e.g. `voyagerIdentityDashProfileCards.<hash>`.
 * Those hashes change whenever LinkedIn ships a new web build, which is the
 * single most common reason a scraper like this breaks.
 *
 * Two mitigations:
 *   1. The legacy REST endpoints (which take no queryId) are tried first.
 *   2. Every hash below is overridable at runtime via environment variables, so
 *      a rotation can be fixed by editing config rather than redeploying code.
 *      See README §"When LinkedIn rotates a queryId".
 */

const envOr = (key: string, fallback: string): string => process.env[key]?.trim() || fallback;

export const QUERY_IDS = {
  /** Top-card profile record, addressed by vanity name. */
  profileByVanity: envOr('QID_PROFILE_BY_VANITY', 'voyagerIdentityDashProfiles.d4d7bd9d1bdb0a2e8ba0d1e8b6a5b9b3'),
  /** The section cards (experience / education / skills / …). */
  profileCards: envOr('QID_PROFILE_CARDS', 'voyagerIdentityDashProfileCards.2fdaa6b0b1d3b19c5f9c2c8b6ac3b2a1'),
  /** A single expanded section, addressed by section urn. */
  profileComponents: envOr('QID_PROFILE_COMPONENTS', 'voyagerIdentityDashProfileComponents.9f0a5e2f0f5a4b9c6f1c0f6a1d2b3c4d'),
} as const;

/** Legacy REST — one call, whole profile, no queryId to rotate. Strategy #1. */
export const profileViewPath = (publicId: string): string =>
  `/identity/profiles/${encodeURIComponent(publicId)}/profileView`;

/** Legacy REST — connection/follower counts, which profileView omits. */
export const profileNetworkInfoPath = (publicId: string): string =>
  `/identity/profiles/${encodeURIComponent(publicId)}/networkinfo`;

/** Legacy REST — the top card, used to recover the member URN cheaply. */
export const profileContactInfoPath = (publicId: string): string =>
  `/identity/profiles/${encodeURIComponent(publicId)}/profileContactInfo`;

/** Dash REST — profile record by vanity name. Strategy #2 entry point. */
export const dashProfileByVanityPath = (publicId: string): string =>
  `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}` +
  `&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-102`;

/**
 * GraphQL variables use LinkedIn's Rest.li tuple encoding — `(key:value,...)`
 * rather than JSON — and URNs inside must be percent-encoded.
 */
export const graphqlPath = (queryId: string, variables: Record<string, string>): string => {
  const encoded = Object.entries(variables)
    .map(([key, value]) => `${key}:${encodeURIComponent(value)}`)
    .join(',');
  return `/graphql?includeWebMetadata=true&variables=(${encoded})&queryId=${queryId}`;
};

export const profileCardsPath = (publicId: string): string =>
  graphqlPath(QUERY_IDS.profileCards, { profileUrn: publicId });

export const profileComponentsPath = (profileUrn: string, sectionType: string): string =>
  graphqlPath(QUERY_IDS.profileComponents, { profileUrn, sectionType });

/** Public profile HTML — the Playwright fallback's target. */
export const publicProfileUrl = (publicId: string): string =>
  `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;

/** Section identifiers the dash card endpoint accepts. */
export const SECTION_TYPES = [
  'experience',
  'education',
  'skills',
  'certifications',
  'languages',
  'projects',
  'publications',
  'honors',
  'volunteering_experience',
] as const;

export type SectionType = (typeof SECTION_TYPES)[number];
