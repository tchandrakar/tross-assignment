import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore, NullSessionStore } from '../src/session/store.js';

const state = (names: string[]) => ({
  cookies: Object.fromEntries(names.map((name) => [name, `${name}-value`])),
  updatedAt: new Date().toISOString(),
});

describe('FileSessionStore', () => {
  let dir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-store-'));
    store = new FileSessionStore(dir);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('round-trips a session', async () => {
    await store.save('primary', state(['li_at', 'JSESSIONID']) as never);
    const loaded = await store.load('primary');
    expect(Object.keys(loaded?.cookies ?? {})).toHaveLength(2);
  });

  it('returns null for an identity that has never been saved', async () => {
    expect(await store.load('nobody')).toBeNull();
  });

  it('writes the session file 0600 — it is equivalent to a password', async () => {
    await store.save('primary', state(['li_at']) as never);
    const mode = (await stat(join(dir, 'primary.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keys identities separately', async () => {
    await store.save('a', state(['li_at']) as never);
    await store.save('b', state(['li_at', 'JSESSIONID', 'lidc']) as never);
    expect(Object.keys((await store.load('a'))?.cookies ?? {})).toHaveLength(1);
    expect(Object.keys((await store.load('b'))?.cookies ?? {})).toHaveLength(3);
  });

  it('treats an empty cookie jar as no session, so the caller re-establishes', async () => {
    // The bug this guards: clear() used to blank the file, and load() accepted
    // it, so a dead session became an unauthenticated request loop instead of
    // triggering a re-login.
    await writeFile(join(dir, 'primary.json'), JSON.stringify({ cookies: {} }));
    expect(await store.load('primary')).toBeNull();
  });

  it('clear() removes the session so load() reports absence', async () => {
    await store.save('primary', state(['li_at']) as never);
    await store.clear('primary');
    expect(await store.load('primary')).toBeNull();
  });

  it('survives a corrupt file rather than throwing', async () => {
    await writeFile(join(dir, 'primary.json'), 'not json at all');
    expect(await store.load('primary')).toBeNull();
  });

  it('overwrites rather than appending, so a rotated token replaces the old one', async () => {
    await store.save('primary', state(['li_at']) as never);
    await store.save('primary', state(['li_at', 'lidc']) as never);
    const raw = JSON.parse(await readFile(join(dir, 'primary.json'), 'utf8'));
    expect(Object.keys(raw.cookies)).toHaveLength(2);
  });

  it('sanitises the identity id so it cannot escape the directory', async () => {
    await store.save('../escape', state(['li_at']) as never);
    // Written inside the directory, under an encoded name.
    expect(await store.load('../escape')).not.toBeNull();
    await expect(stat(join(dir, '..', 'escape.json'))).rejects.toThrow();
  });
});

describe('NullSessionStore', () => {
  it('never returns a session and never throws', async () => {
    const store = new NullSessionStore();
    await expect(store.save()).resolves.toBeUndefined();
    expect(await store.load()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
