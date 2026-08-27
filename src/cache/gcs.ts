import { Storage, type Bucket } from '@google-cloud/storage';
import { CACHE_SCHEMA_VERSION, type CacheEntry, type CachedProfile, type ProfileCache, toCacheEntry } from './store.js';

/**
 * Blob-storage cache. One JSON object per profile, keyed by public identifier:
 *
 *   gs://<bucket>/<prefix><publicId>.json
 *
 * Chosen over a database deliberately — the access pattern is a pure key/value
 * get-or-scrape, there is no query surface, and Cloud Run scales to zero, so a
 * bucket costs nothing when idle and needs no connection pool on cold start.
 *
 * Every write also stamps GCS custom metadata so the bucket can be audited
 * (and lifecycle-expired) without reading object bodies.
 */
export class GcsProfileCache implements ProfileCache {
  readonly kind = 'gcs' as const;
  private readonly bucket: Bucket;

  constructor(
    bucketName: string,
    private readonly prefix: string,
    storage: Storage = new Storage(),
  ) {
    this.bucket = storage.bucket(bucketName);
  }

  private objectPath(publicId: string): string {
    // publicId is already validated against a strict charset upstream, but
    // encode anyway so a stray separator can never escape the prefix.
    return `${this.prefix}${encodeURIComponent(publicId)}.json`;
  }

  async get(publicId: string): Promise<CacheEntry | null> {
    const file = this.bucket.file(this.objectPath(publicId));
    try {
      const [buffer] = await file.download();
      const parsed = JSON.parse(buffer.toString('utf8')) as CachedProfile;
      if (typeof parsed?.scrapedAt !== 'string' || !parsed.profile) return null;
      return toCacheEntry(parsed);
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 404) return null;
      throw error;
    }
  }

  async set(entry: CachedProfile): Promise<void> {
    const file = this.bucket.file(this.objectPath(entry.publicId));
    await file.save(JSON.stringify(entry), {
      contentType: 'application/json',
      resumable: false,
      metadata: {
        cacheControl: 'no-store',
        metadata: {
          publicId: entry.publicId,
          scrapedAt: entry.scrapedAt,
          source: entry.source,
          schemaVersion: String(CACHE_SCHEMA_VERSION),
        },
      },
    });
  }

  async delete(publicId: string): Promise<boolean> {
    try {
      await this.bucket.file(this.objectPath(publicId)).delete();
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 404) return false;
      throw error;
    }
  }

  /**
   * Probes an object rather than the bucket. `bucket.exists()` requires
   * `storage.buckets.get`, which `roles/storage.objectAdmin` does not grant —
   * so a correctly least-privileged service account reported the cache as
   * unhealthy while reads and writes worked perfectly.
   *
   * A 404 on a nonexistent object is a healthy answer: it proves we can reach
   * the bucket and are authorised to read it.
   */
  async healthy(): Promise<boolean> {
    try {
      await this.bucket.file(`${this.prefix}.healthcheck`).exists();
      return true;
    } catch {
      return false;
    }
  }
}
