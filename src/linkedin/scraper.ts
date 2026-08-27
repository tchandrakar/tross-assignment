import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../errors.js';
import type { Identity, IdentityPool } from '../identity/pool.js';
import type { Profile, ScrapeSource } from '../schema/profile.js';
import { profileSchema } from '../schema/profile.js';
import { VoyagerClient } from './voyager-client.js';
import { normalize } from './normalize.js';
import {
  dashProfileByVanityPath, profileCardsPath, profileNetworkInfoPath, profileViewPath,
} from './endpoints.js';
import { parseProfileView } from './parse/profile-view.js';
import {
  collectEntities, entityToCertification, entityToEducation, entityToExperience,
  entityToHonor, entityToLanguage, entityToProject, entityToPublication, entityToSkill,
  entityToVolunteer, type CardEntity,
} from './parse/dash-cards.js';
import { attributedText, get, isObject, num, parseCountText, parseVectorImage, pick, str } from './parse/common.js';

export interface ScrapeResult {
  profile: Profile;
  source: ScrapeSource;
  missingSections: string[];
}

interface Strategy {
  name: ScrapeSource;
  run(publicId: string): Promise<ScrapeResult>;
}

/**
 * Runs the extraction strategies in order of decreasing reliability and stops
 * at the first one that returns a profile with a name on it.
 *
 *   1. profileView   — legacy REST, one call, complete, no rotating queryId
 *   2. dash GraphQL  — what the current web client uses; survives when (1) is off
 *   3. browser       — headless Playwright against the rendered page (opt-in)
 *
 * A strategy that gets *blocked* aborts the chain — trying the next strategy on
 * an identity LinkedIn just flagged only deepens the block. A strategy that
 * merely fails to parse falls through to the next one.
 */
export class ProfileScraper {
  private readonly client: VoyagerClient;

  constructor(
    private readonly pool: IdentityPool,
    private readonly logger: FastifyBaseLogger,
    private readonly browserFallback: ((publicId: string) => Promise<ScrapeResult>) | null,
  ) {
    this.client = new VoyagerClient(pool);
  }

  async scrape(publicId: string): Promise<ScrapeResult> {
    const strategies: Strategy[] = [
      { name: 'voyager-profile-view', run: (id) => this.viaProfileView(id) },
      { name: 'voyager-graphql', run: (id) => this.viaDashCards(id) },
    ];

    if (this.browserFallback) {
      strategies.push({ name: 'browser', run: (id) => this.browserFallback!(id) });
    }

    const failures: string[] = [];

    for (const strategy of strategies) {
      try {
        const result = await strategy.run(publicId);
        if (!result.profile.fullName && result.profile.experience.length === 0) {
          failures.push(`${strategy.name}: returned an empty profile`);
          this.logger.warn({ strategy: strategy.name, publicId }, 'strategy returned empty profile, trying next');
          continue;
        }
        this.logger.info({ strategy: strategy.name, publicId }, 'profile extracted');
        return result;
      } catch (error) {
        if (error instanceof ApiError) {
          // Terminal outcomes — no later strategy can do better.
          if (error.code === 'PROFILE_NOT_FOUND' || error.code === 'NO_IDENTITY_AVAILABLE') throw error;
          if (error.code === 'UPSTREAM_BLOCKED' || error.code === 'AUTH_FAILED') {
            this.logger.warn({ strategy: strategy.name, code: error.code }, 'blocked upstream, aborting strategy chain');
            throw error;
          }
          failures.push(`${strategy.name}: ${error.code}`);
        } else {
          failures.push(`${strategy.name}: ${(error as Error).message}`);
        }
        this.logger.warn({ strategy: strategy.name, err: error }, 'strategy failed, trying next');
      }
    }

    throw new ApiError('PARSE_FAILED', 'Every extraction strategy failed for this profile.', {
      details: { publicId, attempts: failures },
    });
  }

  // ─── Strategy 1: legacy profileView ────────────────────────────────────────

  private async viaProfileView(publicId: string): Promise<ScrapeResult> {
    return this.client.withIdentity(async (identity) => {
      const response = await this.client.get({ path: profileViewPath(publicId), identity });
      const { data } = normalize(response.body);

      const { profile, missingSections } = parseProfileView(data);

      // profileView omits network counts, so top them up with a cheap second
      // call. A failure here must not fail the whole scrape.
      let connectionCount: number | null = null;
      let followerCount: number | null = null;
      try {
        const network = await this.client.get({ path: profileNetworkInfoPath(publicId), identity });
        const networkData = normalize(network.body).data;
        connectionCount = num(pick(networkData, 'connectionsCount', 'connections.paging.total'));
        followerCount = num(pick(networkData, 'followersCount', 'followerCount'));
      } catch (error) {
        this.logger.debug({ err: error, publicId }, 'networkinfo lookup failed; counts will be null');
      }

      return {
        source: 'voyager-profile-view' as const,
        missingSections,
        profile: profileSchema.parse({
          ...profile,
          publicId,
          profileUrl: `https://www.linkedin.com/in/${publicId}/`,
          connectionCount,
          followerCount,
        }),
      };
    });
  }

  // ─── Strategy 2: dash profile + GraphQL cards ──────────────────────────────

  private async viaDashCards(publicId: string): Promise<ScrapeResult> {
    return this.client.withIdentity(async (identity) => {
      const dashResponse = await this.client.get({ path: dashProfileByVanityPath(publicId), identity });
      const { data: dashData, included } = normalize(dashResponse.body);

      const record =
        (pick(dashData, 'elements.0') as unknown) ??
        included.find((e) => typeof e.$type === 'string' && (e.$type as string).endsWith('identity.profile.Profile'));

      if (!isObject(record)) {
        throw new ApiError('PROFILE_NOT_FOUND', 'LinkedIn returned no profile record for that identifier.');
      }

      const urn = str(pick(record, 'entityUrn', 'dashEntityUrn'));
      const firstName = str(pick(record, 'firstName'));
      const lastName = str(pick(record, 'lastName'));

      const base = {
        publicId,
        profileUrl: `https://www.linkedin.com/in/${publicId}/`,
        urn,
        firstName,
        lastName,
        fullName: [firstName, lastName].filter(Boolean).join(' ') || null,
        headline: str(pick(record, 'headline')),
        about: attributedText(pick(record, 'summary')) ?? str(pick(record, 'summary')),
        location: {
          full: str(pick(record, 'geoLocation.geo.defaultLocalizedName', 'geoLocationName', 'locationName')),
          city: str(pick(record, 'geoLocation.geo.defaultLocalizedName'))?.split(',')[0]?.trim() ?? null,
          country: str(pick(record, 'geoCountry.defaultLocalizedName', 'geoCountryName')),
          countryCode: str(pick(record, 'location.countryCode'))?.toUpperCase()?.slice(0, 2) ?? null,
        },
        industry: str(pick(record, 'industry.name', 'industryName')),
        pronouns: str(pick(record, 'standardizedPronoun', 'customPronoun')),
        connectionCount: num(pick(record, 'connections.paging.total', 'connectionsCount')),
        followerCount: num(pick(record, 'followingState.followerCount', 'followerCount')),
        isPremium: pick(record, 'premium') === true,
        isInfluencer: pick(record, 'influencer') === true,
        isOpenToWork: get(record, 'profileOpenToWorkCard') != null || /open to work/i.test(str(pick(record, 'headline')) ?? ''),
        isHiring: /hiring/i.test(str(pick(record, 'headline')) ?? ''),
        profilePicture: parseVectorImage(pick(record, 'profilePicture.displayImageReference.vectorImage', 'profilePicture')),
        backgroundImage: parseVectorImage(
          pick(record, 'backgroundImage.displayImageReference.vectorImage', 'backgroundPicture', 'backgroundImage'),
        ),
      };

      const sections = await this.fetchCards(publicId, identity);

      return {
        source: 'voyager-graphql' as const,
        missingSections: sections.missing,
        profile: profileSchema.parse({ ...base, ...sections.parsed }),
      };
    });
  }

  private async fetchCards(publicId: string, identity: Identity) {
    const missing: string[] = [];
    const empty = {
      experience: [], education: [], skills: [], certifications: [],
      languages: [], projects: [], publications: [], honors: [], volunteering: [],
    };

    let cards: unknown;
    try {
      const response = await this.client.get({ path: profileCardsPath(publicId), identity });
      cards = normalize(response.body).data;
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'UPSTREAM_BLOCKED' || error.code === 'AUTH_FAILED')) throw error;
      this.logger.warn({ err: error, publicId }, 'profile cards fetch failed; returning top-card data only');
      return { parsed: empty, missing: Object.keys(empty) };
    }

    const grouped = groupCardsBySection(cards);

    const take = <T>(key: string, mapper: (e: CardEntity) => T): T[] => {
      const entities = grouped.get(key) ?? [];
      if (entities.length === 0) missing.push(key);
      return entities.map(mapper);
    };

    if ((grouped.get('experience') ?? []).length === 0) missing.push('experience');

    return {
      missing,
      parsed: {
        experience: (grouped.get('experience') ?? []).flatMap(flattenRoles),
        education: take('education', entityToEducation),
        skills: take('skills', entityToSkill).filter((s) => s.name.length > 0),
        certifications: take('certifications', entityToCertification),
        languages: take('languages', entityToLanguage).filter((l) => l.name.length > 0),
        projects: take('projects', entityToProject),
        publications: take('publications', entityToPublication),
        honors: take('honors', entityToHonor),
        volunteering: take('volunteering', entityToVolunteer),
      },
    };
  }
}

/**
 * Cards identify their section through a `*card`/`topComponents` urn that
 * contains the section name, e.g.
 *   urn:li:fsd_profileCard:(ACoAAB…,EXPERIENCE,en_US)
 */
const SECTION_ALIASES: Record<string, string> = {
  EXPERIENCE: 'experience',
  EDUCATION: 'education',
  SKILLS: 'skills',
  LICENSES_AND_CERTIFICATIONS: 'certifications',
  CERTIFICATIONS: 'certifications',
  LANGUAGES: 'languages',
  PROJECTS: 'projects',
  PUBLICATIONS: 'publications',
  HONORS_AND_AWARDS: 'honors',
  VOLUNTEERING_EXPERIENCE: 'volunteering',
};

function groupCardsBySection(cards: unknown): Map<string, CardEntity[]> {
  const grouped = new Map<string, CardEntity[]>();
  const elements = Array.isArray(get(cards, 'elements')) ? (get(cards, 'elements') as unknown[]) : [];

  for (const card of elements) {
    const urn = str(pick(card, 'entityUrn', 'cardUrn')) ?? '';
    const sectionKey = Object.keys(SECTION_ALIASES).find((k) => urn.includes(k));
    if (!sectionKey) continue;

    const section = SECTION_ALIASES[sectionKey]!;
    const entities = collectEntities(pick(card, 'topComponents', 'components'));
    grouped.set(section, [...(grouped.get(section) ?? []), ...entities]);
  }

  return grouped;
}

/**
 * LinkedIn groups several roles at the same employer under one company entity:
 * the outer entity carries the company (and its combined tenure), each child
 * carries a job title. Flatten those into standalone experience records so a
 * caller never has to know about the nesting — the child's title wins, the
 * parent's company is inherited.
 */
function flattenRoles(entity: CardEntity): ReturnType<typeof entityToExperience>[] {
  if (entity.children.length === 0) return [entityToExperience(entity)];

  const parent = entityToExperience(entity);
  // In the grouped layout the outer title is the company name, not a job title.
  const company = parent.company ?? entity.title;

  return entity.children.map((child) => {
    const role = entityToExperience(child);
    return {
      ...role,
      company: company ?? role.company,
      companyLinkedinUrl: role.companyLinkedinUrl ?? parent.companyLinkedinUrl,
      companyLogo: role.companyLogo ?? parent.companyLogo,
      // A nested role's subtitle holds the employment type, not the employer.
      employmentType: role.employmentType ?? (child.subtitle || null),
    };
  });
}

export { parseCountText };
