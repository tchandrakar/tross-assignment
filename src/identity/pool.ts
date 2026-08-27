import { createHash, randomUUID } from 'node:crypto';
import type { Dispatcher } from 'undici';
import type { AppConfig, IdentityConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { getDispatcher, redactProxy, renderStickyProxy } from './proxy.js';

/**
 * The rotator.
 *
 * The unit of rotation is an *identity* — a LinkedIn session cookie married to
 * a fixed egress IP — not an IP on its own. Rotating IPs underneath a single
 * cookie is what gets accounts checkpointed, so the pairing is permanent for
 * the lifetime of the process.
 *
 * Each identity carries health state. A block (HTTP 999 / 429 / 403) puts it
 * into a cooldown that grows exponentially with consecutive failures; enough
 * consecutive failures quarantines it outright so we stop burning a cookie
 * that LinkedIn has already flagged.
 */

const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 60 * 60_000;
const QUARANTINE_AFTER_FAILURES = 5;

export type IdentityState = 'available' | 'cooling-down' | 'quarantined';

export interface Identity {
  readonly id: string;
  readonly label: string;
  readonly liAt: string;
  readonly jsessionId: string;
  /** CSRF token LinkedIn expects — literally the JSESSIONID with quotes stripped. */
  readonly csrfToken: string;
  readonly proxyUrl: string | undefined;
  readonly dispatcher: Dispatcher;
  /** Stable per-identity session id handed to sticky-session proxy providers. */
  readonly stickySessionId: string;

  consecutiveFailures: number;
  cooldownUntil: number;
  quarantined: boolean;
  totalRequests: number;
  totalFailures: number;
  lastUsedAt: number;
}

export interface IdentityHealth {
  label: string;
  state: IdentityState;
  proxy: string;
  totalRequests: number;
  totalFailures: number;
  consecutiveFailures: number;
  cooldownSecondsRemaining: number;
}

export class IdentityPool {
  private readonly identities: Identity[];
  private cursor = 0;

  constructor(config: AppConfig) {
    this.identities = config.identities.map((cfg, index) =>
      buildIdentity(cfg, index, config),
    );
  }

  get size(): number {
    return this.identities.length;
  }

  /**
   * Least-recently-used among healthy identities, so load spreads evenly
   * instead of hammering whichever one happens to be first.
   */
  acquire(): Identity {
    if (this.identities.length === 0) {
      throw new ApiError(
        'NO_IDENTITY_AVAILABLE',
        'No LinkedIn identity is configured. Set LINKEDIN_IDENTITIES (or LI_AT + LI_JSESSIONID).',
      );
    }

    const now = Date.now();
    const healthy = this.identities.filter((i) => !i.quarantined && i.cooldownUntil <= now);

    if (healthy.length === 0) {
      const soonest = this.identities
        .filter((i) => !i.quarantined)
        .reduce<number | null>((min, i) => (min === null || i.cooldownUntil < min ? i.cooldownUntil : min), null);

      const retryAfterSeconds = soonest ? Math.max(1, Math.ceil((soonest - now) / 1000)) : undefined;
      const allQuarantined = this.identities.every((i) => i.quarantined);

      throw new ApiError(
        'NO_IDENTITY_AVAILABLE',
        allQuarantined
          ? 'Every configured LinkedIn identity has been quarantined after repeated blocks. The session cookies likely need to be refreshed.'
          : 'All LinkedIn identities are cooling down after being rate-limited upstream.',
        { retryAfterSeconds, details: { poolSize: this.identities.length } },
      );
    }

    healthy.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    const chosen = healthy[0]!;
    this.cursor = (this.cursor + 1) % this.identities.length;
    chosen.lastUsedAt = now;
    chosen.totalRequests += 1;
    return chosen;
  }

  reportSuccess(identity: Identity): void {
    identity.consecutiveFailures = 0;
    identity.cooldownUntil = 0;
  }

  /**
   * @param blocked true for signals that mean "LinkedIn pushed back on this
   * identity" (999/429/403). Transient network errors don't warrant a cooldown.
   */
  reportFailure(identity: Identity, blocked: boolean): void {
    identity.totalFailures += 1;
    if (!blocked) return;

    identity.consecutiveFailures += 1;

    const backoff = Math.min(
      BASE_COOLDOWN_MS * 2 ** (identity.consecutiveFailures - 1),
      MAX_COOLDOWN_MS,
    );
    // Jitter stops a multi-instance deployment from retrying in lockstep.
    const jitter = backoff * 0.2 * Math.random();
    identity.cooldownUntil = Date.now() + backoff + jitter;

    if (identity.consecutiveFailures >= QUARANTINE_AFTER_FAILURES) {
      identity.quarantined = true;
    }
  }

  /** Manual recovery hook — exposed via the admin health endpoint. */
  release(label?: string): number {
    let released = 0;
    for (const identity of this.identities) {
      if (label && identity.label !== label) continue;
      identity.quarantined = false;
      identity.cooldownUntil = 0;
      identity.consecutiveFailures = 0;
      released += 1;
    }
    return released;
  }

  health(): IdentityHealth[] {
    const now = Date.now();
    return this.identities.map((i) => ({
      label: i.label,
      state: i.quarantined ? 'quarantined' : i.cooldownUntil > now ? 'cooling-down' : 'available',
      proxy: redactProxy(i.proxyUrl),
      totalRequests: i.totalRequests,
      totalFailures: i.totalFailures,
      consecutiveFailures: i.consecutiveFailures,
      cooldownSecondsRemaining: Math.max(0, Math.ceil((i.cooldownUntil - now) / 1000)),
    }));
  }
}

function buildIdentity(cfg: IdentityConfig, index: number, config: AppConfig): Identity {
  // Derived from the cookie so the same identity keeps the same sticky IP
  // across restarts — a fresh random id every deploy would defeat the point.
  const stickySessionId = createHash('sha256')
    .update(cfg.liAt)
    .digest('hex')
    .slice(0, 12);

  const proxyUrl = resolveProxyUrl(cfg, index, config, stickySessionId);

  return {
    id: randomUUID(),
    label: cfg.label || `identity-${index + 1}`,
    liAt: cfg.liAt,
    jsessionId: cfg.jsessionId,
    csrfToken: cfg.jsessionId.replaceAll('"', ''),
    proxyUrl,
    dispatcher: getDispatcher(proxyUrl),
    stickySessionId,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    quarantined: false,
    totalRequests: 0,
    totalFailures: 0,
    lastUsedAt: 0,
  };
}

function resolveProxyUrl(
  cfg: IdentityConfig,
  index: number,
  config: AppConfig,
  stickySessionId: string,
): string | undefined {
  // Precedence: explicit per-identity proxy → sticky template → round-robin list → direct.
  if (cfg.proxy) return cfg.proxy;
  if (config.proxyStickyTemplate) return renderStickyProxy(config.proxyStickyTemplate, stickySessionId);
  if (config.proxyUrls.length > 0) return config.proxyUrls[index % config.proxyUrls.length];
  return undefined;
}
