import type { Profile } from '../../schema/profile.js';
import type { DateRange, PartialDate } from '../../schema/profile.js';
import { monthsBetween } from './common.js';

/**
 * Parser for the public profile page's `application/ld+json` block.
 *
 * This is the unauthenticated fallback. LinkedIn embeds a schema.org `Person`
 * on every public profile, and it is served without a session — so the API can
 * still answer when no session is available, rather than failing outright.
 *
 * The trade-off is explicit rather than hidden: LinkedIn **masks** most free
 * text for logged-out viewers, replacing it with runs of asterisks:
 *
 *     "jobTitle": ["*** ******* ******* * *********"]
 *     "worksFor": [{ "name": "***", "location": "Ahmedabad, Gujarat, India" }]
 *
 * A masked value carries no information, so it is reported as `null` and the
 * section is listed in `missingSections`. Returning the asterisks would be
 * worse than returning nothing: a consumer would store them as though they were
 * the member's actual job title.
 *
 * What does survive unmasked, in practice: name, location, profile image,
 * languages, awards, follower count, and the date ranges on positions and
 * education — enough to be useful, nowhere near the authenticated response.
 */

interface LdNode {
  '@type'?: string;
  [key: string]: unknown;
}

/** LinkedIn masks text by replacing every character with an asterisk. */
export function isMasked(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const stripped = value.replace(/[\s,.\-–—|/()]/g, '');
  if (stripped.length === 0) return false;
  const asterisks = (stripped.match(/\*/g) ?? []).length;
  // Partly-masked strings ("Confidential ***") still carry information, so the
  // threshold is deliberately high rather than "contains an asterisk".
  return asterisks / stripped.length >= 0.6;
}

/** Returns the value, or null when LinkedIn masked it for logged-out viewers. */
function visible(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || isMasked(trimmed)) return null;
  return trimmed;
}

const asArray = (value: unknown): LdNode[] =>
  Array.isArray(value) ? value.filter((v): v is LdNode => typeof v === 'object' && v !== null) : [];

/** Extracts every `application/ld+json` block from a page. */
export function extractLdJson(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      blocks.push(JSON.parse(match[1]!));
    } catch {
      // A malformed block is not worth failing the request over.
    }
  }
  return blocks;
}

/** Finds the schema.org Person node, which may sit inside an `@graph`. */
export function findPerson(blocks: unknown[]): LdNode | null {
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const graph = (block as { '@graph'?: unknown })['@graph'];
    const nodes = Array.isArray(graph) ? graph : [block];
    for (const node of nodes) {
      if (typeof node === 'object' && node !== null && (node as LdNode)['@type'] === 'Person') {
        return node as LdNode;
      }
    }
  }
  return null;
}

/** schema.org gives years only, so day and month are genuinely unknown. */
function yearOnly(value: unknown): PartialDate | null {
  const year = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(year) && year > 1900 && year < 2200 ? { day: null, month: null, year } : null;
}

function range(member: unknown): DateRange {
  const node = (typeof member === 'object' && member !== null ? member : {}) as LdNode;
  const start = yearOnly(node.startDate);
  const end = yearOnly(node.endDate);
  const current = start !== null && end === null;
  return { start, end, current, durationMonths: monthsBetween(start, end, current) };
}

export interface PublicParseResult {
  profile: Omit<Profile, 'publicId' | 'profileUrl'>;
  missingSections: string[];
  /** Fields present on the page but masked for logged-out viewers. */
  maskedFields: string[];
}

export function parsePublicProfile(html: string): PublicParseResult | null {
  const person = findPerson(extractLdJson(html));
  if (!person) return null;

  const missingSections: string[] = [];
  const maskedFields: string[] = [];

  const note = (field: string, raw: unknown) => {
    if (typeof raw === 'string' && isMasked(raw)) maskedFields.push(field);
  };

  const name = visible(person.name);

  // jobTitle is an array of roles, most recent first; the headline is not
  // exposed to logged-out viewers at all.
  const jobTitles = Array.isArray(person.jobTitle) ? person.jobTitle : [];
  note('headline', jobTitles[0]);
  const headline = visible(jobTitles[0]);

  const address = (typeof person.address === 'object' && person.address !== null ? person.address : {}) as LdNode;
  const locality = visible(address.addressLocality);
  const region = visible(address.addressRegion);
  const country = visible(address.addressCountry);

  const experience = asArray(person.worksFor).map((org, index) => {
    note(`experience[${index}].company`, org.name);
    const member = (typeof org.member === 'object' && org.member !== null ? org.member : {}) as LdNode;
    note(`experience[${index}].description`, member.description);

    return {
      title: visible(jobTitles[index]),
      employmentType: null,
      company: visible(org.name),
      companyLinkedinUrl: typeof org.url === 'string' ? org.url : null,
      companyLogo: null,
      location: visible(org.location),
      workplaceType: null,
      description: visible(member.description),
      dates: range(org.member),
      skills: [] as string[],
    };
  });

  const education = asArray(person.alumniOf).map((school, index) => {
    note(`education[${index}].school`, school.name);
    return {
      school: visible(school.name),
      schoolLinkedinUrl: typeof school.url === 'string' ? school.url : null,
      schoolLogo: null,
      degree: null,
      fieldOfStudy: null,
      grade: null,
      activities: null,
      description: null,
      dates: range(school.member),
    };
  });

  const languages = asArray(person.knowsLanguage)
    .map((l) => ({ name: visible(l.name) ?? '', proficiency: null }))
    .filter((l) => l.name.length > 0);

  const honors = (Array.isArray(person.awards) ? person.awards : [])
    .map((award) => ({ title: visible(award), issuer: null, description: null, issuedAt: null }))
    .filter((h) => h.title !== null);

  const image = (typeof person.image === 'object' && person.image !== null ? person.image : {}) as LdNode;
  const imageUrl = typeof image.contentUrl === 'string' ? image.contentUrl : null;

  const followers = asArray(person.interactionStatistic).find(
    (s) => String(s.interactionType ?? '').includes('FollowAction'),
  );
  const followerCount = typeof followers?.userInteractionCount === 'number' ? followers.userInteractionCount : null;

  // Sections the authenticated response carries that the public page never does.
  missingSections.push('skills', 'certifications', 'projects', 'publications', 'volunteering');
  if (experience.length === 0) missingSections.push('experience');
  if (education.length === 0) missingSections.push('education');
  if (languages.length === 0) missingSections.push('languages');
  if (honors.length === 0) missingSections.push('honors');

  return {
    maskedFields,
    missingSections,
    profile: {
      urn: null,
      firstName: name?.split(/\s+/)[0] ?? null,
      lastName: name?.split(/\s+/).slice(1).join(' ') || null,
      fullName: name,
      headline,
      // The summary is not exposed to logged-out viewers at all.
      about: null,
      location: {
        full: [locality, region, country].filter(Boolean).join(', ') || null,
        city: locality,
        country,
        countryCode: null,
      },
      industry: null,
      pronouns: null,
      connectionCount: null,
      followerCount,
      isPremium: false,
      isInfluencer: false,
      isOpenToWork: false,
      isHiring: false,
      profilePicture: imageUrl ? { url: imageUrl, width: null, height: null, expiresAt: null } : null,
      backgroundImage: null,
      experience,
      education,
      skills: [],
      certifications: [],
      languages,
      projects: [],
      publications: [],
      honors,
      volunteering: [],
    },
  };
}
