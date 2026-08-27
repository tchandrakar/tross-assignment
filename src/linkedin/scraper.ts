import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../errors.js';
import type { Identity, IdentityPool } from '../identity/pool.js';
import type { Profile, ScrapeSource } from '../schema/profile.js';
import { profileSchema } from '../schema/profile.js';
import { VoyagerClient } from './voyager-client.js';
import { normalize } from './normalize.js';
import type { BrowserSession } from '../browser/session.js';
import {
  dashProfileByVanityPath, profileCardsPath, profileNetworkInfoPath, profileViewPath, publicProfileUrl,
} from './endpoints.js';
import { parseProfileView } from './parse/profile-view.js';
import {
  collectEntities, entityToCertification, entityToEducation, entityToExperience,
  entityToHonor, entityToLanguage, entityToProject, entityToPublication, entityToSkill,
  entityToVolunteer, type CardEntity,
} from './parse/dash-cards.js';
import { attributedText, get, isObject, num, parseVectorImage, pick, str } from './parse/common.js';

export interface ScrapeResult {
  profile: Profile;
  source: ScrapeSource;
  missingSections: string[];
}

/**
 * How a Voyager request gets made. The two implementations differ only in
 * transport — raw HTTP versus a fetch issued from inside a real authenticated
 * Chromium page — so every parser and every extraction routine is shared.
 */
export interface Transport {
  readonly source: ScrapeSource;
  /**
   * `publicId` is the profile being scraped. The browser transport uses it to
   * land on that profile's page before issuing in-page calls, so one navigation
   * both establishes the session and puts us on a same-origin, on-topic page.
   */
  fetch(path: string, identity: Identity, publicId: string): Promise<unknown>;
}

export class HttpTransport implements Transport {
  readonly source = 'voyager-graphql' as const;
  constructor(private readonly client: VoyagerClient) {}
  async fetch(path: string, identity: Identity): Promise<unknown> {
    return (await this.client.get({ path, identity })).body;
  }

}

export class BrowserTransport implements Transport {
  readonly source = 'browser-voyager' as const;
  constructor(private readonly session: BrowserSession) {}
  async fetch(path: string, identity: Identity, publicId: string): Promise<unknown> {
    return (await this.session.fetchVoyager(identity, path, publicProfileUrl(publicId))).body;
  }
}

interface Strategy {
  name: ScrapeSource;
  run(publicId: string): Promise<ScrapeResult>;
}

/**
 * Runs extraction strategies in order and stops at the first that returns a
 * profile with a name on it.
 *
 *   1. browser-voyager      — Voyager API called from inside a real browser page.
 *                             Same JSON, same parsers; the transport carries
 *                             Chrome's true TLS fingerprint and cookie jar.
 *   2. voyager-graphql      — the same dash calls over raw HTTP. Faster and much
 *                             cheaper, but far easier for LinkedIn to fingerprint.
 *   3. voyager-profile-view — legacy REST. 410 Gone as of 2026-08; kept because
 *                             it costs one call and is the richest single response
 *                             wherever it still works.
 *   4. browser              — harvest payloads from the rendered profile page.
 *
 * Failure handling distinguishes three cases, and the distinction is
 * load-bearing:
 *   - blocked (999/429/403/401) → abort the chain. Trying another strategy on an
 *     identity LinkedIn just flagged only deepens the block.
 *   - endpoint retired (410)    → fall through at once; the identity is healthy.
 *   - parse failure             → fall through to the next strategy.
 */
export class ProfileScraper {
  private readonly client: VoyagerClient;
  private readonly httpTransport: HttpTransport;
  private readonly browserTransport: BrowserTransport | null;

  constructor(
    private readonly pool: IdentityPool,
    private readonly logger: FastifyBaseLogger,
    private readonly browser: BrowserSession | null,
    private readonly enableHttpTransport = false,
  ) {
    this.client = new VoyagerClient(pool);
    this.httpTransport = new HttpTransport(this.client);
    this.browserTransport = browser ? new BrowserTransport(browser) : null;
  }

  async scrape(publicId: string): Promise<ScrapeResult> {
    const strategies: Strategy[] = [];

    if (this.browserTransport) {
      strategies.push({ name: 'browser-voyager', run: (id) => this.viaDash(id, this.browserTransport!) });
    }
    // Raw HTTP is opt-in: it makes the same calls, but LinkedIn fingerprints
    // the client and answers by killing the session. See config.ENABLE_HTTP_TRANSPORT.
    if (this.enableHttpTransport) {
      strategies.push(
        { name: 'voyager-graphql', run: (id) => this.viaDash(id, this.httpTransport) },
        { name: 'voyager-profile-view', run: (id) => this.viaProfileView(id) },
      );
    }
    if (this.browser) {
      strategies.push({ name: 'browser', run: (id) => this.viaRenderedPage(id) });
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
          if (error.code === 'PROFILE_NOT_FOUND' || error.code === 'NO_IDENTITY_AVAILABLE') throw error;

          if (error.code === 'ENDPOINT_RETIRED') {
            this.logger.debug({ strategy: strategy.name }, 'endpoint retired by LinkedIn, falling through');
            failures.push(`${strategy.name}: retired (410)`);
            continue;
          }

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

  // ─── Dash profile + cards, over either transport ───────────────────────────

  private async viaDash(publicId: string, transport: Transport): Promise<ScrapeResult> {
    return this.client.withIdentity(async (identity) => {
      const body = await transport
        .fetch(dashProfileByVanityPath(publicId), identity, publicId)
        .catch(async (error: unknown) => {
          // A dead session's persisted state must be discarded, or every retry
          // replays the same dead token.
          if (error instanceof ApiError && error.code === 'AUTH_FAILED') {
            await this.browser?.invalidate(identity);
          }
          throw error;
        });
      const { data: dashData, included } = normalize(body);

      const record =
        (pick(dashData, 'elements.0') as unknown) ??
        included.find((e) => typeof e.$type === 'string' && (e.$type as string).endsWith('identity.profile.Profile'));

      if (!isObject(record)) {
        throw new ApiError('PROFILE_NOT_FOUND', 'LinkedIn returned no profile record for that identifier.');
      }

      const base = this.parseTopCard(record, publicId);
      const sections = await this.fetchCards(publicId, identity, transport);

      return {
        source: transport.source,
        missingSections: sections.missing,
        profile: profileSchema.parse({ ...base, ...sections.parsed }),
      };
    });
  }

  private parseTopCard(record: Record<string, unknown>, publicId: string) {
    const firstName = str(pick(record, 'firstName'));
    const lastName = str(pick(record, 'lastName'));
    const headline = str(pick(record, 'headline'));

    return {
      publicId,
      profileUrl: publicProfileUrl(publicId),
      urn: str(pick(record, 'entityUrn', 'dashEntityUrn')),
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || null,
      headline,
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
      isOpenToWork: get(record, 'profileOpenToWorkCard') != null || /open to work/i.test(headline ?? ''),
      isHiring: /hiring/i.test(headline ?? ''),
      profilePicture: parseVectorImage(pick(record, 'profilePicture.displayImageReference.vectorImage', 'profilePicture')),
      backgroundImage: parseVectorImage(
        pick(record, 'backgroundImage.displayImageReference.vectorImage', 'backgroundPicture', 'backgroundImage'),
      ),
    };
  }

  private async fetchCards(publicId: string, identity: Identity, transport: Transport) {
    const empty = {
      experience: [], education: [], skills: [], certifications: [],
      languages: [], projects: [], publications: [], honors: [], volunteering: [],
    };

    let cards: unknown;
    try {
      cards = normalize(await transport.fetch(profileCardsPath(publicId), identity, publicId)).data;
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'UPSTREAM_BLOCKED' || error.code === 'AUTH_FAILED')) throw error;
      this.logger.warn({ err: error, publicId }, 'profile cards fetch failed; returning top-card data only');
      return { parsed: empty, missing: Object.keys(empty) };
    }

    return parseCards(cards);
  }

  // ─── Legacy profileView ────────────────────────────────────────────────────

  private async viaProfileView(publicId: string): Promise<ScrapeResult> {
    return this.client.withIdentity(async (identity) => {
      const response = await this.client.get({ path: profileViewPath(publicId), identity });
      const { data } = normalize(response.body);
      const { profile, missingSections } = parseProfileView(data);

      // profileView omits network counts. Failure here must not fail the scrape.
      // (This endpoint is also 410 as of 2026-08 — counts come from dash instead.)
      let connectionCount: number | null = null;
      let followerCount: number | null = null;
      try {
        const network = normalize((await this.client.get({ path: profileNetworkInfoPath(publicId), identity })).body).data;
        connectionCount = num(pick(network, 'connectionsCount', 'connections.paging.total'));
        followerCount = num(pick(network, 'followersCount', 'followerCount'));
      } catch (error) {
        this.logger.debug({ err: error, publicId }, 'networkinfo lookup failed; counts will be null');
      }

      return {
        source: 'voyager-profile-view' as const,
        missingSections,
        profile: profileSchema.parse({
          ...profile,
          publicId,
          profileUrl: publicProfileUrl(publicId),
          connectionCount,
          followerCount,
        }),
      };
    });
  }

  // ─── Rendered page harvest ─────────────────────────────────────────────────

  private async viaRenderedPage(publicId: string): Promise<ScrapeResult> {
    if (!this.browser) throw new ApiError('PARSE_FAILED', 'Browser fallback is disabled.');

    return this.client.withIdentity(async (identity) => {
      const payloads = await this.browser!.collectRenderedPayloads(identity, publicId);
      return selectBestPayload(payloads, publicId, this.logger);
    });
  }
}

// ─── Card grouping ───────────────────────────────────────────────────────────

/**
 * Cards identify their section through an urn that names it, e.g.
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

export function groupCardsBySection(cards: unknown): Map<string, CardEntity[]> {
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

export function parseCards(cards: unknown) {
  const grouped = groupCardsBySection(cards);
  const missing: string[] = [];

  const take = <T>(key: string, mapper: (e: CardEntity) => T): T[] => {
    const entities = grouped.get(key) ?? [];
    if (entities.length === 0) missing.push(key);
    return entities.map(mapper);
  };

  const experienceEntities = grouped.get('experience') ?? [];
  if (experienceEntities.length === 0) missing.push('experience');

  return {
    missing,
    parsed: {
      experience: experienceEntities.flatMap(flattenRoles),
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

/**
 * LinkedIn groups several roles at the same employer under one company entity:
 * the outer entity carries the company (and combined tenure), each child a job
 * title. Flatten those into standalone records so a caller never has to know
 * about the nesting — the child's title wins, the parent's company is inherited.
 */
export function flattenRoles(entity: CardEntity): ReturnType<typeof entityToExperience>[] {
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

// ─── Rendered-payload selection ──────────────────────────────────────────────

/**
 * Payloads harvested from a rendered page arrive in arbitrary order and most
 * are unrelated (nav, ads, messaging), so score rather than assume.
 */
export function selectBestPayload(payloads: unknown[], publicId: string, logger: FastifyBaseLogger): ScrapeResult {
  let best: { score: number; result: ScrapeResult } | null = null;

  for (const payload of payloads) {
    let data: unknown;
    try {
      data = normalize(payload).data;
    } catch {
      continue;
    }

    const candidate = looksLikeProfileView(data) ? data : looksLikeProfileView(payload) ? payload : null;
    if (!candidate) continue;

    try {
      const { profile, missingSections } = parseProfileView(candidate);
      const parsed = profileSchema.parse({ ...profile, publicId, profileUrl: publicProfileUrl(publicId) });

      const score =
        (parsed.fullName ? 4 : 0) + parsed.experience.length + parsed.education.length + parsed.skills.length;

      if (!best || score > best.score) {
        best = { score, result: { profile: parsed, source: 'browser', missingSections } };
      }
    } catch {
      continue;
    }
  }

  if (!best || best.score === 0) {
    throw new ApiError('PARSE_FAILED', 'The rendered page contained no recognisable profile payload.', {
      details: { publicId, payloadsInspected: payloads.length },
    });
  }

  logger.debug({ publicId, score: best.score }, 'selected best rendered payload');
  return best.result;
}

function looksLikeProfileView(data: unknown): boolean {
  return isObject(data) && ('positionView' in data || 'educationView' in data || 'profile' in data);
}
