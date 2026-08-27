import { type CacheEntry, type CachedProfile, type ProfileCache, toCacheEntry } from './store.js';

/**
 * In-process fallback used when no GCS bucket is configured. Fine for local
 * development; useless on Cloud Run beyond a single container, which is exactly
 * why the deployed configuration sets GCS_BUCKET.
 */
export class MemoryProfileCache implements ProfileCache {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, CachedProfile>();

  constructor(private readonly maxEntries = 500) {}

  async get(publicId: string): Promise<CacheEntry | null> {
    const cached = this.entries.get(publicId);
    if (!cached) return null;
    // Refresh LRU position.
    this.entries.delete(publicId);
    this.entries.set(publicId, cached);
    return toCacheEntry(cached);
  }

  async set(entry: CachedProfile): Promise<void> {
    this.entries.delete(entry.publicId);
    this.entries.set(entry.publicId, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async delete(publicId: string): Promise<boolean> {
    return this.entries.delete(publicId);
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
