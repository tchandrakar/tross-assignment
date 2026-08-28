import type { FastifyBaseLogger } from 'fastify';
import { ApiError } from '../errors.js';
import type { Identity, IdentityPool } from '../identity/pool.js';
import type { Profile, ScrapeSource } from '../schema/profile.js';
import { profileSchema } from '../schema/profile.js';
import { normalize, resolveGraph } from './normalize.js';
import type { HttpSessionManager } from './http/session.js';
import { dashProfileByVanityPath, profileViewPath, publicProfileUrl } from './endpoints.js';
import { parseProfileView } from './parse/profile-view.js';
import { parseDashProfile } from './parse/dash-profile.js';
import { parsePublicProfile } from './parse/public-profile.js';
import { fetchPublicProfile } from './http/public.js';
import { isObject, num, pick, str } from './parse/common.js';

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
/**
 * How a Voyager request is made. One implementation today — plain HTTP — but the
 * seam is kept because the strategy chain below is written against it, and a
 * second source (a replay fixture, a different endpoint family) slots in without
 * touching the parsers.
 */
export interface Transport {
  readonly source: ScrapeSource;
  fetch(path: string, identity: Identity, publicId: string): Promise<unknown>;
}

/**
 * The only transport: direct HTTP calls to LinkedIn's Voyager endpoints.
 *
 * No browser is involved anywhere in this service. What makes that viable is
 * covered in http/client.ts (TLS, HTTP/2 and header shaping) and
 * http/cookie-jar.ts (following session-token rotation).
 */
export class HttpTransport implements Transport {
  readonly source = 'voyager-dash' as const;

  constructor(private readonly sessions: HttpSessionManager) {}

  async fetch(path: string, identity: Identity, publicId: string): Promise<unknown> {
    const response = await this.sessions.fetchVoyager(identity, path, publicProfileUrl(publicId));
    try {
      return response.body ? JSON.parse(response.body) : null;
    } catch {
      throw new ApiError('PARSE_FAILED', `LinkedIn returned a non-JSON body for ${path}.`, {
        details: { status: response.status, preview: response.body.slice(0, 200) },
      });
    }
  }
}

interface Strategy {
  name: ScrapeSource;
  run(publicId: string): Promise<ScrapeResult>;
}

/**
 * Runs extraction strategies in order; the first to return a profile with a
 * name wins.
 *
 *   1. voyager-dash        the dash profile graph. One request returns the whole
 *                          profile — positions, education, skills, certifications,
 *                          languages — addressed by decorationId rather than a
 *                          rotating GraphQL queryId.
 *   2. voyager-profile-view legacy REST. Returned every section in one call and
 *                          took no queryId. Withdrawn upstream (410 Gone), kept
 *                          because it costs one request to try and 410 is
 *                          unambiguous.
 *
 * Failure handling distinguishes three cases, and the distinction is
 * load-bearing:
 *   - blocked (999/429/403/401) → abort. Trying another strategy with an
 *     identity LinkedIn just flagged only deepens the block.
 *   - endpoint withdrawn (410)  → fall through at once; the identity is healthy.
 *   - parse failure             → fall through to the next strategy.
 */
export class ProfileScraper {
  private readonly transport: HttpTransport;

  constructor(
    private readonly pool: IdentityPool,
    private readonly logger: FastifyBaseLogger,
    private readonly sessions: HttpSessionManager,
    /** Whether to fall back to the unauthenticated public page. */
    private readonly enablePublicFallback = true,
  ) {
    this.transport = new HttpTransport(sessions);
  }

  async scrape(publicId: string): Promise<ScrapeResult> {
    const strategies: Strategy[] = [
      { name: 'voyager-dash', run: (id) => this.viaDash(id, this.transport) },
      { name: 'voyager-profile-view', run: (id) => this.viaProfileView(id) },
    ];

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
            this.logger.debug({ strategy: strategy.name }, 'endpoint withdrawn upstream, falling through');
            failures.push(`${strategy.name}: retired (410)`);
            continue;
          }

          if (error.code === 'UPSTREAM_BLOCKED' || error.code === 'AUTH_FAILED') {
            this.logger.warn({ strategy: strategy.name, code: error.code }, 'blocked upstream, aborting authenticated strategies');

            // The public page needs no session, so it is still worth trying
            // when the authenticated path is unavailable. Reduced data beats no
            // answer, and meta.source says which the caller got.
            if (this.enablePublicFallback) {
              try {
                const fallback = await this.viaPublicPage(publicId);
                this.logger.info({ publicId }, 'served reduced data from the public page');
                return fallback;
              } catch (fallbackError) {
                this.logger.warn({ err: fallbackError, publicId }, 'public fallback also failed');
              }
            }

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
    return this.pool.run(async (identity) => {
      const body = await transport
        .fetch(dashProfileByVanityPath(publicId), identity, publicId)
        .catch(async (error: unknown) => {
          // A dead session's persisted state must be discarded, or every retry
          // replays the same dead token.
          if (error instanceof ApiError && error.code === 'AUTH_FAILED') {
            await this.sessions.invalidate(identity);
          }
          throw error;
        });

      const { data, index, included } = normalize(body);

      // The response is a Rest.li CollectionResponse whose single element is
      // the Profile. Fall back to scanning `included` if the shape shifts.
      const record =
        (pick(data, 'elements.0') as unknown) ??
        (() => {
          const raw = included.find(
            (e) => typeof e.$type === 'string' && (e.$type as string).endsWith('identity.profile.Profile'),
          );
          return raw ? resolveGraph(raw, index) : undefined;
        })();

      if (!isObject(record)) {
        throw new ApiError('PROFILE_NOT_FOUND', 'LinkedIn returned no profile record for that identifier.');
      }

      const { profile, missingSections } = parseDashProfile(record);

      return {
        source: transport.source,
        missingSections,
        profile: profileSchema.parse({
          ...profile,
          // Prefer LinkedIn's own identifier: it is authoritative if the caller
          // used a stale vanity name that redirected.
          publicId: str(pick(record, 'publicIdentifier')) ?? publicId,
          profileUrl: publicProfileUrl(str(pick(record, 'publicIdentifier')) ?? publicId),
        }),
      };
    });
  }

  // ─── Legacy profileView ────────────────────────────────────────────────────

  /**
   * Reads the public profile page with no session at all.
   *
   * Deliberately last, and deliberately marked: LinkedIn masks most free text
   * for logged-out viewers, so this returns a fraction of the authenticated
   * response. `meta.source` is `public` and `meta.missingSections` lists what
   * is unavailable, so a consumer is never misled into treating reduced data as
   * complete.
   */
  private async viaPublicPage(publicId: string): Promise<ScrapeResult> {
    const html = await fetchPublicProfile(publicId);
    const parsed = parsePublicProfile(html);

    if (!parsed) {
      throw new ApiError('PARSE_FAILED', 'The public profile page carried no structured profile data.', {
        details: { publicId },
      });
    }

    if (parsed.maskedFields.length > 0) {
      this.logger.debug({ publicId, masked: parsed.maskedFields.length }, 'public page masked fields for logged-out viewing');
    }

    return {
      source: 'public',
      missingSections: [...new Set([...parsed.missingSections, ...parsed.maskedFields])],
      profile: profileSchema.parse({
        ...parsed.profile,
        publicId,
        profileUrl: publicProfileUrl(publicId),
      }),
    };
  }

  private async viaProfileView(publicId: string): Promise<ScrapeResult> {
    return this.pool.run(async (identity) => {
      // Goes through the same authenticated transport as everything else. An
      // earlier revision used a separate client that carried no cookie jar,
      // so this strategy 403'd and — because a block aborts the chain — took
      // the whole request down with it.
      const body = await this.transport.fetch(profileViewPath(publicId), identity, publicId);
      const { data } = normalize(body);
      const { profile, missingSections } = parseProfileView(data);

      return {
        source: 'voyager-profile-view' as const,
        missingSections,
        profile: profileSchema.parse({
          ...profile,
          publicId,
          profileUrl: publicProfileUrl(publicId),
        }),
      };
    });
  }
}
