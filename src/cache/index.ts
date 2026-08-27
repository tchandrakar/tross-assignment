import type { AppConfig } from '../config.js';
import { GcsProfileCache } from './gcs.js';
import { MemoryProfileCache } from './memory.js';
import type { ProfileCache } from './store.js';

export function createCache(config: AppConfig): ProfileCache {
  if (config.gcsBucket) {
    return new GcsProfileCache(config.gcsBucket, config.gcsPrefix);
  }
  return new MemoryProfileCache();
}

export * from './store.js';
