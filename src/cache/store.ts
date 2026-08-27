import type { Profile, ScrapeSource } from '../schema/profile.js';

/** What we persist per profile. Versioned so a schema change invalidates old blobs. */
export const CACHE_SCHEMA_VERSION = 1;

export interface CachedProfile {
  schemaVersion: number;
  publicId: string;
  scrapedAt: string;
  source: ScrapeSource;
  missingSections: string[];
  profile: Profile;
}

export interface CacheEntry extends CachedProfile {
  ageSeconds: number;
}

export interface ProfileCache {
  readonly kind: 'gcs' | 'memory';
  get(publicId: string): Promise<CacheEntry | null>;
  set(entry: CachedProfile): Promise<void>;
  delete(publicId: string): Promise<boolean>;
  healthy(): Promise<boolean>;
}

export function toCacheEntry(cached: CachedProfile): CacheEntry {
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(cached.scrapedAt)) / 1000));
  return { ...cached, ageSeconds };
}

/** A cached blob is usable only if it's the current schema and inside the TTL. */
export function isFresh(entry: CacheEntry, ttlSeconds: number): boolean {
  if (entry.schemaVersion !== CACHE_SCHEMA_VERSION) return false;
  if (ttlSeconds === 0) return true;
  return entry.ageSeconds < ttlSeconds;
}
