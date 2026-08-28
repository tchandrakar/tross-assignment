/**
 * Voyager endpoint catalogue.
 *
 * Note what is *absent*: any GraphQL `queryId`.
 *
 * LinkedIn's GraphQL endpoints are addressed by an opaque hash of a persisted
 * query — `voyagerIdentityDashProfileCards.2fdaa6b0…` — and those hashes change
 * with every LinkedIn web build. A hardcoded hash is the single most common
 * reason a service like this stops working.
 *
 * The endpoints below are plain Rest.li REST, addressed by `decorationId`,
 * which is part of LinkedIn's published data model and changes far less often.
 * An earlier revision carried a table of queryId hashes and environment
 * overrides to rotate them; choosing this endpoint family removed the problem
 * rather than managing it.
 */

/**
 * The whole profile in one request.
 *
 * `FullProfileWithEntities-102` returns the Profile record together with
 * PositionGroups, Positions, Educations, Companies, Schools, Industries and
 * Geos, and the Profile references every remaining section — skills,
 * certifications, languages, projects, publications, honours, volunteering.
 */
export const dashProfileByVanityPath = (publicId: string): string =>
  `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(publicId)}` +
  '&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-102';

/**
 * Legacy REST profile view. Returned every section in a single response and
 * took no decoration or query id at all, which made it the most stable endpoint
 * available — until LinkedIn withdrew it. It answers `410 Gone` as of 2026-08.
 *
 * Retained as a fallback because it costs one request to try and `410` is
 * unambiguous, and because the withdrawal may be staged per account.
 */
export const profileViewPath = (publicId: string): string =>
  `/identity/profiles/${encodeURIComponent(publicId)}/profileView`;

/** Identity check. Used to verify a session without fetching anything. */
export const ME_PATH = '/me';

/** Canonical public URL for a profile, used as a Referer and echoed to callers. */
export const publicProfileUrl = (publicId: string): string =>
  `https://www.linkedin.com/in/${encodeURIComponent(publicId)}/`;
