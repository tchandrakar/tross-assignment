import type { Profile } from '../../schema/profile.js';
import {
  arr, attributedText, bool, companyUrlFromUniversalName, dedupe, get, isObject,
  num, parseDate, parseDateRange, parseVectorImage, pick, schoolUrlFromUniversalName,
  str, type JsonObject,
} from './common.js';

/**
 * Parser for the legacy REST endpoint:
 *   GET /voyager/api/identity/profiles/{publicId}/profileView
 *
 * This one call returns the entire profile — every section — in a single
 * predictable envelope of `<section>View.elements` arrays. It predates the
 * GraphQL migration and LinkedIn has never removed it, which makes it both the
 * richest and the most stable strategy. We try it first for exactly that reason.
 */

export interface ProfileViewParseResult {
  profile: Omit<Profile, 'publicId' | 'profileUrl'>;
  missingSections: string[];
}

export function parseProfileView(root: unknown): ProfileViewParseResult {
  const missingSections: string[] = [];

  const profile = (pick(root, 'profile') ?? {}) as JsonObject;
  const miniProfile = (pick(profile, 'miniProfile') ?? {}) as JsonObject;

  const section = (name: string): JsonObject[] => {
    const elements = arr(get(root, `${name}.elements`));
    if (elements.length === 0) missingSections.push(name.replace(/View$/, ''));
    return elements;
  };

  const firstName = str(pick(profile, 'firstName', 'miniProfile.firstName'));
  const lastName = str(pick(profile, 'lastName', 'miniProfile.lastName'));

  return {
    missingSections,
    profile: {
      urn: str(pick(profile, 'entityUrn', 'miniProfile.entityUrn', 'miniProfile.objectUrn')),

      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || null,
      headline: str(pick(profile, 'headline', 'miniProfile.occupation')),
      about: str(pick(profile, 'summary')),
      location: parseLocation(profile),
      industry: str(pick(profile, 'industryName')),
      pronouns: str(pick(profile, 'pronoun', 'standardizedPronoun')),

      connectionCount: null, // profileView does not carry these; filled by the network call
      followerCount: null,

      isPremium: bool(get(miniProfile, 'premium')),
      isInfluencer: bool(get(miniProfile, 'influencer')),
      isOpenToWork: get(profile, 'profilePositionGroups') !== undefined ? false : false,
      isHiring: false,

      profilePicture: parseVectorImage(pick(miniProfile, 'picture', 'profilePicture')),
      backgroundImage: parseVectorImage(
        pick(miniProfile, 'backgroundImage', 'backgroundPicture'),
      ),

      experience: section('positionView').map(parsePosition),
      education: section('educationView').map(parseEducation),
      skills: dedupe(
        section('skillView').map((s) => ({
          name: str(s.name) ?? '',
          endorsementCount: num(pick(s, 'endorsementCount', 'endorsedByViewer')),
        })),
        (s) => s.name.toLowerCase(),
      ).filter((s) => s.name.length > 0),
      certifications: section('certificationView').map(parseCertification),
      languages: section('languageView')
        .map((l) => ({
          name: str(l.name) ?? '',
          proficiency: humanizeProficiency(str(l.proficiency)),
        }))
        .filter((l) => l.name.length > 0),
      projects: section('projectView').map(parseProject),
      publications: section('publicationView').map(parsePublication),
      honors: section('honorView').map(parseHonor),
      volunteering: section('volunteerExperienceView').map(parseVolunteer),
    },
  };
}

function parseLocation(profile: JsonObject) {
  const full =
    str(pick(profile, 'geoLocationName', 'locationName')) ??
    str(pick(profile, 'location.basicLocation.postalCode'));

  const country = str(pick(profile, 'geoCountryName'));
  const countryCode = str(pick(profile, 'location.basicLocation.countryCode'))?.toUpperCase() ?? null;

  // "Bengaluru, Karnataka, India" → city is the leading component.
  const city = full?.includes(',') ? str(full.split(',')[0]) : full;

  return {
    full: full ?? (country ? country : null),
    city: city && city !== country ? city : null,
    country,
    countryCode: countryCode && countryCode.length === 2 ? countryCode : null,
  };
}

function parsePosition(position: JsonObject) {
  const company = (pick(position, 'company') ?? {}) as JsonObject;
  const miniCompany = (pick(company, 'miniCompany') ?? {}) as JsonObject;

  return {
    title: str(pick(position, 'title')),
    employmentType: humanizeEnum(str(pick(position, 'employmentType', 'employmentTypeUrn'))),
    company: str(pick(position, 'companyName', 'company.miniCompany.name')),
    companyLinkedinUrl: companyUrlFromUniversalName(pick(miniCompany, 'universalName')),
    companyLogo: parseVectorImage(pick(miniCompany, 'logo')),
    location: str(pick(position, 'locationName', 'geoLocationName')),
    workplaceType: humanizeEnum(str(pick(position, 'workplaceType'))),
    description: str(pick(position, 'description')),
    dates: parseDateRange(position),
    skills: arr(get(position, 'profileTreasuryMediaPosition')).length > 0 ? [] : [],
  };
}

function parseEducation(education: JsonObject) {
  const school = (pick(education, 'school') ?? {}) as JsonObject;

  return {
    school: str(pick(education, 'schoolName', 'school.schoolName')),
    schoolLinkedinUrl: schoolUrlFromUniversalName(pick(school, 'schoolUniversalName', 'universalName')),
    schoolLogo: parseVectorImage(pick(school, 'logo')),
    degree: str(pick(education, 'degreeName')),
    fieldOfStudy: str(pick(education, 'fieldOfStudy')),
    grade: str(pick(education, 'grade')),
    activities: str(pick(education, 'activities')),
    description: str(pick(education, 'description')),
    dates: parseDateRange(education),
  };
}

function parseCertification(cert: JsonObject) {
  const authority = (pick(cert, 'company', 'authorityCompany') ?? {}) as JsonObject;
  const miniCompany = (pick(authority, 'miniCompany') ?? authority) as JsonObject;

  return {
    name: str(pick(cert, 'name')),
    issuer: str(pick(cert, 'authority', 'company.miniCompany.name')),
    issuerLogo: parseVectorImage(pick(miniCompany, 'logo')),
    issuedAt: parseDate(pick(cert, 'timePeriod.startDate')),
    expiresAt: parseDate(pick(cert, 'timePeriod.endDate')),
    credentialId: str(pick(cert, 'licenseNumber')),
    credentialUrl: str(pick(cert, 'url')),
  };
}

function parseProject(project: JsonObject) {
  return {
    name: str(pick(project, 'title', 'name')),
    description: str(pick(project, 'description')),
    url: str(pick(project, 'url')),
    dates: parseDateRange(project),
  };
}

function parsePublication(publication: JsonObject) {
  return {
    title: str(pick(publication, 'name', 'title')),
    publisher: str(pick(publication, 'publisher')),
    description: str(pick(publication, 'description')),
    url: str(pick(publication, 'url')),
    publishedAt: parseDate(pick(publication, 'date')),
  };
}

function parseHonor(honor: JsonObject) {
  return {
    title: str(pick(honor, 'title')),
    issuer: str(pick(honor, 'issuer')),
    description: str(pick(honor, 'description')),
    issuedAt: parseDate(pick(honor, 'issueDate')),
  };
}

function parseVolunteer(volunteer: JsonObject) {
  return {
    role: str(pick(volunteer, 'role')),
    organization: str(pick(volunteer, 'companyName', 'company.miniCompany.name')),
    cause: humanizeEnum(str(pick(volunteer, 'cause'))),
    description: str(pick(volunteer, 'description')),
    dates: parseDateRange(volunteer),
  };
}

/** "FULL_TIME" / "urn:li:fsd_employmentType:FULL_TIME" → "Full time". */
function humanizeEnum(value: string | null): string | null {
  if (!value) return null;
  const tail = value.includes(':') ? value.split(':').pop()! : value;
  if (!/^[A-Z0-9_]+$/.test(tail)) return value;
  const words = tail.toLowerCase().split('_').filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

/** LinkedIn stores proficiency as an enum; expose its own display wording. */
const PROFICIENCY: Record<string, string> = {
  NATIVE_OR_BILINGUAL: 'Native or bilingual proficiency',
  FULL_PROFESSIONAL: 'Full professional proficiency',
  PROFESSIONAL_WORKING: 'Professional working proficiency',
  LIMITED_WORKING: 'Limited working proficiency',
  ELEMENTARY: 'Elementary proficiency',
};

function humanizeProficiency(value: string | null): string | null {
  if (!value) return null;
  return PROFICIENCY[value] ?? humanizeEnum(value);
}

export { humanizeEnum, humanizeProficiency };
