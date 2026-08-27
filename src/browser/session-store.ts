import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Storage } from '@google-cloud/storage';

/**
 * Persistence for a browser session's storage state (cookies + localStorage).
 *
 * This exists because of a property of LinkedIn's auth that is easy to miss and
 * expensive to get wrong: **`li_at` is rotated on use.** LinkedIn issues a new
 * session token as you browse and invalidates the previous one. So a scraper
 * that re-seeds a fresh browser context from a fixed, copied-once cookie jar is
 * replaying a superseded token on every run — which is exactly the signature of
 * a stolen cookie, and LinkedIn responds by killing the session outright
 * (`set-cookie: li_at=delete me`).
 *
 * Observed directly: a freshly-pasted cookie authenticated successfully, and
 * the same jar 401'd roughly a minute later from a new context — because the
 * first request had already rotated the token and the new value was thrown away
 * with the context.
 *
 * Persisting storage state fixes it at the root. The configured cookie jar is
 * only ever a *seed*, used once to bootstrap; from then on the stored state is
 * authoritative and rotation is followed rather than fought.
 */

export interface SessionStore {
  readonly kind: string;
  load(identityId: string): Promise<StorageState | null>;
  save(identityId: string, state: StorageState): Promise<void>;
  clear(identityId: string): Promise<void>;
}

/** Playwright's storageState shape — kept structural rather than importing it. */
export interface StorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
}

/** Local-disk store. Path is gitignored; the file contains a live session. */
export class FileSessionStore implements SessionStore {
  readonly kind = 'file' as const;

  constructor(private readonly directory: string) {}

  private path(identityId: string): string {
    return `${this.directory}/${encodeURIComponent(identityId)}.json`;
  }

  async load(identityId: string): Promise<StorageState | null> {
    try {
      const raw = await readFile(this.path(identityId), 'utf8');
      const parsed = JSON.parse(raw) as StorageState;
      // An empty jar is not a session — treat it as absent so the caller
      // re-establishes rather than making an unauthenticated request.
      return Array.isArray(parsed?.cookies) && parsed.cookies.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(identityId: string, state: StorageState): Promise<void> {
    const file = this.path(identityId);
    await mkdir(dirname(file), { recursive: true });
    // 0600: this file is equivalent to a logged-in session.
    await writeFile(file, JSON.stringify(state), { mode: 0o600 });
  }

  async clear(identityId: string): Promise<void> {
    // Remove rather than blank: load() must return null so the caller falls
    // through to re-login instead of using an empty cookie jar.
    await rm(this.path(identityId), { force: true }).catch(() => undefined);
  }
}

/**
 * Blob-storage store, for Cloud Run where the filesystem is ephemeral.
 * Without this, every cold start would replay the seed jar and re-trigger the
 * exact replay detection described above.
 */
export class GcsSessionStore implements SessionStore {
  readonly kind = 'gcs' as const;

  constructor(
    private readonly storage: Storage,
    private readonly bucketName: string,
    private readonly prefix = 'sessions/',
  ) {}

  private file(identityId: string) {
    return this.storage.bucket(this.bucketName).file(`${this.prefix}${encodeURIComponent(identityId)}.json`);
  }

  async load(identityId: string): Promise<StorageState | null> {
    try {
      const [buffer] = await this.file(identityId).download();
      const parsed = JSON.parse(buffer.toString('utf8')) as StorageState;
      return Array.isArray(parsed?.cookies) && parsed.cookies.length > 0 ? parsed : null;
    } catch (error) {
      if ((error as { code?: number }).code === 404) return null;
      throw error;
    }
  }

  async save(identityId: string, state: StorageState): Promise<void> {
    await this.file(identityId).save(JSON.stringify(state), {
      contentType: 'application/json',
      resumable: false,
      metadata: { cacheControl: 'no-store' },
    });
  }

  async clear(identityId: string): Promise<void> {
    await this.file(identityId).delete().catch(() => undefined);
  }
}

/** No-op store, for tests and for explicitly stateless runs. */
export class NullSessionStore implements SessionStore {
  readonly kind = 'none' as const;
  async load(): Promise<StorageState | null> { return null; }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
}
