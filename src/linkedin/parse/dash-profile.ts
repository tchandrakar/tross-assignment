import type { Profile } from '../../schema/profile.js';
import {
  arr, dedupe, get, isObject, num, parseDate, parseDateRange, parseVectorImage, pick, str,
  type JsonObject,
} from './common.js';
import { humanizeEnum, humanizeProficiency } from './profile-view.js';

/**
 * Parser for the dash profile graph:
 *
 *   GET /identity/dash/profiles
 *       ?q=memberIdentity&memberIdentity=<publicId>
 *       &decorationId=com.linkedin.voyager.dash.deco.identity.profile
 *                     .FullProfileWithEntities-102
 *
 * This is the primary extraction path, and the reason is worth stating: the
 * `FullProfileWithEntities` decoration returns the **entire profile graph in a
 * single request** — Profile, PositionGroups, Positions, Educations, Companies,
 * Schools, Industries, Geos — and the Profile entity holds a reference to every
 * other section (`*profileSkills`, `*profileCertifications`, …).
 *
 * Crucially it is a plain REST endpoint with a `decorationId`, **not** GraphQL
 * with a `queryId`. Those queryId hashes rotate with every LinkedIn web build
 * and are the single most common reason scrapers like this break. Decoration
 * ids are part of LinkedIn's published Rest.li model and change far less often.
 * So the whole queryId-rotation fragility simply does not apply to this path.
 *
 * Input here is the graph *after* `normalize()` has rehydrated it, so `*foo`
 * references have already become real nested objects under `foo`.
 */

export interface DashParseResult {
  profile: Omit<Profile, 'publicId' | 'profileUrl'>;
  missingSections: string[];
}

/**
 * Sections arrive as Rest.li CollectionResponse wrappers rather than bare
 * arrays. An absent collection and an empty one are different things — the
 * former means we could not see it, the latter that the member has none — but
 * both yield no rows, so `missingSections` records which sections were empty
 * and callers can tell "none" from "not retrieved".
 */
function elementsOf(collection: unknown): JsonObject[] {
  if (Array.isArray(collection)) return collection.filter(isObject);
  if (!isObject(collection)) return [];
  return arr(collection.elements ?? collection.items);
}

export function parseDashProfile(profileEntity: unknown): DashParseResult {
  const record = isObject(profileEntity) ? profileEntity : {};
  const missingSections: string[] = [];

  const section = (name: string, ref: string): JsonObject[] => {
    const elements = elementsOf(get(record, ref));
    if (elements.length === 0) missingSections.push(name);
    return elements;
  };

  const firstName = str(pick(record, 'firstName', 'multiLocaleFirstName.en_US'));
  const lastName = str(pick(record, 'lastName', 'multiLocaleLastName.en_US'));
  const headline = str(pick(record, 'headline', 'multiLocaleHeadline.en_US'));

  const experience = section('experience', 'profilePositionGroups').flatMap(parsePositionGroup);
  const education = section('education', 'profileEducations').map(parseEducation);

  return {
    missingSections,
    profile: {
      urn: str(pick(record, 'entityUrn')),

      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || null,
      headline,
      about: str(pick(record, 'summary', 'multiLocaleSummary.en_US')),
      location: parseLocation(record),
      industry: str(pick(record, 'industry.name', 'industry.defaultLocalizedName', 'industryName')),
      pronouns: humanizeEnum(str(pick(record, 'standardizedPronoun', 'customPronoun'))),

      // Neither count is carried by this decoration, and /networkinfo — which
      // used to supply them — is 410 Gone. Reported as null rather than guessed.
      connectionCount: num(pick(record, 'connections.paging.total', 'connectionsCount')),
      followerCount: num(pick(record, 'followingState.followerCount', 'followerCount')),

      isPremium: pick(record, 'premium') === true || pick(record, 'showPremiumSubscriberBadge') === true,
      isInfluencer: pick(record, 'influencer') === true,
      isOpenToWork: detectOpenToWork(record, headline),
      isHiring: /(\bhiring\b|#hiring|we're hiring)/i.test(headline ?? ''),

      profilePicture: parseVectorImage(pick(record, 'profilePicture', 'profilePicture.displayImageReference')),
      backgroundImage: parseVectorImage(pick(record, 'backgroundPicture', 'backgroundPicture.displayImageReference')),

      experience,
      education,
      skills: dedupe(
        section('skills', 'profileSkills').map((s) => ({
          name: str(pick(s, 'name', 'multiLocaleName.en_US')) ?? '',
          endorsementCount: num(pick(s, 'endorsementCount', 'endorsementsCount')),
        })),
        (s) => s.name.toLowerCase(),
      ).filter((s) => s.name.length > 0),
      certifications: section('certifications', 'profileCertifications').map(parseCertification),
      languages: section('languages', 'profileLanguages')
        .map((l) => ({
          name: str(pick(l, 'name', 'multiLocaleName.en_US')) ?? '',
          proficiency: humanizeProficiency(str(pick(l, 'proficiency'))),
        }))
        .filter((l) => l.name.length > 0),
      projects: section('projects', 'profileProjects').map(parseProject),
      publications: section('publications', 'profilePublications').map(parsePublication),
      honors: section('honors', 'profileHonors').map(parseHonor),
      volunteering: section('volunteering', 'profileVolunteerExperiences').map(parseVolunteer),
    },
  };
}

function parseLocation(record: JsonObject) {
  const full = str(
    pick(record, 'geoLocation.geo.defaultLocalizedName', 'geoLocationName', 'locationName', 'location.defaultLocalizedName'),
  );
  const country = str(pick(record, 'geoCountry.defaultLocalizedName', 'geoCountryName'));
  const countryCode = str(pick(record, 'location.countryCode', 'geoLocation.geo.countryCode'))?.toUpperCase() ?? null;

  // "Seattle, Washington, United States" → leading component is the city.
  const parts = full?.split(',').map((p) => p.trim()) ?? [];
  const city = parts.length > 0 ? (parts[0] ?? null) : null;
  const trailing = parts.length > 1 ? (parts[parts.length - 1] ?? null) : null;

  return {
    full,
    city: city && city !== country ? city : null,
    country: country ?? trailing,
    countryCode: countryCode && /^[A-Z]{2}$/.test(countryCode) ? countryCode : null,
  };
}

/**
 * LinkedIn groups consecutive roles at one employer into a PositionGroup: the
 * group carries the company and the combined tenure, and each nested Position
 * carries a job title. Flattened into standalone entries so callers never have
 * to know about the nesting — company details are inherited from the group,
 * dates prefer the specific role's own range.
 *
 * A group with no nested positions still yields one entry, because for
 * single-role employers LinkedIn sometimes puts the title on the group itself.
 */
function parsePositionGroup(group: JsonObject) {
  const company = (pick(group, 'company') ?? {}) as JsonObject;
  const companyName = str(pick(group, 'companyName', 'multiLocaleCompanyName.en_US', 'company.name'));
  const companyLogo = parseVectorImage(pick(company, 'logo'));
  const companyUrl = str(pick(company, 'url')) ?? companyUrlFrom(pick(company, 'universalName'));

  const positions = elementsOf(get(group, 'profilePositionInPositionGroup'));
  const source = positions.length > 0 ? positions : [group];

  return source.map((position) => {
    const positionCompany = (pick(position, 'company') ?? {}) as JsonObject;

    return {
      title: str(pick(position, 'title', 'multiLocaleTitle.en_US')),
      employmentType: humanizeEnum(str(pick(position, 'employmentType', 'employmentTypeUrn'))),
      company: companyName ?? str(pick(position, 'companyName', 'multiLocaleCompanyName.en_US')),
      companyLinkedinUrl:
        companyUrl ?? str(pick(positionCompany, 'url')) ?? companyUrlFrom(pick(positionCompany, 'universalName')),
      companyLogo: companyLogo ?? parseVectorImage(pick(positionCompany, 'logo')),
      location: str(pick(position, 'locationName', 'geoLocationName', 'geoUrn.defaultLocalizedName')),
      workplaceType: humanizeEnum(str(pick(position, 'workplaceType', 'workplaceTypeUrn'))),
      description: str(pick(position, 'description', 'multiLocaleDescription.en_US')),
      // Fall back to the group's combined tenure when a role omits its own.
      dates: parseDateRange(get(position, 'dateRange') ? position : group),
      skills: elementsOf(get(position, 'profilePositionSkills'))
        .map((s) => str(pick(s, 'name')) ?? '')
        .filter(Boolean),
    };
  });
}

function parseEducation(education: JsonObject) {
  const school = (pick(education, 'school') ?? {}) as JsonObject;

  return {
    school: str(pick(education, 'schoolName', 'multiLocaleSchoolName.en_US', 'school.name')),
    schoolLinkedinUrl: str(pick(school, 'url')) ?? schoolUrlFrom(pick(school, 'universalName')),
    schoolLogo: parseVectorImage(pick(school, 'logo')) ?? parseVectorImage(pick(education, 'company.logo')),
    degree: str(pick(education, 'degreeName', 'multiLocaleDegreeName.en_US')),
    fieldOfStudy: str(pick(education, 'fieldOfStudy', 'multiLocaleFieldOfStudy.en_US')),
    grade: str(pick(education, 'grade')),
    activities: str(pick(education, 'activities')),
    description: str(pick(education, 'description')),
    dates: parseDateRange(education),
  };
}

function parseCertification(cert: JsonObject) {
  const authority = (pick(cert, 'company', 'authorityCompany') ?? {}) as JsonObject;

  return {
    name: str(pick(cert, 'name', 'multiLocaleName.en_US')),
    issuer: str(pick(cert, 'authority', 'multiLocaleAuthority.en_US', 'company.name')),
    issuerLogo: parseVectorImage(pick(authority, 'logo')),
    issuedAt: parseDate(pick(cert, 'issuedOn', 'dateRange.start', 'timePeriod.startDate')),
    expiresAt: parseDate(pick(cert, 'expirationDate', 'dateRange.end', 'timePeriod.endDate')),
    credentialId: str(pick(cert, 'licenseNumber')),
    credentialUrl: str(pick(cert, 'url')),
  };
}

function parseProject(project: JsonObject) {
  return {
    name: str(pick(project, 'title', 'name', 'multiLocaleTitle.en_US')),
    description: str(pick(project, 'description')),
    url: str(pick(project, 'url')),
    dates: parseDateRange(project),
  };
}

function parsePublication(publication: JsonObject) {
  return {
    title: str(pick(publication, 'name', 'title', 'multiLocaleName.en_US')),
    publisher: str(pick(publication, 'publisher', 'multiLocalePublisher.en_US')),
    description: str(pick(publication, 'description')),
    url: str(pick(publication, 'url')),
    publishedAt: parseDate(pick(publication, 'publishedOn', 'date', 'dateRange.start')),
  };
}

function parseHonor(honor: JsonObject) {
  return {
    title: str(pick(honor, 'title', 'multiLocaleTitle.en_US')),
    issuer: str(pick(honor, 'issuer', 'multiLocaleIssuer.en_US')),
    description: str(pick(honor, 'description')),
    issuedAt: parseDate(pick(honor, 'issuedOn', 'issueDate', 'dateRange.start')),
  };
}

function parseVolunteer(volunteer: JsonObject) {
  return {
    role: str(pick(volunteer, 'role', 'multiLocaleRole.en_US')),
    organization: str(pick(volunteer, 'companyName', 'multiLocaleCompanyName.en_US', 'company.name')),
    cause: humanizeEnum(str(pick(volunteer, 'cause'))),
    description: str(pick(volunteer, 'description')),
    dates: parseDateRange(volunteer),
  };
}

/**
 * The #OpenToWork state lives in a photo frame overlay rather than a flag, so
 * it is inferred from the frame type with a headline fallback.
 */
function detectOpenToWork(record: JsonObject, headline: string | null): boolean {
  const frame = str(pick(record, 'profilePicture.frameType', 'profilePictureFrameType', 'memberRelationship.frameType'));
  if (frame && /open_to_work|opentowork/i.test(frame)) return true;
  if (get(record, 'profileOpenToWorkCard') != null) return true;
  return /#?open\s?to\s?work/i.test(headline ?? '');
}

const companyUrlFrom = (universalName: unknown): string | null => {
  const name = str(universalName);
  return name ? `https://www.linkedin.com/company/${name}/` : null;
};

const schoolUrlFrom = (universalName: unknown): string | null => {
  const name = str(universalName);
  return name ? `https://www.linkedin.com/school/${name}/` : null;
};
